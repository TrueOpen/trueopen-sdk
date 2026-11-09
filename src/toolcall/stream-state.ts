import { TrueOpenError } from '../errors/errors';
import { indexOfOutsideQuotes, partialMarkerSuffix, unterminatedQuoteSuffix } from './marker-scan';
import type { ToolCallStreamEvent, DerivedToolCall, ToolCallFinishOptions, ToolCallStreamState } from './types';

export interface MarkerStreamOptions {
  readonly startMarker: string;
  readonly endMarker: string;
  /**
   * Turns the text between the markers into a call, or into several (an array, one per function in
   * the block), or returns `undefined` -- or an empty array, which means the same -- when the
   * segment is not a call after all: invalid argument JSON, a name that is not there. Returning
   * `undefined` is not an error path (design S6 row one): the raw segment flows on as content,
   * exactly as it would when calling an inference engine directly.
   */
  readonly parseCall: (inner: string) => DerivedToolCall | readonly DerivedToolCall[] | undefined;
  /**
   * Whether a marker inside a double-quoted span is skipped; default false. TOOL_CALL_PARSER_V1
   * (Common contract, Blocks) matches markers on bytes, inside a JSON string or a parameter value
   * alike, so no v1 parser sets this. It remains for a custom parser whose own spec asks for it.
   */
  readonly quoteAware?: boolean;
  /**
   * The parser's recovery of an unclosed final call (Manifest S7.2 rule 6), given everything after
   * the start marker, raw, as committed. It decides what may be recovered and how a partial end
   * marker at the very end is handled, and returns the call(s), or `undefined` / an empty array
   * for none. Consulted only when `finish` is told the model stopped by itself. A parser that
   * leaves it out defines no recovery: its unclosed final segment is always content.
   */
  readonly recoverUnclosed?: (body: string) => DerivedToolCall | readonly DerivedToolCall[] | undefined;
}

/** The four whitespace bytes of TOOL_CALL_PARSER_V1 (SP, HT, LF, CR); no Unicode space counts. */
const LAYOUT = /^[ \t\n\r]*$/;

/**
 * The incremental state machine of design S7, with TOOL_CALL_PARSER_V1's Common contract.
 *
 * ```text
 *         +--------------------------------------+
 *         v                                      |
 *    +--------+  start marker   +-----------+    | first end marker
 *    |  Text  |---------------->| Buffering |----+ -> emit its tool call(s), or its raw bytes
 *    +--------+                 +-----------+       as content when it yields none
 *         | ordinary bytes            | end of stream, still unclosed
 *         v emit as content           v raw bytes as content, or the parser's recovery when
 *                                       the model stopped by itself
 * ```
 *
 * Blocks: a block opens at a start marker and closes at the first end marker after it, matched on
 * bytes. A start marker inside an open block is payload; an end marker outside any block is text.
 *
 * Content: text outside blocks is content verbatim, except that a whitespace-only segment between
 * two blocks, or after the last one, is layout and is dropped. Text before the first block is
 * always kept. An unclosed block is still a block, so the layout before it is dropped too. In the
 * stream, whitespace after a block is held until it is known to be layout or text.
 *
 * The edge back to `Text` is load-bearing: the chat path has no stop conditions (design S13.3),
 * so generation continues past a closing marker. Content can follow a completed call, and one
 * output can contain several.
 */
