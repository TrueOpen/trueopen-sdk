/**
 * Marker scanning over accumulated text.
 *
 * Frame boundaries are chosen by the Worker and carry no semantics (design S7 requirement 1),
 * so a marker can straddle one. Matching therefore runs against the accumulated buffer, and a
 * marker that is only half present at the end of that buffer must be held back rather than
 * emitted as content -- once emitted it cannot be taken back.
 */

/** Longest suffix of `text` that is a prefix of `marker`, considering prefixes up to `maxLen`. */
function suffixPrefixLength(text: string, marker: string, maxLen: number): number {
  const max = Math.min(text.length, maxLen);
  for (let len = max; len > 0; len -= 1) {
    if (text.endsWith(marker.slice(0, len))) return len;
  }
  return 0;
}

/**
 * How many trailing characters could still grow into one of `markers`, counting **proper**
 * prefixes only.
 *
 * For the state machine, where a complete marker has already been located with `indexOf`: a
 * complete marker at the end is a match to act on, not a holdback.
 */
export function partialMarkerSuffix(text: string, markers: readonly string[]): number {
  let held = 0;
  for (const marker of markers) {
    const len = suffixPrefixLength(text, marker, marker.length - 1);
    if (len > held) held = len;
  }
  return held;
}

/**
 * How many trailing characters could still be, or grow into, one of `markers` -- **including
 * the whole marker**.
 *
 * For a marker that is only meaningful at end of stream, such as a trailing EOS: a complete one
 * must stay held back, because text arriving afterwards proves it was not trailing after all.
 */
export function pendingMarkerSuffix(text: string, markers: readonly string[]): number {
  let held = 0;
  for (const marker of markers) {
    const len = suffixPrefixLength(text, marker, marker.length);
    if (len > held) held = len;
  }
  return held;
}
