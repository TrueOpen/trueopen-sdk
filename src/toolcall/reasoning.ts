import { TrueOpenError } from '../errors/errors';
import { partialMarkerSuffix } from './marker-scan';
import type { ParserConformance } from './registry';
import type { ParserRef } from './types';

/**
 * Reasoning separation (Manifest S7.3, "SDK deterministic parsing contract").
 *
 * A reasoning parser splits the **leading** reasoning span off committed output, giving
 * `reasoning_content` and a remainder; only the remainder goes on to the tool-call parser
 * (rule 5). So a tool-call-shaped marker the model writes while reasoning is reasoning text and
 * never becomes a call (rule 7). Like tool calls, the result is a derived view: it never enters
 * output_hash, the receipt, evidence or the chain.
 *
 * The rules this implements, from S7.3:
 *   6. The span is the content between the parser's start and end markers at the very start of
 *      the output. Every parser declares the class of its start marker, one class only:
 *      - explicit: the start marker must open the output (after leading whitespace); when it is
 *        absent, or non-whitespace precedes it, there is no reasoning;
 *      - implicit: the start marker is deemed at offset 0, so the output opens in reasoning; one
 *        explicit start marker at the head (after leading whitespace) is absorbed. Reasoning runs
 *        from offset 0 to the first end marker.
 *   8. Fallbacks. Explicit: a start marker with no end marker (output cut off, e.g. by max
 *      tokens) makes everything from the start marker on reasoning_content, with an empty
 *      remainder; no marker or a malformed one means no reasoning, the whole output is the
 *      remainder. Implicit: no end marker (no marker at all included) makes the whole output
 *      reasoning_content, with an empty remainder, so no tool-call parsing runs. A parser this
 *      SDK lacks means no reasoning.
 *  10. Streaming recognises the markers incrementally, and reasoning before the end marker is
 *      provisional like everything else before the receipt.
 */
export interface ReasoningSplit {
  /** The reasoning text, markers excluded. Empty when there is no reasoning. */
  readonly reasoningContent: string;
  /** Everything after the reasoning span: the input to the tool-call parser. */
  readonly remainder: string;
}

export type ReasoningStreamEvent =
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'remainder'; readonly text: string };

/** Incremental split. `push` takes decoded text as it arrives; `finish` ends the stream. */
export interface ReasoningStreamState {
  push(text: string): readonly ReasoningStreamEvent[];
  finish(): readonly ReasoningStreamEvent[];
}

/**
 * The class of a parser's start marker (S7.3 rule 6), fixed per `(name, version)`: it never
 * switches by template, request or output. `explicit`: reasoning exists only when the output
 * opens with the start marker. `implicit`: the output opens in reasoning, start marker or not.
 */
export type ReasoningStartMarkerClass = 'explicit' | 'implicit';

export interface ReasoningParser extends ParserRef {
  readonly startMarkerClass: ReasoningStartMarkerClass;
  split(text: string): ReasoningSplit;
  createStreamState(): ReasoningStreamState;
}

export interface ReasoningMarkers {
  readonly startMarker: string;
  readonly endMarker: string;
  /** Declared by every parser (S7.3 rule 6); see `ReasoningStartMarkerClass`. */
  readonly startMarkerClass: ReasoningStartMarkerClass;
  /**
   * Whitespace dropped at the edges of the span: after the start marker and before the end
   * marker in `reasoningContent`, and after the end marker at the head of the remainder. The
   * model writes these as layout around the markers, not as content.
   */
  readonly trimNewlines?: boolean;
}

/**
 * Leading whitespace before a start marker (rule 6 only forbids non-whitespace). Exactly the ASCII
 * bytes SP, HT, LF and CR (REASONING_PARSER_V1, Whitespace): U+FEFF, U+00A0 and other Unicode
 * spaces are not whitespace, so `\s` would split differently from the Go and Rust parsers.
 */
const LEADING_WS = /^[ \t\n\r]*/;

function trimLeadingNewlines(s: string): string {
  return s.replace(/^\n+/, '');
}
function trimTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, '');
}

