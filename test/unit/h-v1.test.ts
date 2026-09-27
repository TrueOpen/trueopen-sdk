import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { hV1, hV1Preimage } from '../../src/codec/h-v1';
import { canonicalFrameBytes } from '../../src/codec/domain-hash';
import { toHex, fromHex } from '../../src/util/bytes';

const VECTOR = JSON.parse(
  readFileSync('test/fixtures/wire/model_manifest_v4.json', 'utf8'),
) as { vectors: { name: string; domain: string; framing: string; preimage_hex: string; preimage_size_bytes: number; digest_hex: string; payload_utf8: string }[] };

const v = VECTOR.vectors[0]!;

describe('H_V1 framing', () => {
  it('reproduces wire\'s preimage byte for byte', () => {
    const payload = new TextEncoder().encode(v.payload_utf8);
    const pre = hV1Preimage(v.domain, payload);
    expect(pre.length).toBe(v.preimage_size_bytes);
    expect(toHex(pre)).toBe(v.preimage_hex);
  });

  it('reproduces wire\'s digest', () => {
    const payload = new TextEncoder().encode(v.payload_utf8);
    expect(toHex(hV1(v.domain, payload))).toBe(v.digest_hex);
  });

  it('lays the frame out as prefix, u32 domain length, domain, u64 payload length, payload', () => {
    // The asymmetry (4 bytes for the domain, 8 for the payload) is the part most likely to
    // be "corrected" by someone who assumes both are the same width, so it is pinned here
    // rather than left implicit in the vector comparison above.
    const pre = hV1Preimage('AB', new Uint8Array([0xff]));
    expect(new TextDecoder().decode(pre.slice(0, 17))).toBe('TRUEOPEN_FRAME_V1');
    expect(toHex(pre.slice(17, 21))).toBe('00000002');          // u32 len('AB')
    expect(new TextDecoder().decode(pre.slice(21, 23))).toBe('AB');
    expect(toHex(pre.slice(23, 31))).toBe('0000000000000001');  // u64 len(payload)
    expect(toHex(pre.slice(31))).toBe('ff');
    expect(pre.length).toBe(17 + 4 + 2 + 8 + 1);
  });

  it('is not H_FIELDS_V1', () => {
    // Both take a domain and bytes and return a preimage. They are different framings, and
    // a caller reaching for the wrong one would compute a hash that verifies against
    // nothing. This asserts they disagree rather than trusting the reader to notice.
    const payload = new Uint8Array([1, 2, 3]);
    const a = hV1Preimage('D', payload);
    const b = canonicalFrameBytes(new TextEncoder().encode('D'), payload);
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it('rejects a domain that is not ASCII, since the length prefix counts bytes not characters', () => {
    // Not a hypothetical constraint: a u32 length over UTF-8 bytes is correct, but a
    // multi-byte domain would make the prefix disagree with a reader who counted characters.
    // Every registered domain is ASCII, so refusing the rest keeps the ambiguity out.
    expect(() => hV1Preimage('Dé', new Uint8Array())).toThrow();
  });
});
