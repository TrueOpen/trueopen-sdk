import type { TaskVerdict } from './task';
import type { ChallengeKind, OptimisticFinalityStatus } from './challenge';

/** node task.v1 failure_class (K9 taxonomy). */
export type TaskFailureClass =
  | 'NONE'
  | 'OK' // legacy alias (node failure_class.go; new code writes NONE)
  | 'INSUFFICIENT_VERIFIER'
  | 'VALUE_MISMATCH'
  | 'SCHEMA_FAULT'
  | 'WORKER_REVEAL_FAULT';

/** SDK view of node task.v1.StreamState (camelCase mapping). */
export interface StreamStateView {
  readonly sessionId: string;
  readonly owner: string; // owner_user_address
  readonly nextExpectedSequence: bigint;
  readonly lastActiveHeight: bigint;
  readonly openPendingCount: bigint;
  readonly status: 'ACTIVE' | 'IDLE' | 'CLOSED';
}

/** Query view of node task.v1 SettlementFinality. */
export interface SettlementFinalityView {
  readonly optimisticFinalityStatus: OptimisticFinalityStatus;
  readonly challengeCloseHeight: bigint;
  readonly maxChallengeResolveDeadlineHeight: bigint;
  readonly taskFinalityHeight: bigint;
  readonly claimableAfterHeight: bigint;
}

/** Query view of node task.v1 Settlement (the subset the SDK cares about). */
export interface SettlementView extends SettlementFinalityView {
  readonly sessionId: string;
  readonly taskId: string;
  readonly settlementId: string;
  readonly taskVerdict: TaskVerdict;
  readonly failureClass: TaskFailureClass;
}

/** The only challenge kind currently enabled on chain (node UserChallenge only accepts USER_REVALIDATION). */
export const CHAIN_ENABLED_CHALLENGE_KINDS: readonly ChallengeKind[] = ['USER_REVALIDATION'];

export function isChallengeKindEnabled(kind: ChallengeKind): boolean {
  return CHAIN_ENABLED_CHALLENGE_KINDS.includes(kind);
}

/**
 * Key facts about an on-chain task (the active view from QueryTask). Needed by both
 * retrieval and stream subscription: task_hash is the first field of
 * TaskDataObjectRefV1, and winner_worker determines whose frame signature to verify.
 */
export interface ChainTaskSnapshot {
  readonly taskId: string;
  /** Canonical lowercase 64-hex; should match the SDK's locally computed task_hash byte for byte. */
  readonly acceptedTaskHash: string;
  readonly acceptedInputHash: string;
  /** Operator address of the selected Worker. */
  readonly winnerWorker: string;
  /** Value of RECEIPT_STATUS_* with the prefix stripped; NONE means the Worker hasn't submitted an InferReceipt yet. */
  readonly receiptStatus: string;
  readonly assignmentStatus: string;
  readonly modelId: string;
  readonly profileVersion: bigint;
  readonly orderSequence: bigint;
}

/**
 * The on-chain InferReceipt (QueryInferReceipt).
 * Since ADR-0017, output_hash is the MMR root over the list of chunks, not a
 * whole-object sha256 -- it is both the validation target for retrieval and
 * TaskDataObjectRefV1.content_hash (retrieval is content-addressed).
 */
export interface InferReceiptView {
  readonly taskId: string;
  readonly winnerWorker: string;
  readonly inferReceiptHash: string;
  /** Canonical lowercase 64-hex, the root of TRUEOPEN_OUTPUT_MMR_V1. */
  readonly outputHash: string;
  readonly outputSizeBytes: bigint;
  /** Number of chunks (>= 1). An empty output is a single zero-length leaf, not an empty tree. */
  readonly outputLeafCount: bigint;
}
