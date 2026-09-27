import { describe, expect, it } from 'vitest';
import { compareUtf8 } from '../../src/manifest/canonical';

describe('compareUtf8', () => {
  it('orders ASCII the same way the default comparison does', () => {
    expect(compareUtf8('a', 'b')).toBeLessThan(0);
    expect(compareUtf8('b', 'a')).toBeGreaterThan(0);
    expect(compareUtf8('a', 'a')).toBe(0);
    expect(compareUtf8('a', 'ab')).toBeLessThan(0);
  });

  it('disagrees with JavaScript default ordering above the BMP', () => {
    // The case that makes this function necessary. In UTF-16 a character above the BMP is a
    // surrogate pair starting at 0xD800, which sorts BELOW 0xFFFF; in UTF-8 it is a 4-byte
    // sequence starting at 0xF0, which sorts ABOVE the 3-byte 0xEF. The two orders are
    // opposite, and Manifest S2.6 rule 2 specifies the UTF-8 one.
    const astral = '\u{10000}';
    const bmp = '￿';
    expect(astral < bmp).toBe(true);              // JavaScript's answer
    expect(compareUtf8(astral, bmp)).toBeGreaterThan(0); // UTF-8's answer, the correct one
  });

  it('is a total order: antisymmetric and transitive on a sample', () => {
    const xs = ['a', 'ab', 'b', 'é', '中', '\u{10000}', '￿', ''];
    for (const x of xs) expect(compareUtf8(x, x)).toBe(0);
    for (const x of xs) {
      for (const y of xs) {
        if (x === y) continue;
        expect(Math.sign(compareUtf8(x, y))).toBe(-Math.sign(compareUtf8(y, x)));
      }
    }
    const sorted = [...xs].sort(compareUtf8);
    for (let i = 0; i + 1 < sorted.length; i += 1) {
      expect(compareUtf8(sorted[i]!, sorted[i + 1]!)).toBeLessThanOrEqual(0);
    }
  });
});
