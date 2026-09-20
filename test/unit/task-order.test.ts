import { describe, it, expect } from 'vitest';
import {
  taskOrderHash,
  taskOrderHashHex,
  TASK_TYPE,
  DEADLINE_LATENCY_CLASS,
  GENERATION_PARAMS_SCHEMA_VERSION_V1,
} from '../../src/order/task-order';
import type { TaskOrderV2, AmountV1 } from '../../src/order/task-order';
import { canonicalOperatorAddressBytes } from '../../src/codec/address';
import { toHex } from '../../src/util/bytes';
import { bech32 } from '@scure/base';

/**
 * ⚠️ **This is not a cross-language golden value -- just a self-consistency
 * regression value.**
 *
 * Back in v0.1.2 this asserted against the V1 golden value published by node itself
 * (f7d3f70c..., from node x/task/types/task_order_test.go, which nexus also mirrored
 * as the same constant) -- that was hard evidence for task_hash between the SDK and
 * node/nexus. Since wire v0.3.0, TaskOrderV2 and TRUEOPEN_TASK_ORDER_V1 were removed
 * together, and V2 still has **no testdata vectors at all**
 * (registry/v1/domains.json only gives the 25 field names and framing rules), so that
 * hard evidence no longer applies.
 *
 * The value below is computed by this implementation itself. It only guards against
 * "accidental changes" -- it cannot catch "all three parties misreading the spec the
 * same way". As soon as wire publishes task_order_v2 vectors, switch to that value
 * immediately -- if it doesn't match, this implementation is wrong; do not change the
 * vector to match instead.
 */
const GOLDEN = 'd1456a9d1b78598387f6d9aa3aa8a2fd27e9ab4c9193ce2eec142060819da362';

const rep = (byte: number, size: number): Uint8Array => new Uint8Array(size).fill(byte);
const amount = (atomicUnits: string): AmountV1 => ({ atomicUnits });

// Reproduces sdk.AccAddress(0x11 * 20).String() from the node fixture. The hrp is not
// part of the preimage (framing uses the address codec bytes); "trueopen" is used only
// to match node's prefix.
const accAddress = (raw: Uint8Array): string => bech32.encode('trueopen', bech32.toWords(raw));

/** Reuses the values from the v0.1.2 fixture, rearranged to match TaskOrderV2's field set. */
function fixture(): TaskOrderV2 {
  return {
    schemaVersion: 2,
    chainId: 'trueopen-test-1',
    userAddress: accAddress(rep(0x11, 20)),
    sessionId: rep(0x12, 32),
    orderSequence: 7n,
    modelId: 'model-task-order',
    profileVersion: 3,
    taskType: TASK_TYPE.TEXT_GENERATION,
    inputHash: rep(0x13, 32),
    inputSizeBytes: 99n,
    inputBucket: 2,
    outputBudgetBucket: 4,
    generationParams: {
      generationParamsSchemaVersion: GENERATION_PARAMS_SCHEMA_VERSION_V1,
      maxOutputTokens: 128n,
      maxOutputDuration: 2_000n,
      decodingParams: {
        samplingEnabled: true,
        temperatureMilli: 700,
        topPPpm: 900_000,
        topK: 40,
        seed: 17n,
        presencePenaltyMilli: -100,
        frequencyPenaltyMilli: 200,
        repetitionPenaltyPpm: 1_050_000,
        stopSequences: ['END', 'STOP'],
        stopTokenIds: [2, 9],
      },
    },
    priceBid: amount('2'),
    maxFee: amount('1000'),
    assignmentPriorityFee: amount('50'),
    txFeeReserve: amount('100'),
    earliestSubmitHeight: 20n,
    orderExpireHeight: 80n,
    deadlinePolicy: { latencyClass: DEADLINE_LATENCY_CLASS.STANDARD },
    timeoutBucketVersion: 6n,
    sessionAnchorHeight: 10n,
    sessionAnchorBlockHash: rep(0x14, 32),
    builderSetId: '7',
    builderSetHash: rep(0x15, 32),
  };
}

