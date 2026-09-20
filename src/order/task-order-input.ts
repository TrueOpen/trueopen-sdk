import { sha256 } from '../codec/hash';
import { fromHex, toHex } from '../util/bytes';
import { TrueOpenError } from '../errors/errors';
import { validateModelId } from './model-id';
import {
  DEADLINE_LATENCY_CLASS,
  GENERATION_PARAMS_SCHEMA_VERSION_V1,
  TASK_ORDER_SCHEMA_VERSION_V2,
} from './task-order';
import type { AmountV1, GenerationParamsV1, TaskOrderV2 } from './task-order';
import { BUCKET_KIND } from '../types/hub';
import type { BuilderSetSnapshot, BeaconView, ParameterBucketView, ProfilePricing, TaskGenerationLimits } from '../types/hub';

/**
 * On-chain-derived order context - **every field feeds into the user's signature**, so
 * each one must be read individually from an authoritative source, never guessed. The
 * Keeper's validation rules for each field (node x/task/keeper/
 * task_builder_selection_runtime.go:51-71, msg_server_worker_handraises.go:486-502):
 *
 *  - builder_set_id is the identifier of that set on chain (as of v0.4.1 it looks like
 *    "genesis-1", no longer a decimal term); builder_set_hash must equal that set
 *    snapshot's hash.
 *  - session_anchor_height must not be earlier than that set's effective_height.
 *  - session_anchor_block_hash must equal GetBlockAnchorHash(height), i.e. the
 *    block_hash recorded by the on-chain **beacon** (not a block header read directly).
 *  - timeout_bucket_version must equal the currently effective version.
 *    (reference_bucket_version was removed from TaskOrderV2 and no longer feeds the
 *    signature, so it is no longer read.)
 */
export interface TaskOrderChainContext {
  readonly chainId: string;
  readonly sessionAnchorHeight: bigint;
  /** Canonical lowercase 64-hex. */
  readonly sessionAnchorBlockHash: string;
  readonly builderSetId: string;
  /** Canonical lowercase 64-hex. */
  readonly builderSetHash: string;
  readonly timeoutBucketVersion: bigint;
  /**
   * The task's generation limits. **Re-read on every order** (governance can change
   * them) and never cached: locally passing a stale limit only for the chain to reject
   * it is harder to debug than skipping validation entirely.
   */
  readonly generationLimits: TaskGenerationLimits;
  /** The latest block height at the time the context was fetched, so callers can derive a height window. */
  readonly latestHeight: bigint;
}

/** The minimal read capability resolveTaskOrderContext needs (HubReader satisfies it; makes test injection easy). */
export interface TaskOrderContextReader {
  getLatestHeight(): Promise<bigint>;
  getActiveBuilderSet(): Promise<BuilderSetSnapshot>;
  getBeacon(height: bigint): Promise<BeaconView>;
  getParameterBucket(
    kind: typeof BUCKET_KIND[keyof typeof BUCKET_KIND],
    bucketKey?: string,
  ): Promise<ParameterBucketView>;
  getTaskGenerationLimits(): Promise<TaskGenerationLimits>;
}

/**
 * The four Amount fields (proto fields 14-17, in the same order as the preimage).
 * V1's eight separate price fields (infer_input/infer_output/verify unit prices,
 * infer/verify caps) were merged into a single price_bid in TaskOrderV2.
 */
export interface TaskOrderAmounts {
  readonly priceBid: AmountV1;
  readonly maxFee: AmountV1;
  readonly assignmentPriorityFee: AmountV1;
  readonly txFeeReserve: AmountV1;
}

/**
 * The "session-independent" part of the user's intent: userAddress / sessionId /
 * orderSequence are filled in by the caller above (TrueOpenClient) from its own config
 * and call parameters.
 */
export type TaskOrderIntent = Omit<TaskOrderRequest, 'userAddress' | 'sessionId' | 'orderSequence'>;

