import { describe, it, expect } from 'vitest';
import { cmdAddress } from '../../src/cli/commands/misc';
import { parseOrderFile } from '../../src/cli/commands/order';
import { resolveConfig } from '../../src/cli/config';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MN = 'flee cover glad finish category story alpha envelope twelve tube glory athlete ugly road roof milk idle ketchup utility park source jewel head shift';

describe('cli commands', () => {
  const base = {
    modelId: '5555555555555555555555555555555555555555555555555555555555555555', profileVersion: 1, taskType: 'TEXT_GENERATION',
    inputBucket: 1, outputBudgetBucket: 1, maxOutputTokens: 128, maxOutputDurationMs: 60_000,
    priceBid: '100000', maxFee: '1000', assignmentPriorityFee: '0', txFeeReserve: '0',
    earliestSubmitHeight: '1', orderExpireHeight: '2', latencyClass: 'STANDARD',
  };
  const write = (o: unknown): string => {
    const p = join(tmpdir(), `trueopen-test-order-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify(o));
    return p;
  };
  const payload = new Uint8Array([1]);
  const without = (k: keyof typeof base): Record<string, unknown> => {
    const o: Record<string, unknown> = { ...base };
    delete o[k];
    return o;
  };

  it('errors when maxOutputTokens / maxOutputDurationMs is missing, instead of silently defaulting', () => {
    // These go into GenerationParamsV1 -> task_hash: silently defaulting them would mean signing
    // parameters on the user's behalf that they never saw, and too small a limit would cut the
    // response off mid-sentence without the user noticing.
    expect(() => parseOrderFile(write(without('maxOutputTokens')), payload)).toThrow(/maxOutputTokens/);
    expect(() => parseOrderFile(write(without('maxOutputDurationMs')), payload)).toThrow(/maxOutputDurationMs/);
    expect(() => parseOrderFile(write({ ...base, maxOutputTokens: 0 }), payload)).toThrow(/positive/);
  });

  it('errors on any missing field instead of defaulting it (amounts, profileVersion, enums, buckets)', () => {
    for (const k of ['priceBid', 'maxFee', 'assignmentPriorityFee', 'txFeeReserve', 'profileVersion', 'taskType', 'latencyClass', 'inputBucket', 'outputBudgetBucket'] as const) {
      expect(() => parseOrderFile(write(without(k)), payload), k).toThrow(new RegExp(`missing required field\\(s\\) ${k}`));
    }
  });

  /**
   * node (task_order.go) and validateTaskOrderScalarScope both refuse a zero profile_version or
   * output_budget_bucket, but they say "task order scalar scope is invalid", which names no
   * field. A strict order-file parser exists so the message points at the field.
   */
  it('errors on a zero profile_version / output_budget_bucket, naming the field', () => {
    expect(() => parseOrderFile(write({ ...base, profileVersion: 0 }), payload)).toThrow(
      /profileVersion must be a positive integer/,
    );
    expect(() => parseOrderFile(write({ ...base, outputBudgetBucket: 0 }), payload)).toThrow(
      /outputBudgetBucket must be a positive integer/,
    );
    // inputBucket has no such rule on either side, so zero stays acceptable.
    expect(parseOrderFile(write({ ...base, inputBucket: 0 }), payload)).toMatchObject({ inputBucket: 0 });
  });

  it('errors on unknown enum values and unknown fields', () => {
    expect(() => parseOrderFile(write({ ...base, taskType: 'TEXT' }), payload)).toThrow(/taskType must be one of/);
    expect(() => parseOrderFile(write({ ...base, taskType: 'UNSPECIFIED' }), payload)).toThrow(/taskType must be one of/);
    expect(() => parseOrderFile(write({ ...base, taskType: 99 }), payload)).toThrow(/taskType must be one of/);
    expect(() => parseOrderFile(write({ ...base, latencyClass: 'SLOW' }), payload)).toThrow(/latencyClass must be one of/);
    // A field from an older order format must not be dropped silently.
    expect(() => parseOrderFile(write({ ...base, inferFeeCap: '600' }), payload)).toThrow(/unknown field\(s\) inferFeeCap/);
    expect(() => parseOrderFile(write({ ...base, maxFee: '-1' }), payload)).toThrow(/maxFee must be a non-negative integer/);
    // Numeric enum values are still accepted.
    expect(parseOrderFile(write({ ...base, taskType: 2, latencyClass: '3' }), payload)).toMatchObject({ taskType: 2, latencyClass: 3 });
  });

  it('address derives a self-consistent address from the mnemonic', async () => {
    const cfg = resolveConfig({ prefix: 'trueopen' }, {});
    const r = (await cmdAddress(cfg, MN)) as { address: string };
    // Protocol HD path m/44'/60'/0'/0/0 + keccak address; see cli-context.test.ts for the derivation chain.
    expect(r.address).toBe('trueopen1jah6xx0ve056wgl3cxlxhe393ywwwyuamfl037');
  });

  it('parseOrderFile parses JSON into a frozen TaskOrderV3 intent (fees are Amount decimal text)', () => {
    const p = join(tmpdir(), `order-${Date.now()}.json`);
    writeFileSync(
      p,
      JSON.stringify({
        modelId: '5555555555555555555555555555555555555555555555555555555555555555', profileVersion: 1, taskType: 'TEXT_GENERATION',
        inputBucket: 1, outputBudgetBucket: 1, maxOutputTokens: 128, maxOutputDurationMs: 60_000,
        priceBid: '100000', maxFee: '1000', assignmentPriorityFee: '0', txFeeReserve: '0',
        earliestSubmitHeight: '100', orderExpireHeight: '50100',
        latencyClass: 'STANDARD',
      }),
    );
    try {
      const order = parseOrderFile(p, new TextEncoder().encode('payload'));
      expect(order.modelId).toBe('5555555555555555555555555555555555555555555555555555555555555555');
      expect(order.profileVersion).toBe(1);
      // Fees changed to Amount: what goes into the task_hash preimage is decimal text, not a numeric value.
      expect(order.amounts.priceBid).toEqual({ atomicUnits: '100000' });
      expect(order.amounts.maxFee).toEqual({ atomicUnits: '1000' });
      expect(order.amounts.assignmentPriorityFee).toEqual({ atomicUnits: '0' });
      expect(order.earliestSubmitHeight).toBe(100n);
      expect(order.orderExpireHeight).toBe(50_100n);
      // Enum names can be written as strings, which map to frozen numeric values.
      expect(order.taskType).toBe(1); // TASK_TYPE_TEXT_GENERATION
      expect(order.latencyClass).toBe(2); // DEADLINE_LATENCY_CLASS_STANDARD
    } finally {
      rmSync(p);
    }
  });
});
