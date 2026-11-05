import { describe, expect, it } from 'vitest';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { bech32 } from '@scure/base';
import { encodeDepositSession, encodeWithdrawSession, decodeWithdrawSession, atomicAmount } from '../../src/transport/session-funding';
import { encodeMsgCreateSession, encodeMsgUpdateSessionKey, decodeMsgCancelOrderResponse } from '../../src/transport/task-msgs';
import * as s from '../../src/gen/task/v1/msg_session_pb.js';
const signer = bech32.encode('trueopen', bech32.toWords(new Uint8Array(20).fill(1)));
const sessionId = `0x${'12'.repeat(32)}`;
describe('Phase 1 Session wire contract', () => {
  it('encodes initial funding and binding using official field numbers', () => {
    const m = fromBinary(s.MsgCreateSessionSchema, encodeMsgCreateSession({ signer, initialBuilder: signer, initialDeposit: '123' }));
    expect(m.initialBuilder).toBe(signer);
    expect(m.initialDeposit?.atomicUnits).toBe('123');
    expect(m.signerAddress).toBe(signer);
  });
  it('encodes deposit and both withdrawal actions', () => {
    const d = fromBinary(s.MsgDepositSessionSchema, encodeDepositSession({ signer, sessionId, amount: '12' }));
    expect(d.sessionId).toEqual(new Uint8Array(32).fill(0x12));
    expect(d.amount?.atomicUnits).toBe('12');
    const w = fromBinary(s.MsgWithdrawSessionSchema, encodeWithdrawSession({ signer, sessionId, amount: '5' }));
    expect(w.action.case).toBe('amount');
    const c = fromBinary(s.MsgWithdrawSessionSchema, encodeWithdrawSession({ signer, sessionId, close: true }));
    expect(c.action.case).toBe('close');
  });
  it('retains delayed withdrawal and cancellation heights without advancing sequence', () => {
    const w = decodeWithdrawSession(toBinary(s.MsgWithdrawSessionResponseSchema, create(s.MsgWithdrawSessionResponseSchema, {
      effectiveHeight: 100n, pendingAmount: { atomicUnits: '5' }, status: 1,
    })));
    expect(w).toEqual({ effectiveHeight: 100n, pendingAmount: '5', status: 1 });
    const c = decodeMsgCancelOrderResponse(toBinary(s.MsgCancelOrderResponseSchema, create(s.MsgCancelOrderResponseSchema, {
      cancelledSequence: 2n, nextExpectedSequence: 2n, cancelEffectiveHeight: 101n, status: 1,
    })));
    expect(c).toMatchObject({ taskId: '', nextExpectedSequence: 2n, cancelEffectiveHeight: 101n });
  });
  it('rejects noncanonical amounts and zero transfers', () => {
    for (const value of ['-1', '01', '1.2', '', ' 1']) expect(() => atomicAmount(value)).toThrow();
    expect(() => encodeDepositSession({ signer, sessionId, amount: '0' })).toThrow();
    expect(() => encodeWithdrawSession({ signer, sessionId, amount: '0' })).toThrow();
  });
});

it('encodes registered key SET and CLEAR with explicit oneof presence', () => {
  const set = fromBinary(s.MsgUpdateSessionKeySchema, encodeMsgUpdateSessionKey({ signer, sessionId, action: { set: { sessionKey: new Uint8Array(20).fill(2), expiryHeight: 100n, spendCap: '500' } } }));
  expect(set.action.case).toBe('set');
  if (set.action.case === 'set') expect(set.action.value.spendCap?.atomicUnits).toBe('500');
  const clear = fromBinary(s.MsgUpdateSessionKeySchema, encodeMsgUpdateSessionKey({ signer, sessionId, action: { clear: true } }));
  expect(clear.action.case).toBe('clear');
});
it('rejects legacy unbound creation', () => {
  expect(() => encodeMsgCreateSession({ signer })).toThrow(/initial_builder/);
});