/** The user-intent portion (excludes on-chain context and any Keeper-derived values). */
export interface TaskOrderRequest {
  readonly userAddress: string;
  /** Canonical lowercase 64-hex (the SDK's internal uniform representation). */
  readonly sessionId: string;
  readonly orderSequence: bigint;
  readonly modelId: string;
  readonly profileVersion: number;
  /** shared.v1.TaskType numeric value (see TASK_TYPE). */
  readonly taskType: number;
  /** The raw plaintext input; input_hash / input_size_bytes are derived from it. */
  readonly payload: Uint8Array;
  readonly inputBucket: number;
  /** Must be non-zero (required by the Keeper's scalar scope check). */
  readonly outputBudgetBucket: number;
  readonly generationParams: GenerationParamsV1;
  readonly amounts: TaskOrderAmounts;
  readonly earliestSubmitHeight: bigint;
  readonly orderExpireHeight: bigint;
  /** task.v1.DeadlineLatencyClass numeric value (see DEADLINE_LATENCY_CLASS). */
  readonly latencyClass: number;
}

/**
 * Explicit default values for the V1 decoding params.
 *
 * The contract requires that "the SDK must explicitly fill in defaults before signing"
 * (per DecodingParamsV1's proto comment), because these values feed into task_hash -
 * silently filling in defaults would mean signing on the user's behalf for parameters
 * they never saw. So this is a **visible baseline that the caller must opt into**,
 * rather than an implicit internal backfill. stop_sequences must be sorted in ascending
 * UTF-8 byte order, and stop_token_ids in ascending numeric order.
 *
 * These values are chosen to be "identity / distribution-preserving" neutral values,
 * not zero values - node's `x/task/types/generation_params.go:52-66` enforces hard
 * ranges on them, and zero is rejected outright for some:
 *   temperature_milli       <= 2_000              (1_000 = 1.0)
 *   top_p_ppm               1..1_000_000          (1_000_000 = 1.0; 0 is rejected)
 *   repetition_penalty_ppm  100_000..2_000_000    (1_000_000 = 1.0; 0 is rejected)
 *   presence/frequency      -2_000..2_000         (0 is neutral)
 * top_k's upper bound comes from the profile's GenerationLimitParamsV1, where 0 means
 * unlimited, so it stays at 0.
 */
export function defaultGenerationParams(maxOutputTokens: bigint, maxOutputDurationMs: bigint): GenerationParamsV1 {
  return {
    generationParamsSchemaVersion: GENERATION_PARAMS_SCHEMA_VERSION_V1,
    maxOutputTokens,
    maxOutputDuration: maxOutputDurationMs,
    decodingParams: {
      samplingEnabled: false,
      temperatureMilli: 1_000,
      topPPpm: 1_000_000,
      topK: 0,
      seed: 0n,
      presencePenaltyMilli: 0,
      frequencyPenaltyMilli: 0,
      repetitionPenaltyPpm: 1_000_000,
      stopSequences: [],
      stopTokenIds: [],
    },
  };
}

/**
 * Read the full context an order needs from the chain.
 *
 * The anchor is `latestHeight - anchorLag`: since the beacon is written block by block,
 * using a slightly older height avoids racing the latest block (whose beacon record may
 * not be queryable yet), while still staying at or after the set's effective height.
 */
