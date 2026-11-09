import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CliConfig } from '../../src/cli/config';
import type { OpenTaskStore, SentOrderRecord } from '../../src/order/open-task-store';

const calls = { openTask: 0, sent: 0, lastNeeds: undefined as unknown, lastParams: undefined as unknown };

vi.mock('../../src/cli/context', () => ({
  buildContext: vi.fn(async (_cfg: unknown, _m: unknown, needs: unknown) => {
    calls.lastNeeds = needs;
    return {
      client: {
        openTask: async (params: { idempotencyKey: string; sessionId: string }) => {
          calls.openTask += 1;
          calls.lastParams = params;
          // Stands in for the client's use of config.openTaskStore: record before the first send,
          // and a retry under a recorded key sends nothing new.
          const store = (needs as { openTaskStore?: OpenTaskStore }).openTaskStore;
          if (store !== undefined) {
            const recorded = await store.get(params.idempotencyKey);
            if (recorded !== undefined) return { accepted: true, taskId: recorded.taskId, status: 4, recorded: true };
            await store.set(params.idempotencyKey, { version: 1, idempotencyKey: params.idempotencyKey, taskId: `task-${calls.sent}` } as SentOrderRecord);
            calls.sent += 1;
          }
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
    modelId: '5555555555555555555555555555555555555555555555555555555555555555', profileVersion: 1, taskType: 'TEXT_GENERATION',
    inputBucket: 1, outputBudgetBucket: 1, maxOutputTokens: 128, maxOutputDurationMs: 60_000,
    priceBid: '100000', maxFee: '1000', assignmentPriorityFee: '0', txFeeReserve: '0',
    earliestSubmitHeight: '100', orderExpireHeight: '50100',
    latencyClass: 'STANDARD',
  }),
);
const PAYLOAD_FILE = join(tmpdir(), `trueopen-payload-${process.pid}.bin`);
writeFileSync(PAYLOAD_FILE, Buffer.from('trueopen-input'));
const STATE_DIR = mkdtempSync(join(tmpdir(), 'trueopen-state-'));
const cfg = { stateDir: STATE_DIR } as unknown as CliConfig;
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
    expect(p.order.modelId).toBe('5555555555555555555555555555555555555555555555555555555555555555');
    expect(p.order.amounts.maxFee).toEqual({ atomicUnits: '1000' });
    expect(new TextDecoder().decode(p.order.payload)).toBe('trueopen-input');
  });

  it('idempotency_key defaults to session:seq with --seq (stays the same across retries)', async () => {
    await cmdOrderSubmit(cfg, 'mnem', { ...baseArgs });
    expect((calls.lastParams as { idempotencyKey: string }).idempotencyKey).toBe('s:3');
    await cmdOrderSubmit(cfg, 'mnem', { ...baseArgs, idempotencyKey: 'explicit' });
    expect((calls.lastParams as { idempotencyKey: string }).idempotencyKey).toBe('explicit');
  });

  it('without --seq: no sequence is read or passed, and the key is session:sha256(payload)', async () => {
    const { seq: _seq, ...noSeq } = baseArgs;
    void _seq;
    await cmdOrderSubmit(cfg, 'mnem', noSeq);
    const p = calls.lastParams as { orderSequence?: bigint; idempotencyKey: string };
    expect(p.orderSequence).toBeUndefined();
    const digest = createHash('sha256').update('trueopen-input').digest('hex');
    expect(p.idempotencyKey).toBe(`s:0x${digest}`);
  });

  it('records orders in a file-backed store under <stateDir>/opentask, so a plain retry places no second order', async () => {
    const { seq: _seq, ...noSeq } = baseArgs;
    void _seq;
    const args = { ...noSeq, idempotencyKey: 'retry-me' };
    const sentBefore = calls.sent;
    await cmdOrderSubmit(cfg, 'mnem', args);
    // The same command again (a new process would build a new client on the same directory).
    const again = (await cmdOrderSubmit(cfg, 'mnem', args)) as { taskId: string; recorded?: boolean };
    expect(calls.sent).toBe(sentBefore + 1);
    expect(again.recorded).toBe(true);
    const dir = join(STATE_DIR, 'opentask');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const name = `${createHash('sha256').update('retry-me').digest('hex')}.json`;
    expect(files).toContain(name);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    expect((calls.lastNeeds as { openTaskStore?: unknown }).openTaskStore).toBeDefined();
  });
});

describe('fileOpenTaskStore', () => {
  it('round-trips a record and answers undefined for an unknown key', async () => {
    const { fileOpenTaskStore } = await import('../../src/cli/open-task-file-store');
    const store = fileOpenTaskStore(join(mkdtempSync(join(tmpdir(), 'trueopen-store-')), 'nested', 'opentask'));
    expect(await store.get('k')).toBeUndefined();
    const rec = { version: 1, idempotencyKey: 'k:/weird key', orderSequence: '7' } as unknown as SentOrderRecord;
    await store.set('k:/weird key', rec);
    expect(await store.get('k:/weird key')).toEqual(rec);
  });
});
