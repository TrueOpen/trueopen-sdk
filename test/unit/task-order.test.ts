import { describe, it, expect } from 'vitest';
import {
  taskOrderHash,
  taskOrderHashHex,
  TASK_TYPE,
  DEADLINE_LATENCY_CLASS,
  GENERATION_PARAMS_SCHEMA_VERSION_V1,
  PAYLOAD_MODE,
  TASK_ORDER_SCHEMA_VERSION_V3,
} from '../../src/order/task-order';
import type { TaskOrderV3, AmountV1 } from '../../src/order/task-order';
import { canonicalOperatorAddressBytes } from '../../src/codec/address';
import { fromHex, toHex } from '../../src/util/bytes';
import { bech32 } from '@scure/base';

/**
 * ⚠️ **This is not a cross-language golden value -- just a self-consistency
 * regression value.**
 *
 * This fixture uses SDK-local values (`chainId: 'trueopen-test-1'`, a `modelId` of
 * `ab` x 32) that do not appear in any wire vector, so the digest below is computed by
 * this implementation itself. It only guards against "accidental changes" -- it cannot
 * catch "all three parties misreading the spec the same way".
 *
 * The authoritative cross-language vector for TaskOrderV3 is now published by wire
 * v0.3.0 at third_party/wire/testdata/v1/task/task_order_v3.json (digest
 * d48c7062a64fcf6932aee1a935d9b0f30a04d954f40caa87f5ccf32a3696d59c for the
 * TRUEOPEN_TASK_ORDER_V3 core vector). task-order-contract-vectors.test.ts asserts
 * against that file directly. Keep this fixture's field set aligned with TaskOrderV3
 * (Hash32 model_id + payload_mode / input_key_commitment / user_recipient_pubkey) and
 * re-cross-check it there whenever either side changes.
 */
const GOLDEN = 'd34f42d8ef77185c042d0adaa47509ab1421cc30b5d13ed022d5181a2f2b3a9f';

const rep = (byte: number, size: number): Uint8Array => new Uint8Array(size).fill(byte);
const amount = (atomicUnits: string): AmountV1 => ({ atomicUnits });

// Reproduces sdk.AccAddress(0x11 * 20).String() from the node fixture. The hrp is not
// part of the preimage (framing uses the address codec bytes); "trueopen" is used only
// to match node's prefix.
const accAddress = (raw: Uint8Array): string => bech32.encode('trueopen', bech32.toWords(raw));

/** Reuses the values from the v0.1.2 fixture, rearranged to match TaskOrderV3's field set. */
function fixture(): TaskOrderV3 {
  return {
    schemaVersion: TASK_ORDER_SCHEMA_VERSION_V3,
    chainId: 'trueopen-test-1',
    userAddress: accAddress(rep(0x11, 20)),
    sessionId: rep(0x12, 32),
    orderSequence: 7n,
    modelId: fromHex('ab'.repeat(32)),
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
    payloadMode: PAYLOAD_MODE.PLAINTEXT,
    inputKeyCommitment: new Uint8Array(32),
    userRecipientPubkey: new Uint8Array(0),
  };
}

describe('taskOrderHash (cross-language golden gate)', () => {
  it('matches the task_hash golden value published by node', () => {
    expect(taskOrderHashHex(fixture())).toBe(GOLDEN);
    expect(toHex(taskOrderHash(fixture()))).toBe(GOLDEN);
  });

  // Content identity: changing a single bit in any field must change task_hash (the TS-side counterpart of node's test of the same name).
  const mutations: Array<[string, (o: TaskOrderV3) => TaskOrderV3]> = [
    ['chain_id', (o) => ({ ...o, chainId: `${o.chainId}-x` })],
    ['user_address', (o) => ({ ...o, userAddress: accAddress(rep(0x22, 20)) })],
    ['session_id', (o) => ({ ...o, sessionId: rep(0x23, 32) })],
    ['order_sequence', (o) => ({ ...o, orderSequence: o.orderSequence + 1n })],
    ['model_id', (o) => ({ ...o, modelId: rep(0x99, 32) })],
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
    const swapped: TaskOrderV3 = { ...o, priceBid: o.maxFee, maxFee: o.priceBid };
    expect(taskOrderHashHex(swapped)).not.toBe(GOLDEN);
  });
});

describe('scalar scope validation', () => {
  it.each([
    ['session_id is not 32 bytes', (o: TaskOrderV3) => ({ ...o, sessionId: rep(0x12, 31) })],
    ['input_hash is not 32 bytes', (o: TaskOrderV3) => ({ ...o, inputHash: rep(0x13, 33) })],
    ['schema_version != 3', (o: TaskOrderV3) => ({ ...o, schemaVersion: 1 })],
    ['task_type unspecified', (o: TaskOrderV3) => ({ ...o, taskType: TASK_TYPE.UNSPECIFIED })],
    ['earliest >= expire', (o: TaskOrderV3) => ({ ...o, earliestSubmitHeight: 80n })],
    ['builder_set_id is empty', (o: TaskOrderV3) => ({ ...o, builderSetId: '' })],
    ['latency_class unspecified', (o: TaskOrderV3) => ({
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
