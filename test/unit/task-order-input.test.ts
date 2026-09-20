import { describe, it, expect } from 'vitest';
import { bech32 } from '@scure/base';
import {
  buildTaskOrder,
  resolveTaskOrderContext,
  defaultGenerationParams,
  payloadRefFor,
} from '../../src/order/task-order-input';
import type { TaskOrderChainContext, TaskOrderRequest } from '../../src/order/task-order-input';
import { taskOrderHashHex, TASK_TYPE, DEADLINE_LATENCY_CLASS } from '../../src/order/task-order';
import { HubReader } from '../../src/transport/hub-reader';
import type { FetchLike, FetchResponse } from '../../src/transport/rest-chain-reader';
import { sha256 } from '../../src/codec/hash';
import { toHex } from '../../src/util/bytes';

const rep = (byte: number, size: number): Uint8Array => new Uint8Array(size).fill(byte);
const hexOf = (byte: number): string => toHex(rep(byte, 32));
const amount = (atomicUnits: string) => ({ atomicUnits });
const USER = bech32.encode('trueopen', bech32.toWords(rep(0x11, 20)));
const SESSION = hexOf(0x12);
const PAYLOAD = new TextEncoder().encode('trueopen-input');

const ctx: TaskOrderChainContext = {
  chainId: 'trueopen-localnet-1',
  sessionAnchorHeight: 100n,
  sessionAnchorBlockHash: hexOf(0x14),
  builderSetId: 'genesis-1',
  builderSetHash: hexOf(0x15),
  timeoutBucketVersion: 1n,
  // Matches task/v1/params.generation as observed on devnet.
  generationLimits: {
    maxOutputTokens: 131_072n, topKMax: 1000n, stopSequenceMaxItems: 16n,
    stopSequenceMaxBytesEach: 128n, stopSequenceMaxTotalBytes: 1024n, stopTokenMaxItems: 64n,
  },
  latestHeight: 102n,
};

const req: TaskOrderRequest = {
  userAddress: USER,
  sessionId: SESSION,
  orderSequence: 1n,
  modelId: 'hf-ad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b',
  profileVersion: 1,
  taskType: TASK_TYPE.TEXT_GENERATION,
  payload: PAYLOAD,
  inputBucket: 1,
  outputBudgetBucket: 1,
  generationParams: defaultGenerationParams(128n, 2_000n),
  amounts: {
    priceBid: amount('100000'),
    maxFee: amount('1000'),
    assignmentPriorityFee: amount('0'),
    txFeeReserve: amount('0'),
  },
  earliestSubmitHeight: 100n,
  orderExpireHeight: 50_100n,
  latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
};

