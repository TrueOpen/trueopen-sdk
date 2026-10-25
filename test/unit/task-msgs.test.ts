import { describe, it, expect } from 'vitest';
import { ProtoWriter, ProtoReader } from '../../src/codec/protobuf';
import {
  TYPE_URL,
  encodeMsgCreateSession,
  encodeMsgCancelOrder,
  encodeMsgUpdateSessionKey,
  decodeMsgUpdateSessionKeyResponse,
  decodeMsgCreateSessionResponse,
  decodeMsgCancelOrderResponse,
} from '../../src/transport/task-msgs';
import type { SessionKeyGrant } from '../../src/transport/task-msgs';
import { toHex, fromHex } from '../../src/util/bytes';

// Raw hex of two 32-byte Hash32 values, and their SDK text form: 0x + 64 lowercase hex (ADR-0034).
const SESSION_HEX = '33530796a5c450a2c5264ec40d1eeabf0e581d3f84dc09b45c35ac8259f4706a';
const TASK_HEX = '0c57743effab15ce41ad3f75e0b190774e544c2ce20f1dd701298f89cfc83e35';
const SESSION_ID = `0x${SESSION_HEX}`;
const TASK_ID = `0x${TASK_HEX}`;

describe('typeUrls', () => {
  it('matches the proto package names', () => {
    expect(TYPE_URL.createSession).toBe('/task.v1.MsgCreateSession');
    expect(TYPE_URL.cancelOrder).toBe('/task.v1.MsgCancelOrder');
    expect(TYPE_URL.updateSessionKey).toBe('/task.v1.MsgUpdateSessionKey');
    expect(Object.keys(TYPE_URL)).toEqual(['createSession', 'cancelOrder', 'updateSessionKey']);
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
    const bytes = encodeMsgCancelOrder({ signer: 'trueopen1s', sessionId: SESSION_ID, orderSequence: 9n });
    const r = new ProtoReader(bytes);
    expect(r.tag()).toEqual({ field: 1, wire: 2 });
    const raw = r.bytes();
    expect(raw.length).toBe(32);
    expect(toHex(raw)).toBe(SESSION_HEX);
    expect(r.tag().field).toBe(2); expect(r.uint64()).toBe(9n);
    expect(r.tag()).toEqual({ field: 3, wire: 2 }); expect(r.string()).toBe('trueopen1s');
    expect(r.eof).toBe(true);
  });

  it('MsgCancelOrder: a session_id that is not 0x + 64 lowercase hex is refused, not encoded', () => {
    for (const bad of [SESSION_HEX, `0x${SESSION_HEX.toUpperCase()}`, `0X${SESSION_HEX}`]) {
      expect(() => encodeMsgCancelOrder({ signer: 'trueopen1s', sessionId: bad, orderSequence: 9n })).toThrowError(
        /0x followed by 64 lowercase hex/,
      );
    }
  });
});

describe('decode responses (build response bytes with the writer, then decode)', () => {
  // node: bytes session_id=1, uint64 session_nonce=2, MutationStatusV1 status=3 (enum -> varint).
  it('MsgCreateSessionResponse: session_id bytes -> 0x + 64 lowercase hex', () => {
    const bytes = new ProtoWriter()
      .bytes(1, fromHex(SESSION_HEX)).uint64(2, 7n).uint64(3, 1n)
      .finish();
    expect(decodeMsgCreateSessionResponse(bytes)).toEqual({
      sessionId: SESSION_ID, sessionNonce: 7n, status: 'MUTATION_STATUS_V1_APPLIED',
    });
  });

  it('MsgCreateSessionResponse: raw 32 bytes must never be decoded as UTF-8 (regression: previously decoded into garbled text and rejected by nexus)', () => {
    const bytes = new ProtoWriter().bytes(1, fromHex(SESSION_HEX)).finish();
    const { sessionId } = decodeMsgCreateSessionResponse(bytes);
    expect(sessionId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sessionId).toBe(SESSION_ID);
  });

  // node: bytes task_id=1, uint64 cancelled_sequence=2, uint64 next_expected_sequence=3, status=4.
  it('MsgCancelOrderResponse: field 1 is task_id (not session_id)', () => {
    const bytes = new ProtoWriter()
      .bytes(1, fromHex(TASK_HEX)).uint64(2, 3n).uint64(3, 4n).uint64(4, 2n)
      .finish();
    expect(decodeMsgCancelOrderResponse(bytes)).toEqual({
      taskId: TASK_ID, cancelledSequence: 3n, nextExpectedSequence: 4n,
      status: 'MUTATION_STATUS_V1_NOOP',
    });
  });

});