export async function resolveTaskOrderContext(
  hub: TaskOrderContextReader,
  chainId: string,
  opts?: { readonly anchorLag?: bigint },
): Promise<TaskOrderChainContext> {
  const latestHeight = await hub.getLatestHeight();
  const lag = opts?.anchorLag ?? 2n;
  const anchorHeight = latestHeight > lag ? latestHeight - lag : latestHeight;

  const [set, beacon, timeout, generationLimits] = await Promise.all([
    hub.getActiveBuilderSet(),
    hub.getBeacon(anchorHeight),
    hub.getParameterBucket(BUCKET_KIND.TIMEOUT),
    hub.getTaskGenerationLimits(),
  ]);

  if (beacon.height !== anchorHeight) {
    throw invalid('SDK_LOCAL_ANCHOR_HEIGHT_MISMATCH', `beacon height ${beacon.height} != requested ${anchorHeight}`);
  }
  // The anchor must not be earlier than that set's effective height - otherwise the
  // builder_set_hash signed into the order wouldn't be authoritative at that height.
  // The old term window (start/end/snapshot) was removed along with the term model.
  if (set.effectiveHeight > anchorHeight) {
    throw invalid(
      'SDK_LOCAL_ANCHOR_BEFORE_BUILDER_SET',
      `anchor height ${anchorHeight} is before builder set ${set.builderSetId} takes effect at ${set.effectiveHeight}`,
    );
  }

  return {
    chainId,
    sessionAnchorHeight: anchorHeight,
    sessionAnchorBlockHash: beacon.blockHash,
    builderSetId: set.builderSetId,
    builderSetHash: set.setHash,
    // What gets signed in must be the **currently effective version**, not the version recorded on the bucket itself.
    timeoutBucketVersion: timeout.currentVersion,
    generationLimits,
    latestHeight,
  };
}

/**
 * Assemble the frozen TaskOrderV2. This is a pure function: both the on-chain context
 * and the user intent are supplied by the caller; this function only does
 * representation conversion and local validation, and never implicitly fills in any
 * field that feeds into the signature.
 */
