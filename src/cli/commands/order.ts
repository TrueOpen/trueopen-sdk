import { readFileSync } from 'node:fs';
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
  if (typeof modelId !== 'string') throw orderFileError('field modelId must be a 64-hex string');
  const amountOf = (k: (typeof AMOUNT_FIELDS)[number]): { atomicUnits: string } => ({ atomicUnits: uint(k, o[k]).toString() });

  return {
    modelId,
    profileVersion: uint32('profileVersion', o['profileVersion']),
    taskType: enumValue('taskType', TASK_TYPE, o['taskType']),
    payload,
    inputBucket: uint32('inputBucket', o['inputBucket']),
    outputBudgetBucket: uint32('outputBudgetBucket', o['outputBudgetBucket']),
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

export async function cmdOrderSubmit(
  cfg: CliConfig,
  mnemonic: string,
  a: { orderFile: string; session: string; seq?: string; payloadFile: string; idempotencyKey?: string },
): Promise<unknown> {
  const payload = new Uint8Array(readFileSync(a.payloadFile));
  const order = parseOrderFile(a.orderFile, payload);
  // OpenTask needs on-chain context and Task Builder routing, so we always build the context via deterministic routing.
  const ctx = await buildContext(cfg, mnemonic, { nexus: true, key: true, deterministic: true });
  try {
    // The default sequence is read from chain (the sole source of truth). We resolve it here rather than
    // leaving it to openTask internally because the idempotency key must carry the real sequence number --
    // retries of the same order must produce the same key.
    const seq = a.seq === undefined ? await ctx.client.nextOrderSequence(a.session) : BigInt(a.seq);
    return await ctx.client.openTask({
      sessionId: a.session,
      orderSequence: seq,
      order,
      idempotencyKey: a.idempotencyKey ?? `${a.session}:${seq}`,
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
