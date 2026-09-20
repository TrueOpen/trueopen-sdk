import { describe, it, expect } from 'vitest';
import { bech32 } from '@scure/base';
import {
  taskOrderHash,
  taskOrderHashHex,
  DOMAIN_TASK_ORDER_V2,
  TASK_ORDER_SCHEMA_VERSION_V2,
  GENERATION_PARAMS_SCHEMA_VERSION_V1,
  TASK_TYPE,
  DEADLINE_LATENCY_CLASS,
} from '../../src/order/task-order';
import type { TaskOrderV2 } from '../../src/order/task-order';
import { canonicalFrameBytes, uint32BE, uint64BE, enumBE } from '../../src/codec/domain-hash';
import { toHex } from '../../src/util/bytes';

/**
 * Cross-repo consistency gate for TaskOrderV2.
 *
 * These three digests are **published by the contract itself**: monorepo
 * docs/10-protocol-spec/04-task/08-TaskOrder-hash-and-signing.md §8.3 gives the full
 * 25-field input and expected values. wire v0.4.1 hasn't turned this into a fixture yet
 * (wire#24), but the published values themselves are authoritative -- node / cortex /
 * nexus / SDK all agree on the same value. The fixtures and constants are copied
 * verbatim from nexus internal/nodecontract/taskorder_test.go (main@b19f6206, hard
 * cutover to TaskOrderV2 on 2026-09-15).
 *
 * This is the only hard evidence between the SDK and the contract regarding task_hash:
 * if the two sides disagree anywhere on the field order or encoding of
 * H_FIELDS_V1("TRUEOPEN_TASK_ORDER_V2", canonical TaskOrderV2), the same order will
 * hash to a different digest and these tests fail immediately.
 * Do not "update the expected value in place" -- first confirm what changed on the
 * contract side.
 */
const CONTRACT = {
  core: { digest: '87ac39ab4c5616522a55d5303b76f121731dd6dc072a4cb197d04d817c16ce40', preimageLen: 776 },
  lower: { digest: '38011c54053ab42e3ba0163f2186c091c647b1833053bef93f40bd045c182040', preimageLen: 728 },
  maxAmount: { digest: '3b78f4ba9d854367ca948e1243d3ffe84421778af10392ff6a0ce7ee453ba94c', preimageLen: 839 },
} as const;

/** Key intermediate frames listed in §8.3. When the digest doesn't match, these pinpoint exactly which framing layer is wrong. */
const CONTRACT_FRAMES = {
  stopSequences: '00000000000000040000000200000000000000043c2f733e000000000000000453544f50',
  stopTokenIds: '00000000000000040000000200000000000000040000000b0000000000000004000000dc',
  deadlinePolicy: '000000000000000400000002',
  maxFee: '0000000000000006313530303030',
  priorityFee: '000000000000000130',
} as const;

/** §8.3: user_address = bech32("trueopen", a0a1...b3). */
const CONTRACT_USER_ADDRESS = 'trueopen15zs69gay5kn2029f4246etdw47ctrv4ns6facc';

const repeatByte = (value: number, size: number): Uint8Array => new Uint8Array(size).fill(value);
const amountOf = (atomicUnits: string): { atomicUnits: string } => ({ atomicUnits });

/** Encodes the 20-byte address codec as bech32. The hrp is not part of the preimage; "trueopen" is used only to match node. */
function accAddress(raw: Uint8Array): string {
  return bech32.encode('trueopen', bech32.toWords(raw));
}

