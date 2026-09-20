import { describe, it, expect } from 'vitest';
import { mmrLeaf, mmrNode, mmrEmpty, mmrRoot, mmrPrefixRoot, MmrAccumulator } from '../../src/codec/mmr';
import { sha256 } from '../../src/codec/hash';
import { concatBytes, toHex } from '../../src/util/bytes';
import { readFileSync } from 'node:fs';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const u32be = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const u64be = (n: bigint): Uint8Array => {
  const o = new Uint8Array(8);
  for (let i = 0; i < 8; i++) o[i] = Number((n >> BigInt(8 * (7 - i))) & 0xffn);
  return o;
};
const D = 'TRUEOPEN_OUTPUT_MMR_V1';

describe('MMR_ROOT_V1 preimage', () => {
  it('leaf preimage matches an independent recomputation per spec (domain length u32, leaf length u64)', () => {
    const leaf = utf8('hello');
    const expected = sha256(concatBytes(utf8('TRUEOPEN_MMR_LEAF_V1'), u32be(D.length), utf8(D), u64be(3n), u64be(5n), leaf));
    expect(toHex(mmrLeaf(D, 3n, leaf))).toBe(toHex(expected));
  });

  it('node preimage: left and right are concatenated as-is, with no length prefix', () => {
    const l = new Uint8Array(32).fill(0xaa);
    const r = new Uint8Array(32).fill(0xbb);
    const expected = sha256(concatBytes(utf8('TRUEOPEN_MMR_NODE_V1'), u32be(D.length), utf8(D), l, r));
    expect(toHex(mmrNode(D, l, r))).toBe(toHex(expected));
  });

  it('empty tree root is not 32 zero bytes', () => {
    const expected = sha256(concatBytes(utf8('TRUEOPEN_MMR_EMPTY_V1'), u32be(D.length), utf8(D)));
    expect(toHex(mmrEmpty(D))).toBe(toHex(expected));
    expect(toHex(mmrEmpty(D))).not.toBe('00'.repeat(32));
  });

  it('the same content at different indexes produces different leaves (index is part of the preimage)', () => {
    const leaf = utf8('x');
    expect(toHex(mmrLeaf(D, 0n, leaf))).not.toBe(toHex(mmrLeaf(D, 1n, leaf)));
  });

  it('index out of range is rejected, not silently truncated (2^64 and 0 would otherwise collide into the same leaf)', () => {
    const leaf = utf8('x');
    expect(() => mmrLeaf(D, 2n ** 64n, leaf)).toThrow(/index out of uint64 range/);
    expect(() => mmrLeaf(D, -1n, leaf)).toThrow(/index out of uint64 range/);
    // The maximum value within range is still usable
    expect(() => mmrLeaf(D, 2n ** 64n - 1n, leaf)).not.toThrow();
  });

  it('empty leaf_bytes is a valid leaf (ADR-0017: empty output is a zero-length leaf)', () => {
    const empty = mmrLeaf(D, 0n, new Uint8Array(0));
    expect(empty).toHaveLength(32);
    expect(toHex(empty)).not.toBe(toHex(mmrLeaf(D, 0n, utf8('x'))));
    // Must also differ from the empty tree root, otherwise "empty output" and "no output" would be indistinguishable
    expect(toHex(empty)).not.toBe(toHex(mmrEmpty(D)));
  });

  it('domain that is empty or exceeds 128 bytes is rejected', () => {
    const leaf = utf8('x');
    expect(() => mmrLeaf('', 0n, leaf)).toThrow(/domain length/);
    expect(() => mmrLeaf('x'.repeat(129), 0n, leaf)).toThrow(/domain length/);
    expect(() => mmrLeaf('x'.repeat(128), 0n, leaf)).not.toThrow();
  });

  it('node hashing is not commutative: swapping left and right yields a different hash', () => {
    const l = new Uint8Array(32).fill(1);
    const r = new Uint8Array(32).fill(2);
    expect(toHex(mmrNode(D, l, r))).not.toBe(toHex(mmrNode(D, r, l)));
  });
});

