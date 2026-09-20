import { describe, it, expect } from 'vitest';
import {
  orderEnvelopeSigningBytes,
  deriveTaskId,
  userChallengeSigningBytes,
} from '../../src/order/order-signing';
import { domainHash } from '../../src/codec/domain-hash';
import { toHex } from '../../src/util/bytes';

// Anchored to node's cross-language golden: the "order" vector in
// x/task/types/testdata/task_data_plane_v1_golden.json.
// order signing bytes = domainHash("TRUEOPEN_ORDER_V1", chain, owner, session, dec(seq), order_json).
const ORDER_JSON_GOLDEN =
  '{"schema_version":"trueopen-order-envelope-v1","model_id":"model-golden","profile_version":1,"task_type":"inference","reward_bucket":2,"profile_resource_tier":3,"infer_input_unit_price_bid":2,"infer_output_unit_price_bid":3,"verify_unit_price_bid":4,"max_fee":1000,"tx_fee_reserve":0,"infer_fee_cap":700,"verify_fee_cap":200,"order_value":900,"valid_after_height":11,"deadline_height":222,"payload_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","infer_timeout_blocks":33}';

describe('signing bytes / task_id (real golden from chain)', () => {
  it("orderEnvelopeSigningBytes is anchored to node's cross-language golden (order vector)", () => {
    expect(
      toHex(orderEnvelopeSigningBytes('chain-golden', 'owner-golden', 'session-golden', 42n, ORDER_JSON_GOLDEN)),
    ).toBe('723d1c261375ca282e4ba0f0d1f3d350807a317da823c13ed5fc76c99134e6a0');
  });

  it("deriveTaskId is anchored to node's cross-language golden (raw Hash32 preimage)", () => {
    // node x/task/types/testdata/task_data_plane_v1_golden.json (current version):
    //   session_id_raw_hex = ab*32, order_sequence = 42
    //   preimage = 8-byte length frame("TRUEOPEN_TASK_ID_V1") || raw32 || u64be(42)
    // node has removed the old textual pipeline producer (refactor: remove textual task
    // id producer); nexus PR #46 switched to DeriveTaskIDFromRawSession in lockstep, so
    // both sides are now consistent.
    expect(deriveTaskId('ab'.repeat(32), 42n)).toBe(
      '0891a5c5704d4dff5671daab9b353f31c86f81ac53cf1b3c4ef5171322c19f50',
    );
  });

  it('deriveTaskId tolerates leading/trailing whitespace but rejects a session_id that is not a Hash32', () => {
    const hex = 'ab'.repeat(32);
    expect(deriveTaskId(` ${hex} `, 42n)).toBe(deriveTaskId(hex, 42n));
    expect(() => deriveTaskId('sess-1', 1n)).toThrowError(/Hash32|64-hex/);
  });

  it('userChallengeSigningBytes matches the golden value', () => {
    expect(
      toHex(
        userChallengeSigningBytes('trueopen-devnet-1', 'sess-1', 'task-1', 'settle-1', 'USER_REVALIDATION', 'evi-digest', 1000n, []),
      ),
    ).toBe('b9e43273626ea8201bc71ab95706db513e28f156d08dd5b7e9f1a9ae761ae477');
  });

  it('domainHash: 32 bytes, domain separation, boundaries cannot be confused (mirrors the Go test)', () => {
    expect(domainHash('d', 'x')).toHaveLength(32);
    expect(domainHash('A', 'x')).not.toEqual(domainHash('B', 'x'));
    expect(domainHash('test|chain', 'abc')).not.toEqual(domainHash('test', 'chain|abc'));
  });
});
