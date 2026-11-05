import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { canonicalAccountAddressBytes, canonicalOperatorAddressBytes } from '../codec/address';
import { strictHash32 } from '../codec/hash32';
import * as session from '../gen/task/v1/msg_session_pb.js';
import type { SessionKeyGrant } from './task-msgs';

/**
 * Phase 1 Session funding (wire #49): CreateSession's prefund and first Builder binding, deposits,
 * and delayed withdrawal / CLOSE. Registered session keys (SET / CLEAR) are encoded in task-msgs.
 */
export interface CreateSessionInput {
  readonly sessionKey?: SessionKeyGrant;
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