// ---- registered session keys (ADR-0037) ----
const KEY = fromHex('00112233445566778899aabbccddeeff00112233');
const grant = (over: Partial<SessionKeyGrant> = {}): SessionKeyGrant => ({
  sessionKey: KEY, expiryHeight: 1000n, spendCap: '5000', ...over,
});

/** Decodes a SessionKeyGrantV1 { bytes key=1; uint64 expiry=2; Amount cap=3 } with the reader. */
function readGrant(bytes: Uint8Array): { key: Uint8Array; expiry: bigint; cap: string } {
  const r = new ProtoReader(bytes);
  const out: { key: Uint8Array; expiry: bigint; cap: string } = { key: new Uint8Array(), expiry: 0n, cap: '' };
  while (!r.eof) {
    const { field, wire } = r.tag();
    if (field === 1) out.key = r.bytes();
    else if (field === 2) out.expiry = r.uint64();
    else if (field === 3) {
      const a = new ProtoReader(r.bytes());
      expect(a.tag()).toEqual({ field: 1, wire: 2 });
      out.cap = a.string();
      expect(a.eof).toBe(true);
    } else r.skip(wire);
  }
  return out;
}

describe('MsgCreateSession with a session key grant', () => {
  it('without a key it is unchanged (signer only)', () => {
    expect(toHex(encodeMsgCreateSession({ signer: 'trueopen1abc' }))).toBe(
      toHex(new ProtoWriter().string(1, 'trueopen1abc').finish()),
    );
  });

  it('writes the grant as field 2 with key=1, expiry=2, Amount{atomic_units}=3', () => {
    const r = new ProtoReader(encodeMsgCreateSession({ signer: 'trueopen1abc', sessionKey: grant() }));
    expect(r.tag()).toEqual({ field: 1, wire: 2 });
    expect(r.string()).toBe('trueopen1abc');
    expect(r.tag()).toEqual({ field: 2, wire: 2 });
    expect(readGrant(r.bytes())).toEqual({ key: KEY, expiry: 1000n, cap: '5000' });
    expect(r.eof).toBe(true);
  });

  it('byte-exact for a small grant, with an explicit "0" cap still present', () => {
    const key = new Uint8Array(20).fill(1);
    const bytes = encodeMsgCreateSession({ signer: 'a', sessionKey: { sessionKey: key, expiryHeight: 5n, spendCap: '0' } });
    // 0a 01 'a' | 12 len | 0a 14 <20x01> | 10 05 | 1a 03 0a 01 '0'
    const expected = '0a0161' + '12' + '1d' + '0a14' + '01'.repeat(20) + '1005' + '1a030a0130';
    expect(toHex(bytes)).toBe(expected);
  });

  it('accepts the bounds: spend_cap u64 max, expiry_height 2^63 - 1', () => {
    expect(() => encodeMsgCreateSession({ signer: 's', sessionKey: grant({ spendCap: ((1n << 64n) - 1n).toString(), expiryHeight: (1n << 63n) - 1n }) })).not.toThrow();
  });

  it('rejects an invalid grant with SDK_LOCAL_SESSION_KEY_INVALID', () => {
    const bad: Partial<SessionKeyGrant>[] = [
      { sessionKey: new Uint8Array(19).fill(1) },
      { sessionKey: new Uint8Array(21).fill(1) },
      { sessionKey: new Uint8Array(20) },
      { spendCap: '' },
      { spendCap: '01' },
      { spendCap: '-1' },
      { spendCap: '1.5' },
      { spendCap: '0x10' },
      { spendCap: (1n << 64n).toString() },
      { expiryHeight: 0n },
      { expiryHeight: 1n << 63n },
    ];
    for (const b of bad) {
      expect(() => encodeMsgCreateSession({ signer: 's', sessionKey: grant(b) })).toThrowError(
        expect.objectContaining({ code: 'SDK_LOCAL_SESSION_KEY_INVALID' }),
      );
    }
  });
});

