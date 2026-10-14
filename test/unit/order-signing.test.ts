import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deriveTaskId } from '../../src/order/order-signing';
import { domainHash, canonicalFrameBytes, uint64BE } from '../../src/codec/domain-hash';
import { fromHex, toHex } from '../../src/util/bytes';

/** wire testdata/v1/task/task_data_plane_v1_golden.json, read from the submodule. */
const PLANE = JSON.parse(readFileSync('third_party/wire/testdata/v1/task/task_data_plane_v1_golden.json', 'utf8')) as {
  task_id: { expected_hex: string; order_sequence: string; preimage_hex: string; session_id_raw_hex: string };
};

describe('signing bytes / task_id', () => {
  it('deriveTaskId matches the wire task_id vector (preimage and digest)', () => {
    const v = PLANE.task_id;
    const preimage = canonicalFrameBytes(
      new TextEncoder().encode('TRUEOPEN_TASK_ID_V1'),
      fromHex(v.session_id_raw_hex),
      uint64BE(BigInt(v.order_sequence)),
    );
    expect(toHex(preimage)).toBe(v.preimage_hex);
    expect(deriveTaskId(`0x${v.session_id_raw_hex}`, BigInt(v.order_sequence))).toBe(`0x${v.expected_hex}`);
  });

  it('deriveTaskId takes and returns 0x + 64 lowercase hex, and rejects any other session_id spelling', () => {
    const hex = 'ab'.repeat(32);
    expect(deriveTaskId(`0x${hex}`, 42n)).toMatch(/^0x[0-9a-f]{64}$/);
    for (const bad of ['sess-1', hex, `0x${hex.toUpperCase()}`, `0X${hex}`, ` 0x${hex} `, `0x${hex}00`]) {
      expect(() => deriveTaskId(bad, 1n)).toThrowError(/0x followed by 64 lowercase hex/);
    }
  });

  it('domainHash: 32 bytes, domain separation, boundaries cannot be confused', () => {
    expect(domainHash('d', 'x')).toHaveLength(32);
    expect(domainHash('A', 'x')).not.toEqual(domainHash('B', 'x'));
    expect(domainHash('test|chain', 'abc')).not.toEqual(domainHash('test', 'chain|abc'));
  });
});
