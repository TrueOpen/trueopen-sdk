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

describe('model_id validation (matches node ^[a-z0-9][a-z0-9_-]{0,127}$)', () => {
  it('accepts valid ids', () => {
    expect(isValidModelId('hf-ad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b')).toBe(true);
    expect(isValidModelId('a')).toBe(true);
    expect(isValidModelId('model_1-v2')).toBe(true);
    expect(isValidModelId('a'.repeat(128))).toBe(true); // boundary at 128
  });

  it('rejects slash / uppercase / empty / invalid first character / too long', () => {
    expect(isValidModelId('hf/ad410')).toBe(false); // slash
    expect(isValidModelId('HF-abc')).toBe(false); // uppercase
    expect(isValidModelId('')).toBe(false); // empty
    expect(isValidModelId('-abc')).toBe(false); // first character '-'
    expect(isValidModelId('_abc')).toBe(false); // first character '_'
    expect(isValidModelId('a b')).toBe(false); // space
    expect(isValidModelId('a'.repeat(129))).toBe(false); // 129 > 128
  });

  it('validateModelId throws on invalid ids', () => {
    expect(() => validateModelId('hf/ad410')).toThrow(/must match/);
    let code: unknown;
    try {
      validateModelId('HF');
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('SDK_LOCAL_MODEL_ID_INVALID');
  });

  it('buildTaskOrder fails fast on an invalid model_id (never produces an order the chain would reject)', () => {
    expect(() => buildTaskOrder(CTX, baseOrder('hf/bad'))).toThrow(/must match/);
    expect(() => buildTaskOrder(CTX, baseOrder('hf-ad410'))).not.toThrow();
  });
});
