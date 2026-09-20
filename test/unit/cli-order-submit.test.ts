import { describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliConfig } from '../../src/cli/config';

const calls = { openTask: 0, lastNeeds: undefined as unknown, lastParams: undefined as unknown };

vi.mock('../../src/cli/context', () => ({
  buildContext: vi.fn(async (_cfg: unknown, _m: unknown, needs: unknown) => {
    calls.lastNeeds = needs;
    return {
      client: {
        openTask: async (params: unknown) => {
          calls.openTask += 1;
          calls.lastParams = params;
          return {
            accepted: true, taskId: 't', taskHash: 'h', reason: '', sessionId: 's',
            endpointsTried: 3, context: {},
          };
        },
      },
      identity: {},
      dispose: async () => {},
    };
  }),
}));

// Import the module under test after the mock is set up.
const { cmdOrderSubmit } = await import('../../src/cli/commands/order');

const ORDER_FILE = join(tmpdir(), `trueopen-order-${process.pid}.json`);
writeFileSync(
  ORDER_FILE,
  JSON.stringify({
    modelId: 'm', profileVersion: 1, taskType: 'TEXT_GENERATION',
    inputBucket: 1, outputBudgetBucket: 1, maxOutputTokens: 128, maxOutputDurationMs: 60_000,
    inferInputUnitPriceBid: '2', inferOutputUnitPriceBid: '3', verifyUnitPriceBid: '4',
    maxFee: '1000', inferFeeCap: '600', verifyFeeCap: '300',
    earliestSubmitHeight: '100', orderExpireHeight: '50100',
    latencyClass: 'STANDARD',
  }),
);
const PAYLOAD_FILE = join(tmpdir(), `trueopen-payload-${process.pid}.bin`);
writeFileSync(PAYLOAD_FILE, Buffer.from('trueopen-input'));
const cfg = {} as unknown as CliConfig;
const baseArgs = { orderFile: ORDER_FILE, session: 's', seq: '3', payloadFile: PAYLOAD_FILE };

/**
 * After OpenTask there is no longer a "single-send vs. deterministic routing" branch:
 * Task Builders are uniquely determined by the anchor signed into the order, so submitting
 * an order always goes through deterministic routing and fans out to every selected
 * endpoint, which is why buildContext always requires the deterministic capability.
 */
describe('cmdOrderSubmit', () => {
  it('goes through openTask, and buildContext requires the deterministic capability', async () => {
    const res = (await cmdOrderSubmit(cfg, 'mnem', { ...baseArgs })) as { endpointsTried?: number };
    expect(calls.openTask).toBe(1);
    expect(res.endpointsTried).toBe(3);
    expect((calls.lastNeeds as { deterministic?: boolean }).deterministic).toBe(true);
  });

  it('order-file is parsed into the intent, payload is read from --payload-file', async () => {
    await cmdOrderSubmit(cfg, 'mnem', { ...baseArgs });
    const p = calls.lastParams as {
      sessionId: string;
      orderSequence: bigint;
      idempotencyKey: string;
      order: { modelId: string; payload: Uint8Array; amounts: { maxFee: { atomicUnits: string } } };
    };
    expect(p.sessionId).toBe('s');
    expect(p.orderSequence).toBe(3n);
    expect(p.order.modelId).toBe('m');
    expect(p.order.amounts.maxFee).toEqual({ atomicUnits: '1000' });
    expect(new TextDecoder().decode(p.order.payload)).toBe('trueopen-input');
  });

  it('idempotency_key defaults to session:seq (stays the same across retries)', async () => {
    await cmdOrderSubmit(cfg, 'mnem', { ...baseArgs });
    expect((calls.lastParams as { idempotencyKey: string }).idempotencyKey).toBe('s:3');
    await cmdOrderSubmit(cfg, 'mnem', { ...baseArgs, idempotencyKey: 'explicit' });
    expect((calls.lastParams as { idempotencyKey: string }).idempotencyKey).toBe('explicit');
  });
});
