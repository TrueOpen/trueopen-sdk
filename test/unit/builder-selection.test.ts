import { describe, it, expect } from 'vitest';
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

/**
 * Cross-language fixture published by node:
 *   x/task/types/testdata/task_builder_rank_v1.json
 *   { schema_version: "trueopen-task-builder-rank-v1",
 *     domain: "TRUEOPEN_TASK_BUILDER_RANK_V1",
 *     sort: "rank_bytes_asc_then_address_codec_bytes_asc", vectors: [...] }
 * Asserted by TestTaskBuilderRankCrossLanguageFixture. The SDK must reproduce the same
 * vectors, otherwise it would send orders to the wrong set of Builders. Do not edit the
 * expected values in place — first confirm what changed on the node side.
 */
const RANK_VECTORS = [
  {
    seedHex: '3132330000000000000000000000000000000000000000000000000000000000',
    addressCodecHex: '4141414141414141414141414141414141414141',
    expectedRankHex: '2215fbe71a020f4624a48f6c8649516b7b6937017c023ff4744a7486ca61e1a1',
  },
] as const;

const addrOf = (codecHex: string): string => bech32.encode('trueopen', bech32.toWords(fromHex(codecHex)));
const hexOf = (b: number): string => toHex(new Uint8Array(32).fill(b));

describe('taskBuilderRank (cross-language fixture gate)', () => {
  it.each(RANK_VECTORS)('reproduces the rank vectors published by node', (v) => {
    // The fixture provides address codec bytes; the node side likewise bech32-encodes first, then decodes back to codec bytes.
    expect(toHex(taskBuilderRank(fromHex(v.seedHex), addrOf(v.addressCodecHex)))).toBe(v.expectedRankHex);
  });

  it('hrp is not part of the preimage - changing the prefix does not change the rank', () => {
    const v = RANK_VECTORS[0];
    const other = bech32.encode('cosmos', bech32.toWords(fromHex(v.addressCodecHex)));
    expect(toHex(taskBuilderRank(fromHex(v.seedHex), other))).toBe(v.expectedRankHex);
  });

  it('domain constants match the node registry', () => {
    expect(DOMAIN_TASK_BUILDERS_V1).toBe('TRUEOPEN_TASK_BUILDERS_V1');
    expect(DOMAIN_TASK_BUILDER_RANK_V1).toBe('TRUEOPEN_TASK_BUILDER_RANK_V1');
  });

  it('rejects a seed that is not 32 bytes', () => {
    expect(() => taskBuilderRank(new Uint8Array(31), addrOf(RANK_VECTORS[0].addressCodecHex))).toThrowError(/32 bytes/);
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
