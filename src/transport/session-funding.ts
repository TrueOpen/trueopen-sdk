import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { canonicalAccountAddressBytes, canonicalOperatorAddressBytes } from '../codec/address';
import { strictHash32 } from '../codec/hash32';
import * as session from '../gen/task/v1/msg_session_pb.js';

export interface CreateSessionInput {
  readonly sessionKey?: SessionKeyInput;
  readonly initialBuilder: string;
  /** Atomic units in the chain's native settlement denomination. */
  readonly initialDeposit: string;
}
export interface DepositSessionInput {
  readonly sessionId: string;
  readonly amount: string;
}
export type WithdrawSessionInput = { readonly sessionId: string } & (
  { readonly amount: string; readonly close?: never } |
  { readonly close: true; readonly amount?: never }
);
export interface DepositSessionResult { readonly balance: string; readonly status: number }
export interface WithdrawSessionResult {
  readonly effectiveHeight: bigint;
  readonly pendingAmount: string;
  readonly status: number;
}
export const SESSION_FUNDING_TYPE_URL = {
  depositSession: '/task.v1.MsgDepositSession',
  withdrawSession: '/task.v1.MsgWithdrawSession',
} as const;

export function atomicAmount(value: string): { atomicUnits: string } {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('amount must be canonical unsigned decimal atomic units');
  return { atomicUnits: value };
}
export function validateInitialBuilder(value: string): void {
  canonicalOperatorAddressBytes('initial_builder', value);
}
export function encodeDepositSession(m: DepositSessionInput & { signer: string }): Uint8Array {
  canonicalAccountAddressBytes('signer_address', m.signer);
  if (m.amount === '0') throw new Error('deposit amount must be positive');
  return toBinary(session.MsgDepositSessionSchema, create(session.MsgDepositSessionSchema, {
    signerAddress: m.signer, sessionId: strictHash32('session_id', m.sessionId), amount: atomicAmount(m.amount),
  }));
}
export function encodeWithdrawSession(m: WithdrawSessionInput & { signer: string }): Uint8Array {
  canonicalAccountAddressBytes('signer_address', m.signer);
  if ((m.close === true) === (m.amount !== undefined)) throw new Error('choose exactly one withdrawal amount or close');
  if (m.amount === '0') throw new Error('withdrawal amount must be positive');
  return toBinary(session.MsgWithdrawSessionSchema, create(session.MsgWithdrawSessionSchema, {
    signerAddress: m.signer, sessionId: strictHash32('session_id', m.sessionId),
    action: m.close === true ? { case: 'close', value: {} } : { case: 'amount', value: { amount: atomicAmount(m.amount!) } },
  }));
}
export function decodeDepositSession(bytes: Uint8Array): DepositSessionResult {
  const r = fromBinary(session.MsgDepositSessionResponseSchema, bytes);
  if (!r.balance) throw new Error('deposit response missing balance');
  return { balance: r.balance.atomicUnits, status: r.status };
}
export function decodeWithdrawSession(bytes: Uint8Array): WithdrawSessionResult {
  const r = fromBinary(session.MsgWithdrawSessionResponseSchema, bytes);
  if (!r.pendingAmount) throw new Error('withdrawal response missing pending amount');
  return { effectiveHeight: r.effectiveHeight, pendingAmount: r.pendingAmount.atomicUnits, status: r.status };
}

export interface SessionKeyInput {
  readonly sessionKey: Uint8Array;
  readonly expiryHeight: bigint;
  readonly spendCap: string;
}
export type UpdateSessionKeyInput = { readonly sessionId: string } & (
  { readonly set: SessionKeyInput; readonly clear?: never } |
  { readonly clear: true; readonly set?: never }
);
export function sessionKeyGrant(input: SessionKeyInput, signer: string) {
  const owner = canonicalAccountAddressBytes('signer_address', signer);
  if (input.sessionKey.length !== 20 || input.sessionKey.every(x => x === 0) || input.sessionKey.every((x, i) => x === owner[i])) throw new Error('session key must be a nonzero raw20 address distinct from owner');
  if (input.expiryHeight <= 0n || input.expiryHeight > (1n << 64n) - 1n) throw new Error('invalid session key expiry height');
  return { sessionKey: input.sessionKey, expiryHeight: input.expiryHeight, spendCap: atomicAmount(input.spendCap) };
}
export const UPDATE_SESSION_KEY_TYPE_URL = '/task.v1.MsgUpdateSessionKey';
export function encodeUpdateSessionKey(m: UpdateSessionKeyInput & { signer: string }): Uint8Array {
  canonicalAccountAddressBytes('signer_address', m.signer);
  if ((m.clear === true) === (m.set !== undefined)) throw new Error('choose exactly one key SET or CLEAR');
  return toBinary(session.MsgUpdateSessionKeySchema, create(session.MsgUpdateSessionKeySchema, {
    signerAddress: m.signer, sessionId: strictHash32('session_id', m.sessionId),
    action: m.clear === true ? { case: 'clear', value: {} } : { case: 'set', value: sessionKeyGrant(m.set!, m.signer) },
  }));
}
export function decodeUpdateSessionKey(bytes: Uint8Array) {
  return fromBinary(session.MsgUpdateSessionKeyResponseSchema, bytes);
}
