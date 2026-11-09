import { createMarkerStreamState } from '../stream-state';
import type { DerivedAssistantMessage, DerivedToolCall, ToolCallParseOptions, ToolCallParser, ToolCallStreamState } from '../types';

const START_MARKER = '<tool_call>';
const END_MARKER = '</tool_call>';

/** TOOL_CALL_PARSER_V1 hermes@1, strict JSON: objects / arrays nested deeper than this are malformed. */
const MAX_DEPTH = 64;

/** Thrown inside the strict scan only; caught by `parseHermesPayload`, never escapes it. */
class Malformed extends Error {}

function isWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** Leading and trailing whitespace (the four bytes of the spec, nothing else) removed. */
function trimWhitespace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isWhitespace(text[start])) start += 1;
  while (end > start && isWhitespace(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

const HEX = /^[0-9a-fA-F]{4}$/;
/** RFC 8259 number, matched at a position (sticky). */
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/**
 * A strict RFC 8259 scanner with the extra hermes@1 rules: JSON whitespace is exactly SP / HT / LF /
 * CR, a `\u` escape for an unpaired surrogate is malformed, and nesting deeper than 64 is
 * malformed. Number magnitude and precision are not checked, and duplicate keys below the top level
 * are allowed: those bytes are passed through, never decoded.
 */
class StrictJson {
  i = 0;
  constructor(readonly text: string) {}

  ws(): void {
    while (this.i < this.text.length && isWhitespace(this.text[this.i])) this.i += 1;
  }

  /** A string at `i`; returns its decoded value. */
  string(): string {
    const t = this.text;
    if (t[this.i] !== '"') throw new Malformed();
    this.i += 1;
    let out = '';
    for (;;) {
      if (this.i >= t.length) throw new Malformed();
      const ch = t[this.i]!;
      if (ch === '"') {
        this.i += 1;
        return out;
      }
      if (ch.charCodeAt(0) < 0x20) throw new Malformed();
      if (ch !== '\\') {
        out += ch;
        this.i += 1;
        continue;
      }
      const esc = t[this.i + 1];
      this.i += 2;
      switch (esc) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          const unit = this.hex4();
          if (unit >= 0xdc00 && unit <= 0xdfff) throw new Malformed(); // a low half on its own
          if (unit >= 0xd800 && unit <= 0xdbff) {
            // A high half must be followed at once by an escaped low half.
            if (t[this.i] !== '\\' || t[this.i + 1] !== 'u') throw new Malformed();
            this.i += 2;
            const low = this.hex4();
            if (low < 0xdc00 || low > 0xdfff) throw new Malformed();
            out += String.fromCharCode(unit, low);
          } else {
            out += String.fromCharCode(unit);
          }
          break;
        }
        default:
          throw new Malformed();
      }
    }
  }

  hex4(): number {
    const digits = this.text.slice(this.i, this.i + 4);
    if (!HEX.test(digits)) throw new Malformed();
    this.i += 4;
    return parseInt(digits, 16);
  }

  number(): void {
    NUMBER.lastIndex = this.i;
    const m = NUMBER.exec(this.text);
    if (m === null) throw new Malformed();
    this.i += m[0].length;
  }

  literal(word: string): void {
    if (!this.text.startsWith(word, this.i)) throw new Malformed();
    this.i += word.length;
  }

  /** Any value at `i`, the container it opens (if any) being at `depth`. */
  value(depth: number): void {
    const ch = this.text[this.i];
    if (ch === '{') this.object(depth, undefined);
    else if (ch === '[') this.array(depth);
    else if (ch === '"') this.string();
    else if (ch === 't') this.literal('true');
    else if (ch === 'f') this.literal('false');
    else if (ch === 'n') this.literal('null');
    else this.number();
  }

  array(depth: number): void {
    if (depth > MAX_DEPTH) throw new Malformed();
    this.i += 1; // [
    this.ws();
    if (this.text[this.i] === ']') {
      this.i += 1;
      return;
    }
    for (;;) {
      this.ws();
      this.value(depth + 1);
      this.ws();
      const ch = this.text[this.i];
      this.i += 1;
      if (ch === ']') return;
      if (ch !== ',') throw new Malformed();
    }
  }

  /** An object; `member` sees each member (decoded key, raw value span) when given. */
  object(depth: number, member: ((key: string, start: number, end: number) => void) | undefined): void {
    if (depth > MAX_DEPTH) throw new Malformed();
    this.i += 1; // {
    this.ws();
    if (this.text[this.i] === '}') {
      this.i += 1;
      return;
    }
    for (;;) {
      this.ws();
      const key = this.string();
      this.ws();
      if (this.text[this.i] !== ':') throw new Malformed();
      this.i += 1;
      this.ws();
      const start = this.i;
      this.value(depth + 1);
      member?.(key, start, this.i);
      this.ws();
      const ch = this.text[this.i];
      this.i += 1;
      if (ch === '}') return;
      if (ch !== ',') throw new Malformed();
    }
  }
}

