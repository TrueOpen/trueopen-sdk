import type { SettlementFinalityView } from '../types/node';
import type { ChainTaskView } from './reconcile';

/**
 * node's SettlementFinality already existing means the task has entered the
 * settlement state (SETTLED/SETTLE). Maps optimistic_finality_status and
 * challenge_close_height into a ChainTaskView the state machine can consume.
 * verdict isn't part of SettlementFinality (it lives in the Settlement query),
 * so it's left unset here -- reconcile falls back to its default.
 */
export function settlementFinalityToChainView(f: SettlementFinalityView): ChainTaskView {
  return {
    state: 'SETTLED',
    phase: 'SETTLE',
    finality: f.optimisticFinalityStatus,
    challengeUntil: f.challengeCloseHeight,
  };
}