export function buildTaskOrder(
  ctx: TaskOrderChainContext,
  req: TaskOrderRequest,
  /** Pricing constraints for this model profile (HubReader.getProfile().pricing). If provided, validated locally. */
  pricing?: ProfilePricing,
): TaskOrderV2 {
  validateModelId(req.modelId);
  if (req.payload.length === 0) {
    throw invalid('SDK_LOCAL_PAYLOAD_EMPTY', 'payload must be non-empty');
  }
  // order_sequence has no local lower bound: the sole authority is the on-chain
  // StreamState.next_expected_sequence (node keeper/order_sequence.go:34-36), and the
  // first order of a newly created session is 0 (createSession doesn't write this
  // field, so it takes the proto3 zero value). This used to hard-validate >= 1, which
  // encoded protocol spec 04-Task/01-Session-and-Order Section 15's never-frozen
  // pending item "order_sequence starting value (0 or 1)", and would block a legitimate
  // first order locally.
  if (req.outputBudgetBucket === 0) {
    throw invalid('SDK_LOCAL_OUTPUT_BUCKET_INVALID', 'output_budget_bucket must be non-zero');
  }
  if (req.latencyClass === DEADLINE_LATENCY_CLASS.UNSPECIFIED) {
    throw invalid('SDK_LOCAL_LATENCY_CLASS_INVALID', 'latency_class must not be UNSPECIFIED');
  }
  if (req.earliestSubmitHeight === 0n || req.orderExpireHeight === 0n) {
    throw invalid('SDK_LOCAL_ORDER_WINDOW_INVALID', 'earliest_submit_height and order_expire_height must be non-zero');
  }
  // order_value must be > 0, otherwise the Keeper rejects it at admission (node
  // x/task/types/task_order.go's TaskOrderCosts: "order_value is zero or overflows
  // uint64"). It's computed as:
  //   worker   = floor(max_output_tokens x price_bid / 1_000_000)
  //   verifier = floor(worker x verify_ratio_bps / 10_000)
  //   order_value = worker + verifier
  // In other words, **price_bid is the unit price per million tokens**. When the
  // product of the two is less than 1e6, worker rounds straight down to 0, and
  // order_value follows it to 0.
  //
  // This failure happens very late on chain: nexus accepts the order first, and only
  // after the Builder broadcasts it does the Keeper reject it - at which point nexus
  // simply drops the task, so from the caller's point of view the task just vanishes.
  // Hence we catch it here first. We only validate worker > 0: verifier depends on the
  // on-chain verify_ratio_bps, which isn't available locally; worker > 0 alone is
  // already enough to guarantee order_value > 0.
  validateGenerationLimits(req.generationParams, ctx.generationLimits);
  const workerMax = (req.generationParams.maxOutputTokens * BigInt(req.amounts.priceBid.atomicUnits)) / 1_000_000n;
  if (workerMax === 0n) {
    throw invalid(
      'SDK_LOCAL_ORDER_VALUE_ZERO',
      `order_value would be 0: floor(max_output_tokens ${req.generationParams.maxOutputTokens} x ` +
        `price_bid ${req.amounts.priceBid.atomicUnits} / 1e6) = 0. price_bid is the unit price per million tokens, ` +
        `the current value needs to be >= ${minPriceBidFor(1n, req.generationParams.maxOutputTokens)}`,
    );
  }
  // If profile pricing was given, also catch "below the profile minimum" locally - this
  // is likewise a rejection that only happens on chain after nexus has accepted the
  // order (node: "order_value is below the profile minimum").
  if (pricing !== undefined && pricing.minOrderValue > 0n) {
    const orderValue = workerMax + (workerMax * pricing.verifyRatioBps) / 10_000n;
    if (orderValue < pricing.minOrderValue) {
      throw invalid(
        'SDK_LOCAL_ORDER_VALUE_BELOW_PROFILE_MIN',
        `order_value ${orderValue} < profile min_order_value ${pricing.minOrderValue}; ` +
          `with max_output_tokens=${req.generationParams.maxOutputTokens}, verify_ratio_bps=${pricing.verifyRatioBps}, ` +
          `price_bid must be at least ${minPriceBidFor(pricing.minOrderValue, req.generationParams.maxOutputTokens, pricing.verifyRatioBps)}`,
      );
    }
    const maxFee = BigInt(req.amounts.maxFee.atomicUnits);
    const reserved = orderValue + BigInt(req.amounts.txFeeReserve.atomicUnits);
    if (reserved > maxFee) {
      throw invalid(
        'SDK_LOCAL_MAX_FEE_TOO_LOW',
        `order_value ${orderValue} + tx_fee_reserve ${req.amounts.txFeeReserve.atomicUnits} = ${reserved} > max_fee ${maxFee}`,
      );
    }
  }
  if (req.earliestSubmitHeight >= req.orderExpireHeight) {
    throw invalid(
      'SDK_LOCAL_ORDER_WINDOW_INVALID',
      `earliest_submit_height (${req.earliestSubmitHeight}) must be < order_expire_height (${req.orderExpireHeight})`,
    );
  }

  const a = req.amounts;
  return {
    schemaVersion: TASK_ORDER_SCHEMA_VERSION_V2,
    chainId: ctx.chainId,
    userAddress: req.userAddress,
    sessionId: hash32('session_id', req.sessionId),
    orderSequence: req.orderSequence,
    modelId: req.modelId,
    profileVersion: req.profileVersion,
    taskType: req.taskType,
    inputHash: sha256(req.payload),
    inputSizeBytes: BigInt(req.payload.length),
    inputBucket: req.inputBucket,
    outputBudgetBucket: req.outputBudgetBucket,
    generationParams: req.generationParams,
    priceBid: a.priceBid,
    maxFee: a.maxFee,
    assignmentPriorityFee: a.assignmentPriorityFee,
    txFeeReserve: a.txFeeReserve,
    earliestSubmitHeight: req.earliestSubmitHeight,
    orderExpireHeight: req.orderExpireHeight,
    deadlinePolicy: { latencyClass: req.latencyClass },
    timeoutBucketVersion: ctx.timeoutBucketVersion,
    sessionAnchorHeight: ctx.sessionAnchorHeight,
    sessionAnchorBlockHash: hash32('session_anchor_block_hash', ctx.sessionAnchorBlockHash),
    builderSetId: ctx.builderSetId,
    builderSetHash: hash32('builder_set_hash', ctx.builderSetHash),
  };
}

/**
 * Mirrors node's admission validation line by line (x/task/keeper/task_admission.go and
 * types/generation_params.go). These are all conditions the chain would reject
 * unconditionally, so failing early is better: failing on chain means waiting for
 * nexus accepted -> Builder broadcast -> Keeper rejection, and nexus then drops the
 * task, so from the caller's point of view the task just vanishes.
 */
