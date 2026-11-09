import { TrueOpenError } from '../errors/errors';
import { isHash32Text } from '../codec/hash32';
import type { TaskOrderChainContext } from './task-order-input';
import { deriveTaskId } from './order-signing';
import type { TaskGenerationLimits } from '../types/hub';

/** The SentOrderRecord schema version this SDK writes and reads. */
export const SENT_ORDER_RECORD_VERSION = 1;

/** TaskOrderChainContext with every bigint as a decimal string, so it survives JSON. */
export interface SentOrderContextRecord {
  readonly chainId: string;
  readonly sessionAnchorHeight: string;
  readonly sessionAnchorBlockHash?: string;
  readonly builderSetId: string;
  readonly builderSetHash: string;
  readonly timeoutBucketVersion: string;
  readonly generationLimits: { readonly [K in keyof TaskGenerationLimits]: string };
  readonly latestHeight: string;
}

/**
 * What openTask records, under the idempotency key, before it sends the first byte of an order:
 * enough to resend that exact order (the same SignedOrderV2 bytes, so the same task_hash) or to
 * recognize it on chain, after the response was lost. Plain JSON: every bigint is a decimal
 * string and every byte string hex.
 */
export interface SentOrderRecord {
  /** SENT_ORDER_RECORD_VERSION. */
  readonly version: 1;
  readonly idempotencyKey: string;
  /** `0x` + 64 lowercase hex. */
  readonly sessionId: string;
  /** The order user (canonical Bech32). */
  readonly userAddress: string;
  /** Decimal. */
  readonly orderSequence: string;
  /** TRUEOPEN_TASK_ID_V1(session_id, order_sequence). */
  readonly taskId: string;
  /** The order's canonical task_hash, `0x` + 64 lowercase hex. */
  readonly taskHash: string;
  /** The SignedOrderV2 bytes exactly as sent (order_envelope), lowercase hex without `0x`. */
  readonly signedOrderHex: string;
  /** sha256(payload), `0x` + 64 lowercase hex. */
  readonly inputHash: string;
  /** Decimal. */
  readonly inputSizeBytes: string;
  readonly inputMediaType: string;
  /** Decimal. */
  readonly earliestSubmitHeight: string;
  /** Decimal. */
  readonly orderExpireHeight: string;
  /** max_fee in atomic units, decimal. */
  readonly maxFee: string;
  readonly feeDenom: string;
  readonly orderSignedBy: 'wallet' | 'session-key';
  /** The registered key's 20-byte address, lowercase hex (orderSignedBy 'session-key' only). */
  readonly orderSignerAddress?: string;
  /** The chain context the order was built on. */
  readonly context: SentOrderContextRecord;
}

/**
 * Where openTask keeps SentOrderRecords (TrueOpenClientConfig.openTaskStore). Either method may
 * be synchronous or return a promise. A `set` that fails (throws or rejects) aborts the send:
 * nothing is sent without a record. The default keeps them in memory for the client's lifetime;
 * persist them (a file, a database) to make retries idempotent across processes.
 */
export interface OpenTaskStore {
  get(key: string): SentOrderRecord | undefined | Promise<SentOrderRecord | undefined>;
  set(key: string, record: SentOrderRecord): void | Promise<void>;
}

/** An OpenTaskStore in a Map: the default, one per client. */
export function memoryOpenTaskStore(): OpenTaskStore {
  const records = new Map<string, SentOrderRecord>();
  return {
    get: (key) => records.get(key),
    set: (key, record) => {
      records.set(key, record);
    },
  };
}

/** TaskOrderChainContext -> its JSON-safe record. */
export function contextToRecord(c: TaskOrderChainContext): SentOrderContextRecord {
  const g = c.generationLimits;
  return {
    chainId: c.chainId,
    sessionAnchorHeight: c.sessionAnchorHeight.toString(),
    ...(c.sessionAnchorBlockHash !== undefined ? { sessionAnchorBlockHash: c.sessionAnchorBlockHash } : {}),
    builderSetId: c.builderSetId,
    builderSetHash: c.builderSetHash,
    timeoutBucketVersion: c.timeoutBucketVersion.toString(),
    generationLimits: {
      maxOutputTokens: g.maxOutputTokens.toString(),
      topKMax: g.topKMax.toString(),
      stopSequenceMaxItems: g.stopSequenceMaxItems.toString(),
      stopSequenceMaxBytesEach: g.stopSequenceMaxBytesEach.toString(),
      stopSequenceMaxTotalBytes: g.stopSequenceMaxTotalBytes.toString(),
      stopTokenMaxItems: g.stopTokenMaxItems.toString(),
    },
    latestHeight: c.latestHeight.toString(),
  };
}