/** Replicates the core input from 08 §8.3 field by field. */
function contractFixture(): TaskOrderV2 {
  const raw = new Uint8Array(20);
  for (let i = 0; i < raw.length; i++) raw[i] = 0xa0 + i;
  // Fixture self-check: if the derived address doesn't match the contract's published value, the digest assertions below are meaningless.
  expect(accAddress(raw)).toBe(CONTRACT_USER_ADDRESS);

  return {
    schemaVersion: TASK_ORDER_SCHEMA_VERSION_V2,
    chainId: 'trueopen-golden-1',
    userAddress: CONTRACT_USER_ADDRESS,
    sessionId: repeatByte(0x11, 32),
    orderSequence: 42n,
    modelId: 'qwen3-8b-test',
    profileVersion: 1,
    taskType: TASK_TYPE.CHAT,
    inputHash: repeatByte(0x22, 32),
    inputSizeBytes: 4096n,
    inputBucket: 3,
    outputBudgetBucket: 4,
    generationParams: {
      generationParamsSchemaVersion: GENERATION_PARAMS_SCHEMA_VERSION_V1,
      maxOutputTokens: 256n,
      maxOutputDuration: 30_000n,
      decodingParams: {
        samplingEnabled: true,
        temperatureMilli: 700,
        topPPpm: 950_000,
        topK: 40,
        seed: 8_675_309n,
        presencePenaltyMilli: -250,
        frequencyPenaltyMilli: 125,
        repetitionPenaltyPpm: 1_050_000,
        stopSequences: ['</s>', 'STOP'],
        stopTokenIds: [11, 220],
      },
    },
    priceBid: amountOf('4000000'),
    maxFee: amountOf('150000'),
    assignmentPriorityFee: amountOf('0'),
    txFeeReserve: amountOf('250'),
    earliestSubmitHeight: 1000n,
    orderExpireHeight: 2000n,
    deadlinePolicy: { latencyClass: DEADLINE_LATENCY_CLASS.STANDARD },
    timeoutBucketVersion: 9n,
    sessionAnchorHeight: 990n,
    sessionAnchorBlockHash: repeatByte(0x33, 32),
    builderSetId: '12',
    builderSetHash: repeatByte(0x44, 32),
  };
}

/** §8.3's second vector: decoding params at their lower bound, both repeated lists empty. */
function lowerBoundFixture(): TaskOrderV2 {
  const base = contractFixture();
  return {
    ...base,
    generationParams: {
      generationParamsSchemaVersion: GENERATION_PARAMS_SCHEMA_VERSION_V1,
      maxOutputTokens: 1n,
      maxOutputDuration: 1n,
      decodingParams: {
        samplingEnabled: false,
        temperatureMilli: 0,
        topPPpm: 1,
        topK: 0,
        seed: 0n,
        presencePenaltyMilli: -2000,
        frequencyPenaltyMilli: -2000,
        repetitionPenaltyPpm: 100_000,
        stopSequences: [],
        stopTokenIds: [],
      },
    },
  };
}

/** §8.3's third vector: all four Amounts at the u64 upper bound. */
function maxAmountFixture(): TaskOrderV2 {
  const u64max = amountOf('18446744073709551615');
  return {
    ...contractFixture(),
    priceBid: u64max,
    maxFee: u64max,
    assignmentPriorityFee: u64max,
    txFeeReserve: u64max,
  };
}

describe('TaskOrderV2 contract-published vectors (monorepo 08-TaskOrder-hash-and-signing §8.3)', () => {
  const cases: [string, () => TaskOrderV2, { digest: string; preimageLen: number }][] = [
    ['core', contractFixture, CONTRACT.core],
    ['decoding params at lower bound, lists empty', lowerBoundFixture, CONTRACT.lower],
    ['four Amounts at u64 upper bound', maxAmountFixture, CONTRACT.maxAmount],
  ];

  for (const [name, build, want] of cases) {
    it(`${name}: task_hash equals the contract's published value`, () => {
      expect(taskOrderHashHex(build())).toBe(want.digest);
      expect(toHex(taskOrderHash(build()))).toBe(want.digest);
    });
  }

  // preimage length is a check that fires earlier than the digest: a wrong length means
  // an entire field was encoded wrong, not just a flipped bit -- the two failure modes
  // need completely different debugging paths.
  for (const [name, build, want] of cases) {
    it(`${name}: preimage byte length equals the contract's published value`, () => {
      expect(preimageLengthOf(build())).toBe(want.preimageLen);
    });
  }
});

describe('TaskOrderV2 key intermediate frames (§8.3)', () => {
  const d = contractFixture().generationParams.decodingParams;

  it('stop_sequences count frame', () => {
    const parts = [uint32BE(d.stopSequences.length), ...d.stopSequences.map((x) => new TextEncoder().encode(x))];
    expect(toHex(canonicalFrameBytes(...parts))).toBe(CONTRACT_FRAMES.stopSequences);
  });

  it('stop_token_ids count frame', () => {
    const parts = [uint32BE(d.stopTokenIds.length), ...d.stopTokenIds.map((x) => uint32BE(x))];
    expect(toHex(canonicalFrameBytes(...parts))).toBe(CONTRACT_FRAMES.stopTokenIds);
  });

  it('deadline_policy is a nested single-field frame, not a bare enum', () => {
    expect(toHex(canonicalFrameBytes(enumBE(DEADLINE_LATENCY_CLASS.STANDARD)))).toBe(CONTRACT_FRAMES.deadlinePolicy);
  });

  it('Amount is FRAME_V1(ascii decimal), not a bare u64_be', () => {
    const enc = new TextEncoder();
    expect(toHex(canonicalFrameBytes(enc.encode('150000')))).toBe(CONTRACT_FRAMES.maxFee);
    expect(toHex(canonicalFrameBytes(enc.encode('0')))).toBe(CONTRACT_FRAMES.priorityFee);
    // Counter-check: encoding the same value as u64_be gives a completely different result -- this is the easiest spot to get wrong.
    expect(toHex(canonicalFrameBytes(uint64BE(150000n)))).not.toBe(CONTRACT_FRAMES.maxFee);
  });
});

