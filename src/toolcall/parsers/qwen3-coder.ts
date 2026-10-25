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

/** First index at or after `from` of any of `markers`, or `text.length` when none occurs. */
function indexOfFirst(text: string, markers: readonly string[], from: number): number {
  let best = text.length;
  for (const marker of markers) {
    const at = text.indexOf(marker, from);
    if (at >= 0 && at < best) best = at;
  }
  return best;
}

/**
 * The `NAME` of `<function=NAME>` / `KEY` of `<parameter=KEY>`, starting just past the `=`.
 * Undefined when there is no `>`, or the span is empty or holds `<` or a newline -- a tag the
 * model never finished, whose `>` belongs to some later tag.
 */
function readTagValue(text: string, start: number): { value: string; end: number } | undefined {
  const close = text.indexOf('>', start);
  if (close < 0) return undefined;
  const value = text.slice(start, close);
  if (value === '' || value.includes('<') || value.includes('\n')) return undefined;
  return { value, end: close + 1 };
}

/** Strip one leading and one trailing newline: the line breaks Qwen3's chat template puts around a value. */
function trimWrappingNewlines(value: string): string {
  let out = value;
  if (out.startsWith('\n')) out = out.slice(1);
  if (out.endsWith('\n')) out = out.slice(0, -1);
  return out;
}

/**
 * The arguments JSON of one function body: each `<parameter=KEY>VALUE</parameter>` in order of
 * appearance. A missing `</parameter>` ends the value at the next `<parameter=` or at the end of
 * the body. A repeated key keeps its first position and its last value. Anything but whitespace
 * between parameters means the body is not a call.
 *
 * Every value is a JSON string: the raw text, less one wrapping newline each side, verbatim. No
 * value is coerced to a number, boolean, object or array, and no tool schema is consulted, so
 * the result depends on the committed output alone (wire #46).
 */
function parseParameters(body: string): string | undefined {
  const entries = new Map<string, string>();
  let i = 0;
  for (;;) {
    i = skipWhitespace(body, i);
    if (i === body.length) break;
    if (!body.startsWith(PARAMETER_OPEN, i)) return undefined;
    const key = readTagValue(body, i + PARAMETER_OPEN.length);
    if (key === undefined) return undefined;
    const valueEnd = indexOfFirst(body, [PARAMETER_CLOSE, PARAMETER_OPEN], key.end);
    entries.set(key.value, JSON.stringify(trimWrappingNewlines(body.slice(key.end, valueEnd))));
    i = body.startsWith(PARAMETER_CLOSE, valueEnd) ? valueEnd + PARAMETER_CLOSE.length : valueEnd;
  }
  return `{${[...entries].map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',')}}`;
}

/**
 * Parse the text between `<tool_call>` and `</tool_call>` into its calls.
 *
 * The block holds one or more `<function=NAME>...</function>`, separated by whitespace only. A
 * missing `</function>` ends the function at the next `<function=` or at the end of the block.
 * Returns `undefined` when the block is not a call after all -- no function, an unfinished tag,
 * or stray text -- and the raw block then flows on as content (design S6 row one).
 */
function parseQwen3CoderBlock(inner: string): DerivedToolCall[] | undefined {
  const calls: DerivedToolCall[] = [];
  let i = 0;
  for (;;) {
    i = skipWhitespace(inner, i);
    if (i === inner.length) break;
    if (!inner.startsWith(FUNCTION_OPEN, i)) return undefined;
    const name = readTagValue(inner, i + FUNCTION_OPEN.length);
    if (name === undefined) return undefined;
    const bodyEnd = indexOfFirst(inner, [FUNCTION_CLOSE, FUNCTION_OPEN], name.end);
    const args = parseParameters(inner.slice(name.end, bodyEnd));
    if (args === undefined) return undefined;
    calls.push({ name: name.value, arguments: args });
    i = inner.startsWith(FUNCTION_CLOSE, bodyEnd) ? bodyEnd + FUNCTION_CLOSE.length : bodyEnd;
  }
  return calls.length === 0 ? undefined : calls;
}

function createQwen3CoderStreamState(): ToolCallStreamState {
  return createMarkerStreamState({
    startMarker: START_MARKER,
    endMarker: END_MARKER,
    parseCall: parseQwen3CoderBlock,
    // Values are free text, not JSON: a lone quote in one must not hide `</tool_call>`.
    quoteAware: false,
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
 * is assembled here with every value a JSON string, verbatim (wire #46). vLLM's `qwen3_xml` /
 * `qwen3_coder` and Dynamo coerce values by the request's tool schema; qwen3_coder@1 does not,
 * so its result depends on the committed output alone, like hermes@1.
 *
 * Conformance is `'unverified'`: no shared vectors exist (monorepo#11).
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
