import { describe, it, expect } from 'vitest';
import { isValidModelId, validateModelId } from '../../src/order/model-id';
import { buildTaskOrder, defaultGenerationParams } from '../../src/order/task-order-input';
import type { TaskOrderChainContext, TaskOrderRequest } from '../../src/order/task-order-input';
import { TASK_TYPE, DEADLINE_LATENCY_CLASS } from '../../src/order/task-order';
import { bech32 } from '@scure/base';
import { toHex } from '../../src/util/bytes';

const hexOf = (b: number): string => toHex(new Uint8Array(32).fill(b));
const amount = (atomicUnits: string) => ({ atomicUnits });

const CTX: TaskOrderChainContext = {
  chainId: 'trueopen-localnet-1', sessionAnchorHeight: 100n, sessionAnchorBlockHash: hexOf(0x14),
  builderSetId: 'genesis-1', builderSetHash: hexOf(0x15), timeoutBucketVersion: 1n, latestHeight: 102n,
  generationLimits: {
    maxOutputTokens: 131_072n, topKMax: 1000n, stopSequenceMaxItems: 16n,
    stopSequenceMaxBytesEach: 128n, stopSequenceMaxTotalBytes: 1024n, stopTokenMaxItems: 64n,
  },
};

const baseOrder = (modelId: string): TaskOrderRequest => ({
  userAddress: bech32.encode('trueopen', bech32.toWords(new Uint8Array(20).fill(0x11))),
  sessionId: hexOf(0x12), orderSequence: 1n,
  modelId, profileVersion: 1, taskType: TASK_TYPE.CHAT,
  payload: new TextEncoder().encode('x'),
  inputBucket: 1, outputBudgetBucket: 1,
  generationParams: defaultGenerationParams(128n, 2_000n),
  amounts: {
    priceBid: amount('100000'), maxFee: amount('1000000'),
    assignmentPriorityFee: amount('0'), txFeeReserve: amount('0'),
  },
  earliestSubmitHeight: 100n, orderExpireHeight: 50_100n,
  latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
});

const MODEL = 'ad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b';

describe('model_id validation (non-zero canonical lowercase 64-hex Hash32)', () => {
  it('accepts a canonical Hash32', () => {
    expect(isValidModelId(MODEL)).toBe(true);
    expect(isValidModelId('5'.repeat(64))).toBe(true);
  });

  it('rejects legacy slugs, uppercase, prefixes, wrong length and the zero hash', () => {
    expect(isValidModelId(`hf-${MODEL}`)).toBe(false); // legacy text slug
    expect(isValidModelId('qwen3-8b')).toBe(false);
    expect(isValidModelId(MODEL.toUpperCase())).toBe(false);
    expect(isValidModelId(`0x${MODEL}`)).toBe(false);
    expect(isValidModelId(MODEL.slice(1))).toBe(false); // 63
    expect(isValidModelId(`${MODEL}0`)).toBe(false); // 65
    expect(isValidModelId('')).toBe(false);
    expect(isValidModelId('0'.repeat(64))).toBe(false);
  });

  it('validateModelId throws SDK_LOCAL_MODEL_ID_INVALID', () => {
    expect(() => validateModelId('hf-ad410')).toThrow(/64-hex Hash32/);
    let code: unknown;
    try {
      validateModelId(MODEL.toUpperCase());
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('SDK_LOCAL_MODEL_ID_INVALID');
  });

  it('buildTaskOrder fails fast on an invalid model_id and binds the raw 32 bytes otherwise', () => {
    expect(() => buildTaskOrder(CTX, baseOrder('hf-ad410'))).toThrow(/64-hex Hash32/);
    const order = buildTaskOrder(CTX, baseOrder(MODEL));
    expect(toHex(order.modelId)).toBe(MODEL);
    expect(order.modelId).toHaveLength(32);
  });

  it('buildTaskOrder fixes the plaintext Phase 0 reserved fields', () => {
    const order = buildTaskOrder(CTX, baseOrder(MODEL));
    expect(order.schemaVersion).toBe(3);
    expect(order.payloadMode).toBe(1);
    expect(order.inputKeyCommitment).toEqual(new Uint8Array(32));
    expect(order.userRecipientPubkey).toHaveLength(0);
  });
});