describe('MMR peak shape and folding', () => {
  const leaves = (n: number): Uint8Array[] => Array.from({ length: n }, (_, i) => utf8(`chunk-${i}`));

  it('n=1: the root is just that leaf, with no extra node wrapping', () => {
    const l = leaves(1);
    expect(toHex(mmrRoot(D, l))).toBe(toHex(mmrLeaf(D, 0n, l[0]!)));
  });

  it('n=2: two leaves of equal height merge into one peak, and the root is that node', () => {
    const l = leaves(2);
    const expected = mmrNode(D, mmrLeaf(D, 0n, l[0]!), mmrLeaf(D, 1n, l[1]!));
    expect(toHex(mmrRoot(D, l))).toBe(toHex(expected));
  });

  it('n=3: the peaks are [height 1, height 0], folded right to left', () => {
    const l = leaves(3);
    const peak1 = mmrNode(D, mmrLeaf(D, 0n, l[0]!), mmrLeaf(D, 1n, l[1]!));
    const peak0 = mmrLeaf(D, 2n, l[2]!);
    expect(toHex(mmrRoot(D, l))).toBe(toHex(mmrNode(D, peak1, peak0)));
  });

  it('n=4: a single peak (binary 100), and the root is that peak', () => {
    const l = leaves(4);
    const a = mmrNode(D, mmrLeaf(D, 0n, l[0]!), mmrLeaf(D, 1n, l[1]!));
    const b = mmrNode(D, mmrLeaf(D, 2n, l[2]!), mmrLeaf(D, 3n, l[3]!));
    expect(toHex(mmrRoot(D, l))).toBe(toHex(mmrNode(D, a, b)));
  });

  it('n=7: peaks [4,2,1] correspond to binary 111, folded right to left', () => {
    const l = leaves(7);
    const p4 = mmrNode(D, mmrNode(D, mmrLeaf(D, 0n, l[0]!), mmrLeaf(D, 1n, l[1]!)), mmrNode(D, mmrLeaf(D, 2n, l[2]!), mmrLeaf(D, 3n, l[3]!)));
    const p2 = mmrNode(D, mmrLeaf(D, 4n, l[4]!), mmrLeaf(D, 5n, l[5]!));
    const p1 = mmrLeaf(D, 6n, l[6]!);
    const expected = mmrNode(D, p4, mmrNode(D, p2, p1));
    expect(toHex(mmrRoot(D, l))).toBe(toHex(expected));
  });

  it('empty list root is MmrEmptyV1', () => {
    expect(toHex(mmrRoot(D, []))).toBe(toHex(mmrEmpty(D)));
  });

  it('order is locked in by the tree: swapping two leaves yields a different root', () => {
    const a = [utf8('a'), utf8('b')];
    const b = [utf8('b'), utf8('a')];
    expect(toHex(mmrRoot(D, a))).not.toBe(toHex(mmrRoot(D, b)));
  });
});

describe('prefix root and accumulator', () => {
  const leaves = (n: number): Uint8Array[] => Array.from({ length: n }, (_, i) => utf8(`chunk-${i}`));

  it('prefix root equals the root computed independently from the first k leaves', () => {
    const all = leaves(9);
    for (let k = 1; k <= 9; k++) {
      expect(toHex(mmrPrefixRoot(D, all, k))).toBe(toHex(mmrRoot(D, all.slice(0, k))));
    }
  });

  it('accumulator appending leaves one at a time matches a one-shot mmrRoot', () => {
    const all = leaves(9);
    const acc = new MmrAccumulator(D);
    for (let i = 0; i < all.length; i++) {
      const root = acc.append(all[i]!);
      expect(toHex(root)).toBe(toHex(mmrRoot(D, all.slice(0, i + 1))));
      expect(acc.leafCount).toBe(BigInt(i + 1));
    }
    expect(toHex(acc.root())).toBe(toHex(mmrRoot(D, all)));
  });

  it('empty accumulator\'s root is MmrEmptyV1, with leafCount 0', () => {
    const acc = new MmrAccumulator(D);
    expect(acc.leafCount).toBe(0n);
    expect(toHex(acc.root())).toBe(toHex(mmrEmpty(D)));
  });

  it('k out of range throws, not silently truncated', () => {
    const all = leaves(3);
    expect(() => mmrPrefixRoot(D, all, 4)).toThrow(/prefix/);
    expect(() => mmrPrefixRoot(D, all, -1)).toThrow(/prefix/);
  });

  it('k=0 is the empty tree root', () => {
    expect(toHex(mmrPrefixRoot(D, leaves(3), 0))).toBe(toHex(mmrEmpty(D)));
  });

  it('accumulator with an invalid domain throws at construction, not on the first append', () => {
    expect(() => new MmrAccumulator('')).toThrow(/domain/);
    expect(() => new MmrAccumulator('x'.repeat(129))).toThrow(/domain/);
  });

  it('appending after restoring from a checkpoint yields the same root as uninterrupted accumulation', () => {
    const all = leaves(9);
    const original = new MmrAccumulator(D);
    for (const leaf of all.slice(0, 5)) original.append(leaf);

    const checkpoint = original.checkpoint();
    const restored = new MmrAccumulator(D, checkpoint);
    expect(restored.leafCount).toBe(5n);
    expect(toHex(restored.root())).toBe(toHex(mmrRoot(D, all.slice(0, 5))));

    for (const leaf of all.slice(5)) restored.append(leaf);
    expect(toHex(restored.root())).toBe(toHex(mmrRoot(D, all)));
  });

  it('checkpoint/clone are both defensive copies; external mutation does not pollute the accumulator', () => {
    const acc = new MmrAccumulator(D);
    acc.append(utf8('a'));
    const checkpoint = acc.checkpoint();
    const clone = acc.clone();
    const before = toHex(acc.root());

    checkpoint.peaks[0]!.hash[0] = (checkpoint.peaks[0]!.hash[0] ?? 0) ^ 0xff;
    clone.append(utf8('b'));
    expect(toHex(acc.root())).toBe(before);
    expect(acc.leafCount).toBe(1n);
    expect(clone.leafCount).toBe(2n);
  });

  it('rejects a checkpoint with an invalid domain, peak shape, or hash length', () => {
    const acc = new MmrAccumulator(D);
    for (const leaf of leaves(3)) acc.append(leaf);
    const checkpoint = acc.checkpoint();

    expect(() => new MmrAccumulator('OTHER', checkpoint)).toThrow(/domain/);
    expect(() => new MmrAccumulator(D, { ...checkpoint, peaks: checkpoint.peaks.slice(0, 1) })).toThrow(/peaks/);
    expect(() => new MmrAccumulator(D, {
      ...checkpoint,
      peaks: [{ ...checkpoint.peaks[0]!, hash: new Uint8Array(31) }, ...checkpoint.peaks.slice(1)],
    })).toThrow(/32 bytes/);
  });
});

