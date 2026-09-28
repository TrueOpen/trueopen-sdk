import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { bech32 } from '@scure/base';
import {
  selectTaskBuilders,
  taskBuilderSeed,
  taskBuilderRank,
  BUILDERS_PER_TASK,
  DOMAIN_TASK_BUILDERS_V1,
  DOMAIN_TASK_BUILDER_RANK_V1,
} from '../../src/hub/builder-selection';
import type { BuilderSetMember } from '../../src/hub/builder-selection';
import { fromHex, toHex } from '../../src/util/bytes';
import { canonicalFrameBytes } from '../../src/codec/domain-hash';

/**
 * wire testdata/v1/task/task_builder_rank_v1.json, read from the submodule: every vector
 * pins both the preimage (field order) and the rank. The SDK must reproduce them, or it
 * would send orders to the wrong Builders.
 */
interface RankVector {
  readonly name: string;
  readonly digest_hex: string;
  readonly preimage_hex: string;
  readonly fields: readonly { readonly name: string; readonly hex: string; readonly bech32?: string }[];
}
const RANK = JSON.parse(readFileSync('third_party/wire/testdata/v1/task/task_builder_rank_v1.json', 'utf8')) as {
  domain: string;
  vectors: RankVector[];
};
const RANK_VECTORS = RANK.vectors.map((v) => ({
  name: v.name,
  seedHex: v.fields.find((f) => f.name === 'task_builder_seed')!.hex,
  addressCodecHex: v.fields.find((f) => f.name === 'builder_operator_address')!.hex,
  bech32: v.fields.find((f) => f.name === 'builder_operator_address')!.bech32,
  preimageHex: v.preimage_hex,
  expectedRankHex: v.digest_hex,
}));

const addrOf = (codecHex: string): string => bech32.encode('trueopen', bech32.toWords(fromHex(codecHex)));
const hexOf = (b: number): string => toHex(new Uint8Array(32).fill(b));

describe('taskBuilderRank (cross-language fixture gate)', () => {
  it('covers all four published vectors', () => {
    expect(RANK_VECTORS).toHaveLength(4);
    expect(RANK.domain).toBe(DOMAIN_TASK_BUILDER_RANK_V1);
  });

  it.each(RANK_VECTORS)('$name: preimage and rank match', (v) => {
    const preimage = canonicalFrameBytes(new TextEncoder().encode(DOMAIN_TASK_BUILDER_RANK_V1), fromHex(v.seedHex), fromHex(v.addressCodecHex));
    expect(toHex(preimage)).toBe(v.preimageHex);
    // The bech32 column is a decoder self-check.
    expect(addrOf(v.addressCodecHex)).toBe(v.bech32);
    expect(toHex(taskBuilderRank(fromHex(v.seedHex), addrOf(v.addressCodecHex)))).toBe(v.expectedRankHex);
  });

  it('hrp is not part of the preimage - changing the prefix does not change the rank', () => {
    const v = RANK_VECTORS[0]!;
    const other = bech32.encode('cosmos', bech32.toWords(fromHex(v.addressCodecHex)));
    expect(toHex(taskBuilderRank(fromHex(v.seedHex), other))).toBe(v.expectedRankHex);
  });

  it('domain constants match the wire registry', () => {
    expect(DOMAIN_TASK_BUILDERS_V1).toBe('TRUEOPEN_TASK_BUILDERS_V1');
    expect(DOMAIN_TASK_BUILDER_RANK_V1).toBe('TRUEOPEN_TASK_BUILDER_RANK_V1');
  });

  it('rejects a seed that is not 32 bytes', () => {
    expect(() => taskBuilderRank(new Uint8Array(31), addrOf(RANK_VECTORS[0]!.addressCodecHex))).toThrowError(/32 bytes/);
  });
});

