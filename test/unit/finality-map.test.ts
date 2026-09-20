import { describe, it, expect } from 'vitest';
import { settlementFinalityToChainView } from '../../src/state/finality-map';
import type { SettlementFinalityView } from '../../src/types/node';
import { reconcile } from '../../src/state/reconcile';

describe('settlementFinalityToChainView', () => {
  const base: SettlementFinalityView = {
    optimisticFinalityStatus: 'PENDING', challengeCloseHeight: 200n,
    maxChallengeResolveDeadlineHeight: 250n, taskFinalityHeight: 0n, claimableAfterHeight: 0n,
  };
  it('SETTLED view carries finality + challengeUntil', () => {
    const v = settlementFinalityToChainView({ ...base, optimisticFinalityStatus: 'CHALLENGED' });
    expect(v.state).toBe('SETTLED');
    expect(v.phase).toBe('SETTLE');
    expect(v.finality).toBe('CHALLENGED');
    expect(v.challengeUntil).toBe(200n);
  });
  it('fed into reconcile: FINAL -> final', () => {
    const v = settlementFinalityToChainView({ ...base, optimisticFinalityStatus: 'FINAL' });
    const out = reconcile({ kind: 'draft' }, v);
    expect(out.kind).toBe('final');
  });
  it('fed into reconcile: OVERTURNED -> optimistic_finality(OVERTURNED)', () => {
    const v = settlementFinalityToChainView({ ...base, optimisticFinalityStatus: 'OVERTURNED' });
    const out = reconcile({ kind: 'draft' }, v);
    expect(out.kind).toBe('optimistic_finality');
    if (out.kind === 'optimistic_finality') expect(out.finality).toBe('OVERTURNED');
  });
});
