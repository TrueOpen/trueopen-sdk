import type { TaskPhase, TaskState } from '../types/task';

/**
 * TaskPhase -> TaskState coarse-state mapping (Interface Inventory §0.1).
 * Note: SWEEP_OBSERVED maps to SETTLED; whether the final outcome is FAILED
 * is decided by task_verdict / an on-chain query, not by phase alone
 * (Detailed Design §2.7 / §3).
 */
const MAP: Record<TaskPhase, TaskState> = {
  ASSIGN_RANDOMNESS_PENDING: 'PENDING',
  ASSIGNMENT_FINALIZED: 'ASSIGNED',
  OPEN_VERIFY: 'VERIFYING',
  SAMPLE_READY: 'VERIFYING',
  COMMIT: 'VERIFYING',
  WORKER_REVEAL: 'VERIFYING',
  FULL_RESULT_REVEAL: 'VERIFYING',
  SETTLE: 'SETTLED',
  SWEEP_OBSERVED: 'SETTLED',
};

export function phaseToState(phase: TaskPhase): TaskState {
  return MAP[phase];
}
