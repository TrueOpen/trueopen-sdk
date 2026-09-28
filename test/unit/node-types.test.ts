import { describe, it, expect } from 'vitest';
import type { StreamStateView } from '../../src/types/node';
import { TaskFailureClass, TaskVerdict, TaskPhase, TaskFinalityStatusV1 } from '../../src/index';

describe('node view types', () => {
  it('StreamStateView shape can be constructed', () => {
    const s: StreamStateView = {
      sessionId: 's1', owner: 'trueopen1abc', nextExpectedSequence: 3n,
      lastActiveHeight: 100n, openPendingCount: 1n, status: 'ACTIVE',
    };
    expect(s.nextExpectedSequence).toBe(3n);
  });

  it('task lifecycle enums are the generated wire enums', () => {
    // Values are the wire numbers, so a REST enum name maps back by name.
    expect(TaskFailureClass[TaskFailureClass.INSUFFICIENT_VERIFIER]).toBe('INSUFFICIENT_VERIFIER');
    expect(TaskVerdict.PASS).toBe(1);
    expect(TaskFinalityStatusV1.FINAL).toBe(2);
    expect(typeof TaskPhase.UNSPECIFIED).toBe('number');
  });
});
