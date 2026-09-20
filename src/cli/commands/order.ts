import { readFileSync } from 'node:fs';
import { buildContext } from '../context';
import type { CliConfig } from '../config';
import type { TaskOrderIntent } from '../../order/task-order-input';
import { defaultGenerationParams } from '../../order/task-order-input';
import { TASK_TYPE, DEADLINE_LATENCY_CLASS } from '../../order/task-order';

/** Fields in the order file that are parsed as uint64 (JSON numbers don't have enough precision, so we always use BigInt). */
const U64_FIELDS = ['earliestSubmitHeight', 'orderExpireHeight'] as const;
/** Fields in the order file that are parsed as uint32. */
const U32_FIELDS = ['profileVersion', 'inputBucket', 'outputBudgetBucket'] as const;
const AMOUNT_FIELDS = ['priceBid', 'maxFee', 'assignmentPriorityFee', 'txFeeReserve'] as const;

/**
 * Read order-file JSON -> TaskOrderIntent.
 *
 * Since TaskOrderV1 was frozen, the order no longer carries reward_bucket / profile_resource_tier /
 * order_value / infer_timeout_blocks -- all of these are now derived by the Keeper, and submitting them
 * is rejected. Fee fields are now Amount (decimal text atomic units).
 */
/** Required uint64 fields in the order file: missing or non-positive values error out immediately; no default is filled in. */
function reqU64(key: string, value: unknown): bigint {
  if (value === undefined || value === null || value === '') {
    throw new Error(`order file field ${key} is required (it goes into task_hash; the SDK will not fill in a default value for you)`);
  }
  const n = BigInt(String(value));
  if (n <= 0n) throw new Error(`order file field ${key} must be a positive integer, got ${String(value)}`);
  return n;
}

export function parseOrderFile(path: string, payload: Uint8Array): TaskOrderIntent {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const num = (k: string, v: unknown): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`order file field ${k} must be a non-negative integer`);
    return n;
  };
  const amountOf = (k: (typeof AMOUNT_FIELDS)[number]): { atomicUnits: string } => ({
    atomicUnits: String(raw[k] ?? '0'),
  });
  const amounts: TaskOrderIntent['amounts'] = {
    priceBid: amountOf('priceBid'),
    maxFee: amountOf('maxFee'),
    assignmentPriorityFee: amountOf('assignmentPriorityFee'),
    txFeeReserve: amountOf('txFeeReserve'),
  };

  const taskType = raw['taskType'];
  const latency = raw['latencyClass'];
  return {
    modelId: String(raw['modelId'] ?? ''),
    profileVersion: num('profileVersion', raw['profileVersion'] ?? 1),
    taskType: typeof taskType === 'string' ? (TASK_TYPE[taskType as keyof typeof TASK_TYPE] ?? 0) : num('taskType', taskType ?? TASK_TYPE.TEXT_GENERATION),
    payload,
    inputBucket: num('inputBucket', raw['inputBucket'] ?? 1),
    outputBudgetBucket: num('outputBudgetBucket', raw['outputBudgetBucket'] ?? 1),
    // No default here: these two values go into GenerationParamsV1 -> task_hash, so silently filling in
    // a default would mean signing the user up for a parameter they never saw (same rationale as in
    // task-order-input.ts). Also, if maxOutputTokens is too small, the response gets cut off mid-sentence
    // and the user has no way of knowing what limit they signed.
    generationParams: defaultGenerationParams(
      reqU64('maxOutputTokens', raw['maxOutputTokens']),
      reqU64('maxOutputDurationMs', raw['maxOutputDurationMs']),
    ),
    amounts,
    earliestSubmitHeight: BigInt(String(raw['earliestSubmitHeight'] ?? 0)),
    orderExpireHeight: BigInt(String(raw['orderExpireHeight'] ?? 0)),
    latencyClass:
      typeof latency === 'string'
        ? (DEADLINE_LATENCY_CLASS[latency as keyof typeof DEADLINE_LATENCY_CLASS] ?? DEADLINE_LATENCY_CLASS.STANDARD)
        : num('latencyClass', latency ?? DEADLINE_LATENCY_CLASS.STANDARD),
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
