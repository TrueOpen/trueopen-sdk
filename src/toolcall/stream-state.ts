import { TrueOpenError } from '../errors/errors';
import { partialMarkerSuffix } from './marker-scan';
import type { AssistantStreamEvent, DerivedToolCall, ToolCallStreamState } from './types';

export interface MarkerStreamOptions {
  readonly startMarker: string;
  readonly endMarker: string;
  /**
   * Turns the text between the markers into a call, or returns `undefined` when the segment is
   * not a call after all -- invalid argument JSON, a name that is not there. Returning
   * `undefined` is not an error path (design S6 row one): the raw segment flows on as content,
   * exactly as it would when calling an inference engine directly.
   */
  readonly parseCall: (inner: string) => DerivedToolCall | undefined;
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
 *         v emit as content           v flush buffer as plain text
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

  let buffer = '';
  let buffering = false;

  /** Consumes as much of `buffer` as is unambiguous. `atEnd` releases every holdback. */
  function drain(atEnd: boolean): AssistantStreamEvent[] {
    const events: AssistantStreamEvent[] = [];
    for (;;) {
      if (!buffering) {
        const at = buffer.indexOf(startMarker);
        if (at < 0) {
          // Everything except a suffix that could still grow into the start marker.
          const held = atEnd ? 0 : partialMarkerSuffix(buffer, [startMarker]);
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

      const at = buffer.indexOf(endMarker);
      if (at < 0) {
        if (!atEnd) return events;
        // Design S7 requirement 2: an unclosed segment at end of stream flushes as plain text,
        // start marker included. A generation truncated by max_output_tokens produces exactly
        // this; it is neither dropped nor an error.
        events.push({ kind: 'content', text: startMarker + buffer });
        buffer = '';
        buffering = false;
        return events;
      }

      const inner = buffer.slice(0, at);
      buffer = buffer.slice(at + endMarker.length);
      buffering = false;
      const call = parseCall(inner);
      if (call === undefined) {
        events.push({ kind: 'content', text: startMarker + inner + endMarker });
      } else {
        events.push({ kind: 'tool-call-provisional', call });
      }
    }
  }

  return {
    push(text) {
      buffer += text;
      return drain(false);
    },
    finish() {
      return drain(true);
    },
  };
}
