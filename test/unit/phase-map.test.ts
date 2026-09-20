import { describe, it, expect } from 'vitest';
import { phaseToState } from '../../src/task/phase-map';
import type { TaskPhase, TaskState } from '../../src/types/task';

describe('phaseToState', () => {
  const cases: Array<[TaskPhase, TaskState]> = [
    ['ASSIGN_RANDOMNESS_PENDING', 'PENDING'],
    ['ASSIGNMENT_FINALIZED', 'ASSIGNED'],
    ['OPEN_VERIFY', 'VERIFYING'],
    ['SAMPLE_READY', 'VERIFYING'],
    ['COMMIT', 'VERIFYING'],
    ['WORKER_REVEAL', 'VERIFYING'],
    ['FULL_RESULT_REVEAL', 'VERIFYING'],
    ['SETTLE', 'SETTLED'],
    ['SWEEP_OBSERVED', 'SETTLED'],
  ];
  it.each(cases)('%s → %s', (phase, state) => {
    expect(phaseToState(phase)).toBe(state);
  });
});