/** The record -> TaskOrderChainContext. */
export function contextFromRecord(r: SentOrderContextRecord): TaskOrderChainContext {
  const g = r.generationLimits;
  return {
    chainId: r.chainId,
    sessionAnchorHeight: BigInt(r.sessionAnchorHeight),
    ...(r.sessionAnchorBlockHash !== undefined ? { sessionAnchorBlockHash: r.sessionAnchorBlockHash } : {}),
    builderSetId: r.builderSetId,
    builderSetHash: r.builderSetHash,
    timeoutBucketVersion: BigInt(r.timeoutBucketVersion),
    generationLimits: {
      maxOutputTokens: BigInt(g.maxOutputTokens),
      topKMax: BigInt(g.topKMax),
      stopSequenceMaxItems: BigInt(g.stopSequenceMaxItems),
      stopSequenceMaxBytesEach: BigInt(g.stopSequenceMaxBytesEach),
      stopSequenceMaxTotalBytes: BigInt(g.stopSequenceMaxTotalBytes),
      stopTokenMaxItems: BigInt(g.stopTokenMaxItems),
    },
    latestHeight: BigInt(r.latestHeight),
  };
}

const DECIMAL = /^[0-9]+$/;
const HEX = /^(?:[0-9a-f]{2})+$/;

/**
 * Checks a record a store returned for `key` (it may come from a file or another process) and
 * returns it; a malformed one, another version or one stored under another key is refused with
 * SDK_LOCAL_OPEN_TASK_RECORD_INVALID rather than resent.
 */
export function checkSentOrderRecord(key: string, value: unknown): SentOrderRecord {
  const bad = (why: string): TrueOpenError =>
    new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_OPEN_TASK_RECORD_INVALID', `the openTask record for idempotency_key ${JSON.stringify(key)} ${why}`, {
      category: 'invalid',
      userAction: 'repair or remove the record in config.openTaskStore, or use a new idempotency key',
    });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw bad('is not an object');
  const r = value as Record<string, unknown>;
  if (r['version'] !== SENT_ORDER_RECORD_VERSION) throw bad(`has version ${JSON.stringify(r['version'])}, not ${SENT_ORDER_RECORD_VERSION}`);
  if (r['idempotencyKey'] !== key) throw bad(`was stored under idempotency_key ${JSON.stringify(r['idempotencyKey'])}`);
  const str = (k: string): void => {
    if (typeof r[k] !== 'string') throw bad(`has no string field ${k}`);
  };
  for (const k of ['userAddress', 'taskId', 'inputMediaType', 'feeDenom']) str(k);
  for (const k of ['sessionId', 'taskHash', 'inputHash']) {
    if (!isHash32Text(r[k])) throw bad(`field ${k} is not 0x + 64 lowercase hex`);
  }
  for (const k of ['orderSequence', 'inputSizeBytes', 'earliestSubmitHeight', 'orderExpireHeight', 'maxFee']) {
    if (typeof r[k] !== 'string' || !DECIMAL.test(r[k] as string)) throw bad(`field ${k} is not a decimal string`);
  }
  if (r['taskId'] !== deriveTaskId(r['sessionId'] as string, BigInt(r['orderSequence'] as string))) {
    throw bad('field taskId is not TRUEOPEN_TASK_ID_V1(sessionId, orderSequence)');
  }
  if (typeof r['signedOrderHex'] !== 'string' || !HEX.test(r['signedOrderHex'])) throw bad('field signedOrderHex is not lowercase hex');
  if (r['orderSignedBy'] !== 'wallet' && r['orderSignedBy'] !== 'session-key') throw bad('field orderSignedBy is not wallet or session-key');
  if (r['orderSignerAddress'] !== undefined && (typeof r['orderSignerAddress'] !== 'string' || !HEX.test(r['orderSignerAddress']))) {
    throw bad('field orderSignerAddress is not lowercase hex');
  }
  const c = r['context'];
  if (typeof c !== 'object' || c === null) throw bad('has no context');
  const ctx = c as Record<string, unknown>;
  for (const k of ['sessionAnchorHeight', 'timeoutBucketVersion', 'latestHeight']) {
    if (typeof ctx[k] !== 'string' || !DECIMAL.test(ctx[k] as string)) throw bad(`field context.${k} is not a decimal string`);
  }
  if (typeof ctx['chainId'] !== 'string' || typeof ctx['builderSetId'] !== 'string' || !isHash32Text(ctx['builderSetHash'])) {
    throw bad('has a malformed context');
  }
  const g = ctx['generationLimits'];
  if (typeof g !== 'object' || g === null) throw bad('has no context.generationLimits');
  for (const k of ['maxOutputTokens', 'topKMax', 'stopSequenceMaxItems', 'stopSequenceMaxBytesEach', 'stopSequenceMaxTotalBytes', 'stopTokenMaxItems']) {
    const v = (g as Record<string, unknown>)[k];
    if (typeof v !== 'string' || !DECIMAL.test(v)) throw bad(`field context.generationLimits.${k} is not a decimal string`);
  }
  return value as SentOrderRecord;
}
