import type { TaskState, TaskPhase, TaskVerdict } from '../types/task';
import type { OptimisticFinalityStatus } from '../types/challenge';

export type AttentionIssue =
  | 'DATA_UNAVAILABLE'
  | 'CREDENTIAL_EXPIRED'
  | 'INSUFFICIENT_BALANCE'
  | 'RBF_STUCK'
  | 'CHALLENGEABLE';

export type LocalTaskState =
  | { kind: 'draft' }
  | { kind: 'submitted'; submitId: Uint8Array }
  | { kind: 'in_progress'; state: TaskState; phase: TaskPhase }
  | { kind: 'optimistic_finality'; verdict: TaskVerdict; challengeUntil: bigint; finality: OptimisticFinalityStatus }
  | { kind: 'final'; reason: 'settled' | 'failed' | 'refunded' | 'cancelled' }
  | { kind: 'local_attention'; issue: AttentionIssue };

export type TaskEvent =
  | { code: 'SUBMITTED'; submitId: Uint8Array }
  | { code: 'PHASE'; state: TaskState; phase: TaskPhase }
  | { code: 'SETTLED'; verdict: TaskVerdict; challengeUntil: bigint; finality: OptimisticFinalityStatus }
  | { code: 'FINAL'; reason: 'settled' | 'failed' | 'refunded' | 'cancelled' }
  | { code: 'ATTENTION'; issue: AttentionIssue };

export function initialState(): LocalTaskState {
  return { kind: 'draft' };
}

/** Event -> local state (advances optimistically). See reconcile for on-chain overrides. */
export function reduce(_prev: LocalTaskState, ev: TaskEvent): LocalTaskState {
  switch (ev.code) {
    case 'SUBMITTED':
      return { kind: 'submitted', submitId: ev.submitId };
    case 'PHASE':
      return { kind: 'in_progress', state: ev.state, phase: ev.phase };
    case 'SETTLED':
      return { kind: 'optimistic_finality', verdict: ev.verdict, challengeUntil: ev.challengeUntil, finality: ev.finality };
    case 'FINAL':
      return { kind: 'final', reason: ev.reason };
    case 'ATTENTION':
      return { kind: 'local_attention', issue: ev.issue };
  }
}
