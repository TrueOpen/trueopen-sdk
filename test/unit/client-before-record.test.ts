import { describe, it, expect } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import { secp256k1 } from '@noble/curves/secp256k1';
import { TrueOpenClient } from '../../src/client';
import type { OutputStreamEvent, OutputStreamSource, OutputTaskReader, StreamOutputParams } from '../../src/client';
import { DispatchResultHeaderV1Schema } from '../../src/gen/nexus/v1/dispatch_pb.js';
import type { DispatchResultHeaderV1 } from '../../src/gen/nexus/v1/dispatch_pb.js';
import { DispatchAcceptV1Schema, DispatchRecordStatusV1, DispatchTicketV1Schema } from '../../src/gen/task/v1/dispatch_pb.js';
import { SubscribeOutputResponseSchema } from '../../src/gen/nexus/v1/ingress_pb.js';
import type { SubscribeOutputResponse } from '../../src/gen/nexus/v1/ingress_pb.js';
import { dispatchAcceptDigest, dispatchResultHeaderDigest, dispatchTicketDigest } from '../../src/output/dispatch-proof';
import { OUTPUT_MMR_DOMAIN, outputChunkSigningDigest, outputFinSigningDigest } from '../../src/output/output-commitment';
import { mmrPrefixRoot } from '../../src/codec/mmr';
import { hash32Text } from '../../src/codec/hash32';
import { TrueOpenError } from '../../src/errors/errors';
import type { ServiceKeyBinding } from '../../src/types/hub';
import type { ChainTaskSnapshot } from '../../src/types/node';
import { ethSecp256k1Address } from '../../src/signer/eth-secp256k1';
import { privateKeyTypedDataSigner } from '../../src/signer/typed-data-signer';

// streamOutput({ beforeRecord }): output is delivered from the Builder-signed dispatch header
// before the chain records the dispatch, marked provisional until the chain confirms it.

const CHAIN_ID = 'trueopen-devnet-1';
const rawTask = new Uint8Array(32).fill(0xe4);
const rawSession = new Uint8Array(32).fill(0xb7);
const rawTaskHash = new Uint8Array(32).fill(0xcc);
const TASK = hash32Text(rawTask);
const SESSION = hash32Text(rawSession);
const TASK_HASH = hash32Text(rawTaskHash);
const priv = (b: number): Uint8Array => new Uint8Array(32).fill(b);
const pub = (k: Uint8Array): Uint8Array => secp256k1.getPublicKey(k, true);
const BUILDER_PRIV = priv(0x11);
const WORKER_PRIV = priv(0x22);
const OTHER_WORKER_PRIV = priv(0x33);
const STRANGER_PRIV = priv(0x44);
const WALLET_PRIV = priv(0x55);
const BUILDER = ethSecp256k1Address(pub(BUILDER_PRIV), 'trueopen');
const WORKER = ethSecp256k1Address(pub(WORKER_PRIV), 'trueopen');
const OTHER_WORKER = ethSecp256k1Address(pub(OTHER_WORKER_PRIV), 'trueopen');
const KEYS: Record<string, Uint8Array> = { [BUILDER]: pub(BUILDER_PRIV), [WORKER]: pub(WORKER_PRIV), [OTHER_WORKER]: pub(OTHER_WORKER_PRIV) };
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sign = (digest: Uint8Array, key: Uint8Array): Uint8Array => secp256k1.sign(digest, key).toCompactRawBytes();

interface AttemptOpts {
  readonly worker?: string;
  readonly workerPriv?: Uint8Array;
  readonly round?: number;
  readonly taskHash?: Uint8Array;
  readonly builderPriv?: Uint8Array;
  readonly acceptPriv?: Uint8Array;
}

