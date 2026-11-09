# Tool Call Parser `qwen3_coder@1` (Specification)

Status: **vector-verified; wire is the authority.** This is the behaviour the SDK's
`qwen3CoderParser` implements, as a readable companion to wire's `docs/TOOL_CALL_PARSER_V1.md`
(qwen3_coder@1, settled in wire #51). Where the two differ, wire's document wins. The parser passes
every vector in wire's `testdata/v1/parser/tool_call_qwen3_coder_v1.json`
(`test/unit/parser-vectors.test.ts`), and the SDK registers it as `'vector-verified'`: no
`allowUnverified` is needed.

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

This is the only input. The result is a function of the committed output and `(name, version)`
(Manifest §7.2 rule 3). The verified finish reason, which Manifest §7.2 rule 6 allows as a
further input for unclosed-call recovery, does not change it, because qwen3_coder@1 defines no
recovery (§3). The request's `tools` are **not** an input: the model writes each argument value
as plain text and qwen3_coder@1 keeps it as a JSON string (§5, wire#46); no tool schema is read.

## 3. Framing

- Markers: start `<tool_call>`, end `</tool_call>`, matched on bytes with **no quote awareness**,
  as for every v1 tool-call parser (TOOL_CALL_PARSER_V1, Blocks). A block closes at the first
  `</tool_call>` after its start, even inside a value; a `<tool_call>` inside an open block is
  payload.
- Text outside blocks is content, concatenated in order, except that a whitespace-only segment
  between two blocks, or after the last one, is layout and is dropped (TOOL_CALL_PARSER_V1,
  Content). Text before the first block is kept verbatim. Zero or more blocks.
- A block whose body (§4) is malformed is emitted as content verbatim, markers included; the other
  blocks are unaffected.
- **Unclosed final block** (start marker, no end marker by end of text): the start marker and
  everything after it are content, whatever the finish reason. qwen3_coder@1 defines no
  unclosed-call recovery (Manifest §7.2 rule 6: a parser that defines none does not recover).
- A `<function=` with no `<tool_call>` before it is content. There is no bare-function
  fallback.

## 4. Block body

Grammar over the text between the markers, matched exactly. `ws` is one of SP, HT, LF, CR.

```text
payload   = ws* function ( ws* function )* ws*
function  = "<function=" NAME ">" ws* ( parameter ws* )* "</function>"
parameter = "<parameter=" KEY ">" VALUE "</parameter>"
```

- **NAME / KEY**: the text from just after `=` up to the next `>`. It must be non-empty and must
  contain neither `<` nor LF; otherwise the block is malformed. This catches a tag that was never
  finished, whose `>` belongs to a later tag. It is taken verbatim, with no trimming.
- **VALUE**: the text up to the first `</parameter>` in the block. So `<`, `>`, `<parameter=` and
  `</function>` inside a value are plain bytes, and an omitted `</parameter>` followed by a later
  one makes the value run on to that later one, taking the next `<parameter=...>` with it.
- **Malformed** (the whole block is content): no function; text other than whitespace between
  elements (this also covers a JSON body, which is the hermes format); an open parameter with no
  `</parameter>` left in the block; a missing `</function>`; a space inside a tag such as
  `<parameter = k>`; or a KEY repeated within one function.
- Several functions in one block are several calls, in order. A function with no parameters has
  arguments `{}`.
- A value cannot hold a literal `</parameter>` or `</tool_call>`; there is no escape. A
  `</tool_call>` inside a value closes the block there, and the block, cut short, is malformed.

## 5. Values

1. **Raw text.** Strip exactly one leading `\n` and one trailing `\n`, if present. These are the
   template's line breaks. Everything else is kept, including indentation, inner blank lines
   and `\r`. There is no HTML unescaping.
2. **Always a string.** The value is the raw text as a JSON string, verbatim. It is never coerced
   to a number, boolean, null, object or array, whatever it looks like, and no tool schema is
   consulted (wire#46). A caller that wants typed values converts them itself, against the schema
   it sent.
3. **JSON string encoding.** The escaping is:
   - `"` and `\` are escaped as `\"` and `\\`;
   - `\b \f \n \r \t` use their short forms;
   - other U+0000 to U+001F use `\u00xx` with lower-case hex;
   - everything else -- `<`, `>`, `&`, `/`, U+007F, U+2028, U+2029 and all non-ASCII -- is
     emitted as its UTF-8 bytes.

   (A lone surrogate cannot come from decoded committed output; should one reach the encoder it
   is written `\udxxx`, as ECMAScript `JSON.stringify` does.)

## 6. Arguments object

```text
arguments := "{" [ entry ("," entry)* ] "}"
entry     := json_string(KEY) ":" json_string(VALUE)
```

- The serialization is compact, with no whitespace between tokens.
- Entries are in order of appearance. A KEY cannot repeat within one function (§4).

## 7. Examples

| Committed output | content | tool_calls |
|---|---|---|
| `<tool_call>\n<function=f>\n<parameter=a>\n1\n</parameter>\n</function>\n</tool_call>` | `""` | `f`, `{"a":"1"}` |
| `x<tool_call><function=a></function><function=b></function></tool_call>y` | `xy` | `a`, `{}`; `b`, `{}` |
| `<tool_call><function=a></function></tool_call>\n<tool_call><function=b></function></tool_call>\n` | `""` (layout dropped) | `a`, `{}`; `b`, `{}` |
| `<tool_call><function=f><parameter=s>say "hi</parameter></function></tool_call>` | `""` | `f`, `{"s":"say \"hi"}` |
| `<tool_call><function=f><parameter=a>1<parameter=b>2</parameter></function></tool_call>` | `""` | `f`, `{"a":"1<parameter=b>2"}` |
| `<tool_call><function=f><parameter=s>a</function>b</parameter></function></tool_call>` | `""` | `f`, `{"s":"a</function>b"}` |
| `<tool_call><function=f><parameter=a>\n1\n<parameter=b>2</function></tool_call>` | the input, verbatim | none |
| `<tool_call><function=f><parameter=a>1</parameter></tool_call>` | the input, verbatim | none |
| `<tool_call><function=f><parameter=a>1</parameter><parameter=a>2</parameter></function></tool_call>` | the input, verbatim | none |
| `<tool_call>\n{"name":"f","arguments":{}}\n</tool_call>` | the input, verbatim | none |
| `<tool_call><function=f\n<parameter=a>1</parameter></function></tool_call>` | the input, verbatim | none |
| `<function=f></function>` | the input, verbatim | none |
| `<tool_call><function=f><parameter=s>a</tool_call>b</parameter></function></tool_call>` | the input, verbatim | none |

The unclosed final block `ok<tool_call>\n<function=f>\n</function>\n` is the input, verbatim, as
content, whatever the finish reason.

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
| unclosed final block | recovered | recovered (`allow_eof_recovery`) | content: no recovery defined (§3) |
| arguments spacing | `json.dumps` (`", "`, `": "`) | compact | compact |
| text outside blocks | content `None` when there are only calls and whitespace | normal text is trimmed and text after the first call is dropped | whitespace-only layout between / after blocks dropped, all other text kept verbatim (§3) |
| a value missing its closing tag | ends at the next `<parameter=` | runs on past `<parameter=` and `</tool_call>` (SGLang-style) | runs on to the next `</parameter>`; none left is malformed (§4) |
| missing `</function>` | tolerated | tolerated | malformed (§4) |
| repeated KEY | last value | first position, last value | malformed (§4) |
| spaces inside a tag | tolerated | -- | malformed (§4) |

The reference corpus (`test/fixtures/reference/`) holds 39 qwen3_coder cases: 18 agree and 21 diverge
by spec, each citing a rule above; the cases wire #51 changed say so.

Each choice favours a rule that is exact in every language. For the unclosed final block it never
invents a call from bytes the model did not finish: the block is content.

## 9. Open items

None in the SDK. Governance still has to admit `(qwen3_coder, 1)` to
`supported_tool_call_parsers` before a profile can pin it (TOOL_CALL_PARSER_V1, Open items).