export function createMarkerStreamState(opts: MarkerStreamOptions): ToolCallStreamState {
  const { startMarker, endMarker, parseCall } = opts;
  if (startMarker === '' || endMarker === '') {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'TOOLCALL_MARKER_EMPTY',
      'start and end markers must both be non-empty; an empty marker matches at every position',
    );
  }

  const quoteAware = opts.quoteAware === true;
  const find = (text: string, marker: string): number =>
    quoteAware ? indexOfOutsideQuotes(text, marker) : text.indexOf(marker);
  /** Pushes the call(s) `parse` finds, or returns false when there are none. */
  function emitCalls(events: ToolCallStreamEvent[], inner: string, parse = parseCall): boolean {
    const parsed = parse(inner);
    const calls: readonly DerivedToolCall[] =
      parsed === undefined ? [] : Array.isArray(parsed) ? parsed : [parsed as DerivedToolCall];
    if (calls.length === 0) return false;
    for (const call of calls) {
      events.push({ kind: 'tool-call-provisional', call });
    }
    return true;
  }

  let buffer = '';
  let buffering = false;
  /** A block has been seen, so the outside segment being read may be layout. */
  let afterBlock = false;
  /** The current outside segment already held non-whitespace, so it is text, not layout. */
  let segmentIsText = false;

  /** Whether an outside segment that ended (at a start marker or end of input) is dropped as layout. */
  const isLayout = (segment: string): boolean => afterBlock && !segmentIsText && LAYOUT.test(segment);

  /** Consumes as much of `buffer` as is unambiguous. `atEnd` releases every holdback. */
  function drain(atEnd: boolean, recover = false): ToolCallStreamEvent[] {
    const events: ToolCallStreamEvent[] = [];
    for (;;) {
      if (!buffering) {
        const at = find(buffer, startMarker);
        if (at < 0) {
          if (atEnd) {
            if (buffer !== '' && !isLayout(buffer)) events.push({ kind: 'content', text: buffer });
            buffer = '';
            return events;
          }
          // Everything except a suffix that could still grow into the start marker (or, for a
          // quote-aware custom parser, an as-yet-unclosed quote span).
          const held = Math.max(partialMarkerSuffix(buffer, [startMarker]), quoteAware ? unterminatedQuoteSuffix(buffer) : 0);
          const text = buffer.slice(0, buffer.length - held);
          // Whitespace after a block waits until it is known whether it is layout.
          if (afterBlock && !segmentIsText && LAYOUT.test(text)) return events;
          if (afterBlock) segmentIsText = true;
          buffer = held === 0 ? '' : buffer.slice(buffer.length - held);
          if (text !== '') events.push({ kind: 'content', text });
          return events;
        }
        const before = buffer.slice(0, at);
        if (before !== '' && !isLayout(before)) events.push({ kind: 'content', text: before });
        buffer = buffer.slice(at + startMarker.length);
        buffering = true;
        afterBlock = true;
        segmentIsText = false;
        continue;
      }

      const at = find(buffer, endMarker);
      if (at < 0) {
        // Unbounded buffering: while the block remains open, the entire content is retained -- a
        // start marker that never closes grows the buffer for the stream's life. Text inside an
        // open block cannot be classified as call-versus-content until it resolves, so nothing in
        // it can be emitted early. No bound is imposed because capping overflow requires choosing
        // what happens on excess (drop output? error?), a policy decision design S7 leaves open.
        if (!atEnd) return events;
        // TOOL_CALL_PARSER_V1 Recovery: when the model stopped by itself and the parser defines
        // recovery, it may read the unclosed block as a call whose end marker was never written.
        // Otherwise -- truncated, no recovery defined, or nothing recovered -- the unclosed block's
        // raw bytes are content, start marker included: neither dropped nor an error.
        if (recover && opts.recoverUnclosed !== undefined && emitCalls(events, buffer, opts.recoverUnclosed)) {
          buffer = '';
          buffering = false;
          return events;
        }
        events.push({ kind: 'content', text: startMarker + buffer });
        buffer = '';
        buffering = false;
        return events;
      }

      const inner = buffer.slice(0, at);
      buffer = buffer.slice(at + endMarker.length);
      buffering = false;
      segmentIsText = false;
      if (!emitCalls(events, inner)) {
        // Failure: a malformed block yields no call; its raw bytes, markers included, are content.
        events.push({ kind: 'content', text: startMarker + inner + endMarker });
      }
    }
  }

  return {
    push(text) {
      buffer += text;
      return drain(false);
    },
    finish(finishOpts?: ToolCallFinishOptions) {
      return drain(true, finishOpts?.recoverUnclosedAtEnd === true);
    },
  };
}
