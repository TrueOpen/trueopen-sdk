import type { ChatJsonValue, ChatTool } from '../../order/chat-input';
import { createMarkerStreamState } from '../stream-state';
import type {
  DerivedAssistantMessage,
  DerivedToolCall,
  ToolCallContext,
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

/** A tool's `parameters.properties`: parameter name to its JSON Schema. */
type SchemaProperties = Readonly<Record<string, ChatJsonValue>>;

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

const TYPE_ALIASES: ReadonlyMap<string, string> = new Map(Object.entries({
  str: 'string',
  text: 'string',
  varchar: 'string',
  char: 'string',
  enum: 'string',
  int: 'integer',
  int32: 'integer',
  int64: 'integer',
  uint: 'integer',
  uint32: 'integer',
  uint64: 'integer',
  long: 'integer',
  short: 'integer',
  unsigned: 'integer',
  float: 'number',
  float32: 'number',
  float64: 'number',
  double: 'number',
  bool: 'boolean',
  dict: 'object',
  arr: 'array',
  list: 'array',
  sequence: 'array',
}));

function isJsonObject(v: unknown): v is Readonly<Record<string, ChatJsonValue>> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function jsonValueType(v: unknown): string | undefined {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'bigint') return 'integer';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return undefined;
}

/**
 * The JSON Schema types a parameter admits: `type` (a string or a list), the types of `enum`
 * values, and recursively `anyOf` / `oneOf` / `allOf`, normalized through `TYPE_ALIASES`.
 * `string` when the schema says nothing usable.
 */
function schemaTypes(schema: unknown): Set<string> {
  const types = new Set<string>();
  const collect = (s: unknown): void => {
    if (!isJsonObject(s)) return;
    const type = s['type'];
    for (const t of typeof type === 'string' ? [type] : Array.isArray(type) ? type : []) {
      if (typeof t !== 'string') continue;
      const key = t.trim().toLowerCase();
      types.add(TYPE_ALIASES.get(key) ?? key);
    }
    const values = s['enum'];
    if (Array.isArray(values)) {
      for (const v of values) {
        const t = jsonValueType(v);
        if (t !== undefined) types.add(t);
      }
    }
    for (const field of ['anyOf', 'oneOf', 'allOf']) {
      const choices = s[field];
      if (Array.isArray(choices)) for (const choice of choices) collect(choice);
    }
  };
  collect(schema);
  if (types.size === 0) types.add('string');
  return types;
}

const INTEGER_LITERAL = /^-?(?:0|[1-9][0-9]*)$/;
const NUMBER_LITERAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

function parsesAs(text: string, want: 'object' | 'array'): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  return want === 'array' ? Array.isArray(value) : isJsonObject(value);
}

/**
 * One parameter value as JSON text, typed by the parameter's schema.
 *
 * The model writes every value as plain text; the schema decides what it becomes. Candidate
 * types are tried in a fixed priority -- null, integer, number, boolean, object, array, string
 * -- and the first the text satisfies wins. A value that satisfies none of its types, or whose
 * parameter has no schema, stays a string. Numbers, objects and arrays keep the model's own
 * bytes (whitespace-trimmed) rather than a re-serialization, so no precision or key order is lost.
 */
function valueJson(raw: string, schema: ChatJsonValue | undefined): string {
  const types = schema === undefined ? new Set(['string']) : schemaTypes(schema);
  const text = raw.slice(skipWhitespace(raw, 0)).replace(/[ \t\n\r]+$/, '');
  for (const type of ['null', 'integer', 'number', 'boolean', 'object', 'array', 'string']) {
    if (!types.has(type)) continue;
    switch (type) {
      case 'null':
        if (text.toLowerCase() === 'null') return 'null';
        break;
      case 'integer':
        if (INTEGER_LITERAL.test(text)) return text;
        break;
      case 'number':
        if (NUMBER_LITERAL.test(text)) return text;
        break;
      case 'boolean': {
        const lower = text.toLowerCase();
        if (lower === 'true' || lower === '1') return 'true';
        if (lower === 'false' || lower === '0') return 'false';
        break;
      }
      case 'object':
      case 'array':
        if (parsesAs(text, type)) return text;
        break;
      case 'string':
        return JSON.stringify(raw);
    }
  }
  return JSON.stringify(raw);
}

