# Tool Call Parser `qwen3_coder@1` (Specification)

Status: **SDK draft, unverified.** This is the behaviour the SDK's `qwen3CoderParser` implements.
It is written language-neutrally so another implementation can reproduce it byte for byte, and
so it can be proposed for wire's `TOOL_CALL_PARSER_V1`, which freezes the same format under the
same name in wire#46. Until wire publishes shared vectors for it, the SDK registers it as
`'unverified'` (callers pass `allowUnverified`).

## 1. Scope

The parser turns committed output into `{ content, tool_calls[] }` for models whose chat template
writes calls as XML, as Qwen3-Coder and the Qwen3.5+ templates do:

```text
<tool_call>
<function=get_weather>
<parameter=city>
Paris
</parameter>
<parameter=days>
3
</parameter>
</function>
</tool_call>
```

It inherits wire's common tool-call contract (input is the verified committed output, or the
remainder after reasoning separation when a reasoning parser is pinned; malformed input
degrades to content, never an error; `id` / `type` / `index` are Provider-synthesised and out of
scope; a stream split never changes the result).

## 2. Inputs

| Input | Source | Committed by |
|---|---|---|
| `text` | the committed output (or the reasoning remainder) | `output_hash` in the `InferReceipt` |
| `recover` | true iff the Worker-signed Fin's finish reason is `EOS_TOKEN` or `STOP_SEQUENCE` | the Fin, held to the receipt |

