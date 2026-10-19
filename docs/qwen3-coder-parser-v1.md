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
| `tools` | the request's `tools` (`ChatInferInput.tools`), may be absent | `input_hash` |
| `recover` | true iff the Worker-signed Fin's finish reason is `EOS_TOKEN` or `STOP_SEQUENCE` | the Fin, held to the receipt |

**Difference from hermes@1.** The model writes no JSON here: each argument value is plain text,
and its JSON type comes from the tool's schema in `tools`. So the result depends on `tools` as
well as on the committed output and `(name, version)`. Manifest §7.3 rule 11 names only the
latter two. `tools` is committed too, through `input_hash`, so the result is still a function of
committed data. The stream and the confirmation must be given the same `tools`.

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
- A value containing the literal `</parameter>`, `<parameter=`, `</function>`, `<function=` or
  `</tool_call>` ends early at it. This cannot be escaped. vLLM ends at the same markers; Dynamo differs when a closing tag is missing (see §8).

## 5. Values

1. **Raw text.** Strip exactly one leading `\n` and one trailing `\n`, if present. These are the
   template's line breaks. Everything else is kept, including indentation, inner blank lines
   and `\r`. There is no HTML unescaping.
2. **Schema.** Use the first tool in `tools` with `type == "function"` and
   `function.name == NAME`, then its `function.parameters.properties[KEY]`. If there is no
   tool, no such property, or `tools` is absent, there is no schema.
3. **Admitted types.** With no schema the only type is `{string}`. Otherwise the set is the
   union of:
   - `type`, as a string or a list of strings;
   - the type of each `enum` value: `null`, `boolean`, `integer` (integral number), `number`,
     `string`, `array` or `object`;
   - recursively, the same for every entry of `anyOf`, `oneOf` and `allOf`.

   Each name is trimmed, lower-cased and mapped through these aliases:

   | Alias | Type |
   |---|---|
   | `str`, `text`, `varchar`, `char`, `enum` | `string` |
   | `int`, `int32`, `int64`, `uint`, `uint32`, `uint64`, `long`, `short`, `unsigned` | `integer` |
   | `float`, `float32`, `float64`, `double` | `number` |
   | `bool` | `boolean` |
   | `dict` | `object` |
   | `arr`, `list`, `sequence` | `array` |

   An empty set becomes `{string}`.
4. **Coercion.** Let `t` be the raw text with JSON whitespace trimmed from both ends. Try the
   admitted types in this fixed priority, and the first that matches gives the JSON value text:

   | Type | Matches when | JSON emitted |
   |---|---|---|
   | `null` | lower-case `t` is `null` | `null` |
   | `integer` | `t` matches `^-?(0\|[1-9][0-9]*)$` | `t` verbatim |
   | `number` | `t` matches the RFC 8259 number grammar | `t` verbatim |
   | `boolean` | lower-case `t` is `true` or `1` / `false` or `0` | `true` / `false` |
   | `object` | `t` parses as JSON and is an object | `t` verbatim |
   | `array` | `t` parses as JSON and is an array | `t` verbatim |
   | `string` | always | the raw text as a JSON string |

   When no admitted type matches, the value is the raw text as a JSON string. Numbers, objects
   and arrays keep the model's own bytes, so there is no precision loss, no key reordering and
   no float re-formatting.
5. **JSON string encoding.** The escaping is:
   - `"` and `\` are escaped as `\"` and `\\`;
   - `\b \f \n \r \t` use their short forms;
   - other U+0000 to U+001F use `\u00xx` with lower-case hex;
   - lone surrogates use `\udxxx` with lower-case hex;
   - everything else, non-ASCII included, is emitted as UTF-8.

   This is ECMAScript `JSON.stringify` on a string.

## 6. Arguments object

```text
arguments := "{" [ entry ("," entry)* ] "}"
entry     := json_string(KEY) ":" value_json
```

- The serialization is compact, with no whitespace between tokens.
- Entries are in order of first appearance.
- A repeated KEY keeps its first position and takes its last value.

## 7. Examples

Without `tools`:

