import { describe, it, expect } from 'vitest';
import { createRouterTransport, ConnectError, Code } from '@connectrpc/connect';
import type { HandlerContext, Transport } from '@connectrpc/connect';
import { secp256k1 } from '@noble/curves/secp256k1';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import type { SubscribeOutputResponse } from '../../src/gen/nexus/v1/ingress_pb.js';
import { TrueOpenClient } from '../../src/client';
import type { OutputStreamEvent, OutputStreamSource, OutputTaskReader, StreamOutputParams } from '../../src/client';
import { MAX_OVERFLOW_RESUBSCRIBES } from '../../src/client';
import type { OutputStreamVerifierCheckpoint } from '../../src/output/output-commitment';
import type { ChainClient } from '../../src/transport/chain-client';
import type { ChainTaskSnapshot, InferReceiptView } from '../../src/types/node';
import type { ServiceKeyBinding } from '../../src/types/hub';
import { secp256k1PublicKey } from '../../src/signer/secp256k1';
import { ethSecp256k1Address } from '../../src/signer/eth-secp256k1';
import { privateKeyTypedDataSigner } from '../../src/signer/typed-data-signer';
import { mmrPrefixRoot } from '../../src/codec/mmr';
import { OUTPUT_MMR_DOMAIN, outputChunkSigningDigest, outputFinSigningDigest } from '../../src/output/output-commitment';
import { fromHex } from '../../src/util/bytes';

// Early subscribe: SubscribeOutput opens before the trust anchors are known; frames are held
// unverified and only released once the anchors arrive and each frame verifies.