/**
 * A reasoning parser over one pair of start / end markers.
 *
 * Reasoning is only ever the leading span, so after the end marker (or after deciding there is
 * no reasoning) everything passes through untouched -- a later `<think>` is content.
 *
 * With an implicit start marker the output opens in reasoning: an explicit start marker at the
 * head (after leading whitespace, which goes with it) is absorbed, exactly one; otherwise the
 * span starts at offset 0. Either way it ends at the first end marker, or runs to the end.
 */
export function createMarkerReasoningParser(ref: ParserRef, markers: ReasoningMarkers): ReasoningParser {
  const { startMarker, endMarker } = markers;
  if (startMarker === '' || endMarker === '') {
    throw new TrueOpenError('SDK_LOCAL', 'REASONING_PARSER_MARKER_EMPTY', `${ref.name}@${ref.version}: markers must be non-empty`);
  }
  const implicit = markers.startMarkerClass === 'implicit';
  const trim = markers.trimNewlines === true;
  const body = (s: string) => (trim ? trimTrailingNewlines(trimLeadingNewlines(s)) : s);
  const tail = (s: string) => (trim ? trimLeadingNewlines(s) : s);

  return {
    name: ref.name,
    version: ref.version,
    startMarkerClass: markers.startMarkerClass,
    split(text) {
      const lead = LEADING_WS.exec(text)![0].length;
      let from: number;
      if (text.startsWith(startMarker, lead)) from = lead + startMarker.length;
      else if (implicit) from = 0; // the start marker is deemed at offset 0
      else return { reasoningContent: '', remainder: text };
      const end = text.indexOf(endMarker, from);
      // Rule 8: unclosed, so everything from the start marker (implicit: offset 0) on is reasoning.
      if (end < 0) return { reasoningContent: body(text.slice(from)), remainder: '' };
      return { reasoningContent: body(text.slice(from, end)), remainder: tail(text.slice(end + endMarker.length)) };
    },
    createStreamState(): ReasoningStreamState {
      // 'head': deciding whether the output opens with the start marker.
      // 'reasoning': inside the span. 'done': passing the remainder through.
      let phase: 'head' | 'reasoning' | 'done' = 'head';
      let buf = '';
      // Edge newlines are dropped as they are seen, so a newline held back here may turn out to be
      // the edge (before the end marker) and never be emitted, or content and be emitted later.
      let reasoningStarted = false;
      let pendingNewlines = '';
      let remainderStarted = false;

      const emitReasoning = (s: string, out: ReasoningStreamEvent[]) => {
        if (!trim) {
          if (s !== '') out.push({ kind: 'reasoning', text: s });
          return;
        }
        let t = s;
        if (!reasoningStarted) {
          t = trimLeadingNewlines(t);
          if (t === '') return;
          reasoningStarted = true;
        }
        // Trailing newlines may be the layout before the end marker, so they are held until more
        // reasoning follows them; at the end marker they are dropped.
        const joined = pendingNewlines + t;
        const core = trimTrailingNewlines(joined);
        pendingNewlines = joined.slice(core.length);
        if (core !== '') out.push({ kind: 'reasoning', text: core });
      };
      const emitRemainder = (s: string, out: ReasoningStreamEvent[]) => {
        let t = s;
        if (trim && !remainderStarted) {
          t = trimLeadingNewlines(t);
          if (t === '') return;
        }
        remainderStarted = true;
        out.push({ kind: 'remainder', text: t });
      };

      const drain = (final: boolean): ReasoningStreamEvent[] => {
        const out: ReasoningStreamEvent[] = [];
        if (phase === 'head') {
          const lead = LEADING_WS.exec(buf)![0].length;
          const rest = buf.slice(lead);
          if (rest.startsWith(startMarker)) {
            phase = 'reasoning';
            buf = rest.slice(startMarker.length);
          } else if (!final && startMarker.startsWith(rest)) {
            return out; // could still become the start marker
          } else if (implicit) {
            phase = 'reasoning'; // no explicit marker: reasoning from offset 0, whitespace included
          } else {
            phase = 'done';
            remainderStarted = true; // no reasoning: the output is passed through untouched
            const all = buf;
            buf = '';
            if (all !== '') out.push({ kind: 'remainder', text: all });
            return out;
          }
        }
        if (phase === 'reasoning') {
          const end = buf.indexOf(endMarker);
          if (end >= 0) {
            emitReasoning(buf.slice(0, end), out);
            const after = buf.slice(end + endMarker.length);
            phase = 'done';
            buf = '';
            if (after !== '') emitRemainder(after, out);
            return out;
          }
          const hold = final ? 0 : partialMarkerSuffix(buf, [endMarker]);
          emitReasoning(buf.slice(0, buf.length - hold), out);
          buf = buf.slice(buf.length - hold);
          return out;
        }
        if (buf !== '') {
          emitRemainder(buf, out);
          buf = '';
        }
        return out;
      };

      return {
        push(text) {
          buf += text;
          return drain(false);
        },
        finish() {
          return drain(true);
        },
      };
    },
  };
}

