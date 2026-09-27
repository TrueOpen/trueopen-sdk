import { TrueOpenError } from '../errors/errors';
import { pendingMarkerSuffix } from './marker-scan';

/**
 * Remove one trailing end-of-sequence marker.
 *
 * ADR-0022 v1.4 fixes `output_decoding.strip_trailing_eos = true`: committed output is the
 * decoded tokens with the trailing EOS removed. Cortex does not do this yet (design S13.2) --
 * it concatenates every token's bytes including the trailing EOS -- so the SDK strips it if
 * present. When cortex catches up, this keeps working: there is simply nothing left to strip.
 *
 * **This is the only place in the SDK that does it.** A parser that tolerated a trailing marker
 * would be written against behaviour scheduled to disappear, and would then disagree with the
 * cross-language vectors, which are authored against the spec rather than against today's
 * producer. Keeping it here makes its eventual deletion a one-line change.
 *
 * `markers` are decoded strings, not token ids: the SDK has no tokenizer and must not acquire
 * one (design S8). They come from the caller and always will: Manifest S7.1 states outright
 * that the SDK is not EOS-aware and needs no tokenizer, and its `eos_token_ids` are `[]u32`
 * token ids, which nothing here could turn into strings anyway. So this is not a phase-1
 * placeholder for a manifest lookup -- it is a tolerance for a producer that has not caught
 * up, and when Cortex strips the EOS itself the right move is to delete it rather than
 * source it from somewhere.
 *
 * Exactly one marker is removed. A doubled EOS is not normal output, and silently collapsing a
 * run of them would hide that.
 */
export function stripTrailingEos(text: string, markers: readonly string[]): string {
  let longest = 0;
  for (const marker of markers) {
    // Longest match, so the result does not depend on the order the caller listed them in.
    if (marker !== '' && marker.length > longest && text.endsWith(marker)) longest = marker.length;
  }
  return longest === 0 ? text : text.slice(0, text.length - longest);
}

/**
 * The EOS/end-marker collision guard (design S10.3).
 *
 * `deriveAssistantStream` runs the EOS stripper *before* the marker state machine, so a
 * configured EOS marker that overlaps the parser's end marker would let the stripper
 * withhold the characters that complete the end marker, silently losing the tool call as
 * plain text. Reject that combination instead.
 *
 * The check must be symmetric: with end `</tc>` and EOS `}</tc>`, `'</tc>'.endsWith('}</tc>')`
 * is false yet the call is lost and a `}` eaten, so a one-sided check misses it.
 */
export function assertNoEndMarkerCollision(
  endMarkers: readonly string[],
  trailingEosMarkers: readonly string[],
): void {
  for (const end of endMarkers) {
    for (const eos of trailingEosMarkers) {
      if (end.endsWith(eos) || eos.endsWith(end)) {
        throw new TrueOpenError(
          'SDK_LOCAL',
          'TOOLCALL_END_MARKER_COLLISION',
          `parser end marker ${JSON.stringify(end)} collides with EOS marker ${JSON.stringify(eos)}`,
        );
      }
    }
  }
}

/**
 * The streaming form of `stripTrailingEos`.
 *
 * A marker is only *trailing* once the stream has ended, so any suffix that could still be, or
 * grow into, one is held back and released by `finish()`. Without that, an EOS arriving as its
 * own final frame -- or split across the last two -- would already have been delivered as
 * content before the stream ended, and content cannot be taken back.
 */
export class TrailingEosStripper {
  private readonly markers: readonly string[];
  private buffer = '';

  constructor(markers: readonly string[]) {
    this.markers = markers.filter((marker) => marker !== '');
  }

  /** Feeds the next decoded text; returns the part that can no longer become a trailing marker. */
  push(text: string): string {
    this.buffer += text;
    if (this.markers.length === 0) {
      const all = this.buffer;
      this.buffer = '';
      return all;
    }
    const held = pendingMarkerSuffix(this.buffer, this.markers);
    const safe = this.buffer.slice(0, this.buffer.length - held);
    this.buffer = held === 0 ? '' : this.buffer.slice(this.buffer.length - held);
    return safe;
  }

  /** Ends the stream; returns the held tail with a trailing marker removed if it is one. */
  finish(): string {
    const tail = stripTrailingEos(this.buffer, this.markers);
    this.buffer = '';
    return tail;
  }
}
