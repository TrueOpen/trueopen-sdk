import { describe, it, expect } from 'vitest';
import type { StreamStateView, TaskFailureClass } from '../../src/types/node';

describe('node view types', () => {
  it('StreamStateView shape can be constructed', () => {
    const s: StreamStateView = {
      sessionId: 's1', owner: 'trueopen1abc', nextExpectedSequence: 3n,
      lastActiveHeight: 100n, openPendingCount: 1n, status: 'ACTIVE',
    };
    const fc: TaskFailureClass = 'VALUE_MISMATCH';
    expect(s.nextExpectedSequence).toBe(3n);
    expect(fc).toBe('VALUE_MISMATCH');
  });
});
