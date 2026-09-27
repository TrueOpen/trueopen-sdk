import { skipJsonString } from '../marker-scan';
import { createMarkerStreamState } from '../stream-state';
import type { DerivedAssistantMessage, DerivedToolCall, ToolCallParser } from '../types';

const START_MARKER = '<tool_call>';
const END_MARKER = '</tool_call>';

/**
 * Parse the text between `<tool_call>` and `</tool_call>` into a derived call.
 *
 * The model writes `{"name": "...", "arguments": {...}}` (key order may vary, and there may be
 * surrounding whitespace or newlines). `name` is a plain string whose decoded value is exactly
 * what the model wrote; `arguments`, being a nested JSON value, must be preserved
 * byte-for-byte -- re-serializing through `JSON.parse`/`stringify` would reorder keys and change
 * the bytes the cross-language vectors pin (design S3).
 *
 * Returns `undefined` when the segment is not a call after all: invalid JSON, a non-object, or
 * no string `name`. That is not an error path (design S6 row one); the raw segment flows on as
 * content, exactly as it would when calling an inference engine directly.
 *
 * A name-only call `{"name": "get_weather"}` recovers with `arguments: "{}"`, mirroring
 * Dynamo's `allow_name_only_call` (empty-arg recovery). The `"{}"` is synthesized -- the model
 * wrote no arguments -- so there are no model bytes to preserve.
 *
 * A marker inside a quoted span is content, not control syntax (design §5.3): the state machine
 * that frames this parser skips quoted spans when locating markers, so an argument string that
 * happens to contain the literal `</tool_call>` does not close the call early.
 */
function parseHermesCall(inner: string): DerivedToolCall | undefined {
  let value: unknown;
  try {
    value = JSON.parse(inner);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const name = (value as { name?: unknown }).name;
  if (typeof name !== 'string') return undefined;

  const args = extractRawArguments(inner);
  return { name, arguments: args ?? '{}' };
}

function isJsonWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function skipWhitespace(text: string, i: number): number {
  while (i < text.length && isJsonWhitespace(text[i])) i += 1;
  return i;
}

/** Skip a balanced JSON container starting at `text[i]` (`{` or `[`); returns the index past it. */
function skipBalanced(text: string, i: number, open: string, close: string): number {
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i = skipJsonString(text, i);
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

/** Skip one JSON value starting at `text[i]`; returns the index just past it. */
function skipJsonValue(text: string, i: number): number {
  const ch = text[i];
  if (ch === '"') return skipJsonString(text, i);
  if (ch === '{') return skipBalanced(text, i, '{', '}');
  if (ch === '[') return skipBalanced(text, i, '[', ']');
  // Scalar: number, true, false, null. Scan to the next delimiter (`,` or `}` at top level).
  let j = i;
  while (j < text.length && !isJsonWhitespace(text[j]) && text[j] !== ',' && text[j] !== '}') {
    j += 1;
  }
  return j;
}

/**
 * Extract the raw bytes of the top-level `"arguments"` member's value, or `undefined` when the
 * object has no such member. The object is already known to be valid JSON (JSON.parse succeeded
 * above), so this is a structural scan, not a second validation.
 */
function extractRawArguments(inner: string): string | undefined {
  let i = skipWhitespace(inner, 0);
  if (inner[i] !== '{') return undefined;
  i += 1;
  for (;;) {
    i = skipWhitespace(inner, i);
    if (inner[i] === '}') return undefined; // reached the end; no "arguments"
    if (inner[i] !== '"') return undefined;
    const keyStart = i;
    i = skipJsonString(inner, i);
    // Keys are plain ASCII identifiers ("name", "arguments"), so slicing the quotes off is
    // exact; the surrounding JSON.parse already validated the object.
    const key = inner.slice(keyStart + 1, i - 1);
    i = skipWhitespace(inner, i);
    if (inner[i] !== ':') return undefined;
    i = skipWhitespace(inner, i + 1);
    const valueStart = i;
    i = skipJsonValue(inner, i);
    if (key === 'arguments') return inner.slice(valueStart, i);
    i = skipWhitespace(inner, i);
    if (inner[i] === ',') {
      i += 1;
      continue;
    }
    if (inner[i] === '}') return undefined;
    return undefined;
  }
}

/**
 * The Hermes tool-call parser: `<tool_call>{"name": "...", "arguments": {...}}</tool_call>`.
 *
 * Covers NousResearch's Hermes series and the Qwen 2.5 line that adopted the same format, and
 * is the shape `tool-call-design.md` S2 sketches as `parsers/hermes.ts`.
 *
 * Conformance is `'unverified'`: ADR-0022 decision four's shared vectors do not exist yet
 * (monorepo#11), so this parser is not registered in the built-in registry by default. A caller
 * registers it through `createToolCallRegistry` and opts in with `allowUnverified`.
 */
export const hermesParser: ToolCallParser = {
  name: 'hermes',
  version: 1,
  endMarkers: [END_MARKER],
  parseComplete(text: string): DerivedAssistantMessage {
    // Reuse the streaming machine so the full-text and streaming paths cannot diverge: a chunk
    // boundary is the Worker's choice and must not change the parse (design S7 requirement 1).
    const state = createMarkerStreamState({
      startMarker: START_MARKER,
      endMarker: END_MARKER,
      parseCall: parseHermesCall,
    });
    const events = [...state.push(text), ...state.finish()];
    let content = '';
    const toolCalls: DerivedToolCall[] = [];
    for (const event of events) {
      if (event.kind === 'content') content += event.text;
      else toolCalls.push(event.call);
    }
    return { role: 'assistant', content, toolCalls };
  },
  createStreamState() {
    return createMarkerStreamState({
      startMarker: START_MARKER,
      endMarker: END_MARKER,
      parseCall: parseHermesCall,
    });
  },
};
