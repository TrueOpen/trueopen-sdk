import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { orderEnvelopeSigningBytes, deriveTaskId } from '../../src/order/order-signing';
import { domainHash, canonicalFrameBytes, uint64BE } from '../../src/codec/domain-hash';
import { fromHex, toHex } from '../../src/util/bytes';

/** wire testdata/v1/task/task_data_plane_v1_golden.json, read from the submodule. */
const PLANE = JSON.parse(readFileSync('third_party/wire/testdata/v1/task/task_data_plane_v1_golden.json', 'utf8')) as {
  task_id: { expected_hex: string; order_sequence: string; preimage_hex: string; session_id_raw_hex: string };
};

// Regression value for the outer OpenTask order-envelope signing bytes
// (domainHash("TRUEOPEN_ORDER_V1", chain, owner, session, dec(seq), envelope)).
// Wire publishes no vector for this nexus-side domain, so this only guards against
// accidental changes.
const ORDER_JSON =
  '{"schema_version":"trueopen-order-envelope-v1","model_id":"model-golden","profile_version":1,"task_type":"inference","reward_bucket":2,"profile_resource_tier":3,"infer_input_unit_price_bid":2,"infer_output_unit_price_bid":3,"verify_unit_price_bid":4,"max_fee":1000,"tx_fee_reserve":0,"infer_fee_cap":700,"verify_fee_cap":200,"order_value":900,"valid_after_height":11,"deadline_height":222,"payload_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","infer_timeout_blocks":33}';

describe('signing bytes / task_id', () => {
  it('orderEnvelopeSigningBytes regression value', () => {
    expect(toHex(orderEnvelopeSigningBytes('chain-golden', 'owner-golden', 'session-golden', 42n, ORDER_JSON))).toBe(
      '723d1c261375ca282e4ba0f0d1f3d350807a317da823c13ed5fc76c99134e6a0',
    );
  });

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
