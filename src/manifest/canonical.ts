import { TrueOpenError } from '../errors/errors';

const enc = new TextEncoder();

/**
 * Checks if a string contains a lone surrogate (an unpaired surrogate code unit).
 * A high surrogate (0xD800-0xDBFF) must be followed by a low surrogate (0xDC00-0xDFFF),
 * and a low surrogate must be preceded by a high surrogate. Anything else is a lone surrogate,
 * which has no valid UTF-8 encoding.
 */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i)!;
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: must be followed by a low surrogate
      if (i + 1 >= s.length || !isLowSurrogate(s.charCodeAt(i + 1)!)) {
        return true;
      }
      i += 1; // Skip the low surrogate
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Low surrogate without a preceding high surrogate
      return true;
    }
  }
  return false;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Compares two strings by their UTF-8 bytes, which is what Manifest S2.6 rule 2 specifies
 * for object key ordering.
 *
 * JavaScript's `<` and `Array.prototype.sort` compare UTF-16 code units instead, and the two
 * orders are not merely different -- they are opposite above the BMP. A character at U+10000
 * is the surrogate pair 0xD800 0xDC00 in UTF-16 and so sorts below U+FFFF; in UTF-8 it is
 * `F0 90 80 80` and sorts above U+FFFF's `EF BF BF`. Every key in the V4 manifest is ASCII
 * today, where the two agree, which is exactly why this would go unnoticed.
 *
 * Rejects strings containing lone surrogates (unpaired surrogate code units), which have no
 * valid UTF-8 encoding. Such strings cannot appear in a canonical manifest, so failing loudly
 * on them is correct.
 */
export function compareUtf8(a: string, b: string): number {
  if (a === b) return 0;

  // Detect and reject lone surrogates before encoding
  if (hasLoneSurrogate(a)) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'MANIFEST_CANONICAL_LONE_SURROGATE',
      `String contains a lone surrogate which has no UTF-8 encoding and cannot appear in a canonical manifest: ${JSON.stringify(a)}`
    );
  }
  if (hasLoneSurrogate(b)) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'MANIFEST_CANONICAL_LONE_SURROGATE',
      `String contains a lone surrogate which has no UTF-8 encoding and cannot appear in a canonical manifest: ${JSON.stringify(b)}`
    );
  }

  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const d = x[i]! - y[i]!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}