/** A signed winner ticket + accept, and headers of it at any record status. */
function attempt(o: AttemptOpts = {}) {
  const worker = o.worker ?? WORKER;
  const th = o.taskHash ?? rawTaskHash;
  const h32 = (b: number): Uint8Array => new Uint8Array(32).fill(b);
  const target = { candidatePoolSnapshotId: h32(9), slot: 1, slotVersion: 1n, operatorAddress: worker };
  const ticket = create(DispatchTicketV1Schema, {
    schemaVersion: 1, chainId: CHAIN_ID, taskId: rawTask, taskHash: th, sessionId: rawSession, orderSequence: 1n,
    builderAddress: BUILDER, referenceHeight: 10n, candidatePoolSnapshotId: h32(9), vrfEpoch: 1n, vrfOutput: h32(8),
    vrfProof: new Uint8Array([1, 2]), randomnessScheme: 1, rosterHash: h32(7), handraiseRootDigest: h32(6),
    dispatchRound: o.round ?? 1, rank: 1, target, acceptDeadlineMs: 500n, inputHash: h32(5), boundChangeHeight: 10n,
    serviceAuthorizationNonce: 1n,
  });
  ticket.builderServiceSignature = sign(dispatchTicketDigest(ticket), BUILDER_PRIV);
  const ticketHash = dispatchTicketDigest(ticket);
  const accept = create(DispatchAcceptV1Schema, {
    schemaVersion: 1, chainId: CHAIN_ID, taskId: rawTask, taskHash: th, dispatchTicketHash: ticketHash,
    member: target, serviceAuthorizationNonce: 1n,
  });
  accept.serviceSignature = sign(dispatchAcceptDigest(accept), o.acceptPriv ?? o.workerPriv ?? WORKER_PRIV);
  const header = (status: DispatchRecordStatusV1, signer: { nonce: bigint; priv: Uint8Array } = { nonce: 1n, priv: o.builderPriv ?? BUILDER_PRIV }): DispatchResultHeaderV1 => {
    const h = create(DispatchResultHeaderV1Schema, { taskId: rawTask, winnerTicket: ticket, accept, recordStatus: status, serviceAuthorizationNonce: signer.nonce });
    h.builderServiceSignature = sign(dispatchResultHeaderDigest(h), signer.priv);
    return h;
  };
  return { ticketHash, ticketHex: hash32Text(ticketHash), worker, header, workerPriv: o.workerPriv ?? WORKER_PRIV };
}

/** Signed chunks for `words`, and the signed Fin after them, of one attempt. */
function output(ticket: Uint8Array, key: Uint8Array, words: string[]) {
  const texts = words.map((w) => new TextEncoder().encode(w));
  const chunks = texts.map((text, i): SubscribeOutputResponse => {
    const seq = BigInt(i);
    const mmrRoot = mmrPrefixRoot(OUTPUT_MMR_DOMAIN, texts, i + 1);
    const workerSignature = sign(outputChunkSigningDigest({ chainId: CHAIN_ID, taskHash: rawTaskHash, dispatchTicketHash: ticket, seq, mmrRoot }), key);
    return { frame: { case: 'chunk', value: { seq, text, mmrRoot, dispatchTicketHash: ticket, workerSignature, attachment: new Uint8Array(), attachmentSignature: new Uint8Array(), cumulativeGeneratedTokens: BigInt(i + 1) } } } as unknown as SubscribeOutputResponse;
  });
  const finalSeq = BigInt(texts.length - 1);
  const outputMmrRoot = mmrPrefixRoot(OUTPUT_MMR_DOMAIN, texts, texts.length);
  const workerSignature = sign(outputFinSigningDigest({ chainId: CHAIN_ID, taskHash: rawTaskHash, dispatchTicketHash: ticket, finalSeq, outputMmrRoot, finishReason: 1 }), key);
  const fin = { frame: { case: 'fin', value: { finalSeq, outputMmrRoot, dispatchTicketHash: ticket, finishReason: 1, workerSignature } } } as unknown as SubscribeOutputResponse;
  return { chunks, fin };
}

const headerMsg = (h: DispatchResultHeaderV1): SubscribeOutputResponse => create(SubscribeOutputResponseSchema, { dispatchResult: h });

