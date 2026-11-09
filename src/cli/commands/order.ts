import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileOpenTaskStore } from '../open-task-file-store';
import { sha256 } from '../../codec/hash';
import { hash32Text } from '../../codec/hash32';
import { buildContext } from '../context';
import type { CliConfig } from '../config';
import type { TaskOrderIntent } from '../../order/task-order-input';
import { defaultGenerationParams } from '../../order/task-order-input';
import { TASK_TYPE, DEADLINE_LATENCY_CLASS } from '../../order/task-order';
import { TrueOpenError } from '../../errors/errors';

const AMOUNT_FIELDS = ['priceBid', 'maxFee', 'assignmentPriorityFee', 'txFeeReserve'] as const;

/**
 * Every field the order file has. All of them are required and nothing else is accepted: each one
 * goes into task_hash, so a default would sign something the user never wrote, and an unknown key is
 * usually a field from an older order format that would otherwise be dropped without a word.
 */
export const ORDER_FILE_FIELDS = [
  'modelId',
  'profileVersion',
  'taskType',
  'inputBucket',
  'outputBudgetBucket',
  'maxOutputTokens',
  'maxOutputDurationMs',
  ...AMOUNT_FIELDS,
  'earliestSubmitHeight',
  'orderExpireHeight',
  'latencyClass',
] as const;

function orderFileError(message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'CLI_ORDER_FILE_INVALID', `order file: ${message}`);
}

/** A non-negative integer given as a JSON number or a decimal string. */
function uint(key: string, value: unknown): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
  throw orderFileError(`field ${key} must be a non-negative integer, got ${JSON.stringify(value)}`);
}

function uint32(key: string, value: unknown): number {
  const n = uint(key, value);
  if (n > 0xffff_ffffn) throw orderFileError(`field ${key} does not fit in uint32`);
  return Number(n);
}

/**
 * Required positive uint32.
 *
 * Zero is rejected here rather than two layers down: both node (task_order.go) and
 * validateTaskOrderScalarScope refuse a zero profile_version or output_budget_bucket, but they
 * report it as "task order scalar scope is invalid", which names no field. The point of parsing
 * the order file strictly is that the message says which field is wrong.
 */
function positive32(key: string, value: unknown): number {
  const n = uint32(key, value);
  if (n === 0) throw orderFileError(`field ${key} must be a positive integer, got ${JSON.stringify(value)}`);
  return n;
}

/** Required positive uint64 (no default: it goes into task_hash). */
function positive(key: string, value: unknown): bigint {
  const n = uint(key, value);
  if (n === 0n) throw orderFileError(`field ${key} must be a positive integer, got ${JSON.stringify(value)}`);
  return n;
}

/** An enum given by name or numeric value; UNSPECIFIED and unknown values are refused. */
function enumValue(key: string, table: Record<string, number>, value: unknown): number {
  const known = Object.entries(table).filter(([name]) => name !== 'UNSPECIFIED');
  const hit =
    typeof value === 'string' && !/^[0-9]+$/.test(value)
      ? known.find(([name]) => name === value)
      : known.find(([, n]) => BigInt(n) === uint(key, value));
  if (hit === undefined) {
    throw orderFileError(`field ${key} must be one of ${known.map(([name]) => name).join(' | ')}, got ${JSON.stringify(value)}`);
  }
  return hit[1];
}

/**
 * Read order-file JSON -> TaskOrderIntent.
 *
 * Since TaskOrderV3 was frozen, the order no longer carries reward_bucket / profile_resource_tier /
 * order_value / infer_timeout_blocks -- all of these are now derived by the Keeper, and submitting them
 * is rejected. Fee fields are Amount (decimal text atomic units).
 */
