const enc = new TextEncoder();

/**
 * Compares two strings by their UTF-8 bytes, which is what Manifest S2.6 rule 2 specifies
 * for object key ordering.
 *
 * JavaScript's `<` and `Array.prototype.sort` compare UTF-16 code units instead, and the two
 * orders are not merely different -- they are opposite above the BMP. A character at U+10000
 * is the surrogate pair 0xD800 0xDC00 in UTF-16 and so sorts below U+FFFF; in UTF-8 it is
 * `F0 90 80 80` and sorts above U+FFFF's `EF BF BF`. Every key in the V4 manifest is ASCII
 * today, where the two agree, which is exactly why this would go unnoticed.
 */
export function compareUtf8(a: string, b: string): number {
  if (a === b) return 0;
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const d = x[i]! - y[i]!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}