/** An output source whose subscriptions the test feeds by hand. */
function liveSource() {
  type Item = { msg: SubscribeOutputResponse } | { end: true } | { error: unknown };
  const subs: { rpc: string; ticket: Uint8Array | undefined; cursor: bigint | undefined; queue: Item[]; wake?: () => void }[] = [];
  const acks: bigint[] = [];
  const open = <T>(rpc: string, p: { dispatchTicketHash?: Uint8Array; resumeAfterSeq?: bigint; signal?: AbortSignal }, wrap: (m: SubscribeOutputResponse) => T): AsyncIterable<T> => {
    const sub: (typeof subs)[number] = { rpc, ticket: p.dispatchTicketHash, cursor: p.resumeAfterSeq, queue: [] };
    subs.push(sub);
    return {
      [Symbol.asyncIterator]: () => ({
        async next(): Promise<IteratorResult<T>> {
          for (;;) {
            if (p.signal?.aborted) throw new ConnectError('aborted', Code.Canceled);
            const item = sub.queue.shift();
            if (item !== undefined) {
              if ('end' in item) return { done: true, value: undefined };
              if ('error' in item) throw item.error;
              return { done: false, value: wrap(item.msg) };
            }
            await new Promise<void>((r) => {
              sub.wake = r;
              p.signal?.addEventListener('abort', () => r(), { once: true });
            });
          }
        },
        async return(): Promise<IteratorResult<T>> {
          return { done: true, value: undefined };
        },
      }),
    };
  };
  const feed = (n: number, ...items: Item[]): void => {
    const sub = subs[n]!;
    sub.queue.push(...items);
    sub.wake?.();
  };
  const source: OutputStreamSource = {
    id: 'live',
    ingress: {
      subscribeOutput: (p: never) => open('subscribe', p, (m) => m),
      resumeOutput: (p: never) => open('resume', p, (m) => ({ frame: m })),
      async ackOutput(p: { lastSeq: bigint }) {
        acks.push(p.lastSeq);
        return { acked: true } as never;
      },
    } as unknown as OutputStreamSource['ingress'],
  };
  return { source, subs, acks, feed, send: (n: number, ...msgs: SubscribeOutputResponse[]) => feed(n, ...msgs.map((msg) => ({ msg }))) };
}

/** The chain: no task until `record(ticket, worker)`. */
function chain() {
  const state: { ticket?: string; worker?: string; reads: number } = { reads: 0 };
  const reader: OutputTaskReader = {
    async queryTask(taskId: string): Promise<ChainTaskSnapshot> {
      state.reads += 1;
      if (state.ticket === undefined) throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_NOT_FOUND', 'chain query -> HTTP 404');
      return {
        view: 'active', taskId, acceptedTaskHash: TASK_HASH, winnerWorker: state.worker!, dispatchTicketHash: state.ticket,
        modelId: `0x${'b'.repeat(64)}`, profileVersion: 1n, orderSequence: 1n, acceptedInputHash: `0x${'a'.repeat(64)}`, taskPhase: 'INFER_PENDING',
      };
    },
    async queryInferReceipt() {
      throw new Error('streaming never reads the receipt');
    },
  };
  return { reader, state, record: (ticket: string, worker: string) => { state.ticket = ticket; state.worker = worker; } };
}

const hub = {
  keyReads: 0,
  /** Bindings that replace an operator's default one (a rotated key). */
  rotated: {} as Record<string, Omit<ServiceKeyBinding, 'participantType' | 'operatorAddress' | 'serviceAddress'>>,
  getLatestHeight: async (): Promise<bigint> => 500n,
  async getCurrentServiceKey(pt: string, addr: string): Promise<ServiceKeyBinding> {
    hub.keyReads += 1;
    const rotated = hub.rotated[addr];
    if (rotated !== undefined) return { participantType: pt, operatorAddress: addr, serviceAddress: addr, ...rotated };
    const key = KEYS[addr];
    if (key === undefined) throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_NOT_FOUND', `no key for ${addr}`);
    return { participantType: pt, operatorAddress: addr, serviceAddress: addr, servicePubKey: key, status: 'ACTIVE', serviceAuthorizationNonce: 1n };
  },
};