describe('official cross-language vectors (wire v0.4.1 testdata/v1/shared/mmr_primitive_v1.json)', () => {
  /**
   * This vector is published byte-for-byte by wire per monorepo "Canonical Encoding and Domain Hashing.md §11.5",
   * and is the shared criterion used by cortex / nexus / trueopen-sdk. The SDK's earlier self-made vectors have
   * been removed -- a self-made vector can only prove "the implementation hasn't changed unintentionally," not
   * "the implementation reads the spec correctly."
   */
  const v = JSON.parse(readFileSync('third_party/wire/testdata/v1/shared/mmr_primitive_v1.json', 'utf8'));
  const leaves: Uint8Array[] = (v.leaves_utf8 as string[]).map(utf8);

  for (const c of v.cases as { leaf_count: number; root_hex: string }[]) {
    it(`root for leaf_count ${c.leaf_count}`, () => {
      expect(toHex(mmrRoot(v.domain, leaves.slice(0, c.leaf_count)))).toBe(c.root_hex);
    });
  }

  it('digests of the four framing preimages', () => {
    const f = v.framing_preimages as { name: string; digest_hex: string }[];
    expect(toHex(mmrLeaf(v.domain, 0n, leaves[0]!))).toBe(f[0]!.digest_hex);
    expect(toHex(mmrLeaf(v.domain, 1n, leaves[1]!))).toBe(f[1]!.digest_hex);
    expect(toHex(mmrNode(v.domain, mmrLeaf(v.domain, 0n, leaves[0]!), mmrLeaf(v.domain, 1n, leaves[1]!)))).toBe(
      f[2]!.digest_hex,
    );
    expect(toHex(mmrEmpty(v.domain))).toBe(f[3]!.digest_hex);
  });

  it('leaf_count 2\'s root equals leaf_count 3\'s height-1 peak (the minimal case for §9 rule 6)', () => {
    const two = v.cases.find((c: { leaf_count: number }) => c.leaf_count === 2);
    const three = v.cases.find((c: { leaf_count: number }) => c.leaf_count === 3);
    expect(three.peaks[0].hash_hex).toBe(two.root_hex);
  });

  for (const n of v.negative as { name: string; leaf_count: number; root_hex: string; reason: string }[]) {
    it(`negative case ${n.name} must not match`, () => {
      // 7 leaves is the smallest size that distinguishes folding direction: for 1..6, both foldings are byte-identical.
      expect(toHex(mmrRoot(v.domain, leaves.slice(0, n.leaf_count)))).not.toBe(n.root_hex);
    });
  }
});