describe('MsgUpdateSessionKey', () => {
  it('SET: signer=1, session_id=2 (32 raw bytes), set=3 with the grant', () => {
    const r = new ProtoReader(encodeMsgUpdateSessionKey({ signer: 'trueopen1abc', sessionId: SESSION_ID, action: { set: grant() } }));
    expect(r.tag()).toEqual({ field: 1, wire: 2 });
    expect(r.string()).toBe('trueopen1abc');
    expect(r.tag()).toEqual({ field: 2, wire: 2 });
    expect(toHex(r.bytes())).toBe(SESSION_HEX);
    expect(r.tag()).toEqual({ field: 3, wire: 2 });
    expect(readGrant(r.bytes())).toEqual({ key: KEY, expiry: 1000n, cap: '5000' });
    expect(r.eof).toBe(true);
  });

  it('SET with an explicit "0" cap writes the Amount', () => {
    const r = new ProtoReader(encodeMsgUpdateSessionKey({ signer: 's', sessionId: SESSION_ID, action: { set: grant({ spendCap: '0' }) } }));
    r.tag(); r.string(); r.tag(); r.bytes();
    expect(r.tag()).toEqual({ field: 3, wire: 2 });
    expect(readGrant(r.bytes()).cap).toBe('0');
  });

  it('CLEAR is an empty length-delimited field 4 (and no field 3)', () => {
    const bytes = encodeMsgUpdateSessionKey({ signer: 's', sessionId: SESSION_ID, action: { clear: true } });
    expect(toHex(bytes).endsWith('2200')).toBe(true); // tag (4<<3|2)=0x22, length 0
    const r = new ProtoReader(bytes);
    r.tag(); r.string(); r.tag(); r.bytes();
    expect(r.tag()).toEqual({ field: 4, wire: 2 });
    expect(r.bytes().length).toBe(0);
    expect(r.eof).toBe(true);
  });

  it('rejects an invalid grant and a malformed session id', () => {
    expect(() => encodeMsgUpdateSessionKey({ signer: 's', sessionId: SESSION_ID, action: { set: grant({ expiryHeight: 0n }) } }))
      .toThrowError(expect.objectContaining({ code: 'SDK_LOCAL_SESSION_KEY_INVALID' }));
    expect(() => encodeMsgUpdateSessionKey({ signer: 's', sessionId: SESSION_HEX, action: { clear: true } })).toThrow();
  });

  it('decodes the response (with a key)', () => {
    const amt = (v: string) => new ProtoWriter().string(1, v).finish();
    const bytes = new ProtoWriter()
      .bytes(1, KEY).uint64(2, 1000n).message(3, amt('5000')).message(4, amt('12')).uint64(5, 900n).uint64(6, 1n)
      .finish();
    const r = decodeMsgUpdateSessionKeyResponse(bytes);
    expect(r.sessionKey).toEqual(KEY);
    expect(r).toMatchObject({ expiryHeight: 1000n, spendCap: '5000', spent: '12', setHeight: 900n, status: 'MUTATION_STATUS_V1_APPLIED' });
  });

  it('a present but empty or non-20-byte key in the response is malformed', () => {
    for (const k of [new Uint8Array(0), new Uint8Array(19).fill(1), new Uint8Array(21).fill(1)]) {
      const bytes = new ProtoWriter().message(1, k).uint64(6, 1n).finish();
      expect(() => decodeMsgUpdateSessionKeyResponse(bytes)).toThrowError(
        expect.objectContaining({ code: 'CHAIN_QUERY_MALFORMED' }),
      );
    }
  });

  it('decodes the response after CLEAR (no key, zero amounts)', () => {
    const r = decodeMsgUpdateSessionKeyResponse(new ProtoWriter().uint64(6, 1n).finish());
    expect(r.sessionKey).toBeUndefined();
    expect(r).toMatchObject({ expiryHeight: 0n, spendCap: '0', spent: '0', setHeight: 0n, status: 'MUTATION_STATUS_V1_APPLIED' });
    expect('sessionKey' in r).toBe(false);
  });
});
