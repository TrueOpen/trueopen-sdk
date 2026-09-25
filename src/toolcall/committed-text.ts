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
 * one (design S8). Phase 1 takes them from the caller; phase 3 from the manifest's
 * `output_decoding`.
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