describe('taskOrderHash (cross-language golden gate)', () => {
  it('matches the task_hash golden value published by node', () => {
    expect(taskOrderHashHex(fixture())).toBe(GOLDEN);
    expect(toHex(taskOrderHash(fixture()))).toBe(GOLDEN);
  });

  // Content identity: changing a single bit in any field must change task_hash (the TS-side counterpart of node's test of the same name).
  const mutations: Array<[string, (o: TaskOrderV2) => TaskOrderV2]> = [
    ['chain_id', (o) => ({ ...o, chainId: `${o.chainId}-x` })],
    ['user_address', (o) => ({ ...o, userAddress: accAddress(rep(0x22, 20)) })],
    ['session_id', (o) => ({ ...o, sessionId: rep(0x23, 32) })],
    ['order_sequence', (o) => ({ ...o, orderSequence: o.orderSequence + 1n })],
    ['model_id', (o) => ({ ...o, modelId: `${o.modelId}-x` })],
    ['profile_version', (o) => ({ ...o, profileVersion: o.profileVersion + 1 })],
    ['task_type', (o) => ({ ...o, taskType: TASK_TYPE.IMAGE_GENERATION })],
    ['input_hash', (o) => ({ ...o, inputHash: rep(0x24, 32) })],
    ['input_size_bytes', (o) => ({ ...o, inputSizeBytes: o.inputSizeBytes + 1n })],
    ['input_bucket', (o) => ({ ...o, inputBucket: o.inputBucket + 1 })],
    ['output_budget_bucket', (o) => ({ ...o, outputBudgetBucket: o.outputBudgetBucket + 1 })],
    ['generation.max_output_tokens', (o) => ({
      ...o,
      generationParams: { ...o.generationParams, maxOutputTokens: o.generationParams.maxOutputTokens + 1n },
    })],
    ['generation.presence_penalty (negative numbers use Int32BE)', (o) => ({
      ...o,
      generationParams: {
        ...o.generationParams,
        decodingParams: { ...o.generationParams.decodingParams, presencePenaltyMilli: -101 },
      },
    })],
    ['generation.stop_sequences', (o) => ({
      ...o,
      generationParams: {
        ...o.generationParams,
        decodingParams: { ...o.generationParams.decodingParams, stopSequences: ['END', 'STOP', 'HALT'] },
      },
    })],
    ['generation.stop_token_ids', (o) => ({
      ...o,
      generationParams: {
        ...o.generationParams,
        decodingParams: { ...o.generationParams.decodingParams, stopTokenIds: [2, 10] },
      },
    })],
    ['price_bid', (o) => ({ ...o, priceBid: amount('3') })],
    ['max_fee', (o) => ({ ...o, maxFee: amount('1001') })],
    ['assignment_priority_fee', (o) => ({ ...o, assignmentPriorityFee: amount('51') })],
    ['tx_fee_reserve', (o) => ({ ...o, txFeeReserve: amount('101') })],
    ['earliest_submit_height', (o) => ({ ...o, earliestSubmitHeight: o.earliestSubmitHeight + 1n })],
    ['order_expire_height', (o) => ({ ...o, orderExpireHeight: o.orderExpireHeight + 1n })],
    ['deadline_policy', (o) => ({ ...o, deadlinePolicy: { latencyClass: DEADLINE_LATENCY_CLASS.FAST } })],
    ['timeout_bucket_version', (o) => ({ ...o, timeoutBucketVersion: o.timeoutBucketVersion + 1n })],
    ['session_anchor_height', (o) => ({ ...o, sessionAnchorHeight: o.sessionAnchorHeight + 1n })],
    ['session_anchor_block_hash', (o) => ({ ...o, sessionAnchorBlockHash: rep(0x25, 32) })],
    ['builder_set_id', (o) => ({ ...o, builderSetId: '8' })],
    ['builder_set_hash', (o) => ({ ...o, builderSetHash: rep(0x26, 32) })],
  ];

  it.each(mutations)('task_hash must change after modifying %s', (_name, mutate) => {
    expect(taskOrderHashHex(mutate(fixture()))).not.toBe(GOLDEN);
  });

  it('swapping two Amounts changes the digest (the order of the 4 Amounts cannot be swapped)', () => {
    const o = fixture();
    const swapped: TaskOrderV2 = { ...o, priceBid: o.maxFee, maxFee: o.priceBid };
    expect(taskOrderHashHex(swapped)).not.toBe(GOLDEN);
  });
});

describe('scalar scope validation', () => {
  it.each([
    ['session_id is not 32 bytes', (o: TaskOrderV2) => ({ ...o, sessionId: rep(0x12, 31) })],
    ['input_hash is not 32 bytes', (o: TaskOrderV2) => ({ ...o, inputHash: rep(0x13, 33) })],
    ['schema_version != 2', (o: TaskOrderV2) => ({ ...o, schemaVersion: 1 })],
    ['task_type unspecified', (o: TaskOrderV2) => ({ ...o, taskType: TASK_TYPE.UNSPECIFIED })],
    ['earliest >= expire', (o: TaskOrderV2) => ({ ...o, earliestSubmitHeight: 80n })],
    ['builder_set_id is empty', (o: TaskOrderV2) => ({ ...o, builderSetId: '' })],
    ['latency_class unspecified', (o: TaskOrderV2) => ({
      ...o, deadlinePolicy: { latencyClass: DEADLINE_LATENCY_CLASS.UNSPECIFIED },
    })],
  ])('%s -> throws instead of computing a digest', (_name, mutate) => {
    expect(() => taskOrderHashHex(mutate(fixture()))).toThrowError(/scalar scope/);
  });

  it('Amount with leading zero / non-decimal is rejected', () => {
    expect(() => taskOrderHashHex({ ...fixture(), maxFee: { atomicUnits: '0100' } })).toThrowError(/leading zero/);
    expect(() => taskOrderHashHex({ ...fixture(), maxFee: { atomicUnits: '10a' } })).toThrowError(/unsigned decimal/);
    expect(() => taskOrderHashHex({ ...fixture(), maxFee: { atomicUnits: '' } })).toThrowError(/required/);
  });
});

describe('canonicalOperatorAddressBytes', () => {
  it('bech32 -> address codec bytes (hrp not part of the preimage)', () => {
    const raw = rep(0x11, 20);
    expect(toHex(canonicalOperatorAddressBytes('user_address', accAddress(raw)))).toBe(toHex(raw));
    // Same address bytes with a different prefix -- the codec bytes stay the same.
    const other = bech32.encode('cosmos', bech32.toWords(raw));
    expect(toHex(canonicalOperatorAddressBytes('user_address', other))).toBe(toHex(raw));
  });

  it('rejects empty string / leading-trailing whitespace / invalid bech32', () => {
    expect(() => canonicalOperatorAddressBytes('a', '')).toThrowError(/non-empty/);
    expect(() => canonicalOperatorAddressBytes('a', ` ${accAddress(rep(0x11, 20))} `)).toThrowError(/whitespace/);
    expect(() => canonicalOperatorAddressBytes('a', 'not-an-address')).toThrowError(/Bech32/);
  });
});