function validateGenerationLimits(params: GenerationParamsV1, limits: TaskGenerationLimits): void {
  const d = params.decodingParams;
  if (params.maxOutputTokens === 0n || params.maxOutputDuration === 0n) {
    // 0 does not mean "unlimited": it both fails this check and would make order_value 0.
    throw invalid('SDK_LOCAL_GENERATION_PARAMS_INVALID', 'max_output_tokens and max_output_duration must be positive (0 does not mean unlimited)');
  }
  if (params.maxOutputTokens > limits.maxOutputTokens) {
    throw invalid(
      'SDK_LOCAL_MAX_OUTPUT_TOKENS_TOO_LARGE',
      `max_output_tokens ${params.maxOutputTokens} exceeds the on-chain limit ${limits.maxOutputTokens}`,
    );
  }
  if (BigInt(d.topK) > limits.topKMax) {
    throw invalid('SDK_LOCAL_TOP_K_TOO_LARGE', `top_k ${d.topK} exceeds the on-chain limit ${limits.topKMax}`);
  }
  if (BigInt(d.stopSequences.length) > limits.stopSequenceMaxItems) {
    throw invalid(
      'SDK_LOCAL_STOP_SEQUENCES_TOO_MANY',
      `stop_sequences has ${d.stopSequences.length} entries, exceeding the on-chain limit ${limits.stopSequenceMaxItems}`,
    );
  }
  const enc = new TextEncoder();
  let totalBytes = 0n;
  for (const [i, value] of d.stopSequences.entries()) {
    const n = BigInt(enc.encode(value).length);
    if (n > limits.stopSequenceMaxBytesEach) {
      throw invalid(
        'SDK_LOCAL_STOP_SEQUENCE_TOO_LONG',
        `stop_sequences[${i}] is ${n} bytes, exceeding the on-chain per-entry limit ${limits.stopSequenceMaxBytesEach}`,
      );
    }
    totalBytes += n;
  }
  if (totalBytes > limits.stopSequenceMaxTotalBytes) {
    throw invalid(
      'SDK_LOCAL_STOP_SEQUENCES_TOO_LONG',
      `stop_sequences total is ${totalBytes} bytes, exceeding the on-chain limit ${limits.stopSequenceMaxTotalBytes}`,
    );
  }
  if (BigInt(d.stopTokenIds.length) > limits.stopTokenMaxItems) {
    throw invalid(
      'SDK_LOCAL_STOP_TOKENS_TOO_MANY',
      `stop_token_ids has ${d.stopTokenIds.length} entries, exceeding the on-chain limit ${limits.stopTokenMaxItems}`,
    );
  }
}

/**
 * The minimum price_bid needed to satisfy order_value >= target.
 * Inverting worker = floor(tokens x pb / 1e6) and order_value = worker x (1 + ratio/1e4):
 * first solve for the needed worker, then for the needed pb, rounding up both times.
 */
function minPriceBidFor(targetOrderValue: bigint, maxOutputTokens: bigint, verifyRatioBps = 0n): bigint {
  if (maxOutputTokens === 0n) return 0n;
  const denom = 10_000n + verifyRatioBps;
  const neededWorker = (targetOrderValue * 10_000n + denom - 1n) / denom;
  const worker = neededWorker === 0n ? 1n : neededWorker;
  return (worker * 1_000_000n + maxOutputTokens - 1n) / maxOutputTokens;
}

/** Content-addressed reference for a payload (matches nexus payloadstore.RefFor). */
export function payloadRefFor(payload: Uint8Array): string {
  return `nexus://sha256/${toHex(sha256(payload))}`;
}

function hash32(field: string, hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw invalid('SDK_LOCAL_NOT_HASH32', `${field} must be canonical lowercase 64-hex Hash32, got ${JSON.stringify(hex)}`);
  }
  return fromHex(hex);
}

function invalid(code: string, message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', code, message);
}
