import { TrueOpenError } from '../errors/errors';
import { indexOfOutsideQuotes, partialMarkerSuffix, unterminatedQuoteSuffix } from './marker-scan';
import type { ToolCallStreamEvent, DerivedToolCall, ToolCallParseOptions, ToolCallStreamState } from './types';

export interface MarkerStreamOptions {
  readonly startMarker: string;
  readonly endMarker: string;
  /**
   * Turns the text between the markers into a call, or returns `undefined` when the segment is
   * not a call after all -- invalid argument JSON, a name that is not there. Returning
   * `undefined` is not an error path (design S6 row one): the raw segment flows on as content,
   * exactly as it would when calling an inference engine directly.
   */
  readonly parseCall: (inner: string) => DerivedToolCall | readonly DerivedToolCall[] | undefined;
  /**
   * Whether a marker inside a double-quoted span is content (design S5.3); default true. Right
   * for a format whose payload is JSON (hermes@1). A format whose payload is plain text
   * (qwen3_coder@1, where a parameter value is free text and may hold one lone `"`) sets false:
   * there a quote means nothing, and honouring it would let a stray quote hide the end marker.
   */
  readonly quoteAware?: boolean;
}

/**
 * The incremental state machine of design S7.
 *
 * ```text
 *         +--------------------------------------+
 *         v                                      |
 *    +--------+  start marker   +-----------+    | closing marker
 *    |  Text  |---------------->| Buffering |----+ -> emit one tool call
 *    +--------+                 +-----------+
 *         | ordinary bytes            | end of stream, still unclosed
 *         v emit as content           v flush buffer as plain text, or recover
 *                                       the call when the model stopped by itself
 * ```
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

  const quoteAware = opts.quoteAware !== false;
  const find = (text: string, marker: string): number =>
    quoteAware ? indexOfOutsideQuotes(text, marker) : text.indexOf(marker);
  /** Pushes the call(s) of a segment, or returns false when it is not a call after all. */
  function emitCalls(events: ToolCallStreamEvent[], inner: string): boolean {
    const parsed = parseCall(inner);
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

  /** Consumes as much of `buffer` as is unambiguous. `atEnd` releases every holdback. */
  function drain(atEnd: boolean, recover = false): ToolCallStreamEvent[] {
    const events: ToolCallStreamEvent[] = [];
    for (;;) {
      if (!buffering) {
        const at = find(buffer, startMarker);
        if (at < 0) {
          // Everything except a suffix that could still grow into the start marker, or that is
          // an as-yet-unclosed quote span (its closing quote may arrive next frame).
          const held = atEnd
            ? 0
            : Math.max(partialMarkerSuffix(buffer, [startMarker]), quoteAware ? unterminatedQuoteSuffix(buffer) : 0);
          const text = buffer.slice(0, buffer.length - held);
          buffer = held === 0 ? '' : buffer.slice(buffer.length - held);
          if (text !== '') events.push({ kind: 'content', text });
          return events;
        }
        if (at > 0) events.push({ kind: 'content', text: buffer.slice(0, at) });
        buffer = buffer.slice(at + startMarker.length);
        buffering = true;
        continue;
      }

      const at = find(buffer, endMarker);
      if (at < 0) {
        // Unbounded buffering: while the segment remains open, the entire content is
        // retained — a start marker that never closes grows the buffer for the stream's
        // life. This is unavoidable: text inside an open segment cannot be classified as
        // call-versus-content until the segment resolves, so nothing in it can be emitted
        // early. No bound is imposed because capping overflow requires choosing what
        // happens on excess (drop output? error?), a policy decision design S7 leaves open.
        if (!atEnd) return events;
        // Design S7 requirement 6. When the model stopped by itself, a body that parses is a
        // complete call whose closing marker was simply never written (an end marker cut short
        // by the stop is dropped with it), as vLLM and Dynamo read it. Otherwise -- truncated,
        // or a body that does not parse -- the unclosed segment flushes as plain text, start
        // marker included: neither dropped nor an error.
        if (recover) {
          const inner = buffer.slice(0, buffer.length - partialMarkerSuffix(buffer, [endMarker]));
          if (emitCalls(events, inner)) {
            buffer = '';
            buffering = false;
            return events;
          }
        }
        events.push({ kind: 'content', text: startMarker + buffer });
        buffer = '';
        buffering = false;
        return events;
      }

      const inner = buffer.slice(0, at);
      buffer = buffer.slice(at + endMarker.length);
      buffering = false;
      if (!emitCalls(events, inner)) {
        events.push({ kind: 'content', text: startMarker + inner + endMarker });
      }
    }
  }

  return {
    push(text) {
      buffer += text;
      return drain(false);
    },
    finish(finishOpts?: ToolCallParseOptions) {
      return drain(true, finishOpts?.recoverUnclosedAtEnd === true);
    },
  };
}
