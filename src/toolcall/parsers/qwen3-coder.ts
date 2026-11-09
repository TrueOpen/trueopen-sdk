import { createMarkerStreamState } from '../stream-state';
import type {
  DerivedAssistantMessage,
  DerivedToolCall,
  ToolCallParseOptions,
  ToolCallParser,
  ToolCallStreamState,
} from '../types';

const START_MARKER = '<tool_call>';
const END_MARKER = '</tool_call>';
const FUNCTION_OPEN = '<function=';
const FUNCTION_CLOSE = '</function>';
const PARAMETER_OPEN = '<parameter=';
const PARAMETER_CLOSE = '</parameter>';

function isWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function skipWhitespace(text: string, i: number): number {
  while (i < text.length && isWhitespace(text[i])) i += 1;
  return i;
}

/**
 * The `NAME` of `<function=NAME>` / `KEY` of `<parameter=KEY>`, starting just past the `=`: the
 * bytes up to the next `>`, raw (not trimmed). Undefined when there is no `>`, or the span is
 * empty or holds `<` or LF -- such a name can only come from a tag the model never finished.
 */
function readTagValue(text: string, start: number): { value: string; end: number } | undefined {
  const close = text.indexOf('>', start);
  if (close < 0) return undefined;
  const value = text.slice(start, close);
  if (value === '' || value.includes('<') || value.includes('\n')) return undefined;
  return { value, end: close + 1 };
}

/** Strip exactly one leading and one trailing LF, if present: the layout the chat template puts around a value. */
function trimWrappingNewlines(value: string): string {
  let out = value;
  if (out.startsWith('\n')) out = out.slice(1);
  if (out.endsWith('\n')) out = out.slice(0, -1);
  return out;
}

/**
 * A JSON string written exactly as TOOL_CALL_PARSER_V1 qwen3_coder@1 `encoding` says, so Go / Rust /
 * TS agree byte for byte: `"` and `\` backslash-escaped, BS FF LF CR HT as `\b \f \n \r \t`, any
 * other byte 0x00-0x1F as `\u00` + two lowercase hex digits, and everything else -- `<`, `>`, `&`,
 * `/`, 0x7F, U+2028, U+2029, all non-ASCII -- copied as is.
 */
function encodeJsonString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20) out += `\\u00${code.toString(16).padStart(2, '0')}`;
    // A lone surrogate has no UTF-8 form and cannot come from decoded committed output; escaped
    // (as JSON.stringify does) rather than written as an ill-formed string, should one ever arrive.
    else if (code >= 0xd800 && code <= 0xdfff) out += `\\u${code.toString(16)}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * Parse the bytes between `<tool_call>` and `</tool_call>` into its calls, by the grammar of
 * TOOL_CALL_PARSER_V1 qwen3_coder@1 `payload`, matched exactly:
 *
 * ```text
 * payload   = ws* function ( ws* function )* ws*
 * function  = "<function=" NAME ">" ws* ( parameter ws* )* "</function>"
 * parameter = "<parameter=" KEY ">" VALUE "</parameter>"
 * ```
 *
 * VALUE runs to the first `</parameter>` in the block, so `<`, `>`, `<parameter=` and
 * `</function>` inside it are plain bytes, and an omitted `</parameter>` makes the value run on to
 * a later one. Then one wrapping LF each side is removed; nothing is unescaped.
 *
 * Each function is one call: arguments is a JSON object with one member per parameter, in order
 * of appearance, every value a JSON string -- no type coercion and no tool-schema lookup, so the
 * result depends on the committed output alone.
 *
 * Returns `undefined` when the block is malformed -- no function, text other than whitespace
 * between elements, no `</parameter>` left for an open parameter, a missing `</function>`, a tag
 * with a space in it, or a KEY repeated within one function. The block's raw bytes are then
 * content (Common contract, Failure).
 */
function parseQwen3CoderBlock(inner: string): DerivedToolCall[] | undefined {
  const calls: DerivedToolCall[] = [];
  let i = skipWhitespace(inner, 0);
  do {
    if (!inner.startsWith(FUNCTION_OPEN, i)) return undefined;
    const name = readTagValue(inner, i + FUNCTION_OPEN.length);
    if (name === undefined) return undefined;
    i = name.end;
    const keys = new Set<string>();
    const members: string[] = [];
    for (;;) {
      i = skipWhitespace(inner, i);
      if (inner.startsWith(FUNCTION_CLOSE, i)) {
        i += FUNCTION_CLOSE.length;
        break;
      }
      if (!inner.startsWith(PARAMETER_OPEN, i)) return undefined;
      const key = readTagValue(inner, i + PARAMETER_OPEN.length);
      if (key === undefined || keys.has(key.value)) return undefined;
      keys.add(key.value);
      const valueEnd = inner.indexOf(PARAMETER_CLOSE, key.end);
      if (valueEnd < 0) return undefined;
      members.push(`${encodeJsonString(key.value)}:${encodeJsonString(trimWrappingNewlines(inner.slice(key.end, valueEnd)))}`);
      i = valueEnd + PARAMETER_CLOSE.length;
    }
    calls.push({ name: name.value, arguments: `{${members.join(',')}}` });
    i = skipWhitespace(inner, i);
  } while (i < inner.length);
  return calls;
}

function createQwen3CoderStreamState(): ToolCallStreamState {
  return createMarkerStreamState({
    startMarker: START_MARKER,
    endMarker: END_MARKER,
    parseCall: parseQwen3CoderBlock,
    // No `recoverUnclosed`: qwen3_coder@1 defines no recovery (Manifest S7.2 rule 6), so an
    // unclosed final block is always content, whatever the finish reason.
  });
}

/**
 * The Qwen3 XML tool-call parser, as Qwen3-Coder and the Qwen3.5+ chat templates write calls:
 *
 * ```text
 * <tool_call>
 * <function=get_weather>
 * <parameter=city>
 * Paris
 * </parameter>
 * </function>
 * </tool_call>
 * ```
 *
 * Unlike hermes@1 the model writes no JSON: each value is plain text, and the arguments object
 * is assembled here with every value a JSON string, verbatim (TOOL_CALL_PARSER_V1 qwen3_coder@1).
 * vLLM's `qwen3_xml` / `qwen3_coder` and Dynamo coerce values by the request's tool schema and
 * tolerate malformed markup; qwen3_coder@1 does neither, so its result depends on the committed
 * output alone, like hermes@1.
 *
 * It defines no unclosed-call recovery: a final block without `</tool_call>` is content.
 *
 * Conformance is `'vector-verified'`: it passes wire's shared vectors
 * (`testdata/v1/parser/tool_call_qwen3_coder_v1.json`).
 */
export const qwen3CoderParser: ToolCallParser = {
  name: 'qwen3_coder',
  version: 1,
  parseComplete(text: string, opts?: ToolCallParseOptions): DerivedAssistantMessage {
    // The streaming machine, so the full-text and streaming paths cannot diverge (design S7
    // requirement 1).
    const state = createQwen3CoderStreamState();
    const events = [...state.push(text), ...state.finish(opts)];
    let content = '';
    const toolCalls: DerivedToolCall[] = [];
    for (const event of events) {
      if (event.kind === 'content') content += event.text;
      else toolCalls.push(event.call);
    }
    return { role: 'assistant', content, toolCalls };
  },
  createStreamState: createQwen3CoderStreamState,
};
