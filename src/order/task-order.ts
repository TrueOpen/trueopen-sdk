import {
  canonicalFrameBytes,
  canonicalHashBytes,
  uint32BE,
  int32BE,
  uint64BE,
  boolByte,
  enumBE,
} from '../codec/domain-hash';
import { canonicalOperatorAddressBytes } from '../codec/address';
import { toHex } from '../util/bytes';
import { TrueOpenError } from '../errors/errors';

const enc = new TextEncoder();
const HASH32 = 32;
const U64_MAX = (1n << 64n) - 1n;

/** The TaskOrder entry in wire registry/v1/domains.json (the V1 row was removed as of v0.3.0). */
export const DOMAIN_TASK_ORDER_V2 = 'TRUEOPEN_TASK_ORDER_V2';

/** The only value currently accepted for GenerationParamsV1.generation_params_schema_version. */
export const GENERATION_PARAMS_SCHEMA_VERSION_V1 = 1;

/** TaskOrderV2.schema_version is always 2; a fresh genesis does not accept V1 orders and has no compatibility decode path. */
export const TASK_ORDER_SCHEMA_VERSION_V2 = 2;

/** shared.v1.TaskType. */
export const TASK_TYPE = {
  UNSPECIFIED: 0,
  TEXT_GENERATION: 1,
  CHAT: 2,
  EMBEDDING: 3,
  CLASSIFICATION: 4,
  IMAGE_GENERATION: 5,
  MULTIMODAL: 6,
} as const;

/** task.v1.DeadlineLatencyClass. */
export const DEADLINE_LATENCY_CLASS = {
  UNSPECIFIED: 0,
  ECONOMY: 1,
  STANDARD: 2,
  FAST: 3,
  EXPRESS: 4,
} as const;

/**
 * shared.v1.Amount: what feeds into the preimage is the **decimal text string**
 * atomic_units, not a numeric value, and it must be wrapped in another single-field
 * frame (per the registry comment: FRAME_V1(ascii(canonical u64 decimal)), never a bare
 * u64_be). denom does not participate in task_hash.
 */
export interface AmountV1 {
  readonly atomicUnits: string;
}

/** task.v1.DecodingParamsV1. The SDK must explicitly fill in defaults before signing - it feeds into task_hash. */
export interface DecodingParamsV1 {
  readonly samplingEnabled: boolean;
  readonly temperatureMilli: number;
  readonly topPPpm: number;
  /** 0 disables top-k. */
  readonly topK: number;
  readonly seed: bigint;
  readonly presencePenaltyMilli: number;
  readonly frequencyPenaltyMilli: number;
  readonly repetitionPenaltyPpm: number;
  /** Ascending UTF-8 byte order. */
  readonly stopSequences: readonly string[];
  /** Ascending numeric order. */
  readonly stopTokenIds: readonly number[];
}

/** task.v1.GenerationParamsV1. */
export interface GenerationParamsV1 {
  readonly generationParamsSchemaVersion: number;
  readonly maxOutputTokens: bigint;
  /** Milliseconds. */
  readonly maxOutputDuration: bigint;
  readonly decodingParams: DecodingParamsV1;
}

/** task.v1.DeadlinePolicyV1: carries only the latency tier; the actual timeout block count is recomputed by the Keeper. */
export interface DeadlinePolicyV1 {
  readonly latencyClass: number;
}

/**
 * task.v1.TaskOrderV2 (frozen as of wire v0.3.0). Field names correspond to proto field
 * numbers 1..25.
 *
 * Changes relative to V1: the 8 Amount fields were collapsed into 4 (dropping
 * infer_input_unit_price_bid / infer_output_unit_price_bid / verify_unit_price_bid /
 * infer_fee_cap / verify_fee_cap, and adding a unified price_bid), reference_bucket_version
 * was removed, and field numbers from 14 onward shifted accordingly.
 *
 * task_id / task_hash / generation_params_digest / order_value / task_builder_seed /
 * reward bucket / resource tier / Task Builders are all derived by the Keeper and
 * **must not** be submitted here.
 */
