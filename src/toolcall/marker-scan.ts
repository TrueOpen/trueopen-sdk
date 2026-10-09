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

/** Skip a JSON string starting at `text[i] === '"'`; returns the index just past the closing quote. */
export function skipJsonString(text: string, i: number): number {
  i += 1; // opening quote
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      // Skip the escape and the escaped character. For `\uXXXX` this skips the backslash and
      // `u`, leaving the four hex digits as ordinary characters -- none is `"` or `\`, so they
      // cannot be mistaken for the closing quote.
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i += 1;
  }
  return i;
}

/**
 * First index of `marker` that is not inside a JSON string, or -1.
 *
 * A marker written as prose inside quotes ("here is `<tool_call>`") or as a string value in a
 * tool's argument JSON is visible content, not parser control syntax (design §5.3). Only an
 * unquoted marker is a real start/end marker, so this scan skips quoted spans.
 */
export function indexOfOutsideQuotes(text: string, marker: string, fromIndex = 0): number {
  let i = fromIndex;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i = skipJsonString(text, i);
      continue;
    }
    if (text.startsWith(marker, i)) return i;
    i += 1;
  }
  return -1;
}

/**
 * Length of the trailing span that begins with an as-yet-unclosed double quote, or 0 when the
 * quotes are balanced.
 *
 * In the Text state, a frame that ends inside a quoted span must not be emitted yet: the closing
 * quote may arrive in the next frame, and emitting now would make that closing quote look like
 * an opening quote, swallowing whatever marker follows. Held back alongside the partial-marker
 * suffix and released on finish.
 */
export function unterminatedQuoteSuffix(text: string): number {
  let inQuote = false;
  let lastOpen = -1;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') {
      if (inQuote) inQuote = false;
      else {
        inQuote = true;
        lastOpen = i;
      }
    }
    i += 1;
  }
  return inQuote ? text.length - lastOpen : 0;
}