export function parseOrderFile(path: string, payload: Uint8Array): TaskOrderIntent {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new TrueOpenError('SDK_LOCAL', 'CLI_ORDER_FILE_INVALID', `order file ${path} is not readable JSON`, { cause: e });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw orderFileError('must be a JSON object');
  const o = raw as Record<string, unknown>;
  const allowed = new Set<string>(ORDER_FILE_FIELDS);
  const unknown = Object.keys(o).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw orderFileError(`unknown field(s) ${unknown.join(', ')}; accepted fields are ${ORDER_FILE_FIELDS.join(', ')}`);
  }
  const missing = ORDER_FILE_FIELDS.filter((k) => o[k] === undefined || o[k] === null || o[k] === '');
  if (missing.length > 0) {
    throw orderFileError(`missing required field(s) ${missing.join(', ')} (each goes into task_hash; the SDK will not fill in a default for you)`);
  }

  const modelId = o['modelId'];
  if (typeof modelId !== 'string') throw orderFileError('field modelId must be a Hash32 string, 0x followed by 64 lowercase hex characters');
  const amountOf = (k: (typeof AMOUNT_FIELDS)[number]): { atomicUnits: string } => ({ atomicUnits: uint(k, o[k]).toString() });

  return {
    modelId,
    profileVersion: positive32('profileVersion', o['profileVersion']),
    taskType: enumValue('taskType', TASK_TYPE, o['taskType']),
    payload,
    inputBucket: uint32('inputBucket', o['inputBucket']),
    outputBudgetBucket: positive32('outputBudgetBucket', o['outputBudgetBucket']),
    // These two go into GenerationParamsV1 -> task_hash. If maxOutputTokens is too small, the
    // response gets cut off mid-sentence and the user has no way of knowing what limit they signed.
    generationParams: defaultGenerationParams(
      positive('maxOutputTokens', o['maxOutputTokens']),
      positive('maxOutputDurationMs', o['maxOutputDurationMs']),
    ),
    amounts: {
      priceBid: amountOf('priceBid'),
      maxFee: amountOf('maxFee'),
      assignmentPriorityFee: amountOf('assignmentPriorityFee'),
      txFeeReserve: amountOf('txFeeReserve'),
    },
    earliestSubmitHeight: positive('earliestSubmitHeight', o['earliestSubmitHeight']),
    orderExpireHeight: positive('orderExpireHeight', o['orderExpireHeight']),
    latencyClass: enumValue('latencyClass', DEADLINE_LATENCY_CLASS, o['latencyClass']),
  };
}

/** Where `order submit` records the orders it sends: `<stateDir>/opentask`. */
export function openTaskStateDir(cfg: CliConfig): string {
  return join(cfg.stateDir, 'opentask');
}

/**
 * `order submit`. Each order sent is recorded first, under its idempotency key, in a file-backed
 * OpenTaskStore (openTaskStateDir), so running the same command again after a lost response or a
 * crash resends that exact order, or prints it once the chain recorded it, and never places a
 * second order at the next sequence. The default key is `<session>:<seq>` with --seq, otherwise
 * `<session>:<sha256(payload)>`: a deliberate second order with the same payload needs its own
 * --idempotency-key.
 */
export async function cmdOrderSubmit(
  cfg: CliConfig,
  mnemonic: string,
  a: { orderFile: string; session: string; seq?: string; payloadFile: string; idempotencyKey?: string },
): Promise<unknown> {
  const payload = new Uint8Array(readFileSync(a.payloadFile));
  const order = parseOrderFile(a.orderFile, payload);
  const seq = a.seq === undefined ? undefined : BigInt(a.seq);
  // Without --seq the sequence is read from chain by openTask (the sole source of truth), or taken
  // from the recorded order on a retry; the key must not depend on it, or a retry after the first
  // attempt was admitted would get a new key and a second order.
  const idempotencyKey = a.idempotencyKey ?? `${a.session}:${seq !== undefined ? seq.toString() : hash32Text(sha256(payload))}`;
  // OpenTask needs on-chain context and Task Builder routing, so we always build the context via deterministic routing.
  const ctx = await buildContext(cfg, mnemonic, {
    nexus: true,
    key: true,
    deterministic: true,
    openTaskStore: fileOpenTaskStore(openTaskStateDir(cfg)),
  });
  try {
    return await ctx.client.openTask({
      sessionId: a.session,
      ...(seq !== undefined ? { orderSequence: seq } : {}),
      order,
      idempotencyKey,
    });
  } finally {
    await ctx.dispose();
  }
}

export async function cmdOrderCancel(cfg: CliConfig, mnemonic: string, a: { session: string; seq: string }): Promise<unknown> {
  const ctx = await buildContext(cfg, mnemonic, { write: true, key: true });
  try {
    return await ctx.client.cancelOrder(a.session, BigInt(a.seq));
  } finally {
    await ctx.dispose();
  }
}
