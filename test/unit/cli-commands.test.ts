import { describe, it, expect } from 'vitest';
import { cmdAddress } from '../../src/cli/commands/misc';
import { parseOrderFile } from '../../src/cli/commands/order';
import { resolveConfig } from '../../src/cli/config';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MN = 'flee cover glad finish category story alpha envelope twelve tube glory athlete ugly road roof milk idle ketchup utility park source jewel head shift';

describe('cli commands', () => {
  it('errors when maxOutputTokens / maxOutputDurationMs is missing, instead of silently defaulting', () => {
    // These go into GenerationParamsV1 -> task_hash: silently defaulting them would mean signing
    // parameters on the user's behalf that they never saw, and too small a limit would cut the
    // response off mid-sentence without the user noticing.
    const base = {
      modelId: 'hf-x', profileVersion: 1, taskType: 'TEXT_GENERATION',
      inputBucket: 1, outputBudgetBucket: 1,
      earliestSubmitHeight: '1', orderExpireHeight: '2', latencyClass: 'STANDARD',
    };
    const write = (o: unknown): string => {
      const p = `/tmp/trueopen-test-order-${Math.abs(JSON.stringify(o).length)}.json`;
      writeFileSync(p, JSON.stringify(o));
      return p;
    };
    const payload = new Uint8Array([1]);
    expect(() => parseOrderFile(write({ ...base, maxOutputDurationMs: 60_000 }), payload)).toThrow(/maxOutputTokens/);
    expect(() => parseOrderFile(write({ ...base, maxOutputTokens: 128 }), payload)).toThrow(/maxOutputDurationMs/);
    expect(() => parseOrderFile(write({ ...base, maxOutputTokens: 0, maxOutputDurationMs: 60_000 }), payload)).toThrow(/positive/);
  });

  it('address derives a self-consistent address from the mnemonic', async () => {
    const cfg = resolveConfig({ prefix: 'trueopen' }, {});
    const r = (await cmdAddress(cfg, MN)) as { address: string };
    // Protocol HD path m/44'/60'/0'/0/0 + keccak address; see cli-context.test.ts for the derivation chain.
    expect(r.address).toBe('trueopen1jah6xx0ve056wgl3cxlxhe393ywwwyuamfl037');
  });

  it('parseOrderFile parses JSON into a frozen TaskOrderV1 intent (fees are Amount decimal text)', () => {
    const p = join(tmpdir(), `order-${Date.now()}.json`);
    writeFileSync(
      p,
      JSON.stringify({
        modelId: 'm', profileVersion: 1, taskType: 'TEXT_GENERATION',
        inputBucket: 1, outputBudgetBucket: 1, maxOutputTokens: 128, maxOutputDurationMs: 60_000,
        maxFee: '1000', inferFeeCap: '600', verifyFeeCap: '300',
        earliestSubmitHeight: '100', orderExpireHeight: '50100',
        latencyClass: 'STANDARD',
      }),
    );
    try {
      const order = parseOrderFile(p, new TextEncoder().encode('payload'));
      expect(order.modelId).toBe('m');
      expect(order.profileVersion).toBe(1);
      // Fees changed to Amount: what goes into the task_hash preimage is decimal text, not a numeric value.
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