function makeClient(reader: OutputTaskReader): TrueOpenClient {
  return new TrueOpenClient({
    chainId: CHAIN_ID, userAddress: ethSecp256k1Address(pub(WALLET_PRIV), 'trueopen'), wallet: privateKeyTypedDataSigner(WALLET_PRIV),
    signatureChainId: 424242n,
    chain: { querySession: async () => { throw new Error('unused'); }, querySessionNonce: async () => ({ nextSessionNonce: 0n }), createSession: async () => { throw new Error('unused'); }, cancelOrder: async () => { throw new Error('unused'); }, updateSessionKey: async () => { throw new Error('unused'); } },
    ingressTransport: createRouterTransport(() => {}), taskReader: reader, hub: hub as never,
  });
}

// What openTask returns, as far as beforeRecord reads it.
const openTaskResult = { taskHash: TASK_HASH, builders: [{ address: BUILDER }], earliestSubmitHeight: 100n };

function start(reader: OutputTaskReader, source: OutputStreamSource, extra: Partial<StreamOutputParams> = {}, before = true) {
  const events: OutputStreamEvent[] = [];
  const it = makeClient(reader).streamOutput({
    sessionId: SESSION, taskId: TASK, sources: [source], ...(before ? { beforeRecord: openTaskResult } : {}), admissionWait: { pollIntervalMs: 5, timeoutMs: 2000 }, ...extra,
  })[Symbol.asyncIterator]();
  let failed: unknown;
  let finished = false;
  const done = (async () => {
    try {
      for (let r = await it.next(); !r.done; r = await it.next()) events.push(r.value);
    } catch (e) {
      failed = e;
    } finally {
      finished = true;
    }
  })();
  return { events, done, state: () => ({ failed, finished }) };
}

const label = (e: OutputStreamEvent): string =>
  e.kind === 'chunk' ? `c${e.seq}${e.recorded === undefined ? '' : e.recorded ? '+' : '?'}` : e.kind === 'fin' ? 'fin' : `reset`;