/**
 * hermes@1's payload rule (TOOL_CALL_PARSER_V1, hermes@1 `payload` / `strict JSON`): the bytes
 * between the markers, trimmed of leading and trailing whitespace, must be exactly one strict JSON
 * object and nothing else.
 *
 * - `name` is required and must be a JSON string; the call's name is its decoded value.
 * - `arguments` is optional. When present it must be a JSON object, and the call's arguments are
 *   its exact bytes in the input, from `{` to the matching `}` -- never re-serialized, since
 *   `JSON.parse` / `stringify` would reorder keys and change the bytes the shared vectors pin. When
 *   absent, arguments is `"{}"`.
 * - Top-level keys are matched on their decoded value (`"arguments"` is `arguments`); `name`
 *   or `arguments` twice is malformed. Any other key is ignored; `parameters` is not an alias.
 *
 * Returns `undefined` for a malformed payload. That is not an error path: the block's raw bytes
 * are content (Common contract, Failure).
 */
function parseHermesPayload(raw: string): DerivedToolCall | undefined {
  const payload = trimWhitespace(raw);
  if (payload[0] !== '{') return undefined;
  const scan = new StrictJson(payload);
  let name: string | undefined;
  let nameCount = 0;
  let args: string | undefined;
  let argsCount = 0;
  try {
    scan.object(1, (key, start, end) => {
      if (key === 'name') {
        nameCount += 1;
        if (payload[start] !== '"') throw new Malformed();
        name = new StrictJson(payload.slice(start, end)).string();
      } else if (key === 'arguments') {
        argsCount += 1;
        if (payload[start] !== '{') throw new Malformed(); // null, a string, an array, ...
        args = payload.slice(start, end);
      }
    });
  } catch (err) {
    if (err instanceof Malformed) return undefined;
    throw err;
  }
  if (scan.i !== payload.length) return undefined; // trailing bytes after the object
  if (nameCount !== 1 || argsCount > 1 || name === undefined) return undefined;
  return { name, arguments: args ?? '{}' };
}

/**
 * hermes@1's recovery of an unclosed block (TOOL_CALL_PARSER_V1 hermes@1 `recover`), used only
 * through the Common-contract gate (the model stopped by itself). The payload is everything after
 * the opening `<tool_call>` -- a later `<tool_call>` included, as payload bytes -- trimmed, and it
 * recovers as exactly one call iff it meets the closed-block payload rules. A trailing partial end
 * marker (`</tool_`) is not stripped, and neither is a stop string: either leaves the JSON invalid,
 * so the block stays content.
 */
function recoverHermesCall(body: string): DerivedToolCall | undefined {
  return parseHermesPayload(body);
}

function createHermesStreamState(): ToolCallStreamState {
  return createMarkerStreamState({
    startMarker: START_MARKER,
    endMarker: END_MARKER,
    parseCall: parseHermesPayload,
    recoverUnclosed: recoverHermesCall,
  });
}

/**
 * The Hermes tool-call parser, `hermes@1` (TOOL_CALL_PARSER_V1):
 * `<tool_call>{"name": "...", "arguments": {...}}</tool_call>`.
 *
 * Covers NousResearch's Hermes series and the Qwen line that adopted the same format. Blocks close
 * at the first `</tool_call>`, matched on bytes even inside a JSON string; whitespace-only text
 * between blocks or after the last one is layout and dropped; a malformed block is content and
 * leaves the others alone.
 *
 * Conformance is `'vector-verified'`: it passes wire's shared vectors
 * (`testdata/v1/parser/tool_call_hermes_v1.json`).
 */
export const hermesParser: ToolCallParser = {
  name: 'hermes',
  version: 1,
  parseComplete(text: string, opts?: ToolCallParseOptions): DerivedAssistantMessage {
    // Reuse the streaming machine so the full-text and streaming paths cannot diverge: a chunk
    // boundary is the Worker's choice and must not change the parse (design S7 requirement 1).
    const state = createHermesStreamState();
    const events = [...state.push(text), ...state.finish(opts)];
    let content = '';
    const toolCalls: DerivedToolCall[] = [];
    for (const event of events) {
      if (event.kind === 'content') content += event.text;
      else toolCalls.push(event.call);
    }
    return { role: 'assistant', content, toolCalls };
  },
  createStreamState: createHermesStreamState,
};
