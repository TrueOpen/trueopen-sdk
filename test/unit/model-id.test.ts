import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isValidModelId, validateModelId, deriveModelId } from '../../src/order/model-id';
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

/** wire testdata/v1/hub/model_id_v1.json, read from the submodule rather than copied. */
interface ModelIdVector {
  readonly name: string;
  readonly digest_hex: string;
  readonly fields: readonly { readonly name: string; readonly utf8?: string; readonly bech32?: string }[];
}
const MODEL_ID_FIXTURE = JSON.parse(
  readFileSync('third_party/wire/testdata/v1/hub/model_id_v1.json', 'utf8'),
) as { readonly vectors: readonly ModelIdVector[] };

function inputOf(v: ModelIdVector) {
  const by = (name: string): string => {
    const f = v.fields.find((x) => x.name === name);
    if (f === undefined) throw new Error(`vector ${v.name} has no field ${name}`);
    return f.utf8 ?? f.bech32!;
  };
  return { chainId: by('chain_id'), provider: by('provider'), repoId: by('repo_id'), proposerAddress: by('proposer_address') };
}

describe('deriveModelId against wire model_id_v1 vectors', () => {
  it.each(MODEL_ID_FIXTURE.vectors.map((v) => [v.name, v] as const))('reproduces %s', (_name, v) => {
    expect(deriveModelId(inputOf(v))).toBe(v.digest_hex);
  });

  it('derives a model_id the SDK then accepts as an order model_id', () => {
    const id = deriveModelId(inputOf(MODEL_ID_FIXTURE.vectors[0]!));
    expect(isValidModelId(id)).toBe(true);
    expect(toHex(buildTaskOrder(CTX, baseOrder(id)).modelId)).toBe(id);
  });

  it('is owner-, case- and chain-bound (P1 vs P2/P3/P4 are four distinct identities)', () => {
    const digests = new Set(MODEL_ID_FIXTURE.vectors.map((v) => deriveModelId(inputOf(v))));
    expect(digests.size).toBe(MODEL_ID_FIXTURE.vectors.length);
  });
});

describe('deriveModelId rejects non-canonical input instead of normalizing it', () => {
  const P1 = inputOf(MODEL_ID_FIXTURE.vectors.find((v) => v.name === 'model_id_p1_reference')!);

  it.each([
    ['provider_lower_case', { provider: 'huggingface' }, 'SDK_LOCAL_MODEL_PROVIDER_INVALID'],
    ['provider_alias', { provider: 'HF' }, 'SDK_LOCAL_MODEL_PROVIDER_INVALID'],
    ['provider_empty', { provider: '' }, 'SDK_LOCAL_MODEL_PROVIDER_INVALID'],
    ['provider_not_supported', { provider: 'OCI' }, 'SDK_LOCAL_MODEL_PROVIDER_INVALID'],
    ['repo_id_without_slash', { repoId: 'Qwen3-8B' }, 'SDK_LOCAL_REPO_ID_INVALID'],
    ['repo_id_two_slashes', { repoId: 'Qwen/Qwen3/8B' }, 'SDK_LOCAL_REPO_ID_INVALID'],
    ['repo_id_empty_segment', { repoId: 'Qwen/' }, 'SDK_LOCAL_REPO_ID_INVALID'],
    ['repo_id_outside_charset', { repoId: 'Qwen/Qwen3 8B' }, 'SDK_LOCAL_REPO_ID_INVALID'],
    ['repo_id_surrounding_whitespace', { repoId: ' Qwen/Qwen3-8B' }, 'SDK_LOCAL_REPO_ID_INVALID'],
    ['repo_id_not_nfc', { repoId: 'Qwen/Café' }, 'SDK_LOCAL_REPO_ID_INVALID'],
    ['repo_id_too_long', { repoId: `Qwen/${'a'.repeat(251)}` }, 'SDK_LOCAL_REPO_ID_INVALID'],
    ['chain_id_empty', { chainId: '' }, 'SDK_LOCAL_CHAIN_ID_INVALID'],
    ['proposer_not_canonical_bech32', { proposerAddress: P1.proposerAddress.toUpperCase() }, undefined],
    ['proposer_wrong_hrp', { proposerAddress: P1.proposerAddress.replace(/^trueopen/, 'cosmos') }, undefined],
  ] as const)('rejects %s', (_name, over, code) => {
    let thrown: unknown;
    try {
      deriveModelId({ ...P1, ...over });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    if (code !== undefined) expect((thrown as { code?: string }).code).toBe(code);
  });

  it('accepts repo_id at exactly the 255-byte limit', () => {
    expect(() => deriveModelId({ ...P1, repoId: `Qwen/${'a'.repeat(250)}` })).not.toThrow();
  });
});