/** `parameters.properties` of the tool named `name`, if the request declared one. */
function schemaProperties(tools: readonly ChatTool[] | undefined, name: string): SchemaProperties | undefined {
  const tool = tools?.find((t) => t.type === 'function' && t.function.name === name);
  const properties = tool?.function.parameters?.['properties'];
  return isJsonObject(properties) ? properties : undefined;
}

/**
 * The arguments JSON of one function body: each `<parameter=KEY>VALUE</parameter>` in order of
 * appearance. A missing `</parameter>` ends the value at the next `<parameter=` or at the end of
 * the body. A repeated key keeps its first position and its last value. Anything but whitespace
 * between parameters means the body is not a call.
 */
function parseParameters(body: string, properties: SchemaProperties | undefined): string | undefined {
  const entries = new Map<string, string>();
  let i = 0;
  for (;;) {
    i = skipWhitespace(body, i);
    if (i === body.length) break;
    if (!body.startsWith(PARAMETER_OPEN, i)) return undefined;
    const key = readTagValue(body, i + PARAMETER_OPEN.length);
    if (key === undefined) return undefined;
    const valueEnd = indexOfFirst(body, [PARAMETER_CLOSE, PARAMETER_OPEN], key.end);
    const raw = trimWrappingNewlines(body.slice(key.end, valueEnd));
    const schema = properties !== undefined && Object.prototype.hasOwnProperty.call(properties, key.value) ? properties[key.value] : undefined;
    entries.set(key.value, valueJson(raw, schema));
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
function parseQwen3CoderBlock(inner: string, tools: readonly ChatTool[] | undefined): DerivedToolCall[] | undefined {
  const calls: DerivedToolCall[] = [];
  let i = 0;
  for (;;) {
    i = skipWhitespace(inner, i);
    if (i === inner.length) break;
    if (!inner.startsWith(FUNCTION_OPEN, i)) return undefined;
    const name = readTagValue(inner, i + FUNCTION_OPEN.length);
    if (name === undefined) return undefined;
    const bodyEnd = indexOfFirst(inner, [FUNCTION_CLOSE, FUNCTION_OPEN], name.end);
    const args = parseParameters(inner.slice(name.end, bodyEnd), schemaProperties(tools, name.value));
    if (args === undefined) return undefined;
    calls.push({ name: name.value, arguments: args });
    i = inner.startsWith(FUNCTION_CLOSE, bodyEnd) ? bodyEnd + FUNCTION_CLOSE.length : bodyEnd;
  }
  return calls.length === 0 ? undefined : calls;
}

function createQwen3CoderStreamState(ctx?: ToolCallContext): ToolCallStreamState {
  const tools = ctx?.tools;
  return createMarkerStreamState({
    startMarker: START_MARKER,
    endMarker: END_MARKER,
    parseCall: (inner) => parseQwen3CoderBlock(inner, tools),
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
 * is assembled here. A value's JSON type comes from the request's tool schema (`tools` in the
 * context), the way vLLM's `qwen3_xml` / `qwen3_coder` parsers read it; without a schema for the
 * parameter the value is a string. So unlike hermes@1 the result depends on the request's
 * `tools` as well as the committed output -- both committed, the tools through `input_hash`.
 *
 * Conformance is `'unverified'`: no shared vectors exist (monorepo#11).
 */
export const qwen3CoderParser: ToolCallParser = {
  name: 'qwen3_coder',
  version: 1,
  parseComplete(text: string, opts?: ToolCallParseOptions): DerivedAssistantMessage {
    // The streaming machine, so the full-text and streaming paths cannot diverge (design S7
    // requirement 1).
    const state = createQwen3CoderStreamState(opts);
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