describe('streamOutput beforeRecord', () => {
  it('delivers verified chunks before the record (recorded=false), then recorded=true once the chain confirms; fin only after', async () => {
    const a = attempt();
    const out = output(a.ticketHash, WORKER_PRIV, ['one ', 'two ', 'three']);
    const c = chain();
    const { source, subs, acks, send, feed } = liveSource();
    const run = start(c.reader, source);
    await tick(10);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.ticket).toBeUndefined();
    send(0, headerMsg(a.header(DispatchRecordStatusV1.PENDING)), out.chunks[0]!, out.chunks[1]!);
    await tick(20);
    // Delivered before the chain knows the task.
    expect(run.events.map(label)).toEqual(['c0?', 'c1?']);
    expect(c.state.reads).toBe(0);

    c.record(a.ticketHex, WORKER);
    send(0, headerMsg(a.header(DispatchRecordStatusV1.RECORDED)));
    await tick(30);
    expect(c.state.reads).toBeGreaterThan(0);
    send(0, out.chunks[2]!, out.fin);
    feed(0, { end: true });
    await run.done;
    expect(run.state().failed).toBeUndefined();
    expect(run.events.map(label)).toEqual(['c0?', 'c1?', 'c2+', 'fin']);
    expect(run.events.at(-1)).toMatchObject({ kind: 'fin', attested: true, finishReason: 1 });
    expect(acks).toEqual([2n]);
  });

  it('reads each signer key once per stream: a re-sent header needs no chain read', async () => {
    const a = attempt();
    const out = output(a.ticketHash, WORKER_PRIV, ['one ', 'two']);
    const c = chain();
    const { source, send, feed } = liveSource();
    const before = hub.keyReads;
    const run = start(c.reader, source);
    await tick(10);
    send(0, headerMsg(a.header(DispatchRecordStatusV1.PENDING)), out.chunks[0]!);
    await tick(20);
    // The Builder key (read when the stream starts) and the Worker key.
    expect(hub.keyReads - before).toBe(2);
    c.record(a.ticketHex, WORKER);
    send(0, headerMsg(a.header(DispatchRecordStatusV1.RECORDED)));
    await tick(30);
    send(0, out.chunks[1]!, out.fin);
    feed(0, { end: true });
    await run.done;
    expect(run.state().failed).toBeUndefined();
    expect(run.events.map(label)).toEqual(['c0?', 'c1+', 'fin']);
    // Plus the one read of the chain confirmation itself, which is never cached.
    expect(hub.keyReads - before).toBe(3);
  });

  it('re-reads a key when a re-sent header names a newer generation', async () => {
    const a = attempt();
    const out = output(a.ticketHash, WORKER_PRIV, ['one ', 'two']);
    const c = chain();
    const { source, send, feed } = liveSource();
    const run = start(c.reader, source);
    await tick(10);
    send(0, headerMsg(a.header(DispatchRecordStatusV1.PENDING)), out.chunks[0]!);
    await tick(20);
    // The Builder rotated: the RECORDED header is signed by its new key under nonce 2.
    hub.rotated[BUILDER] = { servicePubKey: pub(STRANGER_PRIV), status: 'ACTIVE', serviceAuthorizationNonce: 2n,
      previousServicePubKey: pub(BUILDER_PRIV), previousServiceAuthorizationNonce: 1n, previousRetiredHeight: 1000n };
    try {
      const reads = hub.keyReads;
      c.record(a.ticketHex, WORKER);
      send(0, headerMsg(a.header(DispatchRecordStatusV1.RECORDED, { nonce: 2n, priv: STRANGER_PRIV })));
      await tick(30);
      send(0, out.chunks[1]!, out.fin);
      feed(0, { end: true });
      await run.done;
      expect(run.state().failed).toBeUndefined();
      expect(run.events.map(label)).toEqual(['c0?', 'c1+', 'fin']);
      // Both signer keys read again after the cached ones failed, plus the confirmation's read.
      expect(hub.keyReads - reads).toBe(3);
    } finally {
      delete hub.rotated[BUILDER];
    }
  });

  it('holds a Fin that arrives before the record until the chain confirms it, and never acks before', async () => {
    const a = attempt();
    const out = output(a.ticketHash, WORKER_PRIV, ['short']);
    const c = chain();
    const { source, acks, send, feed } = liveSource();
    const run = start(c.reader, source);
    await tick(10);
    send(0, headerMsg(a.header(DispatchRecordStatusV1.PENDING)), out.chunks[0]!, out.fin);
    await tick(40);
    expect(run.events.map(label)).toEqual(['c0?']);
    expect(acks).toEqual([]);
    expect(run.state().finished).toBe(false);

    c.record(a.ticketHex, WORKER);
    send(0, headerMsg(a.header(DispatchRecordStatusV1.RECORDED)));
    feed(0, { end: true });
    await run.done;
    expect(run.state().failed).toBeUndefined();
    expect(run.events.map(label)).toEqual(['c0?', 'fin']);
    expect(acks).toEqual([0n]);
  });

  const refused: Array<[string, () => { header: DispatchResultHeaderV1; ticket: Uint8Array }, Partial<StreamOutputParams>, string]> = [
    ['a header signed by another key', () => { const a = attempt({ builderPriv: STRANGER_PRIV }); return { header: a.header(DispatchRecordStatusV1.PENDING), ticket: a.ticketHash }; }, {}, 'DispatchResultHeaderV1 Builder signature does not verify'],
    ['a Builder the order was not sent to', () => { const a = attempt(); return { header: a.header(DispatchRecordStatusV1.PENDING), ticket: a.ticketHash }; }, { beforeRecord: { ...openTaskResult, builders: [OTHER_WORKER] } }, 'is not one this order was sent to'],
    ['a ticket for another task_hash', () => { const a = attempt({ taskHash: new Uint8Array(32).fill(0xdd) }); return { header: a.header(DispatchRecordStatusV1.PENDING), ticket: a.ticketHash }; }, {}, 'does not bind this order'],
    ['an accept signed by another key', () => { const a = attempt({ acceptPriv: STRANGER_PRIV }); return { header: a.header(DispatchRecordStatusV1.PENDING), ticket: a.ticketHash }; }, {}, 'DispatchAcceptV1 Worker signature does not verify'],
  ];
  for (const [name, make, extra, why] of refused) {
    it(`refuses ${name} and delivers nothing`, async () => {
      const { header, ticket } = make();
      const out = output(ticket, WORKER_PRIV, ['never shown']);
      const c = chain();
      const { source, acks, send } = liveSource();
      const run = start(c.reader, source, { maxAttempts: 1, ...extra });
      await tick(10);
      send(0, headerMsg(header), out.chunks[0]!, out.fin);
      await run.done;
      expect(run.events).toEqual([]);
      expect(acks).toEqual([]);
      expect(run.state().failed).toMatchObject({ code: 'DATA_OUTPUT_STREAM_RETRIES_EXHAUSTED' });
      expect((run.state().failed as Error).message).toContain(why);
    });
  }

  it('refuses output that does not come after a header', async () => {
    const a = attempt();
    const out = output(a.ticketHash, WORKER_PRIV, ['x']);
    const { source, send } = liveSource();
    const run = start(chain().reader, source, { maxAttempts: 1 });
    await tick(10);
    send(0, out.chunks[0]!);
    await run.done;
    expect(run.events).toEqual([]);
    expect((run.state().failed as Error).message).toContain('DispatchResultHeaderV1 first');
  });

  it('resets to the attempt the chain records when it is not the streamed one', async () => {
    const first = attempt();
    const second = attempt({ worker: OTHER_WORKER, workerPriv: OTHER_WORKER_PRIV, round: 2 });
    const firstOut = output(first.ticketHash, WORKER_PRIV, ['provisional']);
    const secondOut = output(second.ticketHash, OTHER_WORKER_PRIV, ['final ', 'text']);
    const c = chain();
    const { source, subs, acks, send, feed } = liveSource();
    const checkpoints: string[] = [];
    const run = start(c.reader, source, { onCheckpoint: (cp) => { checkpoints.push(`${hash32Text(cp.dispatchTicketHash!)}:${cp.mmr.leafCount}`); } });
    await tick(10);
    send(0, headerMsg(first.header(DispatchRecordStatusV1.PENDING)), firstOut.chunks[0]!);
    await tick(20);
    c.record(second.ticketHex, OTHER_WORKER);
    send(0, headerMsg(first.header(DispatchRecordStatusV1.RECORDED)));
    await tick(40);
    expect(run.events.map(label)).toEqual(['c0?', 'reset']);
    expect(run.events[1]).toEqual({ kind: 'reset', previousDispatchTicketHash: first.ticketHex, dispatchTicketHash: second.ticketHex });
    // Reopened on the chain's attempt, from the start.
    expect(subs).toHaveLength(2);
    expect(subs[1]!).toMatchObject({ rpc: 'subscribe', cursor: undefined });
    expect(hash32Text(subs[1]!.ticket!)).toBe(second.ticketHex);
    send(1, headerMsg(second.header(DispatchRecordStatusV1.RECORDED)), ...secondOut.chunks, secondOut.fin);
    feed(1, { end: true });
    await run.done;
    expect(run.state().failed).toBeUndefined();
    expect(run.events.map(label)).toEqual(['c0?', 'reset', 'c0+', 'c1+', 'fin']);
    expect(acks).toEqual([1n]);
    expect(checkpoints).toEqual([`${first.ticketHex}:1`, `${second.ticketHex}:0`, `${second.ticketHex}:1`, `${second.ticketHex}:2`, `${second.ticketHex}:2`]);
  });

  it('ends with OUTPUT_RECORD_REJECTED when the Builder reports the record refused', async () => {
    const a = attempt();
    const out = output(a.ticketHash, WORKER_PRIV, ['void ', 'text']);
    const c = chain();
    const { source, acks, send, feed } = liveSource();
    const run = start(c.reader, source);
    await tick(10);
    send(0, headerMsg(a.header(DispatchRecordStatusV1.PENDING)), out.chunks[0]!, headerMsg(a.header(DispatchRecordStatusV1.REJECTED)));
    feed(0, { error: new ConnectError('RECORD_REJECTED: the chain did not record this attempt; its frames are void', Code.FailedPrecondition) });
    await run.done;
    expect(run.events.map(label)).toEqual(['c0?']);
    expect(run.state().failed).toMatchObject({ code: 'OUTPUT_RECORD_REJECTED' });
    expect(acks).toEqual([]);
  });

  it('ends at once on a REJECTED first header', async () => {
    const a = attempt();
    const { source, send } = liveSource();
    const run = start(chain().reader, source);
    await tick(10);
    send(0, headerMsg(a.header(DispatchRecordStatusV1.REJECTED)));
    await run.done;
    expect(run.events).toEqual([]);
    expect(run.state().failed).toMatchObject({ code: 'OUTPUT_RECORD_REJECTED' });
  });

  it('resumes a provisional attempt after a disconnect with its ticket and cursor', async () => {
    const a = attempt();
    const out = output(a.ticketHash, WORKER_PRIV, ['first ', 'second']);
    const c = chain();
    const { source, subs, acks, send, feed } = liveSource();
    const run = start(c.reader, source);
    await tick(10);
    send(0, headerMsg(a.header(DispatchRecordStatusV1.PENDING)), out.chunks[0]!);
    feed(0, { error: new ConnectError('connection reset', Code.Unavailable) });
    await tick(20);
    expect(subs).toHaveLength(2);
    expect(subs[1]!).toMatchObject({ rpc: 'resume', cursor: 0n });
    expect(hash32Text(subs[1]!.ticket!)).toBe(a.ticketHex);
    c.record(a.ticketHex, WORKER);
    send(1, headerMsg(a.header(DispatchRecordStatusV1.RECORDED)));
    await tick(30);
    send(1, out.chunks[1]!, out.fin);
    feed(1, { end: true });
    await run.done;
    expect(run.state().failed).toBeUndefined();
    expect(run.events.map(label)).toEqual(['c0?', 'c1+', 'fin']);
    expect(acks).toEqual([1n]);
  });

  it('follows a voided attempt to its verified replacement on the same source', async () => {
    const first = attempt();
    const second = attempt({ round: 2 });
    const firstOut = output(first.ticketHash, WORKER_PRIV, ['old']);
    const secondOut = output(second.ticketHash, WORKER_PRIV, ['new']);
    const c = chain();
    const { source, subs, acks, send, feed } = liveSource();
    const run = start(c.reader, source);
    await tick(10);
    send(0, headerMsg(first.header(DispatchRecordStatusV1.PENDING)), firstOut.chunks[0]!);
    feed(0, { error: new ConnectError('NEXUS_INGRESS_ATTEMPT_STALE: dispatch_ticket_hash is not the task\'s current attempt', Code.FailedPrecondition) });
    await tick(20);
    expect(subs).toHaveLength(2);
    expect(subs[1]!.ticket).toBeUndefined();
    send(1, headerMsg(second.header(DispatchRecordStatusV1.PENDING)));
    await tick(20);
    expect(subs).toHaveLength(3);
    expect(hash32Text(subs[2]!.ticket!)).toBe(second.ticketHex);
    send(2, headerMsg(second.header(DispatchRecordStatusV1.PENDING)), secondOut.chunks[0]!, secondOut.fin);
    await tick(20);
    expect(run.events.map(label)).toEqual(['c0?', 'reset', 'c0?']);
    // The replacement is provisional too: its Fin waits for the chain.
    expect(acks).toEqual([]);
    c.record(second.ticketHex, WORKER);
    send(2, headerMsg(second.header(DispatchRecordStatusV1.RECORDED)));
    feed(2, { end: true });
    await run.done;
    expect(run.state().failed).toBeUndefined();
    expect(run.events.map(label)).toEqual(['c0?', 'reset', 'c0?', 'fin']);
    expect(acks).toEqual([0n]);
  });

  it('treats explicit anchors as recorded and needs no header verification', async () => {
    const a = attempt();
    const out = output(a.ticketHash, WORKER_PRIV, ['given']);
    const { source, send, feed } = liveSource();
    const reads = hub.keyReads;
    const run = start(chain().reader, source, { taskHash: TASK_HASH, workerServicePubKey: pub(WORKER_PRIV), dispatchTicketHash: a.ticketHex });
    await tick(10);
    send(0, headerMsg(a.header(DispatchRecordStatusV1.PENDING)), out.chunks[0]!, out.fin);
    feed(0, { end: true });
    await run.done;
    expect(run.state().failed).toBeUndefined();
    expect(run.events.map(label)).toEqual(['c0+', 'fin']);
    expect(hub.keyReads).toBe(reads);
  });

  it('fails at the start, before subscribing, when the confirmation could not run', async () => {
    const { source, subs } = liveSource();
    const noReader = new TrueOpenClient({
      chainId: CHAIN_ID, userAddress: ethSecp256k1Address(pub(WALLET_PRIV), 'trueopen'), wallet: privateKeyTypedDataSigner(WALLET_PRIV),
      signatureChainId: 424242n,
      chain: { querySession: async () => { throw new Error('unused'); }, querySessionNonce: async () => ({ nextSessionNonce: 0n }), createSession: async () => { throw new Error('unused'); }, cancelOrder: async () => { throw new Error('unused'); }, updateSessionKey: async () => { throw new Error('unused'); } },
      ingressTransport: createRouterTransport(() => {}), hub: hub as never,
    });
    const first = (p: Partial<StreamOutputParams>, client = noReader) =>
      client.streamOutput({ sessionId: SESSION, taskId: TASK, sources: [source], beforeRecord: openTaskResult, ...p })[Symbol.asyncIterator]().next();
    await expect(first({})).rejects.toMatchObject({ code: 'SDK_LOCAL_TRUST_ANCHORS_UNCONFIGURED', message: expect.stringMatching(/taskReader/) });
    await expect(first({ admissionWait: { pollIntervalMs: 0 } }, makeClient(chain().reader))).rejects.toMatchObject({ code: 'SDK_LOCAL_POLL_INTERVAL_INVALID' });
    await expect(first({ admissionWait: { timeoutMs: -1 } }, makeClient(chain().reader))).rejects.toMatchObject({ code: 'SDK_LOCAL_TIMEOUT_INVALID' });
    expect(subs).toHaveLength(0);
  });

  it('without the option, chunks carry no recorded field', async () => {
    const a = attempt();
    const out = output(a.ticketHash, WORKER_PRIV, ['plain']);
    const { source, send, feed } = liveSource();
    const run = start(chain().reader, source, { taskHash: TASK_HASH, workerServicePubKey: pub(WORKER_PRIV), dispatchTicketHash: a.ticketHex }, false);
    await tick(10);
    send(0, out.chunks[0]!, out.fin);
    feed(0, { end: true });
    await run.done;
    expect(run.events.map(label)).toEqual(['c0', 'fin']);
    expect(run.events[0]).not.toHaveProperty('recorded');
  });
});