| Committed output | content | tool_calls |
|---|---|---|
| `<tool_call>\n<function=f>\n<parameter=a>\n1\n</parameter>\n</function>\n</tool_call>` | `""` | `f`, `{"a":"1"}` |
| `x<tool_call><function=a></function><function=b></function></tool_call>y` | `xy` | `a`, `{}`; `b`, `{}` |
| `<tool_call><function=f><parameter=a>\n1\n<parameter=b>2</function></tool_call>` | `""` | `f`, `{"a":"1","b":"2"}` |
| `<tool_call><function=f><parameter=s>say "hi</parameter></function></tool_call>` | `""` | `f`, `{"s":"say \"hi"}` |
| `<tool_call>\n{"name":"f","arguments":{}}\n</tool_call>` | the input, verbatim | none |
| `<tool_call><function=f\n<parameter=a>1</parameter></function></tool_call>` | the input, verbatim | none |
| `<function=f></function>` | the input, verbatim | none |

The unclosed final block `ok<tool_call>\n<function=f>\n</function>\n` gives:
- with `recover`: content `ok`, one call `f`, `{}`;
- without `recover`: the input, verbatim, as content.

With `tools` declaring:
- `n: integer`
- `r: number`
- `b: boolean`
- `o: object`
- `c: ["integer","null"]`
- `s: string`

| Parameters written | arguments |
|---|---|
| `n=10`, `r=1.50e3`, `b=True`, `o={"k": 1}`, `c=null`, `s=42` | `{"n":10,"r":1.50e3,"b":true,"o":{"k": 1},"c":null,"s":"42"}` |
| `n=ten`, `b=yes`, `o=[1]` | `{"n":"ten","b":"yes","o":"[1]"}` |
| `n=  7  ` | `{"n":7}` |
| `s=  7  ` | `{"s":"  7  "}` |
| `x=5` (not in schema) | `{"x":"5"}` |

## 8. Relation to the engines

The format and the schema typing follow vLLM's `qwen3_xml` / `qwen3_coder` (`vllm/parser/qwen3.py`
and `ParserEngine._fix_arg_types` at 77154ca) and Dynamo's `qwen3_coder` (dynamo-parsers
10.0.2). Where they differ from each other, or are not precise enough to reproduce across
languages, this spec picks one rule:

| Point | vLLM | Dynamo | qwen3_coder@1 |
|---|---|---|---|
| Wrapping whitespace of a value | one leading and one trailing `\n` | full trim | one `\n` each side |
| HTML entities in a value | kept | unescaped | kept |
| `null` value | only if the schema admits null | any value `null` → null | only if the schema admits null |
| integer / number grammar | Python `int()` / `float()` (accepts `+5`, `1_000`, ` 5`) | Rust `parse` | JSON number grammar after trimming |
| number output | `float` re-serialized (`5.0` → `5`) | re-serialized | model's literal |
| `<function=` with no `<tool_call>` | parsed as a call | parsed as a call | content |
| stray text in a block | ignored | ignored | block is content |
| malformed call next to good ones in one block | bad one dropped | varies | whole block is content |
| unclosed final block | recovered | recovered (`allow_eof_recovery`) | recovered only on `EOS_TOKEN` / `STOP_SEQUENCE` |
| arguments spacing | `json.dumps` (`", "`, `": "`) | compact | compact |
| text outside blocks (whitespace between blocks, prose after a call, whitespace-only output) | content `None` when there are only calls and whitespace | normal text is trimmed and text after the first call is dropped | kept verbatim (§3) |
| a value missing its closing tag | ends at the next `<parameter=` | runs on past `<parameter=` and `</tool_call>` (SGLang-style) | ends at the next `<parameter=` or the end of the function (§4) |
| a parameter whose schema type is unknown (e.g. `other_type`) | tries `json.loads` as a last step, else keeps the string; Python-literal syntax such as single quotes fails it | falls back to Python `literal_eval` | keeps the string (§5.3–5.4) |
| a boolean value that is neither `true`/`1` nor `false`/`0` | falls through to the string | `false` | the raw string (§5.4) |

The reference corpus (`test/fixtures/reference/`) holds 39 qwen3_coder cases: 28 agree and 11 diverge
by spec, each citing a row above.

Each choice favours a rule that is exact in every language and never invents a call from bytes
the model did not finish.

## 9. Open items

1. **Name.** The canonical name is `qwen3_coder`, as in wire#46. The testnet profile
   (`0x758471e7…`, Qwen3.8-27B-FP8) pins `qwen3_xml@1` on chain, which this SDK does not know.
   For that profile `lookup` reports `parser-unknown`, and the output arrives as content with no
   calls, until the profile is re-registered with `qwen3_coder@1`.
2. **Rule 11.** The dependence on `tools` (§2) has to be written into Manifest §7.3 rule 11 /
   wire's contract, or wire has to choose schema-free strings instead.
3. **Vectors.** There are no shared vectors yet. Cases need `tools` next to `input_utf8`.