export interface TaskOrderV2 {
  readonly schemaVersion: number;
  readonly chainId: string;
  /** Canonical bech32; what feeds into the preimage is the address codec bytes, not the text. */
  readonly userAddress: string;
  /** Raw 32-byte Hash32. */
  readonly sessionId: Uint8Array;
  readonly orderSequence: bigint;
  readonly modelId: string;
  readonly profileVersion: number;
  readonly taskType: number;
  /** Raw 32-byte Hash32 = sha256(input). */
  readonly inputHash: Uint8Array;
  readonly inputSizeBytes: bigint;
  readonly inputBucket: number;
  readonly outputBudgetBucket: number;
  readonly generationParams: GenerationParamsV1;
  readonly priceBid: AmountV1;
  readonly maxFee: AmountV1;
  readonly assignmentPriorityFee: AmountV1;
  readonly txFeeReserve: AmountV1;
  readonly earliestSubmitHeight: bigint;
  readonly orderExpireHeight: bigint;
  readonly deadlinePolicy: DeadlinePolicyV1;
  readonly timeoutBucketVersion: bigint;
  readonly sessionAnchorHeight: bigint;
  /** Raw 32-byte Hash32. */
  readonly sessionAnchorBlockHash: Uint8Array;
  readonly builderSetId: string;
  /** Raw 32-byte Hash32. */
  readonly builderSetHash: Uint8Array;
}

/**
 * The canonical task_hash (raw 32 bytes) - the Task's **content identity**: change a
 * single bit in any TaskOrder field and task_hash changes; swapping in a different user
 * signature alone does not. Paired with it is task_id (the stable RBF-slot identity).
 *
 * Reference: the three digests published in monorepo
 * docs/10-Protocol-Spec/04-Task/08-TaskOrder-Hash-and-Signature.md Section 8.3 (core /
 * decoding-params lower bound / the four Amount fields at their u64 upper bound), which
 * are checked together with the preimage length and five key intermediate frames in
 * test/unit/task-order-contract-vectors.test.ts. wire v0.4.1 hasn't turned this into a
 * testdata fixture yet (wire#24), but the published values are themselves authoritative
 * - node / cortex / nexus / SDK all match against the same values. This implementation
 * matches nexus internal/nodecontract/taskorder.go's canonicalTaskOrderFieldsV2
 * field-for-field (verified 2026-09-15 against nexus main@b19f6206).
 *
 * If either side changes the framing, the same TaskOrder will hash to a different
 * task_hash, and the Keeper will bounce it back at admission via the user's signature -
 * so field order and encoding here **must not** be "optimized", and any change must be
 * synchronized with the contract. Don't just "update the expected value in place" -
 * first confirm what changed on the contract side.
 */
export function taskOrderHash(order: TaskOrderV2): Uint8Array {
  return canonicalHashBytes(enc.encode(DOMAIN_TASK_ORDER_V2), ...canonicalTaskOrderFields(order));
}

/** The canonical lowercase 64-hex form of taskOrderHash. */
export function taskOrderHashHex(order: TaskOrderV2): string {
  return toHex(taskOrderHash(order));
}

/** Flatten TaskOrderV2 in ascending order of proto field numbers 1..25 (the same order as the registry's fields array). */
function canonicalTaskOrderFields(order: TaskOrderV2): Uint8Array[] {
  validateTaskOrderScalarScope(order);

  const user = canonicalOperatorAddressBytes('user_address', order.userAddress);

  // The 4 Amount fields at 14-17 are in ascending proto field-number order; this order must not change.
  const amounts = [order.priceBid, order.maxFee, order.assignmentPriorityFee, order.txFeeReserve];
  const encodedAmounts = amounts.map((amount, index) =>
    // Amount is a nested message, so its framing is its own single-field frame, not bare atomic_units bytes.
    canonicalFrameBytes(canonicalAmountUnits(amount, index + 14)),
  );

  // deadline_policy is likewise a nested single-field frame, not a bare enum.
  const deadline = canonicalFrameBytes(enumBE(order.deadlinePolicy.latencyClass));

  return [
    uint32BE(order.schemaVersion),
    utf8Field('chain_id', order.chainId),
    user,
    order.sessionId,
    uint64BE(order.orderSequence),
    utf8Field('model_id', order.modelId),
    uint32BE(order.profileVersion),
    enumBE(order.taskType),
    order.inputHash,
    uint64BE(order.inputSizeBytes),
    uint32BE(order.inputBucket),
    uint32BE(order.outputBudgetBucket),
    canonicalGenerationParamsFrame(order.generationParams),
    ...encodedAmounts,
    uint64BE(order.earliestSubmitHeight),
    uint64BE(order.orderExpireHeight),
    deadline,
    uint64BE(order.timeoutBucketVersion),
    uint64BE(order.sessionAnchorHeight),
    order.sessionAnchorBlockHash,
    utf8Field('builder_set_id', order.builderSetId),
    order.builderSetHash,
  ];
}

