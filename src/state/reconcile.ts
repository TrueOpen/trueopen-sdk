import type { TaskState, TaskPhase, TaskVerdict } from '../types/task';
import type { OptimisticFinalityStatus } from '../types/challenge';
import type { LocalTaskState } from './local-state';

export interface ChainTaskView {
  readonly state: TaskState;
  readonly phase: TaskPhase;
  readonly verdict?: TaskVerdict;
  readonly finality?: OptimisticFinalityStatus;
  readonly challengeUntil?: bigint;
}

/**
 * One-way ranking: the higher the value, the more "final", and it never moves
 * backward (Detailed Design §3).
 * OVERTURNED is an absorbing state (04-Task/06 §9: must never go back to
 * CHALLENGED or FINAL), so it has the highest rank -- once OVERTURNED, no
 * FINAL/CHALLENGED chain view may override it.
 */
const FINALITY_RANK: Record<OptimisticFinalityStatus, number> = {
  PENDING: 0,
  CHALLENGED: 1,
  FINAL: 2,
  OVERTURNED: 3,
};

/**
 * On-chain state overrides local state (any on-chain accepted state overrides
 * the local one).
 * optimistic_finality_status only moves forward: a lower rank than the
 * current one is never accepted.
 */
export function reconcile(local: LocalTaskState, chain: ChainTaskView): LocalTaskState {
  if (chain.state === 'CLOSED' || chain.state === 'FAILED') {
    return { kind: 'final', reason: chain.state === 'FAILED' ? 'failed' : 'settled' };
  }

  if (chain.state === 'SETTLED' && chain.finality) {
    const localFinality = local.kind === 'optimistic_finality' ? local.finality : undefined;
    const nextFinality =
      localFinality && FINALITY_RANK[localFinality] > FINALITY_RANK[chain.finality]
        ? localFinality
        : chain.finality;

    if (nextFinality === 'FINAL') return { kind: 'final', reason: 'settled' };
    if (nextFinality === 'OVERTURNED') {
      return {
        kind: 'optimistic_finality',
        verdict: chain.verdict ?? 'FAIL',
        challengeUntil: chain.challengeUntil ?? 0n,
        finality: 'OVERTURNED',
      };
    }
    return {
      kind: 'optimistic_finality',
      verdict: chain.verdict ?? 'PASS',
      challengeUntil: chain.challengeUntil ?? 0n,
      finality: nextFinality,
    };
  }

  return { kind: 'in_progress', state: chain.state, phase: chain.phase };
}
