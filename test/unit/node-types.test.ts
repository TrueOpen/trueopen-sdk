import { describe, it, expect } from 'vitest';
import type { StreamStateView, SettlementFinalityView, TaskFailureClass } from '../../src/types/node';
import { isChallengeKindEnabled, CHAIN_ENABLED_CHALLENGE_KINDS } from '../../src/types/node';

describe('node view types', () => {
  it('StreamStateView / SettlementFinalityView shapes can be constructed', () => {
    const s: StreamStateView = {
      sessionId: 's1', owner: 'trueopen1abc', nextExpectedSequence: 3n,
      lastActiveHeight: 100n, openPendingCount: 1n, status: 'ACTIVE',
    };
    const f: SettlementFinalityView = {
      optimisticFinalityStatus: 'CHALLENGED', challengeCloseHeight: 200n,
      maxChallengeResolveDeadlineHeight: 250n, taskFinalityHeight: 0n, claimableAfterHeight: 0n,
    };
    const fc: TaskFailureClass = 'VALUE_MISMATCH';
    expect(s.nextExpectedSequence).toBe(3n);
    expect(f.optimisticFinalityStatus).toBe('CHALLENGED');
    expect(fc).toBe('VALUE_MISMATCH');
  });
  it('challenge kind enabled set: only USER_REVALIDATION', () => {
    expect(CHAIN_ENABLED_CHALLENGE_KINDS).toEqual(['USER_REVALIDATION']);
    expect(isChallengeKindEnabled('USER_REVALIDATION')).toBe(true);
    expect(isChallengeKindEnabled('OBJECTIVE_PROOF')).toBe(false);
    expect(isChallengeKindEnabled('VERDICT_FRAUD_PROOF')).toBe(false);
  });
});