describe('buildTaskOrder', () => {
  it('builds a complete order from context + intent whose task_hash can be computed', () => {
    const order = buildTaskOrder(ctx, req);
    expect(order.schemaVersion).toBe(2);
    expect(order.sessionId.length).toBe(32);
    expect(toHex(order.sessionId)).toBe(SESSION);
    // input_hash / input_size_bytes are derived from the payload, not supplied by the caller.
    expect(toHex(order.inputHash)).toBe(toHex(sha256(PAYLOAD)));
    expect(order.inputSizeBytes).toBe(BigInt(PAYLOAD.length));
    // The on-chain context is signed in as-is.
    expect(order.builderSetId).toBe('genesis-1');
    expect(toHex(order.sessionAnchorBlockHash)).toBe(hexOf(0x14));
    expect(order.timeoutBucketVersion).toBe(1n);
    // Being able to compute the digest means the scalar scope is fully satisfied.
    expect(taskOrderHashHex(order)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('payload change → input_hash and task_hash both change', () => {
    const a = taskOrderHashHex(buildTaskOrder(ctx, req));
    const b = taskOrderHashHex(buildTaskOrder(ctx, { ...req, payload: new TextEncoder().encode('other') }));
    expect(b).not.toBe(a);
  });

  it('on-chain context change → task_hash changes (anchor is part of the signature)', () => {
    const a = taskOrderHashHex(buildTaskOrder(ctx, req));
    const b = taskOrderHashHex(buildTaskOrder({ ...ctx, sessionAnchorBlockHash: hexOf(0x99) }, req));
    expect(b).not.toBe(a);
  });

  // Assert on TrueOpenError.code rather than message: code is the stable contract, wording can change.
  const codeOf = (patch: Partial<TaskOrderRequest>): string => {
    try {
      buildTaskOrder(ctx, { ...req, ...patch } as TaskOrderRequest);
    } catch (e) {
      return (e as { code?: string }).code ?? '<no code>';
    }
    return '<no throw>';
  };

  it.each([
    ['payload is empty', { payload: new Uint8Array() }, 'SDK_LOCAL_PAYLOAD_EMPTY'],
    ['output_budget_bucket is 0', { outputBudgetBucket: 0 }, 'SDK_LOCAL_OUTPUT_BUCKET_INVALID'],
    ['latency_class is unspecified', { latencyClass: DEADLINE_LATENCY_CLASS.UNSPECIFIED }, 'SDK_LOCAL_LATENCY_CLASS_INVALID'],
    ['earliest >= expire', { earliestSubmitHeight: 50_100n }, 'SDK_LOCAL_ORDER_WINDOW_INVALID'],
    ['session_id is not 64-hex', { sessionId: 'sess-1' }, 'SDK_LOCAL_NOT_HASH32'],
  ])('%s → fails fast locally', (_name, patch, code) => {
    expect(codeOf(patch as Partial<TaskOrderRequest>)).toBe(code);
  });

  // A newly created session's on-chain next_expected_sequence is 0 (node createSession does not
  // write that field), so order_sequence=0 is a valid first order and must not be blocked locally.
  it('order_sequence=0 is a valid first order and is not blocked locally', () => {
    const order = buildTaskOrder(ctx, { ...req, orderSequence: 0n });
    expect(order.orderSequence).toBe(0n);
    expect(taskOrderHashHex(order)).not.toBe(taskOrderHashHex(buildTaskOrder(ctx, req)));
  });

  it('payloadRefFor matches the nexus payloadstore convention', () => {
    expect(payloadRefFor(PAYLOAD)).toBe(`nexus://sha256/${toHex(sha256(PAYLOAD))}`);
  });
});

// ---- resolveTaskOrderContext: stubbed REST ----
function readerFor(latestHeight: number, routes: Record<string, unknown>): HubReader {
  const fetch: FetchLike = async (url): Promise<FetchResponse> => {
    if (url.endsWith('/blocks/latest')) {
      return { ok: true, status: 200, json: async () => ({ block: { header: { height: String(latestHeight) } } }) };
    }
    // The task generation limits must be read for every order; values match what was observed on devnet.
    if (url.endsWith('/task/v1/params')) {
      return { ok: true, status: 200, json: async () => ({ params: { generation: {
        max_output_tokens: '131072', top_k_max: 1000, stop_sequence_max_items: 16,
        stop_sequence_max_bytes_each: 128, stop_sequence_max_total_bytes: 1024, stop_token_max_items: 64,
      } } }) };
    }
    for (const [suffix, body] of Object.entries(routes)) {
      if (url.includes(suffix)) return { ok: true, status: 200, json: async () => body };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return new HubReader({ baseUrl: 'http://node:1317', fetch });
}

// Shape matches devnet observations field-by-field (builder_set/by_height for trueopen-localnet-1).
const SET_BODY = {
  set: {
    builder_set_id: 'genesis-1', builder_set_version: '1', effective_height: '1',
    builder_set_hash: hexOf(0x15),
    active_builders: ['trueopen1a', 'trueopen1b'], active_builder_count: 2,
  },
};
const bucketBody = (kind: string) => ({
  bucket: { bucket_kind: kind, bucket_key: 'default', version: '1', effective_height: '0' },
  current_version: '1',
});

describe('resolveTaskOrderContext', () => {
  it('anchor uses latest-lag, gets block_hash from beacon and the current effective version from bucket', async () => {
    const hub = readerFor(1000, {
      'builder_set/by_height/1000': SET_BODY,
      'beacon/998': { beacon: { height: '998', block_hash: hexOf(0x14), randomness_hex: hexOf(0x01), source_tag: 'proposer_vrf_v1', verified: true } },
      'reference_bucket/default': bucketBody('BUCKET_KIND_REFERENCE'),
      'timeout_bucket/default': bucketBody('BUCKET_KIND_TIMEOUT'),
    });
    const c = await resolveTaskOrderContext(hub, 'trueopen-localnet-1');
    expect(c.latestHeight).toBe(1000n);
    expect(c.sessionAnchorHeight).toBe(998n);
    expect(c.sessionAnchorBlockHash).toBe(hexOf(0x14));
    expect(c.builderSetId).toBe('genesis-1');
    expect(c.builderSetHash).toBe(hexOf(0x15));
    expect(c.timeoutBucketVersion).toBe(1n);
  });

  it('anchor earlier than the builder set effective height → blocked locally', async () => {
    const hub = readerFor(1000, {
      'builder_set/by_height/1000': {
        set: { ...SET_BODY.set, effective_height: '9999' },
      },
      'beacon/998': { beacon: { height: '998', block_hash: hexOf(0x14) } },
      'reference_bucket/default': bucketBody('BUCKET_KIND_REFERENCE'),
      'timeout_bucket/default': bucketBody('BUCKET_KIND_TIMEOUT'),
    });
    await expect(resolveTaskOrderContext(hub, 'trueopen-localnet-1')).rejects.toMatchObject({
      code: 'SDK_LOCAL_ANCHOR_BEFORE_BUILDER_SET',
    });
  });
});

/**
 * node x/task/types/generation_params.go:52-66 enforces hard ranges on decoding params;
 * zero-valued top_p_ppm / repetition_penalty_ppm would be rejected outright on-chain
 * (the order would never make it into a block). This pins down the ranges to prevent
 * the defaults from regressing to zero values.
 */
describe('defaultGenerationParams falls within node\'s valid range', () => {
  const d = defaultGenerationParams(128n, 60_000n).decodingParams;

  it('top_p_ppm is in [1, 1_000_000], and equals the identity value 1.0', () => {
    expect(d.topPPpm).toBeGreaterThanOrEqual(1);
    expect(d.topPPpm).toBeLessThanOrEqual(1_000_000);
    expect(d.topPPpm).toBe(1_000_000);
  });

  it('repetition_penalty_ppm is in [100_000, 2_000_000], and equals the identity value 1.0', () => {
    expect(d.repetitionPenaltyPpm).toBeGreaterThanOrEqual(100_000);
    expect(d.repetitionPenaltyPpm).toBeLessThanOrEqual(2_000_000);
    expect(d.repetitionPenaltyPpm).toBe(1_000_000);
  });

  it('temperature_milli is <= 2_000, and equals the identity value 1.0', () => {
    expect(d.temperatureMilli).toBeLessThanOrEqual(2_000);
    expect(d.temperatureMilli).toBe(1_000);
  });

  it('presence / frequency penalty ∈ [-2_000, 2_000]', () => {
    for (const v of [d.presencePenaltyMilli, d.frequencyPenaltyMilli]) {
      expect(v).toBeGreaterThanOrEqual(-2_000);
      expect(v).toBeLessThanOrEqual(2_000);
    }
  });

  it('sampling is disabled by default (deterministic decoding)', () => {
    expect(d.samplingEnabled).toBe(false);
  });
});

describe('on-chain caps on generation params (task/v1/params.generation)', () => {
  const gp = (over: Record<string, unknown> = {}, dec: Record<string, unknown> = {}) => ({
    ...defaultGenerationParams(128n, 2_000n),
    ...over,
    decodingParams: { ...defaultGenerationParams(128n, 2_000n).decodingParams, ...dec },
  });
  const build = (params: ReturnType<typeof gp>) =>
    buildTaskOrder(ctx, { ...req, generationParams: params });

  it('max_output_tokens = 0 is rejected — 0 does not mean unlimited', () => {
    expect(() => build(gp({ maxOutputTokens: 0n }))).toThrow(/0 does not mean unlimited/);
  });

  it('max_output_duration = 0 is also rejected', () => {
    expect(() => build(gp({ maxOutputDuration: 0n }))).toThrow(/must be positive/);
  });

  it('max_output_tokens exceeding the on-chain cap is rejected', () => {
    expect(() => build(gp({ maxOutputTokens: 131_073n }))).toThrow(/exceeds the on-chain limit 131072/);
    // Exactly at the limit should be allowed (no extra local margin is added).
    expect(() => build(gp({ maxOutputTokens: 131_072n }))).not.toThrow();
  });

  it('top_k exceeding the on-chain cap is rejected', () => {
    expect(() => build(gp({}, { topK: 1001 }))).toThrow(/top_k 1001 exceeds the on-chain limit 1000/);
  });

  it('stop_sequences item count / per-item bytes / total bytes caps each apply independently', () => {
    expect(() => build(gp({}, { stopSequences: Array(17).fill('x') }))).toThrow(/entries, exceeding the on-chain limit 16/);
    expect(() => build(gp({}, { stopSequences: ['x'.repeat(129)] }))).toThrow(/exceeding the on-chain per-entry limit 128/);
    // 8 items x 128 bytes = 1024, exactly at the limit; one more item goes over.
    expect(() => build(gp({}, { stopSequences: Array(8).fill('x'.repeat(128)) }))).not.toThrow();
    expect(() => build(gp({}, { stopSequences: Array(9).fill('x'.repeat(128)) }))).toThrow(/total is 1152 bytes/);
  });

  it('stop_token_ids item count exceeding the limit is rejected', () => {
    expect(() => build(gp({}, { stopTokenIds: Array.from({ length: 65 }, (_, i) => i) }))).toThrow(/entries, exceeding the on-chain limit 64/);
  });
});
