import { expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import { secp256k1 } from '@noble/curves/secp256k1';
import { TrueOpenClient, type TrueOpenClientConfig, type OutputStreamEvent } from '../../src/client';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import { DispatchResultHeaderV1Schema } from '../../src/gen/nexus/v1/dispatch_pb.js';
import { outputChunkSigningDigest, outputFinSigningDigest, OUTPUT_MMR_DOMAIN } from '../../src/output/output-commitment';
import type { OutputStreamVerifierCheckpoint } from '../../src/output/output-commitment';
import { mmrPrefixRoot } from '../../src/codec/mmr';
import { hash32Text } from '../../src/codec/hash32';
import { privateKeyTypedDataSigner } from '../../src/signer/typed-data-signer';
import { ethSecp256k1Address } from '../../src/signer/eth-secp256k1';
const chainId = 'issue21';
const rawTask = new Uint8Array(32).fill(1), rawSession = new Uint8Array(32).fill(2), taskHash = new Uint8Array(32).fill(3);
const taskId = hash32Text(rawTask), sessionId = hash32Text(rawSession);
const oldTicket = new Uint8Array(32).fill(4), newTicket = new Uint8Array(32).fill(5);
const walletKey = new Uint8Array(32).fill(6), oldKey = new Uint8Array(32).fill(7), newKey = new Uint8Array(32).fill(8);
const pub = (key: Uint8Array) => secp256k1.getPublicKey(key, true);
const worker = ethSecp256k1Address(pub(newKey), 'trueopen');
function frames(ticket: Uint8Array, key: Uint8Array, words: string[]) {
  const chunks = words.map(word => new TextEncoder().encode(word));
  const signed = chunks.map((text, index) => {
    const seq = BigInt(index), mmrRoot = mmrPrefixRoot(OUTPUT_MMR_DOMAIN, chunks, index + 1);
    return { seq, text, mmrRoot, dispatchTicketHash: ticket, workerSignature: secp256k1.sign(outputChunkSigningDigest({ chainId, taskHash, dispatchTicketHash: ticket, seq, mmrRoot }), key).toCompactRawBytes() };
  });
  const last = signed.at(-1)!;
  const fin = { finalSeq: last.seq, outputMmrRoot: last.mmrRoot, dispatchTicketHash: ticket, finishReason: 1, workerSignature: secp256k1.sign(outputFinSigningDigest({ chainId, taskHash, dispatchTicketHash: ticket, finalSeq: last.seq, outputMmrRoot: last.mmrRoot, finishReason: 1 }), key).toCompactRawBytes() };
  return { signed, fin };
}
const header = () => create(DispatchResultHeaderV1Schema, {
  taskId: rawTask,
  winnerTicket: { schemaVersion: 1, chainId, taskId: rawTask, taskHash, sessionId: rawSession, target: { operatorAddress: worker } },
  accept: { schemaVersion: 1, chainId, taskId: rawTask, taskHash, dispatchTicketHash: newTicket, member: { operatorAddress: worker } },
});
const anchors = () => ({ taskId, taskHash: hash32Text(taskHash), dispatchTicketHash: hash32Text(newTicket), winnerWorker: worker, workerServicePubKey: pub(newKey) });
function client(transport: TrueOpenClientConfig['ingressTransport'], extra: Partial<TrueOpenClientConfig> = {}) {
  return new TrueOpenClient({ chainId, userAddress: ethSecp256k1Address(pub(walletKey), 'trueopen'), wallet: privateKeyTypedDataSigner(walletKey),
    chain: { querySession: async () => { throw new Error('unused'); }, querySessionNonce: async () => ({ nextSessionNonce: 0n }), createSession: async () => { throw new Error('unused'); }, cancelOrder: async () => { throw new Error('unused'); } }, ingressTransport: transport, ...extra });
}
const params = { sessionId, taskId, taskHash: hash32Text(taskHash), dispatchTicketHash: hash32Text(oldTicket), workerServicePubKey: pub(oldKey), maxAttempts: 4 };

it('stale attempt resets text/MMR/cursor, uses the new Worker, and resumes only with its ticket', async () => {
  const requests: { rpc: string; cursor: bigint | undefined; ticket: Uint8Array | undefined }[] = [];
  const old = frames(oldTicket, oldKey, ['discard me']);
  const next = frames(newTicket, newKey, ['new first ', 'new second']);
  let subscriptions = 0, acked = 0;
  const transport = createRouterTransport(({ service }) => service(IngressAPI, {
    async *subscribeOutput(req) {
      requests.push({ rpc: 'subscribe', cursor: req.resumeAfterSeq, ticket: req.dispatchTicketHash });
      if (++subscriptions === 1) {
        yield { frame: { case: 'chunk', value: old.signed[0]! } };
        throw new ConnectError('NEXUS_INGRESS_ATTEMPT_STALE', Code.FailedPrecondition);
      }
      if (subscriptions === 2) {
        // Even if discovery delivers seq 0 alongside the header, reopen from 0 with the new ticket.
        yield { dispatchResult: header(), frame: { case: 'chunk', value: next.signed[0]! } };
        return;
      }
      yield { dispatchResult: header() };
      yield { frame: { case: 'chunk', value: next.signed[0]! } };
      throw new ConnectError('disconnected', Code.Unavailable);
    },
    async *resumeOutput(req) {
      requests.push({ rpc: 'resume', cursor: req.resumeAfterSeq, ticket: req.dispatchTicketHash });
      yield { frame: { frame: { case: 'chunk', value: next.signed[1]! } } };
      yield { frame: { frame: { case: 'fin', value: next.fin } } };
    },
    ackOutput() { acked++; return { acked: true }; },
  }));
  const checkpoints: OutputStreamVerifierCheckpoint[] = [];
  const events: OutputStreamEvent[] = [];
  let text = '';
  for await (const event of client(transport).streamOutput({ ...params, resolveDispatchResult: async () => anchors(), onCheckpoint: checkpoint => { checkpoints.push(checkpoint); } })) {
    events.push(event);
    if (event.kind === 'reset') text = '';
    if (event.kind === 'chunk') text += event.text;
  }
  expect(text).toBe('new first new second');
  expect(events.map(e => e.kind)).toEqual(['chunk', 'reset', 'chunk', 'chunk', 'fin']);
  expect(requests).toEqual([
    { rpc: 'subscribe', cursor: undefined, ticket: oldTicket },
    { rpc: 'subscribe', cursor: undefined, ticket: undefined },
    { rpc: 'subscribe', cursor: undefined, ticket: newTicket },
    { rpc: 'resume', cursor: 0n, ticket: newTicket },
  ]);
  expect(checkpoints.map(cp => [hash32Text(cp.dispatchTicketHash!), cp.mmr.leafCount])).toEqual([
    [hash32Text(oldTicket), 1n], [hash32Text(newTicket), 0n], [hash32Text(newTicket), 1n], [hash32Text(newTicket), 2n],
  ]);
  expect(acked).toBe(1);
});

it('uses chain anchors for a replacement by default and never accepts a mismatched header', async () => {
  let calls = 0, reads = 0, acked = 0;
  const next = frames(newTicket, newKey, ['chain verified']);
  const transport = createRouterTransport(({ service }) => service(IngressAPI, {
    async *subscribeOutput() {
      if (++calls === 1) throw new ConnectError('NEXUS_INGRESS_ATTEMPT_STALE', Code.FailedPrecondition);
      if (calls === 2) { yield { dispatchResult: header() }; return; }
      yield { frame: { case: 'chunk', value: next.signed[0]! } };
      yield { frame: { case: 'fin', value: next.fin } };
    }, ackOutput() { acked++; return { acked: true }; },
  }));
  const instance = client(transport, {
    taskReader: { queryTask: async () => { reads++; return { view: 'active', taskId, acceptedTaskHash: hash32Text(taskHash), dispatchTicketHash: hash32Text(newTicket), winnerWorker: worker, modelId: '', profileVersion: 1n, orderSequence: 0n }; }, queryInferReceipt: async () => undefined },
    hub: { getCurrentServiceKey: async () => ({ servicePubKey: pub(newKey), status: 'ACTIVE' }) } as never,
  });
  const events: OutputStreamEvent[] = [];
  for await (const e of instance.streamOutput(params)) events.push(e);
  expect(reads).toBe(1);
  expect(acked).toBe(1);
  expect(events.map(e => e.kind)).toEqual(['reset', 'chunk', 'fin']);

  calls = 0; acked = 0;
  await expect(async () => { for await (const _ of instance.streamOutput({ ...params, maxAttempts: 2, resolveDispatchResult: async () => ({ ...anchors(), dispatchTicketHash: hash32Text(oldTicket) }) })) {} }).rejects.toThrow('Replacement header does not match');
  expect(acked).toBe(0);
});

it('low-level SubscribeOutput and ResumeOutput reject a cursor without its attempt ticket', async () => {
  let called = false;
  const transport = createRouterTransport(({ service }) => service(IngressAPI, {
    async *subscribeOutput() { called = true; yield {}; }, async *resumeOutput() { called = true; yield {}; },
  }));
  for (const method of ['subscribeOutput', 'resumeOutput'] as const) {
    await expect(async () => { for await (const _ of client(transport).ingress[method]({ sessionId, taskId, resumeAfterSeq: 0n })) {} }).rejects.toMatchObject({ code: 'OUTPUT_STREAM_RESUME_TICKET_REQUIRED' });
  }
  expect(called).toBe(false);
});

it('streamOutput admissionWait reads chain immediately on DISPATCH_RECORDED and closes events', async () => {
  const next = frames(newTicket, newKey, ['ready']);
  let reads = 0;
  let eventSignal: AbortSignal | undefined;
  const transport = createRouterTransport(({ service }) => service(IngressAPI, {
    async *getTaskEvents(_req, context) {
      eventSignal = context.signal;
      // Wait for the first pending chain lookup before emitting the recording hint.
      while (reads === 0) await new Promise(resolve => setTimeout(resolve, 1));
      yield { eventCode: 'DISPATCH_RECORDED' };
      if (!context.signal.aborted) await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
    },
    async *subscribeOutput() {
      yield { frame: { case: 'chunk', value: next.signed[0]! } };
      yield { frame: { case: 'fin', value: next.fin } };
    }, ackOutput() { return { acked: true }; },
  }));
  const { TrueOpenError } = await import('../../src/errors/errors');
  const instance = client(transport, {
    taskReader: { queryTask: async () => { if (++reads === 1) throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_NOT_FOUND', 'not yet'); return { view: 'active', taskId, acceptedTaskHash: hash32Text(taskHash), dispatchTicketHash: hash32Text(newTicket), winnerWorker: worker, modelId: '', profileVersion: 1n, orderSequence: 0n }; }, queryInferReceipt: async () => undefined },
    hub: { getCurrentServiceKey: async () => ({ servicePubKey: pub(newKey), status: 'ACTIVE' }) } as never,
  });
  const events: OutputStreamEvent[] = [];
  for await (const e of instance.streamOutput({ sessionId, taskId, admissionWait: { pollIntervalMs: 10_000, timeoutMs: 1000 } })) events.push(e);
  expect(events.map(e => e.kind)).toEqual(['chunk', 'fin']);
  expect(reads).toBe(2);
  expect(eventSignal?.aborted).toBe(true);
});

it('rejects malformed, unrelated and still-stale replacement headers before resolving their keys', async () => {
  for (const mutation of ['session', 'task', 'worker', 'ticket', 'same']) {
    let calls = 0, resolved = false;
    const transport = createRouterTransport(({ service }) => service(IngressAPI, {
      async *subscribeOutput() {
        if (++calls === 1) throw new ConnectError('NEXUS_INGRESS_ATTEMPT_STALE', Code.FailedPrecondition);
        const h = header();
        if (mutation === 'session') h.winnerTicket!.sessionId = new Uint8Array(32);
        if (mutation === 'task') h.taskId = new Uint8Array(32);
        if (mutation === 'worker') h.accept!.member!.operatorAddress = 'wrong-worker';
        if (mutation === 'ticket') h.accept!.dispatchTicketHash = new Uint8Array(31);
        if (mutation === 'same') h.accept!.dispatchTicketHash = oldTicket;
        yield { dispatchResult: h };
      },
    }));
    const events: OutputStreamEvent[] = [];
    await expect(async () => {
      for await (const e of client(transport).streamOutput({ ...params, maxAttempts: 2, resolveDispatchResult: async () => { resolved = true; return anchors(); } })) events.push(e);
    }).rejects.toMatchObject({ code: 'DATA_OUTPUT_STREAM_RETRIES_EXHAUSTED' });
    expect(events).toEqual([]);
    expect(resolved).toBe(false);
  }
});
