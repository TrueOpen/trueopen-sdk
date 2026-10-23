import { describe, it, expect } from 'vitest';
import { createRouterTransport, ConnectError, Code } from '@connectrpc/connect';
import type { HandlerContext, Transport } from '@connectrpc/connect';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import { TrueOpenClient } from '../../src/client';
import type { OutputTaskReader } from '../../src/client';
import type { ChainClient } from '../../src/transport/chain-client';
import type { ChainTaskSnapshot, InferReceiptView } from '../../src/types/node';
import type { ServiceKeyBinding } from '../../src/types/hub';
import { secp256k1PublicKey } from '../../src/signer/secp256k1';
import { ethSecp256k1Address } from '../../src/signer/eth-secp256k1';
import { privateKeyTypedDataSigner } from '../../src/signer/typed-data-signer';
import { fromHex } from '../../src/util/bytes';

const CHAIN_ID = 'trueopen-localnet-1';
const SESSION = '0xb793a05ff8441795fca46a890b906b0c81af9d8d7a4d53e82de53a1c917b9883';
const TASK = `0x${'d'.repeat(64)}`;
const TASK_HASH = `0x${'c'.repeat(64)}`;
const WINNER = 'trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man';
const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const WORKER_PUB = secp256k1PublicKey(fromHex('0302030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'));

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A chain whose task has no winner until `assign()` is called (or until `assignAfter` reads). */
function chain(opts: { assignAfter?: number; terminal?: boolean; phase?: string } = {}) {
  let winner = '';
  const r = {
    reads: 0,
    assign(): void {
      winner = WINNER;
    },
    async queryTask(taskId: string): Promise<ChainTaskSnapshot> {
      r.reads += 1;
      if (opts.assignAfter !== undefined && r.reads >= opts.assignAfter) winner = WINNER;
      return {
        view: opts.terminal ? 'terminal' : 'active', taskId, acceptedTaskHash: TASK_HASH, winnerWorker: winner,
        modelId: `0x${'b'.repeat(64)}`, profileVersion: 1n, orderSequence: 0n,
        ...(opts.terminal
          ? { terminalPhase: 'FAILED' }
          : { acceptedInputHash: `0x${'a'.repeat(64)}`, taskPhase: opts.phase ?? 'WORKER_ASSIGNMENT_PENDING' }),
      };
    },
    async queryInferReceipt(): Promise<InferReceiptView | undefined> {
      throw new Error('streaming anchors never read the receipt');
    },
  };
  return r satisfies OutputTaskReader;
}

function hub(status = 'ACTIVE') {
  const calls = { keys: 0 };
  return {
    calls,
    getLatestHeight: async (): Promise<bigint> => 500n,
    getCurrentServiceKey: async (pt: string, addr: string): Promise<ServiceKeyBinding> => {
      calls.keys += 1;
      return { participantType: pt, operatorAddress: addr, serviceAddress: addr, servicePubKey: WORKER_PUB, status, serviceAuthorizationNonce: 0n };
    },
  };
}

const fakeChain: ChainClient = {
  querySession: async () => { throw new Error('unused'); },
  querySessionNonce: async () => ({ nextSessionNonce: 0n }),
  createSession: async () => { throw new Error('unused'); },
  cancelOrder: async () => { throw new Error('unused'); },
  updateSessionKey: async () => { throw new Error('unused'); },
};

interface EventsLog {
  opened: number;
  closed: number;
}

/**
 * A nexus whose GetTaskEvents stream runs `script`. The stream stays open until the client
 * aborts it, so `closed` counts streams the client really tore down.
 */
