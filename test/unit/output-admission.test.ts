import { afterEach, expect, it, vi } from 'vitest';
import { waitForOutputAdmission } from '../../src/output/output-admission';
import { TrueOpenError } from '../../src/errors/errors';
const pending = () => new TrueOpenError('CHAIN_REJECT', 'OUTPUT_TRUST_ANCHOR_PENDING', 'not recorded', { retriable: true });
afterEach(() => { vi.useRealTimers(); });

it('DISPATCH_RECORDED triggers an immediate chain read without waiting for the poll timer', async () => {
  vi.useFakeTimers();
  let reads = 0;
  let signal: AbortSignal | undefined;
  const result = waitForOutputAdmission(async () => { if (++reads === 1) throw pending(); return 'chain anchors'; }, s => {
    signal = s;
    return (async function* () { yield { eventCode: 'DISPATCH_RECORDED' }; })();
  }, { pollIntervalMs: 10_000, timeoutMs: 30_000 });
  expect(await result).toBe('chain anchors');
  expect(reads).toBe(2);
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('retired event codes and DISPATCH_ACCEPTED do not bypass the polling interval', async () => {
  vi.useFakeTimers();
  let reads = 0;
  const result = waitForOutputAdmission(async () => { if (++reads === 1) throw pending(); return 'ready'; }, async function* () {
    yield { eventCode: 'ASSIGN_ACCEPTED' }; yield { eventCode: 'ASSIGNMENT_FINALIZED' }; yield { eventCode: 'DISPATCH_ACCEPTED' };
  }, { pollIntervalMs: 1000, timeoutMs: 5000 });
  await vi.advanceTimersByTimeAsync(999);
  expect(reads).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe('ready');
});

it('a recording hint is not authority; an unavailable event stream falls back to polling', async () => {
  vi.useFakeTimers();
  let reads = 0;
  const result = waitForOutputAdmission(async () => { if (++reads < 3) throw pending(); return 'recorded'; }, async function* () {
    yield { eventCode: 'DISPATCH_RECORDED' }; throw new Error('events disconnected');
  }, { pollIntervalMs: 1000, timeoutMs: 5000 });
  await vi.advanceTimersByTimeAsync(0);
  expect(reads).toBe(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toBe('recorded');
});

it('abort and timeout close the event subscription, even when the chain read hangs', async () => {
  vi.useFakeTimers();
  for (const mode of ['abort', 'timeout']) {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const result = waitForOutputAdmission(() => new Promise<never>(() => {}), s => {
      signal = s;
      return (async function* () { await new Promise<void>(resolve => s.addEventListener('abort', () => resolve(), { once: true })); })();
    }, { signal: controller.signal, timeoutMs: 100 });
    const checked = expect(result).rejects.toMatchObject({ code: mode === 'abort' ? 'SDK_LOCAL_ABORTED' : 'OUTPUT_TRUST_ANCHOR_TIMEOUT' });
    if (mode === 'abort') controller.abort();
    else await vi.advanceTimersByTimeAsync(100);
    await checked;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  }
});

it('propagates malformed/unauthorized chain responses instead of retrying them', async () => {
  const error = new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_MALFORMED', 'bad response');
  await expect(waitForOutputAdmission(async () => { throw error; }, async function* () {})).rejects.toBe(error);
});