const CHAIN_ID = 'trueopen-devnet-1';
const SESSION = '0xb793a05ff8441795fca46a890b906b0c81af9d8d7a4d53e82de53a1c917b9883';
const TASK = `0x${'e4'.repeat(32)}`;
const TASK_HASH = `0x${'c'.repeat(64)}`;
const WINNER = 'trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man';
const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const WORKER_PRIV = fromHex('0302030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const WORKER_PUB = secp256k1PublicKey(WORKER_PRIV);
const OTHER_PRIV = fromHex('0402030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const anchors = { taskHash: TASK_HASH, workerServicePubKey: WORKER_PUB };

/** Frames for `n` chunks, each signed by `signer` over the prefix root, plus a signed Fin. */
function frames(n: number, signer = WORKER_PRIV): SubscribeOutputResponse[] {
  const chunks = Array.from({ length: n }, (_, i) => new TextEncoder().encode(`t${i} `));
  const th = fromHex(TASK_HASH.slice(2));
  const out = chunks.map((text, i) => {
    const mmrRoot = mmrPrefixRoot(OUTPUT_MMR_DOMAIN, chunks, i + 1);
    const workerSignature = secp256k1.sign(outputChunkSigningDigest({ chainId: CHAIN_ID, taskHash: th, seq: BigInt(i), mmrRoot }), signer).toCompactRawBytes();
    return {
      frame: {
        case: 'chunk',
        value: { seq: BigInt(i), text, mmrRoot, workerSignature, attachment: new Uint8Array(), attachmentSignature: new Uint8Array() },
      },
    } as unknown as SubscribeOutputResponse;
  });
  const finalSeq = BigInt(n - 1);
  const outputMmrRoot = mmrPrefixRoot(OUTPUT_MMR_DOMAIN, chunks, n);
  const finSig = secp256k1
    .sign(outputFinSigningDigest({ chainId: CHAIN_ID, taskHash: th, finalSeq, outputMmrRoot, finishReason: 1 }), signer)
    .toCompactRawBytes();
  out.push({ frame: { case: 'fin', value: { finalSeq, outputMmrRoot, finishReason: 1, workerSignature: finSig } } } as unknown as SubscribeOutputResponse);
  return out;
}

const seqOf = (f: SubscribeOutputResponse): bigint | undefined => (f.frame.case === 'chunk' ? f.frame.value.seq : undefined);

interface Subscription {
  readonly resumeAfterSeq: bigint | undefined;
  readonly signal: AbortSignal;
  pulled: number;
}

/**
 * An output source scripted per subscription. `script(n, resumeAfterSeq)` returns the
 * frames for the n-th subscription (0-based) and how it ends: `hang` (stays open until
 * aborted), `end`, or an error. Every `next()` the client makes is counted in `pulled`.
 */
function scriptedSource(
  script: (n: number, resumeAfterSeq: bigint | undefined) => { frames: SubscribeOutputResponse[]; then?: 'hang' | 'end' | Error },
) {
  const subs: Subscription[] = [];
  const acks: bigint[] = [];
  const source: OutputStreamSource = {
    id: 'scripted',
    ingress: {
      subscribeOutput(p: { resumeAfterSeq?: bigint; signal?: AbortSignal }) {
        const sub: Subscription = { resumeAfterSeq: p.resumeAfterSeq, signal: p.signal!, pulled: 0 };
        const n = subs.length;
        subs.push(sub);
        const { frames: fs, then = 'hang' } = script(n, p.resumeAfterSeq);
        const queue = fs.filter((f) => p.resumeAfterSeq === undefined || seqOf(f) === undefined || seqOf(f)! > p.resumeAfterSeq);
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<SubscribeOutputResponse>> {
                sub.pulled += 1;
                if (sub.signal.aborted) throw new ConnectError('aborted', Code.Canceled);
                const f = queue.shift();
                if (f !== undefined) return { done: false, value: f };
                if (then === 'end') return { done: true, value: undefined };
                if (then instanceof Error) throw then;
                await new Promise<void>((r) => sub.signal.addEventListener('abort', () => r(), { once: true }));
                throw new ConnectError('aborted', Code.Canceled);
              },
              async return(): Promise<IteratorResult<SubscribeOutputResponse>> {
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
      async ackOutput(p: { lastSeq: bigint }) {
        acks.push(p.lastSeq);
        return { acked: true, alreadyAcked: false, ackedAt: 1n } as never;
      },
    } as unknown as OutputStreamSource['ingress'],
  };
  return { source, subs, acks };
}

const fakeChain: ChainClient = {
  querySession: async () => { throw new Error('unused'); },
  querySessionNonce: async () => ({ nextSessionNonce: 0n }),
  createSession: async () => { throw new Error('unused'); },
  cancelOrder: async () => { throw new Error('unused'); },
  updateSessionKey: async () => { throw new Error('unused'); },
};

/** A chain whose task gets its winner after `assignAfter` reads (never by default), or that failed. */
function chain(opts: { assignAfter?: number; failed?: boolean } = {}) {
  const r = {
    reads: 0,
    async queryTask(taskId: string): Promise<ChainTaskSnapshot> {
      r.reads += 1;
      const winner = opts.assignAfter !== undefined && r.reads >= opts.assignAfter ? WINNER : '';
      return {
        view: 'active', taskId, acceptedTaskHash: TASK_HASH, winnerWorker: winner,
        modelId: `0x${'b'.repeat(64)}`, profileVersion: 1n, orderSequence: 0n,
        acceptedInputHash: `0x${'a'.repeat(64)}`, taskPhase: opts.failed ? 'FAILED' : 'WORKER_ASSIGNMENT_PENDING',
      };
    },
    async queryInferReceipt(): Promise<InferReceiptView | undefined> {
      throw new Error('streaming never reads the receipt');
    },
  };
  return r satisfies OutputTaskReader;
}

const hub = {
  getLatestHeight: async (): Promise<bigint> => 500n,
  getCurrentServiceKey: async (pt: string, addr: string): Promise<ServiceKeyBinding> => ({
    participantType: pt, operatorAddress: addr, serviceAddress: addr, servicePubKey: WORKER_PUB, status: 'ACTIVE', serviceAuthorizationNonce: 0n,
  }),
};

/** A default ingress whose event stream stays silent until aborted. */
function silentEvents(): Transport {
  return createRouterTransport(({ service }) => {
    service(IngressAPI, {
      async *getTaskEvents(_req: unknown, ctx: HandlerContext) {
        await new Promise<void>((r) => ctx.signal.addEventListener('abort', () => r(), { once: true }));
        yield* [];
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });
}

function makeClient(reader: OutputTaskReader = chain()): TrueOpenClient {
  return new TrueOpenClient({
    chainId: CHAIN_ID, userAddress: ethSecp256k1Address(secp256k1PublicKey(PRIV), 'trueopen'),
    wallet: privateKeyTypedDataSigner(PRIV), signatureChainId: 424242n,
    chain: fakeChain, ingressTransport: silentEvents(), taskReader: reader, hub: hub as never,
    nonce: () => new Uint8Array(32).fill(1), expiry: () => 1893456000000n,
  });
}

async function collect(it: AsyncIterable<OutputStreamEvent>): Promise<OutputStreamEvent[]> {
  const out: OutputStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function stream(client: TrueOpenClient, p: Omit<StreamOutputParams, 'sessionId' | 'taskId'>): AsyncIterable<OutputStreamEvent> {
  return client.streamOutput({ sessionId: SESSION, taskId: TASK, ...p });
}

describe('streamOutput early subscribe', () => {
  it('subscribes before the anchors, holds every frame (Fin included) until they arrive, then verifies and delivers in order', async () => {
    const { source, subs, acks } = scriptedSource(() => ({ frames: frames(3), then: 'end' }));
    const pending = deferred<typeof anchors>();
    const checkpoints: bigint[] = [];
    const it = stream(makeClient(), {
      sources: [source], pendingAnchors: pending.promise,
      onCheckpoint: (c) => { checkpoints.push(c.mmr.leafCount); },
    })[Symbol.asyncIterator]();
    const first = it.next();
    await tick(30);

    // Subscribed at once and read all of it, Fin included, but nothing went out.
    expect(subs).toHaveLength(1);
    expect(subs[0]!.resumeAfterSeq).toBeUndefined();
    expect(subs[0]!.pulled).toBe(4);
    await expect(Promise.race([first, tick(20).then(() => 'held')])).resolves.toBe('held');
    expect(checkpoints).toEqual([]);
    expect(acks).toEqual([]);

    pending.resolve(anchors);
    const events: OutputStreamEvent[] = [(await first).value as OutputStreamEvent];
    for (let r = await it.next(); !r.done; r = await it.next()) events.push(r.value);
    expect(events.map((e) => (e.kind === 'chunk' ? `c${e.seq}` : 'fin'))).toEqual(['c0', 'c1', 'c2', 'fin']);
    expect(events.at(-1)).toMatchObject({ kind: 'fin', attested: true });
    expect(checkpoints).toEqual([1n, 2n, 3n]);
    // Acked once, after the verified Fin.
    expect(acks).toEqual([2n]);
    expect(subs).toHaveLength(1);
  });

  it('runs held frames through the same verification: a frame the winner did not sign is never delivered', async () => {
    const { source } = scriptedSource(() => ({ frames: frames(2, OTHER_PRIV), then: 'end' }));
    const delivered: OutputStreamEvent[] = [];
    const err = await (async () => {
      for await (const e of stream(makeClient(), { sources: [source], pendingAnchors: Promise.resolve(anchors), maxAttempts: 1 })) delivered.push(e);
    })().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'DATA_OUTPUT_STREAM_RETRIES_EXHAUSTED' });
    expect(String((err as Error).message)).toContain('signature invalid');
    expect(delivered).toEqual([]);
  });

  it('bounds the read-ahead by not pulling the subscription, then reads on once the anchors arrive', async () => {
    const { source, subs } = scriptedSource(() => ({ frames: frames(10), then: 'end' }));
    const pending = deferred<typeof anchors>();
    const done = collect(stream(makeClient(), { sources: [source], pendingAnchors: pending.promise, maxPendingFrames: 3 }));
    await tick(30);
    expect(subs[0]!.pulled).toBe(3);
    pending.resolve(anchors);
    const events = await done;
    expect(events.filter((e) => e.kind === 'chunk')).toHaveLength(10);
    expect(events.at(-1)?.kind).toBe('fin');
  });

  it('resubscribes after the last verified frame when nexus drops the slow subscriber (ResourceExhausted), without using up an attempt', async () => {
    const all = frames(8);
    const { source, subs } = scriptedSource((n) =>
      n === 0
        ? { frames: all.slice(0, 5), then: new ConnectError('NEXUS_OUTPUT_SUBSCRIBER_OVERFLOW: subscriber buffer full', Code.ResourceExhausted) }
        : { frames: all, then: 'end' },
    );
    const pending = deferred<typeof anchors>();
    const done = collect(stream(makeClient(), { sources: [source], pendingAnchors: pending.promise, maxPendingFrames: 2, maxAttempts: 1 }));
    await tick(30);
    expect(subs[0]!.pulled).toBe(2);
    pending.resolve(anchors);
    const events = await done;
    expect(events.filter((e) => e.kind === 'chunk').map((e) => (e.kind === 'chunk' ? e.seq : -1n))).toEqual([0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n]);
    expect(subs.map((s) => s.resumeAfterSeq)).toEqual([undefined, 4n]);
  });

  it('a ResourceExhausted with no new verified frame still counts as a failed attempt', async () => {
    const { source, subs } = scriptedSource(() => ({ frames: [], then: new ConnectError('busy', Code.ResourceExhausted) }));
    await expect(collect(stream(makeClient(), { sources: [source], pendingAnchors: Promise.resolve(anchors), maxAttempts: 2 })))
      .rejects.toMatchObject({ code: 'DATA_OUTPUT_STREAM_RETRIES_EXHAUSTED' });
    expect(subs).toHaveLength(2);
  });

  it('closes the subscription and throws the anchor error when the task ends without a winner', async () => {
    const reader = chain({ failed: true });
    const { source, subs } = scriptedSource(() => ({ frames: frames(2).slice(0, 1) }));
    await expect(collect(stream(makeClient(reader), { sources: [source], waitForAnchors: { pollIntervalMs: 5 } })))
      .rejects.toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_NO_WINNER' });
    expect(subs).toHaveLength(1);
    expect(subs[0]!.signal.aborted).toBe(true);
  });

  it('closes the subscription and throws a timeout or a rejected pendingAnchors as is', async () => {
    const t = scriptedSource(() => ({ frames: [] }));
    await expect(collect(stream(makeClient(chain()), { sources: [t.source], waitForAnchors: { pollIntervalMs: 5, timeoutMs: 30 } })))
      .rejects.toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_TIMEOUT' });
    expect(t.subs[0]!.signal.aborted).toBe(true);

    const r = scriptedSource(() => ({ frames: frames(1) }));
    const boom = new Error('caller wait failed');
    await expect(collect(stream(makeClient(), { sources: [r.source], pendingAnchors: Promise.reject(boom) }))).rejects.toBe(boom);
    expect(r.subs[0]!.signal.aborted).toBe(true);
  });

  it('waits for the anchors with the chain (waitForAnchors: true) and then streams', async () => {
    const reader = chain({ assignAfter: 3 });
    const { source, subs } = scriptedSource(() => ({ frames: frames(2), then: 'end' }));
    const events = await collect(stream(makeClient(reader), { sources: [source], waitForAnchors: { sessionId: SESSION, pollIntervalMs: 5 } }));
    expect(events.map((e) => e.kind)).toEqual(['chunk', 'chunk', 'fin']);
    expect(reader.reads).toBe(3);
    expect(subs).toHaveLength(1);
  });

  it('aborting the signal before the anchors closes the subscription and the anchor wait', async () => {
    const reader = chain();
    const { source, subs } = scriptedSource(() => ({ frames: [] }));
    const ac = new AbortController();
    const done = collect(stream(makeClient(reader), { sources: [source], waitForAnchors: { pollIntervalMs: 5 }, signal: ac.signal })).catch((e: unknown) => e);
    await tick(30);
    ac.abort();
    expect(await done).toMatchObject({ code: 'OUTPUT_STREAM_ABORTED' });
    expect(subs[0]!.signal.aborted).toBe(true);
    const reads = reader.reads;
    await tick(30);
    expect(reader.reads).toBe(reads);
  });

  it('aborting the signal mid-stream closes the subscription', async () => {
    const all = frames(3);
    const { source, subs } = scriptedSource(() => ({ frames: all.slice(0, 2) }));
    const ac = new AbortController();
    const got: OutputStreamEvent[] = [];
    const err = await (async () => {
      for await (const e of stream(makeClient(), { sources: [source], pendingAnchors: Promise.resolve(anchors), signal: ac.signal })) {
        got.push(e);
        if (got.length === 2) setTimeout(() => ac.abort(), 5);
      }
    })().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'OUTPUT_STREAM_ABORTED' });
    expect(got).toHaveLength(2);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.signal.aborted).toBe(true);
  });

  it('a subscription error before the anchors is a normal failed attempt, retried once the anchors are known', async () => {
    const { source, subs } = scriptedSource((n) =>
      n === 0 ? { frames: [], then: new ConnectError('down', Code.Unavailable) } : { frames: frames(2), then: 'end' },
    );
    const pending = deferred<typeof anchors>();
    const done = collect(stream(makeClient(), { sources: [source], pendingAnchors: pending.promise, maxAttempts: 2 }));
    await tick(30);
    // No second subscription while the anchors are pending.
    expect(subs).toHaveLength(1);
    pending.resolve(anchors);
    const events = await done;
    expect(events.map((e) => e.kind)).toEqual(['chunk', 'chunk', 'fin']);
    expect(subs).toHaveLength(2);
  });

  it('explicit anchors keep the old path: no wait, no early subscribe', async () => {
    const reader = chain();
    const { source } = scriptedSource(() => ({ frames: frames(1), then: 'end' }));
    const events = await collect(stream(makeClient(reader), { sources: [source], ...anchors, waitForAnchors: true }));
    expect(events.map((e) => e.kind)).toEqual(['chunk', 'fin']);
    expect(reader.reads).toBe(0);
  });

  it('rejects a bad maxPendingFrames', async () => {
    await expect(collect(stream(makeClient(), { pendingAnchors: Promise.resolve(anchors), maxPendingFrames: 0 })))
      .rejects.toMatchObject({ code: 'OUTPUT_STREAM_PENDING_FRAMES_INVALID' });
  });

  it('resumes from a checkpoint in early mode: the cursor comes from the checkpoint before the anchors arrive', async () => {
    let checkpoint: OutputStreamVerifierCheckpoint | undefined;
    const first = scriptedSource(() => ({ frames: frames(3).slice(0, 2), then: 'end' }));
    await expect(collect(stream(makeClient(), { sources: [first.source], ...anchors, maxAttempts: 1, onCheckpoint: (c) => { checkpoint = c; } })))
      .rejects.toMatchObject({ code: 'DATA_OUTPUT_STREAM_RETRIES_EXHAUSTED' });
    expect(checkpoint?.mmr.leafCount).toBe(2n);

    const { source, subs, acks } = scriptedSource(() => ({ frames: frames(3), then: 'end' }));
    const pending = deferred<typeof anchors>();
    const done = collect(stream(makeClient(), { sources: [source], pendingAnchors: pending.promise, checkpoint: checkpoint!, resumeAfterSeq: 1n }));
    await tick(30);
    expect(subs[0]!.resumeAfterSeq).toBe(1n);
    pending.resolve(anchors);
    const events = await done;
    expect(events.map((e) => (e.kind === 'chunk' ? `c${e.seq}` : 'fin'))).toEqual(['c2', 'fin']);
    expect(acks).toEqual([2n]);

    // A cursor that disagrees with the checkpoint is refused before subscribing.
    const none = scriptedSource(() => ({ frames: [] }));
    await expect(collect(stream(makeClient(), { sources: [none.source], pendingAnchors: pending.promise, checkpoint: checkpoint!, resumeAfterSeq: 0n })))
      .rejects.toMatchObject({ code: 'OUTPUT_STREAM_RESUME_CURSOR_MISMATCH' });
    expect(none.subs).toHaveLength(0);
  });

  it('held duplicates are re-verified and delivered once', async () => {
    const all = frames(3);
    const { source, subs } = scriptedSource(() => ({ frames: [all[0]!, all[1]!, all[0]!, all[1]!, all[2]!, all[3]!], then: 'end' }));
    const pending = deferred<typeof anchors>();
    const done = collect(stream(makeClient(), { sources: [source], pendingAnchors: pending.promise }));
    await tick(30);
    expect(subs[0]!.pulled).toBe(6);
    pending.resolve(anchors);
    expect((await done).map((e) => (e.kind === 'chunk' ? `c${e.seq}` : 'fin'))).toEqual(['c0', 'c1', 'c2', 'fin']);
  });

  it('a held frame with an attachment fails once checked, after the frames before it', async () => {
    const all = frames(3);
    const c1 = all[1]!.frame.value as Record<string, unknown>;
    const bad = { frame: { case: 'chunk', value: { ...c1, attachment: new Uint8Array([1]) } } } as unknown as SubscribeOutputResponse;
    const { source } = scriptedSource(() => ({ frames: [all[0]!, bad, all[2]!, all[3]!], then: 'end' }));
    const got: OutputStreamEvent[] = [];
    const err = await (async () => {
      for await (const e of stream(makeClient(), { sources: [source], pendingAnchors: Promise.resolve(anchors), maxAttempts: 1 })) got.push(e);
    })().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'DATA_OUTPUT_STREAM_RETRIES_EXHAUSTED' });
    expect(String((err as Error).message)).toContain('attachment');
    expect(got.map((e) => (e.kind === 'chunk' ? e.seq : -1n))).toEqual([0n]);
  });

  it('resubscribes on ResourceExhausted with progress without early subscribe too', async () => {
    const all = frames(6);
    const { source, subs } = scriptedSource((n) =>
      n === 0 ? { frames: all.slice(0, 3), then: new ConnectError('overflow', Code.ResourceExhausted) } : { frames: all, then: 'end' },
    );
    const events = await collect(stream(makeClient(), { sources: [source], ...anchors, maxAttempts: 1 }));
    expect(events.filter((e) => e.kind === 'chunk')).toHaveLength(6);
    expect(subs.map((s) => s.resumeAfterSeq)).toEqual([undefined, 2n]);
  });

  it(`caps the free resubscribes at ${MAX_OVERFLOW_RESUBSCRIBES}, then counts them as failed attempts`, async () => {
    const all = frames(MAX_OVERFLOW_RESUBSCRIBES + 5);
    // Every subscription delivers one new frame and is then dropped.
    const { source, subs } = scriptedSource((_n, after) => {
      const start = after === undefined ? 0 : Number(after) + 1;
      return { frames: all.slice(start, start + 1), then: new ConnectError('overflow', Code.ResourceExhausted) };
    });
    await expect(collect(stream(makeClient(), { sources: [source], ...anchors, maxAttempts: 1 })))
      .rejects.toMatchObject({ code: 'DATA_OUTPUT_STREAM_RETRIES_EXHAUSTED' });
    expect(subs).toHaveLength(MAX_OVERFLOW_RESUBSCRIBES + 1);
  });

  it('an explicit taskHash wins over what pendingAnchors resolves to', async () => {
    const { source } = scriptedSource(() => ({ frames: frames(2), then: 'end' }));
    const wrong = { taskHash: `0x${'d'.repeat(64)}`, workerServicePubKey: WORKER_PUB };
    const events = await collect(stream(makeClient(), { sources: [source], taskHash: TASK_HASH, pendingAnchors: Promise.resolve(wrong) }));
    expect(events.map((e) => e.kind)).toEqual(['chunk', 'chunk', 'fin']);
  });

  it('waitForAnchors reads the event hint from the first source when it can serve task events', async () => {
    const reader = chain({ assignAfter: 2 });
    const { source } = scriptedSource(() => ({ frames: frames(1), then: 'end' }));
    let hinted = 0;
    const withEvents: OutputStreamSource = {
      id: 'with-events',
      ingress: {
        ...source.ingress,
        subscribeOutput: source.ingress.subscribeOutput.bind(source.ingress),
        ackOutput: source.ingress.ackOutput.bind(source.ingress),
        async *getTaskEvents() {
          hinted += 1;
          await tick(30);
          yield { cursor: '1', state: '', taskPhase: '', eventCode: 'ASSIGNMENT_FINALIZED', chainHeight: 0n };
        },
      } as unknown as OutputStreamSource['ingress'],
    };
    const started = Date.now();
    // The default ingress never emits: only the source's hint can beat the 60 s poll.
    const events = await collect(stream(makeClient(reader), { sources: [withEvents], waitForAnchors: { sessionId: SESSION, pollIntervalMs: 60_000 } }));
    expect(events.map((e) => e.kind)).toEqual(['chunk', 'fin']);
    expect(hinted).toBe(1);
    expect(reader.reads).toBe(2);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