function eventsTransport(log: EventsLog, script: (emit: (code: string) => void) => Promise<void> | void): Transport {
  return createRouterTransport(({ service }) => {
    service(IngressAPI, {
      async *getTaskEvents(_req: unknown, ctx: HandlerContext) {
        log.opened += 1;
        // Counted on the signal itself: after a yield the handler sits suspended and would
        // never reach a finally block.
        ctx.signal.addEventListener('abort', () => { log.closed += 1; }, { once: true });
        const queue: string[] = [];
        let notify: (() => void) | undefined;
        const emit = (code: string): void => {
          queue.push(code);
          notify?.();
        };
        await script(emit);
        while (!ctx.signal.aborted) {
          const code = queue.shift();
          if (code !== undefined) {
            yield { cursor: '1', state: '', taskPhase: '', eventCode: code, chainHeight: 0n };
            continue;
          }
          await new Promise<void>((r) => {
            notify = r;
            ctx.signal.addEventListener('abort', () => r(), { once: true });
          });
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });
}

function makeClient(transport: Transport, reader: OutputTaskReader, h: unknown = hub()): TrueOpenClient {
  return new TrueOpenClient({
    chainId: CHAIN_ID, userAddress: ethSecp256k1Address(secp256k1PublicKey(PRIV), 'trueopen'),
    wallet: privateKeyTypedDataSigner(PRIV),
    chain: fakeChain, ingressTransport: transport, signatureChainId: 424242n,
    nonce: () => new Uint8Array(32).fill(7),
    taskReader: reader,
    hub: h as never,
  });
}

const noEvents = (log: EventsLog): Transport => eventsTransport(log, () => {});

describe('waitForOutputTrustAnchors', () => {
  it('returns the streaming anchors at once when the winner is already on chain', async () => {
    const reader = chain({ assignAfter: 1 });
    const a = await makeClient(noEvents({ opened: 0, closed: 0 }), reader).waitForOutputTrustAnchors(TASK);
    expect(a).toMatchObject({ taskHash: TASK_HASH, winnerWorker: WINNER, workerServicePubKey: WORKER_PUB });
    expect(a.receipt).toBeUndefined();
    expect(reader.reads).toBe(1);
  });

  it('polls until the winner appears', async () => {
    const reader = chain({ assignAfter: 3 });
    const a = await makeClient(noEvents({ opened: 0, closed: 0 }), reader).waitForOutputTrustAnchors(TASK, { pollIntervalMs: 5 });
    expect(a.winnerWorker).toBe(WINNER);
    expect(reader.reads).toBe(3);
  });

  it('reads the chain once more, straight away, on ASSIGNMENT_FINALIZED, and only once', async () => {
    const reader = chain();
    const log = { opened: 0, closed: 0 };
    let emit!: (code: string) => void;
    const t = eventsTransport(log, (e) => { emit = e; });
    const ac = new AbortController();
    const waiting = makeClient(t, reader)
      .waitForOutputTrustAnchors(TASK, { sessionId: SESSION, pollIntervalMs: 60_000, signal: ac.signal })
      .catch((x: unknown) => x);
    await tick(50);
    expect(reader.reads).toBe(1);

    // Neither another nexus event nor the Verifier one counts.
    emit('ORDER_RECEIVED');
    emit('VERIFIER_ASSIGNMENT_FINALIZED');
    await tick(50);
    expect(reader.reads).toBe(1);

    // The event still finds no winner: one extra read, then back to the (long) poll.
    emit('ASSIGNMENT_FINALIZED');
    await tick(50);
    expect(reader.reads).toBe(2);
    emit('ASSIGNMENT_FINALIZED');
    await tick(50);
    expect(reader.reads).toBe(2);
    // The event stream was closed after its one trigger.
    expect(log.closed).toBe(1);

    // A second event does not wake the wait again: it sleeps until the next poll.
    reader.assign();
    await expect(Promise.race([waiting, tick(50).then(() => 'still waiting')])).resolves.toBe('still waiting');
    ac.abort();
    expect(await waiting).toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_WAIT_ABORTED' });
  });

  it('resolves through the event long before the next poll', async () => {
    const reader = chain();
    const log = { opened: 0, closed: 0 };
    let emit!: (code: string) => void;
    const t = eventsTransport(log, (e) => { emit = e; });
    const started = Date.now();
    const waiting = makeClient(t, reader).waitForOutputTrustAnchors(TASK, { sessionId: SESSION, pollIntervalMs: 60_000 });
    await tick(50);
    reader.assign();
    emit('ASSIGNMENT_FINALIZED');
    const a = await waiting;
    expect(a.winnerWorker).toBe(WINNER);
    expect(reader.reads).toBe(2);
    expect(Date.now() - started).toBeLessThan(5_000);
    await tick(10);
    expect(log).toEqual({ opened: 1, closed: 1 });
  });

  it('keeps polling when the event stream fails', async () => {
    const reader = chain({ assignAfter: 3 });
    const t = eventsTransport({ opened: 0, closed: 0 }, () => {
      throw new ConnectError('events unavailable', Code.Unavailable);
    });
    const a = await makeClient(t, reader).waitForOutputTrustAnchors(TASK, { sessionId: SESSION, pollIntervalMs: 5 });
    expect(a.winnerWorker).toBe(WINNER);
    expect(reader.reads).toBe(3);
  });

  it('keeps polling when the event never arrives, and closes the stream when done', async () => {
    const reader = chain({ assignAfter: 4 });
    const log = { opened: 0, closed: 0 };
    const a = await makeClient(noEvents(log), reader).waitForOutputTrustAnchors(TASK, { sessionId: SESSION, pollIntervalMs: 5 });
    expect(a.winnerWorker).toBe(WINNER);
    expect(reader.reads).toBe(4);
    await tick(10);
    expect(log).toEqual({ opened: 1, closed: 1 });
  });

  it('does not open the event stream without a sessionId', async () => {
    const log = { opened: 0, closed: 0 };
    await makeClient(noEvents(log), chain({ assignAfter: 2 })).waitForOutputTrustAnchors(TASK, { pollIntervalMs: 5 });
    expect(log.opened).toBe(0);
  });

  it('does not retry an inactive Worker key', async () => {
    const reader = chain({ assignAfter: 2 });
    const h = hub('REVOKED');
    await expect(makeClient(noEvents({ opened: 0, closed: 0 }), reader, h).waitForOutputTrustAnchors(TASK, { pollIntervalMs: 5 }))
      .rejects.toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_WORKER_KEY_INACTIVE', retriable: false });
    await tick(30);
    expect(reader.reads).toBe(2);
    expect(h.calls.keys).toBe(1);
  });

  it('stops on a task that failed without a winner, before and after compaction', async () => {
    for (const reader of [chain({ phase: 'FAILED' }), chain({ terminal: true })]) {
      await expect(makeClient(noEvents({ opened: 0, closed: 0 }), reader).waitForOutputTrustAnchors(TASK, { pollIntervalMs: 5 }))
        .rejects.toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_NO_WINNER', retriable: false });
      expect(reader.reads).toBe(1);
    }
  });

  it('times out with the last pending reason as the cause, and closes the stream', async () => {
    const reader = chain();
    const log = { opened: 0, closed: 0 };
    const e = await makeClient(noEvents(log), reader)
      .waitForOutputTrustAnchors(TASK, { sessionId: SESSION, pollIntervalMs: 5, timeoutMs: 40 })
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ family: 'SDK_LOCAL', code: 'OUTPUT_TRUST_ANCHOR_TIMEOUT', retriable: false });
    expect((e as Error).cause).toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_PENDING' });
    expect(reader.reads).toBeGreaterThan(1);
    await tick(10);
    expect(log).toEqual({ opened: 1, closed: 1 });
  });

  it('stops on abort without waiting for the poll interval', async () => {
    const reader = chain();
    const log = { opened: 0, closed: 0 };
    const ac = new AbortController();
    const waiting = makeClient(noEvents(log), reader)
      .waitForOutputTrustAnchors(TASK, { sessionId: SESSION, pollIntervalMs: 60_000, signal: ac.signal })
      .catch((x: unknown) => x);
    await tick(50);
    ac.abort();
    expect(await waiting).toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_WAIT_ABORTED' });
    await tick(10);
    expect(log).toEqual({ opened: 1, closed: 1 });
    await expect(makeClient(noEvents(log), reader).waitForOutputTrustAnchors(TASK, { signal: ac.signal }))
      .rejects.toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_WAIT_ABORTED' });
  });

  it('rejects a bad poll interval or timeout', async () => {
    const c = makeClient(noEvents({ opened: 0, closed: 0 }), chain());
    await expect(c.waitForOutputTrustAnchors(TASK, { pollIntervalMs: 0 })).rejects.toMatchObject({ code: 'SDK_LOCAL_POLL_INTERVAL_INVALID' });
    await expect(c.waitForOutputTrustAnchors(TASK, { timeoutMs: Number.NaN })).rejects.toMatchObject({ code: 'SDK_LOCAL_TIMEOUT_INVALID' });
  });
});

/** A chain whose every task read waits until the test releases it, with or without a winner. */
function gatedChain() {
  const gates: Array<(winner: boolean) => void> = [];
  const r = {
    get reads(): number {
      return gates.length;
    },
    release(i: number, winner: boolean): void {
      gates[i]!(winner);
    },
    async queryTask(taskId: string): Promise<ChainTaskSnapshot> {
      const winner = await new Promise<boolean>((resolve) => gates.push(resolve));
      return {
        view: 'active', taskId, acceptedTaskHash: TASK_HASH, winnerWorker: winner ? WINNER : '',
        modelId: `0x${'b'.repeat(64)}`, profileVersion: 1n, orderSequence: 0n,
        acceptedInputHash: `0x${'a'.repeat(64)}`, taskPhase: 'WORKER_ASSIGNMENT_PENDING',
      };
    },
    async queryInferReceipt(): Promise<InferReceiptView | undefined> {
      throw new Error('streaming anchors never read the receipt');
    },
  };
  return r;
}

describe('waitForOutputTrustAnchors: the event read does not queue behind a read in flight', () => {
  it('starts the event read at once while an older read is still in flight, and returns its winner', async () => {
    const reader = gatedChain();
    const log = { opened: 0, closed: 0 };
    let emit!: (code: string) => void;
    const t = eventsTransport(log, (e) => { emit = e; });
    const waiting = makeClient(t, reader).waitForOutputTrustAnchors(TASK, { sessionId: SESSION, pollIntervalMs: 60_000 });
    await tick(30);
    expect(reader.reads).toBe(1);

    emit('ASSIGNMENT_FINALIZED');
    await tick(30);
    // The first read is still in flight; the event's read did not wait for it.
    expect(reader.reads).toBe(2);
    reader.release(1, true);
    const a = await waiting;
    expect(a.winnerWorker).toBe(WINNER);
    // The stale read finishing later changes nothing.
    reader.release(0, false);
    await tick(10);
    expect(reader.reads).toBe(2);
  });

  it("an older read's pending answer does not override the newer read", async () => {
    const reader = gatedChain();
    let emit!: (code: string) => void;
    const t = eventsTransport({ opened: 0, closed: 0 }, (e) => { emit = e; });
    const started = Date.now();
    const waiting = makeClient(t, reader).waitForOutputTrustAnchors(TASK, { sessionId: SESSION, pollIntervalMs: 60_000 });
    await tick(30);
    emit('ASSIGNMENT_FINALIZED');
    await tick(30);
    expect(reader.reads).toBe(2);
    // The older read says "no winner yet" first: the wait must keep waiting for the newer read,
    // not go to sleep for the poll interval.
    reader.release(0, false);
    await tick(30);
    expect(reader.reads).toBe(2);
    reader.release(1, true);
    expect((await waiting).winnerWorker).toBe(WINNER);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('an older read succeeding first still wins', async () => {
    const reader = gatedChain();
    let emit!: (code: string) => void;
    const t = eventsTransport({ opened: 0, closed: 0 }, (e) => { emit = e; });
    const waiting = makeClient(t, reader).waitForOutputTrustAnchors(TASK, { sessionId: SESSION, pollIntervalMs: 60_000 });
    await tick(30);
    emit('ASSIGNMENT_FINALIZED');
    await tick(30);
    reader.release(0, true);
    expect((await waiting).winnerWorker).toBe(WINNER);
  });

  it('abort ends the wait at once, even with a read in flight', async () => {
    const reader = gatedChain();
    const ac = new AbortController();
    const waiting = makeClient(noEvents({ opened: 0, closed: 0 }), reader)
      .waitForOutputTrustAnchors(TASK, { signal: ac.signal })
      .catch((x: unknown) => x);
    await tick(30);
    ac.abort();
    expect(await waiting).toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_WAIT_ABORTED' });
  });
});

describe('resolveOutputTrustAnchors on a task that ended', () => {
  it('is final, not pending, when the task settled or failed without a winner', async () => {
    for (const reader of [chain({ phase: 'FAILED' }), chain({ phase: 'SETTLED' }), chain({ terminal: true })]) {
      await expect(makeClient(noEvents({ opened: 0, closed: 0 }), reader).resolveOutputTrustAnchors(TASK, { withReceipt: false }))
        .rejects.toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_NO_WINNER', retriable: false });
    }
  });

  it('stays pending while the active task is still being assigned, or carries no phase', async () => {
    for (const phase of ['WORKER_ASSIGNMENT_PENDING', undefined]) {
      const reader = chain();
      const r: OutputTaskReader = {
        queryTask: async (id) => {
          const { taskPhase, ...rest } = await reader.queryTask(id);
          return phase === undefined ? rest : { ...rest, ...(taskPhase !== undefined ? { taskPhase } : {}) };
        },
        queryInferReceipt: reader.queryInferReceipt,
      };
      await expect(makeClient(noEvents({ opened: 0, closed: 0 }), r).resolveOutputTrustAnchors(TASK, { withReceipt: false }))
        .rejects.toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_PENDING', retriable: true });
    }
  });
});