/**
 * `qwen3@1`: Qwen3's `<think>` ... `</think>` span, with an **implicit** start marker (S7.3
 * rule 6). A Qwen3 thinking template may put `<think>` in the prompt (forced thinking), so the
 * output opens in reasoning whether or not the model writes `<think>` itself; one it does write
 * at the head is absorbed. Reasoning ends at the first `</think>`; without one the whole output
 * is reasoning and no tool call is parsed (rule 8). A profile whose template does not think
 * pins no reasoning parser. The template renders a turn as `<think>\n` + reasoning +
 * `\n</think>\n\n` + content, so those newlines are layout and are dropped (wire has not fixed
 * the exact trimming yet).
 *
 * Unverified: wire has not published the reasoning parser vectors (S7.3 rule 11).
 */
export const qwen3ReasoningParser: ReasoningParser = createMarkerReasoningParser(
  { name: 'qwen3', version: 1 },
  { startMarker: '<think>', endMarker: '</think>', startMarkerClass: 'implicit', trimNewlines: true },
);

export interface ReasoningRegistryEntry {
  readonly parser: ReasoningParser;
  readonly conformance: ParserConformance;
}

export type ReasoningSupport =
  | { readonly supported: true; readonly parser: ReasoningParser }
  | { readonly supported: false; readonly reason: 'parser-not-pinned' | 'parser-unknown' | 'parser-unverified' };

export interface ReasoningRegistry {
  lookup(ref: ParserRef, opts?: { readonly allowUnverified?: boolean }): ReasoningSupport;
}

const key = (ref: ParserRef): string => JSON.stringify([ref.name, ref.version]);

export function createReasoningRegistry(entries: readonly ReasoningRegistryEntry[]): ReasoningRegistry {
  const byKey = new Map<string, ReasoningRegistryEntry>();
  for (const entry of entries) {
    if (!Number.isInteger(entry.parser.version) || entry.parser.version < 1) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'REASONING_PARSER_VERSION_INVALID',
        `reasoning parser ${entry.parser.name} has version ${entry.parser.version}; the manifest spec requires an integer >= 1`,
      );
    }
    const k = key(entry.parser);
    if (byKey.has(k)) {
      throw new TrueOpenError('SDK_LOCAL', 'REASONING_PARSER_DUPLICATE', `two reasoning parsers registered for ${entry.parser.name}@${entry.parser.version}`);
    }
    byKey.set(k, entry);
  }
  return {
    lookup(ref, opts) {
      if (ref.name === '') return { supported: false, reason: 'parser-not-pinned' };
      const entry = byKey.get(key(ref));
      if (entry === undefined) return { supported: false, reason: 'parser-unknown' };
      if (entry.conformance === 'unverified' && opts?.allowUnverified !== true) {
        return { supported: false, reason: 'parser-unverified' };
      }
      return { supported: true, parser: entry.parser };
    },
  };
}

/**
 * The reasoning parsers this build ships, all unverified until wire publishes their vectors. An
 * unverified parser is used only when the caller passes `allowUnverified`.
 */
export const BUILTIN_REASONING_PARSERS: ReasoningRegistry = createReasoningRegistry([
  { parser: qwen3ReasoningParser, conformance: 'unverified' },
]);