These are the only inputs, as for hermes@1 (Manifest §7.2 rules 3 and 6): the result is a function
of the committed output, `(name, version)` and the verified finish reason. The request's `tools`
are **not** an input. The model writes each argument value as plain text and qwen3_coder@1 keeps
it as a JSON string (§5, wire#46); no tool schema is read.

## 3. Framing

- Markers: start `<tool_call>`, end `</tool_call>`. They are matched literally, with **no quote
  awareness**. Values are free text, so a lone `"` in one must not hide the end marker; this is
  unlike hermes@1, whose payload is JSON (design §5.3).
- Text outside blocks is content, concatenated in order. Zero or more blocks.
- A block whose body (§4) is not a call is emitted as content verbatim, markers included.
- **Unclosed final block** (start marker, no end marker by end of text):
  - when `recover` is true and the body parses as a call, it is a call; a partial end marker at
    the very end (`</tool_c`) is dropped first;
  - otherwise the start marker and everything after it are content.
- A `<function=` with no `<tool_call>` before it is content. There is no bare-function
  fallback.

## 4. Block body

Grammar over the text between the markers. `WS` is `[ \t\n\r]*`.

```text
body      := WS function (WS function)* WS
function  := "<function=" NAME ">" params [ "</function>" ]
params    := WS ( param WS )*
param     := "<parameter=" KEY ">" VALUE [ "</parameter>" ]
```

- **NAME / KEY**: the text from just after `=` up to the first `>`. It must be non-empty and must
  contain neither `<` nor `\n`; otherwise the block is not a call. This catches a tag that was
  never finished, whose `>` belongs to a later tag. It is taken verbatim, with no trimming.
- **Function end**: the first `</function>`, or `<function=`, at or after the end of the name
  tag; failing both, the end of the body. So a missing `</function>` is tolerated, and several
  functions in one block are several calls, in order.
- **VALUE end**: the first `</parameter>`, or `<parameter=`, at or after the end of the key tag;
  failing both, the end of the function. So a missing `</parameter>` is tolerated.
- **Stray text**: anything but whitespace where the grammar expects `<function=` or
  `<parameter=` means the block is not a call. This also covers a JSON body, which is the
  hermes format.
- A block with no function is not a call. A function with no parameters has arguments `{}`.
- A value cannot hold a literal end marker; there is no escape. What a value that does hold one
  becomes follows from the rules above:
  - `</parameter>`: the value ends there, and the text after it is read as the rest of the block
    (so it is stray text unless it is whitespace or a tag the grammar expects).
  - `<parameter=`: the value ends there and a further parameter starts, so the call gains an
    extra parameter.
  - `</function>` or `<function=`: the function ends there, and the rest of the value is stray
    text between or after tags, so **the whole block is content**, not an early-ended call.
  - `</tool_call>`: the block closes there. The part before it is parsed as the body, and
    everything after it is outside the block, so the result is a call plus trailing content.
  - vLLM's value regex ends a value only at `</parameter>` or `<parameter=`; the function and
    block bounds come from its outer parse. Dynamo differs when a closing tag is missing (§8).

## 5. Values

1. **Raw text.** Strip exactly one leading `\n` and one trailing `\n`, if present. These are the
   template's line breaks. Everything else is kept, including indentation, inner blank lines
   and `\r`. There is no HTML unescaping. (wire#46 still lists the exact VALUE whitespace rule as
   open; this is the SDK's current rule.)
2. **Always a string.** The value is the raw text as a JSON string, verbatim. It is never coerced
   to a number, boolean, null, object or array, whatever it looks like, and no tool schema is
   consulted (wire#46). A caller that wants typed values converts them itself, against the schema
   it sent.
3. **JSON string encoding.** The escaping is:
   - `"` and `\` are escaped as `\"` and `\\`;
   - `\b \f \n \r \t` use their short forms;
   - other U+0000 to U+001F use `\u00xx` with lower-case hex;
   - lone surrogates use `\udxxx` with lower-case hex;
   - everything else, non-ASCII included, is emitted as UTF-8.

   This is ECMAScript `JSON.stringify` on a string.

## 6. Arguments object

```text
arguments := "{" [ entry ("," entry)* ] "}"
entry     := json_string(KEY) ":" json_string(VALUE)
```

- The serialization is compact, with no whitespace between tokens.
- Entries are in order of first appearance.
- A repeated KEY keeps its first position and takes its last value.

## 7. Examples

| Committed output | content | tool_calls |
|---|---|---|
| `<tool_call>\n<function=f>\n<parameter=a>\n1\n</parameter>\n</function>\n</tool_call>` | `""` | `f`, `{"a":"1"}` |
| `x<tool_call><function=a></function><function=b></function></tool_call>y` | `xy` | `a`, `{}`; `b`, `{}` |
| `<tool_call><function=f><parameter=a>\n1\n<parameter=b>2</function></tool_call>` | `""` | `f`, `{"a":"1","b":"2"}` |
| `<tool_call><function=f><parameter=s>say "hi</parameter></function></tool_call>` | `""` | `f`, `{"s":"say \"hi"}` |
| `<tool_call>\n{"name":"f","arguments":{}}\n</tool_call>` | the input, verbatim | none |
| `<tool_call><function=f\n<parameter=a>1</parameter></function></tool_call>` | the input, verbatim | none |
| `<function=f></function>` | the input, verbatim | none |
| `<tool_call><function=f><parameter=s>a</function>b</parameter></function></tool_call>` | the input, verbatim | none |
| `<tool_call><function=f><parameter=s>a<function=g>b</parameter></function></tool_call>` | the input, verbatim | none |
| `<tool_call><function=f><parameter=s>a<parameter=k>b</parameter></function></tool_call>` | `""` | `f`, `{"s":"a","k":"b"}` |
| `<tool_call><function=f><parameter=s>a</tool_call>b</parameter></function></tool_call>` | `b</parameter></function></tool_call>` | `f`, `{"s":"a"}` |

The unclosed final block `ok<tool_call>\n<function=f>\n</function>\n` gives:
- with `recover`: content `ok`, one call `f`, `{}`;
- without `recover`: the input, verbatim, as content.

Values are strings whatever they look like:

| Parameters written | arguments |
|---|---|
| `n=10`, `r=1.50e3`, `b=True`, `o={"k": 1}`, `c=null`, `s=42` | `{"n":"10","r":"1.50e3","b":"True","o":"{\"k\": 1}","c":"null","s":"42"}` |
| `n=  7  ` | `{"n":"  7  "}` |

## 8. Relation to the engines

The format follows vLLM's `qwen3_xml` / `qwen3_coder` (`vllm/parser/qwen3.py` at 77154ca) and
Dynamo's `qwen3_coder` (dynamo-parsers 10.0.2). Both engines also coerce each value by the
request's tool schema (vLLM `ParserEngine._fix_arg_types`); qwen3_coder@1 does not (§5). Where
they differ from each other, or are not precise enough to reproduce across languages, this spec
picks one rule:

| Point | vLLM | Dynamo | qwen3_coder@1 |
|---|---|---|---|
| Wrapping whitespace of a value | one leading and one trailing `\n` | full trim | one `\n` each side |
| HTML entities in a value | kept | unescaped | kept |
| value typing | by the request's tool schema | by the request's tool schema | none: always a string (§5) |
| `<function=` with no `<tool_call>` | parsed as a call | parsed as a call | content |
| stray text in a block | ignored | ignored | block is content |
| malformed call next to good ones in one block | bad one dropped | varies | whole block is content |
| unclosed final block | recovered | recovered (`allow_eof_recovery`) | recovered only on `EOS_TOKEN` / `STOP_SEQUENCE` |
| arguments spacing | `json.dumps` (`", "`, `": "`) | compact | compact |
| text outside blocks (whitespace between blocks, prose after a call, whitespace-only output) | content `None` when there are only calls and whitespace | normal text is trimmed and text after the first call is dropped | kept verbatim (§3) |
| a value missing its closing tag | ends at the next `<parameter=` | runs on past `<parameter=` and `</tool_call>` (SGLang-style) | ends at the next `<parameter=` or the end of the function (§4) |

The reference corpus (`test/fixtures/reference/`) holds 39 qwen3_coder cases: 22 agree and 17 diverge
by spec, each citing a row above.

Each choice favours a rule that is exact in every language. For the unclosed final block it never
invents a call from bytes the model did not finish: without `recover` the block is content.

## 9. Open items

1. **VALUE whitespace.** wire#46 lists the exact whitespace rule of a VALUE as open (b). The SDK
   strips one wrapping `\n` each side (§5.1) until wire decides.
2. **Vectors.** There are no shared vectors yet.