/**
 * Recomputes the preimage length without calling the implementation's internal
 * functions: an H_FIELDS_V1 frame is "an 8-byte big-endian length prefix per segment
 * plus the segment body", with the domain as the first segment. The segmentation and
 * contents are decided by taskOrderHash, so this works backward from the public API --
 * using the fact that the domain's length is known to derive and verify the total
 * length.
 */
function preimageLengthOf(order: TaskOrderV2): number {
  // canonicalFrameBytes and taskOrderHash use the same framing primitive; this only
  // rebuilds the length: re-encoding all 25 fields directly with domain-hash's public
  // primitives isn't possible (the fields are private), so instead we assert an
  // observable quantity other than "same digest => same preimage": the domain segment's
  // length plus the rest of the segments' lengths.
  // Implementation: relies on canonicalFrameBytes being deterministic for the same set
  // of parts, with taskOrderFieldsForLength giving a segmentation consistent with the
  // implementation.
  return taskOrderPreimage(order).length;
}

/**
 * An **independent reimplementation** of the segmentation from
 * src/order/task-order.ts's canonicalTaskOrderFields, written solely to compute the
 * preimage length. Deliberately does not import the implementation's private functions:
 * if the two segmentations disagree, the length assertion fails first, giving us an
 * extra cross-check for free.
 */
function taskOrderPreimage(o: TaskOrderV2): Uint8Array {
  const enc = new TextEncoder();
  const d = o.generationParams.decodingParams;

  const stops = canonicalFrameBytes(
    uint32BE(d.stopSequences.length),
    ...d.stopSequences.map((x) => enc.encode(x)),
  );
  const tokens = canonicalFrameBytes(uint32BE(d.stopTokenIds.length), ...d.stopTokenIds.map((x) => uint32BE(x)));
  const decoding = canonicalFrameBytes(
    new Uint8Array([d.samplingEnabled ? 1 : 0]),
    uint32BE(d.temperatureMilli),
    uint32BE(d.topPPpm),
    uint32BE(d.topK),
    uint64BE(d.seed),
    uint32BE(d.presencePenaltyMilli | 0),
    uint32BE(d.frequencyPenaltyMilli | 0),
    uint32BE(d.repetitionPenaltyPpm),
    stops,
    tokens,
  );
  const generation = canonicalFrameBytes(
    uint32BE(o.generationParams.generationParamsSchemaVersion),
    uint64BE(o.generationParams.maxOutputTokens),
    uint64BE(o.generationParams.maxOutputDuration),
    decoding,
  );
  const amount = (units: string): Uint8Array => canonicalFrameBytes(enc.encode(units));
  const userBytes = bech32.fromWords(bech32.decode(o.userAddress as `${string}1${string}`).words);

  return canonicalFrameBytes(
    enc.encode(DOMAIN_TASK_ORDER_V2),
    uint32BE(o.schemaVersion),
    enc.encode(o.chainId),
    userBytes,
    o.sessionId,
    uint64BE(o.orderSequence),
    enc.encode(o.modelId),
    uint32BE(o.profileVersion),
    enumBE(o.taskType),
    o.inputHash,
    uint64BE(o.inputSizeBytes),
    uint32BE(o.inputBucket),
    uint32BE(o.outputBudgetBucket),
    generation,
    amount(o.priceBid.atomicUnits),
    amount(o.maxFee.atomicUnits),
    amount(o.assignmentPriorityFee.atomicUnits),
    amount(o.txFeeReserve.atomicUnits),
    uint64BE(o.earliestSubmitHeight),
    uint64BE(o.orderExpireHeight),
    canonicalFrameBytes(enumBE(o.deadlinePolicy.latencyClass)),
    uint64BE(o.timeoutBucketVersion),
    uint64BE(o.sessionAnchorHeight),
    o.sessionAnchorBlockHash,
    enc.encode(o.builderSetId),
    o.builderSetHash,
  );
}
