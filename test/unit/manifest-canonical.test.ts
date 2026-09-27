import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compareUtf8, canonicalJsonV1 } from '../../src/manifest/canonical';
import { TrueOpenError } from '../../src/errors/errors';

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

  it('rejects a lone surrogate rather than calling two distinct strings equal', () => {
    // TextEncoder maps every unpaired surrogate to U+FFFD, so '\uD800' and '\uD801' would
    // otherwise encode identically and compare equal despite being different strings. A
    // comparator that returns 0 for distinct keys makes the sort fall back to insertion
    // order, which would make the "canonical" bytes depend on the parser. Reachable: JSON
    // can carry such a key via \ud800 escapes.
    expect(() => compareUtf8('\uD800', '\uD801')).toThrow(TrueOpenError);
    expect(() => compareUtf8('a', '\uDC00')).toThrow(TrueOpenError);
  });

  it('accepts a well-formed surrogate pair, which does have a UTF-8 encoding', () => {
    expect(() => compareUtf8('\u{10000}', 'a')).not.toThrow();
    expect(compareUtf8('\u{10000}', 'a')).toBeGreaterThan(0);
  });
});

const VECTOR = JSON.parse(
  readFileSync('test/fixtures/wire/model_manifest_v4.json', 'utf8'),
) as { manifest: Record<string, unknown>; vectors: { payload_utf8: string }[] };

/**
 * Reverses every object's key order, recursively. The vector's manifest arrives already in
 * canonical key order, so `JSON.stringify` on it happens to equal `payload_utf8` exactly --
 * a serializer that never sorted would pass. Feeding it in the wrong order is what makes the
 * test about sorting. Reversal rather than a random shuffle keeps failures reproducible.
 */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).reverse()) {
      out[k] = reverseKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

describe('canonicalJsonV1', () => {
  it('reproduces wire\'s payload from a manifest whose keys arrive in the wrong order', () => {
    const shuffled = reverseKeys(VECTOR.manifest);
    expect(JSON.stringify(shuffled)).not.toBe(VECTOR.vectors[0]!.payload_utf8); // the test has teeth
    expect(canonicalJsonV1(shuffled)).toBe(VECTOR.vectors[0]!.payload_utf8);
  });

  it('emits no whitespace', () => {
    expect(canonicalJsonV1({ b: 1, a: [1, 2] })).toBe('{"a":[1,2],"b":1}');
  });

  it('keeps array order, since only object keys are sorted', () => {
    expect(canonicalJsonV1({ xs: ['c', 'a', 'b'] })).toBe('{"xs":["c","a","b"]}');
  });

  it('does not escape non-ASCII', () => {
    // Rule 4: shortest valid escape. A raw UTF-8 character is shorter than \uXXXX.
    expect(canonicalJsonV1({ k: '中' })).toBe('{"k":"中"}');
  });

  it('rejects a float, an exponent and a non-integer number', () => {
    // Rule 5 permits only decimal integers. A float reaching the encoder means a u64 was
    // parsed as an IEEE double somewhere upstream, which is the failure rule 5 exists to stop.
    expect(() => canonicalJsonV1({ k: 1.5 })).toThrow();
    expect(() => canonicalJsonV1({ k: 1e21 })).toThrow();
    expect(() => canonicalJsonV1({ k: NaN })).toThrow();
  });

  it('rejects undefined and null rather than dropping or emitting them', () => {
    // Rule 9 fixes explicit empty values per type and rule 10 rejects null, so a nullish
    // value here means the document was not normalised before encoding.
    expect(() => canonicalJsonV1({ k: null })).toThrow();
    expect(() => canonicalJsonV1({ k: undefined })).toThrow();
  });

  it('accepts a bigint and emits it as a decimal integer', () => {
    // The only safe representation for a u64 above 2^53.
    expect(canonicalJsonV1({ k: 18446744073709551615n })).toBe('{"k":18446744073709551615}');
  });
});