describe('taskBuilderSeed', () => {
  const args = ['trueopen-localnet-1', hexOf(0x01), hexOf(0x02), hexOf(0x03)] as const;

  it('changing any of the four inputs changes the seed (anchor included)', () => {
    const base = toHex(taskBuilderSeed(...args));
    expect(toHex(taskBuilderSeed('trueopen-other-1', args[1], args[2], args[3]))).not.toBe(base);
    expect(toHex(taskBuilderSeed(args[0], hexOf(0x99), args[2], args[3]))).not.toBe(base);
    expect(toHex(taskBuilderSeed(args[0], args[1], hexOf(0x99), args[3]))).not.toBe(base);
    // session_anchor_block_hash: this is what ties the selection result to the order the user signed.
    expect(toHex(taskBuilderSeed(args[0], args[1], args[2], hexOf(0x99)))).not.toBe(base);
  });

  it('rejects an input that is not 64 hex characters', () => {
    expect(() => taskBuilderSeed(args[0], 'task-1', args[2], args[3])).toThrowError(/Hash32/);
  });
});

describe('selectTaskBuilders', () => {
  const ADDR_A = 'trueopen1yfse4c367uc2rja5g3905ynmnuv2hjk8gcgvfl';
  const members: BuilderSetMember[] = [
    ADDR_A,
    'trueopen1870sqtdru7dj3xgwpzcexry0dwvyz2ku7xv9mg',
    'trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man',
  ].map((address) => ({ address, status: 'BUILDER_STATUS_ACTIVE' }));

  const input = {
    chainId: 'trueopen-localnet-1',
    taskId: hexOf(0x01),
    builderSetHash: hexOf(0x02),
    sessionAnchorBlockHash: hexOf(0x03),
    members,
  };

  it('is deterministic: same input yields same output, rank increments from 1', () => {
    const a = selectTaskBuilders(input);
    const b = selectTaskBuilders(input);
    expect(a.map((x) => x.address)).toEqual(b.map((x) => x.address));
    expect(a.map((x) => x.rank)).toEqual([1, 2, 3]);
    expect(a).toHaveLength(BUILDERS_PER_TASK);
  });

  it('sorts by rank bytes ascending', () => {
    const selected = selectTaskBuilders(input);
    const hashes = selected.map((s) => s.rankHash);
    expect([...hashes].sort()).toEqual(hashes);
  });

  it('member order does not affect the result (sorted rather than input-order-dependent)', () => {
    const reversed = selectTaskBuilders({ ...input, members: [...members].reverse() });
    expect(reversed.map((x) => x.address)).toEqual(selectTaskBuilders(input).map((x) => x.address));
  });

  it('changing the anchor may change the selection result, but it stays deterministic', () => {
    const other = selectTaskBuilders({ ...input, sessionAnchorBlockHash: hexOf(0x77) });
    expect(other).toHaveLength(BUILDERS_PER_TASK);
    expect(other.map((x) => x.rankHash)).not.toEqual(selectTaskBuilders(input).map((x) => x.rankHash));
  });

  // node filters by **live** status at selection time: the set is frozen for auditing, but a slashed member must not enter a new Task.
  it('excludes non-ACTIVE members', () => {
    const jailed = members.map((m, i) => (i === 0 ? { ...m, status: 'BUILDER_STATUS_JAILED' } : m));
    expect(() => selectTaskBuilders({ ...input, members: jailed })).toThrowError(/eligible members/);
    const four = [...jailed, { address: 'trueopen1qp5c4zkm4q4efuqrwjaww8n5yvrht7fdvnp2mq', status: 'BUILDER_STATUS_ACTIVE' }];
    const selected = selectTaskBuilders({ ...input, members: four });
    expect(selected.map((s) => s.address)).not.toContain(ADDR_A);
  });

  it('errors on too few candidates or duplicate members', () => {
    expect(() => selectTaskBuilders({ ...input, members: members.slice(0, 2) })).toThrowError(/eligible members/);
    const dup: BuilderSetMember[] = [...members, { address: ADDR_A, status: 'BUILDER_STATUS_ACTIVE' }];
    expect(() => selectTaskBuilders({ ...input, members: dup })).toThrowError(/duplicate/);
  });

  it('buildersPerTask can be overridden', () => {
    expect(selectTaskBuilders({ ...input, buildersPerTask: 2 })).toHaveLength(2);
  });
});
