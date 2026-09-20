import { describe, it, expect } from 'vitest';
import { ProtoWriter, ProtoReader } from '../../src/codec/protobuf';
import {
  TYPE_URL,
  encodeMsgCreateSession,
  encodeMsgCancelOrder,
  encodeMsgUserChallenge,
  decodeMsgCreateSessionResponse,
  decodeMsgCancelOrderResponse,
  decodeMsgUserChallengeResponse,
} from '../../src/transport/task-msgs';
import { toHex, fromHex } from '../../src/util/bytes';

// Canonical lowercase 64-hex for a 32-byte Hash32 (the same bytes as node bytes <-> nexus 64-hex).
const SESSION_HEX = '33530796a5c450a2c5264ec40d1eeabf0e581d3f84dc09b45c35ac8259f4706a';
const TASK_HEX = '0c57743effab15ce41ad3f75e0b190774e544c2ce20f1dd701298f89cfc83e35';

describe('typeUrls', () => {
  it('matches the proto package names', () => {
    expect(TYPE_URL.createSession).toBe('/task.v1.MsgCreateSession');
    expect(TYPE_URL.cancelOrder).toBe('/task.v1.MsgCancelOrder');
    expect(TYPE_URL.userChallenge).toBe('/task.v1.MsgUserChallenge');
  });
});

describe('encode Msg (verify field layout using the reader)', () => {
  it('MsgCreateSession', () => {
    const r = new ProtoReader(encodeMsgCreateSession({ signer: 'trueopen1abc' }));
    expect(r.tag()).toEqual({ field: 1, wire: 2 });
    expect(r.string()).toBe('trueopen1abc');
    expect(r.eof).toBe(true);
  });

  // node msg_session.proto: bytes session_id=1, uint64 order_sequence=2, string signer_address=3
  // (no owner_signature -- authorization is handled by the Cosmos account signature).
  it('MsgCancelOrder: session_id is written as 32-byte bytes in field 1, signer is in field 3', () => {
    const bytes = encodeMsgCancelOrder({ signer: 'trueopen1s', sessionId: SESSION_HEX, orderSequence: 9n });
    const r = new ProtoReader(bytes);
    expect(r.tag()).toEqual({ field: 1, wire: 2 });
    const raw = r.bytes();
    expect(raw.length).toBe(32);
    expect(toHex(raw)).toBe(SESSION_HEX);
    expect(r.tag().field).toBe(2); expect(r.uint64()).toBe(9n);
    expect(r.tag()).toEqual({ field: 3, wire: 2 }); expect(r.string()).toBe('trueopen1s');
    expect(r.eof).toBe(true);
  });

  it('MsgUserChallenge: empty requested_evidence is omitted, bond=0 is omitted', () => {
    const bytes = encodeMsgUserChallenge({
      signer: 'trueopen1u', sessionId: 's', taskId: 't', settlementId: 'st',
      challengeKind: 'USER_REVALIDATION', evidenceDigest: 'dig', bondAmount: 0n,
      requestedEvidence: [], challengerSignature: 'csig',
    });
    const r = new ProtoReader(bytes);
    const seen: number[] = [];
    while (!r.eof) {
      const { field, wire } = r.tag();
      seen.push(field);
      if (wire === 0) r.uint64();
      else r.string();
    }
    // 1..6, 9 present; 7(bond=0) and 8(empty repeated) omitted
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 9]);
  });

  it('MsgUserChallenge: bond>0 appears in field 7', () => {
    const bytes = encodeMsgUserChallenge({
      signer: 'u', sessionId: 's', taskId: 't', settlementId: 'st',
      challengeKind: 'USER_REVALIDATION', evidenceDigest: 'd', bondAmount: 1000n,
      requestedEvidence: [], challengerSignature: 'c',
    });
    const r = new ProtoReader(bytes);
    const fields: number[] = [];
    while (!r.eof) {
      const { field, wire } = r.tag();
      fields.push(field);
      if (wire === 0) r.uint64();
      else r.string();
    }
    expect(fields).toContain(7);
  });
});

describe('decode responses (build response bytes with the writer, then decode)', () => {
  // node: bytes session_id=1, uint64 session_nonce=2, MutationStatusV1 status=3 (enum -> varint).
  it('MsgCreateSessionResponse: session_id bytes -> lowercase 64-hex', () => {
    const bytes = new ProtoWriter()
      .bytes(1, fromHex(SESSION_HEX)).uint64(2, 7n).uint64(3, 1n)
      .finish();
    expect(decodeMsgCreateSessionResponse(bytes)).toEqual({
      sessionId: SESSION_HEX, sessionNonce: 7n, status: 'MUTATION_STATUS_V1_APPLIED',
    });
  });

  it('MsgCreateSessionResponse: raw 32 bytes must never be decoded as UTF-8 (regression: previously decoded into garbled text and rejected by nexus)', () => {
    const bytes = new ProtoWriter().bytes(1, fromHex(SESSION_HEX)).finish();
    const { sessionId } = decodeMsgCreateSessionResponse(bytes);
    expect(sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionId).toBe(SESSION_HEX);
  });

  // node: bytes task_id=1, uint64 cancelled_sequence=2, uint64 next_expected_sequence=3, status=4.
  it('MsgCancelOrderResponse: field 1 is task_id (not session_id)', () => {
    const bytes = new ProtoWriter()
      .bytes(1, fromHex(TASK_HEX)).uint64(2, 3n).uint64(3, 4n).uint64(4, 2n)
      .finish();
    expect(decodeMsgCancelOrderResponse(bytes)).toEqual({
      taskId: TASK_HEX, cancelledSequence: 3n, nextExpectedSequence: 4n,
      status: 'MUTATION_STATUS_V1_NOOP',
    });
  });

  it('MsgUserChallengeResponse', () => {
    const bytes = new ProtoWriter()
      .string(1, 'ch-1').string(2, 'OPEN').uint64(3, 200n).uint64(4, 250n).uint64(5, 1000n)
      .finish();
    expect(decodeMsgUserChallengeResponse(bytes)).toEqual({
      challengeId: 'ch-1', status: 'OPEN', challengeDeadlineHeight: 200n,
      resolveDeadlineHeight: 250n, bondLockedAmount: 1000n,
    });
  });
});