/**
 * Encodes field 13 (GenerationParamsV1). Two levels of nesting: the GenerationParams
 * frame wraps a DecodingParams frame, whose two repeated fields each get their own
 * additional "u32 element count + elements" frame. The registry specifically calls out
 * that both repeated members **must write their own count frame even when empty**.
 */
function canonicalGenerationParamsFrame(params: GenerationParamsV1): Uint8Array {
  if (params.generationParamsSchemaVersion !== GENERATION_PARAMS_SCHEMA_VERSION_V1) {
    throw invalid('unsupported generation params schema version');
  }
  const d = params.decodingParams;

  const stops: Uint8Array[] = [uint32BE(d.stopSequences.length)];
  for (const value of d.stopSequences) stops.push(utf8Field('stop_sequence', value));

  const tokens: Uint8Array[] = [uint32BE(d.stopTokenIds.length)];
  for (const value of d.stopTokenIds) tokens.push(uint32BE(value));

  const decodingFrame = canonicalFrameBytes(
    boolByte(d.samplingEnabled),
    uint32BE(d.temperatureMilli),
    uint32BE(d.topPPpm),
    uint32BE(d.topK),
    uint64BE(d.seed),
    int32BE(d.presencePenaltyMilli),
    int32BE(d.frequencyPenaltyMilli),
    uint32BE(d.repetitionPenaltyPpm),
    canonicalFrameBytes(...stops),
    canonicalFrameBytes(...tokens),
  );

  return canonicalFrameBytes(
    uint32BE(params.generationParamsSchemaVersion),
    uint64BE(params.maxOutputTokens),
    uint64BE(params.maxOutputDuration),
    decodingFrame,
  );
}

/**
 * Validate and extract Amount.atomic_units' canonical bytes:
 * non-negative decimal, no leading zeroes, within uint64. What feeds into the preimage
 * is this **decimal text string**, not a numeric value.
 */
function canonicalAmountUnits(amount: AmountV1, fieldNumber: number): Uint8Array {
  const units = amount.atomicUnits;
  const bad = (why: string): TrueOpenError =>
    invalid(`order amount field ${fieldNumber} is not canonical: amount atomic_units ${why}`);
  if (units === '') throw bad('is required');
  if (units !== '0' && units.startsWith('0')) throw bad('must not contain leading zeroes');
  if (!/^[0-9]+$/.test(units)) throw bad('must be canonical unsigned decimal');
  if (BigInt(units) > U64_MAX) throw bad('exceeds uint64');
  return enc.encode(units);
}

/**
 * Preconditions for framing: a Hash32 must really be 32 bytes, and text must be strict
 * UTF-8, otherwise the computed digest silently diverges from the Keeper's. This isn't
 * "business validation" - an order that can't produce a task_hash will be rejected on
 * chain regardless, so failing early is better.
 */
function validateTaskOrderScalarScope(order: TaskOrderV2): void {
  const ok =
    order.schemaVersion === TASK_ORDER_SCHEMA_VERSION_V2 &&
    order.chainId !== '' &&
    order.modelId !== '' &&
    order.sessionId.length === HASH32 &&
    order.profileVersion !== 0 &&
    order.taskType !== TASK_TYPE.UNSPECIFIED &&
    order.inputHash.length === HASH32 &&
    order.inputSizeBytes !== 0n &&
    order.outputBudgetBucket !== 0 &&
    order.earliestSubmitHeight !== 0n &&
    order.orderExpireHeight !== 0n &&
    order.earliestSubmitHeight < order.orderExpireHeight &&
    order.deadlinePolicy.latencyClass !== DEADLINE_LATENCY_CLASS.UNSPECIFIED &&
    order.timeoutBucketVersion !== 0n &&
    order.sessionAnchorHeight !== 0n &&
    order.sessionAnchorBlockHash.length === HASH32 &&
    order.builderSetId !== '' &&
    order.builderSetHash.length === HASH32;
  if (!ok) throw invalid('task order scalar scope is invalid');
}

/** The string rule from Section 1.2: validate strict UTF-8 first (on the JS side, this means rejecting lone surrogates), then take the bytes. */
function utf8Field(field: string, value: string): Uint8Array {
  if (/[\uD800-\uDFFF]/.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) {
    throw invalid(`${field} must be strict UTF-8`);
  }
  return enc.encode(value);
}

function invalid(message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_TASK_ORDER_INVALID', message);
}
