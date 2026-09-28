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
    expect(deriveTaskId(v.session_id_raw_hex, BigInt(v.order_sequence))).toBe(v.expected_hex);
  });

  it('deriveTaskId tolerates leading/trailing whitespace but rejects a session_id that is not a Hash32', () => {
    const hex = 'ab'.repeat(32);
    expect(deriveTaskId(` ${hex} `, 42n)).toBe(deriveTaskId(hex, 42n));
    expect(() => deriveTaskId('sess-1', 1n)).toThrowError(/Hash32|64-hex/);
  });

  it('domainHash: 32 bytes, domain separation, boundaries cannot be confused', () => {
    expect(domainHash('d', 'x')).toHaveLength(32);
    expect(domainHash('A', 'x')).not.toEqual(domainHash('B', 'x'));
    expect(domainHash('test|chain', 'abc')).not.toEqual(domainHash('test', 'chain|abc'));
  });
});
