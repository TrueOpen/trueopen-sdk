
/** SDK view of node task.v1.StreamState (camelCase mapping). */
export interface StreamStateView {
  readonly sessionId: string;
  readonly owner: string; // owner_user_address
  readonly nextExpectedSequence: bigint;
  readonly lastActiveHeight: bigint;
  readonly openPendingCount: bigint;
  readonly status: 'ACTIVE' | 'IDLE' | 'CLOSED';
  /** The registered session key's 20-byte address; absent = wallet-only session. */
  readonly sessionKey?: Uint8Array;
  /** 0 when there is no key. */
  readonly sessionKeyExpiryHeight: bigint;
  /** Canonical decimal atomic units; "0" when there is no key or the key is unlimited. */
  readonly sessionKeySpendCap: string;
  readonly sessionKeySpent: string;
  readonly sessionKeySetHeight: bigint;
}

/**
 * Key facts about an on-chain task (QueryTask). Needed by both retrieval and stream
 * subscription: task_hash is the first field of TaskDataObjectRefV1, and winner_worker
 * determines whose frame signature to verify.
 *
 * TaskViewV1 has two arms. `active` is the composite view of an uncompacted task;
 * `terminal` is the fixed-size TaskTerminalSummaryState kept after cleanup compaction,
 * which no longer carries accepted_input_hash, receipt_status or assignment_status.
 */
export interface ChainTaskSnapshot {
  /**
   * Which TaskViewV1 arm the chain returned. Branch on this before reading any field
   * marked "active arm only" below: on the terminal arm they are `undefined`, not "", so
   * a caller written against the active arm cannot read a compacted task as one with an
   * empty input hash and no receipt.
   */
  readonly view: 'active' | 'terminal';
  /** TaskPhase without its prefix, for the terminal arm only (for example "SETTLED"). */
  readonly terminalPhase?: string;
  /**
   * TaskPhase without its prefix (for example "WORKER_ASSIGNMENT_PENDING", "FAILED"). Active arm
   * only; undefined when the node does not send it. A task that fails or settles keeps the
   * active arm, with this phase, until cleanup compaction switches it to the terminal arm.
   */
  readonly taskPhase?: string;
  readonly taskId: string;
  /** Hash32 text (`0x` + 64 lowercase hex); should match the SDK's locally computed task_hash byte for byte. */
  readonly acceptedTaskHash: string;
  /** Active arm only. */
  readonly acceptedInputHash?: string;
  /** Operator address of the selected Worker. */
  readonly winnerWorker: string;
  /**
   * Value of RECEIPT_STATUS_* with the prefix stripped; NONE means the Worker hasn't
   * submitted an InferReceipt yet. Active arm only.
   */
  readonly receiptStatus?: string;
  /** Active arm only. */
  readonly assignmentStatus?: string;
  /** Hash32 text (`0x` + 64 lowercase hex), decoded the same way hub.v1's reader decodes it. */
  readonly modelId: string;
  readonly profileVersion: bigint;
  readonly orderSequence: bigint;
}

/**
 * The on-chain InferReceipt (QueryInferReceipt).
 * output_hash is the MMR root over the list of chunks, not a
 * whole-object sha256 -- it is both the validation target for retrieval and
 * TaskDataObjectRefV1.content_hash (retrieval is content-addressed).
 */
export interface InferReceiptView {
  readonly taskId: string;
  readonly winnerWorker: string;
  readonly inferReceiptHash: string;
  /** Hash32 text (`0x` + 64 lowercase hex), the root of TRUEOPEN_OUTPUT_MMR_V1. */
  readonly outputHash: string;
  readonly outputSizeBytes: bigint;
  /** Number of chunks (>= 1). An empty output is a single zero-length leaf, not an empty tree. */
  readonly outputLeafCount: bigint;
}
