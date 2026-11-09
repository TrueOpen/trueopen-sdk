import { describe, it, expect } from 'vitest';
import { createRouterTransport, ConnectError, Code } from '@connectrpc/connect';
import type { Transport } from '@connectrpc/connect';
import { IngressAPI, OpenTaskResponseSchema } from '../../src/gen/nexus/v1/ingress_pb.js';
import type { OpenTaskRequest } from '../../src/gen/nexus/v1/ingress_pb.js';
import { OpenTaskStatusV1 } from '../../src/gen/nexus/v1/dispatch_pb.js';
import { TrueOpenClient, nextRetryIdempotencyKey } from '../../src/client';
import type { OpenTaskParams } from '../../src/client';
import type { ChainClient } from '../../src/transport/chain-client';
import type { TaskOrderIntent } from '../../src/order/task-order-input';
import { defaultGenerationParams } from '../../src/order/task-order-input';
import { TASK_TYPE, DEADLINE_LATENCY_CLASS } from '../../src/order/task-order';
import type { BuilderSetSnapshot, ServiceDescriptorRef, BeaconView, ParameterBucketView } from '../../src/types/hub';
import type { ChainTaskSnapshot, StreamStateView } from '../../src/types/node';
import { deriveTaskId } from '../../src/order/order-signing';
import { decodeSignedOrder } from '../../src/order/signed-order';
import { memoryOpenTaskStore, checkSentOrderRecord } from '../../src/order/open-task-store';
import type { OpenTaskStore, SentOrderRecord } from '../../src/order/open-task-store';
import { openTaskInputForSignedOrder } from '../../src/order/build-open-task';
import { secp256k1PublicKey } from '../../src/signer/secp256k1';
import { ethSecp256k1Address } from '../../src/signer/eth-secp256k1';
import { privateKeyTypedDataSigner } from '../../src/signer/typed-data-signer';
import { fromHex, toHex } from '../../src/util/bytes';
import { hash32Text } from '../../src/codec/hash32';
import { sha256 } from '../../src/codec/hash';
import { TrueOpenError } from '../../src/errors/errors';

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const wallet = privateKeyTypedDataSigner(PRIV);
const USER = ethSecp256k1Address(secp256k1PublicKey(PRIV), 'trueopen');

const hexOf = (b: number): string => hash32Text(new Uint8Array(32).fill(b));
const amount = (atomicUnits: string) => ({ atomicUnits });
const SESSION = '0xb793a05ff8441795fca46a890b906b0c81af9d8d7a4d53e82de53a1c917b9883';
const OTHER_SESSION = hexOf(0x77);
const SET_HASH = hexOf(0x15);
const PAYLOAD = new TextEncoder().encode('trueopen-input');
const ADDRS = [
  'trueopen1yfse4c367uc2rja5g3905ynmnuv2hjk8gcgvfl',
  'trueopen1870sqtdru7dj3xgwpzcexry0dwvyz2ku7xv9mg',
  'trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man',
];
const snapshot: BuilderSetSnapshot = {
  builderSetId: 'genesis-1', builderSetVersion: 1n, effectiveHeight: 1n, builders: ADDRS.join(','), setHash: SET_HASH,
};

const order: TaskOrderIntent = {
  modelId: '0xad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b',
  profileVersion: 1,
  taskType: TASK_TYPE.TEXT_GENERATION,
  payload: PAYLOAD,
  inputBucket: 1,
  outputBudgetBucket: 1,
  generationParams: defaultGenerationParams(128n, 2_000n),
  amounts: { priceBid: amount('100000'), maxFee: amount('1000'), assignmentPriorityFee: amount('0'), txFeeReserve: amount('0') },
  earliestSubmitHeight: 1_000n,
  orderExpireHeight: 1_100n, // a 100-block lifetime
  latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
};

interface Header {
  orderEnvelope: Uint8Array;
  orderSequence: bigint;
  idempotencyKey: string;
  requestEnvelope?: { requestNonce: Uint8Array; expiryHeightOrTime: bigint };
}

/** A chain, hub, task reader and Builder transport whose state each test moves by hand. */
function world(opts: { store?: OpenTaskStore; taskReader?: boolean } = {}) {
  const state = {
    latest: 1_000n,
    nextSeq: 0n,
    /** What the next OpenTask call answers: 'ack', 'lose' (the Builder got it, the response is lost) or an error. */
    answer: 'ack' as 'ack' | 'lose' | Error,
    tasks: new Map<string, ChainTaskSnapshot>(),
    /** Runs after each OpenTask call is answered. */
    after: undefined as (() => void) | undefined,
  };
  const headers: Header[] = [];
  let nonce = 0;
  const hub = {
    getLatestHeight: async (): Promise<bigint> => state.latest,
    getBuilderSetAtHeight: async (): Promise<BuilderSetSnapshot> => snapshot,
    getBeacon: async (height: bigint): Promise<BeaconView> => ({
      height, blockHash: hexOf(0x14), randomnessHex: toHex(new Uint8Array(32).fill(1)), sourceTag: 'proposer_vrf_v1', verified: true,
    }),
    getTaskGenerationLimits: async () => ({
      maxOutputTokens: 131_072n, topKMax: 1000n, stopSequenceMaxItems: 16n,
      stopSequenceMaxBytesEach: 128n, stopSequenceMaxTotalBytes: 1024n, stopTokenMaxItems: 64n,
    }),
    getParameterBucket: async (kind: string): Promise<ParameterBucketView> => ({
      bucketKind: kind, bucketKey: 'default', version: 1n, currentVersion: 1n, effectiveHeight: 0n,
    }),
    getBusinessDenom: async (): Promise<string> => 'utrueopen',
    getProfile: async () => ({ pricing: { minOrderValue: 0n, verifyRatioBps: 0n, initialOutputPrice: 0n } }),
    getServiceDescriptor: async (id: string): Promise<ServiceDescriptorRef> => ({
      participantType: 'PARTICIPANT_TYPE_BUILDER', participantId: id, descriptorVersion: 2n,
      endpoints: [{ endpointKind: 'SERVICE_ENDPOINT_KIND_NEXUS_GRPC', uri: `grpc://${id}:8080`, protocolVersion: 'v1' }],
      descriptorHash: hexOf(0xaa), updatedHeight: 1n,
    }),
  } as never;
  const chain: ChainClient = {
    async querySession(id): Promise<StreamStateView> {
      return {
        boundBuilder: ADDRS[0]!, sessionId: id, owner: USER, nextExpectedSequence: state.nextSeq, lastActiveHeight: 0n,
        openPendingCount: 0n, status: 'ACTIVE', sessionKeyExpiryHeight: 0n, sessionKeySpendCap: '0', sessionKeySpent: '0', sessionKeySetHeight: 0n,
      } as StreamStateView;
    },
    async querySessionNonce() { return { nextSessionNonce: 0n }; },
    async createSession() { throw new Error('unused'); },
    async cancelOrder() { throw new Error('unused'); },
    async updateSessionKey() { throw new Error('unused'); },
  };
  const transport: Transport = createRouterTransport(({ service }) => {
    service(IngressAPI, {
      async openTask(reqs: AsyncIterable<OpenTaskRequest>) {
        for await (const f of reqs) if (f.frame.case === 'header') headers.push(f.frame.value as unknown as Header);
        const answer = state.answer;
        state.after?.();
        if (answer === 'lose') throw new ConnectError('connection reset', Code.Unavailable);
        if (answer instanceof Error) throw answer;
        return { taskId: '', accepted: true, reason: '', sessionId: SESSION };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });
  const queried: string[] = [];
  const client = new TrueOpenClient({
    chainId: 'trueopen-localnet-1', userAddress: USER, wallet, chain, ingressTransport: transport, hub,
    ingressTransportFactory: () => transport,
    nonce: () => new Uint8Array(32).fill(1 + (nonce++ % 250)),
    signatureChainId: 424242n, feeDenom: 'utrueopen',
    ...(opts.taskReader === false
      ? {}
      : {
          taskReader: {
            queryTask: async (id: string) => {
              queried.push(id);
              const t = state.tasks.get(id);
              if (t === undefined) throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_NOT_FOUND', 'not found');
              return t;
            },
            queryInferReceipt: async () => undefined,
          },
        }),
    ...(opts.store !== undefined ? { openTaskStore: opts.store } : {}),
  });
  /** The chain admits an order with `taskHash` at `seq`. */
  const record = (seq: bigint, taskHash: string): void => {
    const taskId = deriveTaskId(SESSION, seq);
    state.tasks.set(taskId, { view: 'active', taskId, acceptedTaskHash: taskHash, winnerWorker: USER, orderSequence: seq } as ChainTaskSnapshot);
    state.nextSeq = seq + 1n;
  };
  return { client, state, headers, record, queried };
}

const PARAMS: OpenTaskParams = { sessionId: SESSION, order, idempotencyKey: 'order-1' };

/** The record the client's store holds for `key`. */
function spyStore(): OpenTaskStore & { records: Map<string, SentOrderRecord>; sets: SentOrderRecord[] } {
  const records = new Map<string, SentOrderRecord>();
  const sets: SentOrderRecord[] = [];
  return {
    records,
    sets,
    get: async (key) => records.get(key),
    set: async (key, r) => {
      sets.push(r);
      records.set(key, JSON.parse(JSON.stringify(r)) as SentOrderRecord);
    },
  };
}

describe('openTask retries under the same idempotency key (issue #7)', () => {
  it('lost response, retried before the chain records it: the same SignedOrderV2 bytes under a new envelope nonce', async () => {
    const w = world();
    w.state.answer = 'lose';
    await expect(w.client.openTask(PARAMS)).rejects.toBeDefined();
    expect(w.headers).toHaveLength(1);
    // A block passes: a re-signed order would anchor at 1001 and get a new task_hash.
    w.state.latest = 1_001n;
    w.state.answer = 'ack';
    const res = await w.client.openTask(PARAMS);
    expect(w.headers).toHaveLength(2);
    const [first, again] = w.headers as [Header, Header];
    expect(toHex(again.orderEnvelope)).toBe(toHex(first.orderEnvelope));
    expect(toHex(again.requestEnvelope!.requestNonce)).not.toBe(toHex(first.requestEnvelope!.requestNonce));
    // The envelope expiry counts from the current head.
    expect(again.requestEnvelope!.expiryHeightOrTime).toBe(1_011n);
    expect(again.idempotencyKey).toBe('order-1');
    const signed = decodeSignedOrder(first.orderEnvelope).order!;
    expect(res.taskId).toBe(deriveTaskId(SESSION, 0n));
    expect(res.orderSequence).toBe(0n);
    expect(res.earliestSubmitHeight).toBe(1_000n);
    expect(signed.earliestSubmitHeight).toBe(1_000n);
    expect(res.accepted).toBe(true);
    expect(res.endpointsTried).toBe(1);
    // Same task_hash as the first attempt's record; retryParams are the first attempt's.
    const fresh = await w.client.openTask({ ...PARAMS, idempotencyKey: 'other' });
    expect(fresh.taskHash).not.toBe(res.taskHash); // anchored at 1001: what a re-sign would have sent
    expect(res.retryParams.idempotencyKey).toBe('order-1#retry1');
    expect(res.retryParams.orderSequence).toBe(0n);
    expect(res.retryParams.orderWindow).toEqual({ earliestSubmitBlocks: 0n, orderExpireBlocks: 100n });
  });

  it('the first attempt reached the chain, the response was lost: no OpenTask sent, the recorded order returned, never N+1', async () => {
    const w = world();
    w.state.answer = 'lose';
    await expect(w.client.openTask(PARAMS)).rejects.toBeDefined();
    const sent = decodeSignedOrder(w.headers[0]!.orderEnvelope).order!;
    expect(sent.orderSequence).toBe(0n);
    w.headers.length = 0;
    // The chain admitted it (the response never came back); next_expected_sequence is now 1.
    const store = (w.client as unknown as { openTaskStore: OpenTaskStore }).openTaskStore;
    const rec = (await store.get('order-1'))!;
    w.record(0n, rec.taskHash);
    w.state.answer = 'ack';
    const res = await w.client.openTask(PARAMS); // no orderSequence: would have read 1
    expect(w.headers).toHaveLength(0);
    expect(res).toMatchObject({
      accepted: true, status: OpenTaskStatusV1.RECORDED, boundBuilder: ADDRS[0], taskId: deriveTaskId(SESSION, 0n),
      taskHash: rec.taskHash, orderSequence: 0n, endpointsTried: 0, builders: [], unresolvedBuilders: [],
      earliestSubmitHeight: 1_000n, orderExpireHeight: 1_100n, maxFee: 1000n, feeDenom: 'utrueopen', orderSignedBy: 'wallet',
    });
    expect(res.retryParams.idempotencyKey).toBe('order-1#retry1');
    expect(w.queried).toEqual([deriveTaskId(SESSION, 0n)]);
  });

  it('the recorded sequence went to another task_hash: SDK_LOCAL_IDEMPOTENCY_SEQUENCE_CONSUMED', async () => {
    const w = world();
    w.state.answer = 'lose';
    await expect(w.client.openTask(PARAMS)).rejects.toBeDefined();
    w.headers.length = 0;
    w.record(0n, hexOf(0xee));
    await expect(w.client.openTask(PARAMS)).rejects.toMatchObject({
      code: 'SDK_LOCAL_IDEMPOTENCY_SEQUENCE_CONSUMED', category: 'conflict', details: { orderSequence: 0n, taskHash: hexOf(0xee) },
    });
    expect(w.headers).toHaveLength(0);
  });

  it('a sequence consumed without a task (a cancel) is consumed too; without a taskReader the SDK refuses to guess', async () => {
    const w = world();
    w.state.answer = 'lose';
    await expect(w.client.openTask(PARAMS)).rejects.toBeDefined();
    w.state.nextSeq = 1n;
    await expect(w.client.openTask(PARAMS)).rejects.toMatchObject({ code: 'SDK_LOCAL_IDEMPOTENCY_SEQUENCE_CONSUMED', details: { taskHash: undefined } });

    const n = world({ taskReader: false });
    n.state.answer = 'lose';
    await expect(n.client.openTask(PARAMS)).rejects.toBeDefined();
    n.state.nextSeq = 1n;
    await expect(n.client.openTask(PARAMS)).rejects.toMatchObject({ code: 'SDK_LOCAL_TRUST_ANCHORS_UNCONFIGURED', family: 'SDK_LOCAL' });
    expect(n.headers).toHaveLength(1);
  });

  it('the same key with another payload, session or orderSequence: SDK_LOCAL_IDEMPOTENCY_KEY_REUSED, nothing sent', async () => {
    const w = world();
    await w.client.openTask(PARAMS);
    expect(w.headers).toHaveLength(1);
    const reused = { code: 'SDK_LOCAL_IDEMPOTENCY_KEY_REUSED', category: 'conflict' };
    await expect(w.client.openTask({ ...PARAMS, order: { ...order, payload: new TextEncoder().encode('trueopen-input ') } })).rejects.toMatchObject(reused);
    await expect(w.client.openTask({ ...PARAMS, sessionId: OTHER_SESSION })).rejects.toMatchObject(reused);
    await expect(w.client.openTask({ ...PARAMS, orderSequence: 1n })).rejects.toMatchObject(reused);
    expect(w.headers).toHaveLength(1);
    // The recorded sequence given explicitly is the same order.
    await w.client.openTask({ ...PARAMS, orderSequence: 0n });
    expect(w.headers).toHaveLength(2);
  });

  it('the recorded order expired unrecorded: SDK_LOCAL_ORDER_EXPIRED pointing at retryParams', async () => {
    const w = world();
    w.state.answer = 'lose';
    await expect(w.client.openTask(PARAMS)).rejects.toBeDefined();
    w.state.latest = 1_101n; // past order_expire_height 1100
    w.state.answer = 'ack';
    const err = (await w.client.openTask(PARAMS).catch((e: unknown) => e)) as TrueOpenError;
    expect(err).toMatchObject({ code: 'SDK_LOCAL_ORDER_EXPIRED', details: { orderExpireHeight: 1_100n, latestHeight: 1_101n } });
    expect(err.userAction).toMatch(/retryParams/);
    expect(w.headers).toHaveLength(1);
    // At the expiry height itself it is still resent.
    w.state.latest = 1_100n;
    await w.client.openTask(PARAMS);
    expect(w.headers).toHaveLength(2);
  });

  it('a custom store gets the record before the first byte is sent; the record is plain JSON', async () => {
    const store = spyStore();
    const w = world({ store });
    const origSet = store.set;
    store.set = async (k, r) => {
      expect(w.headers).toHaveLength(0);
      await origSet(k, r);
    };
    const res = await w.client.openTask(PARAMS);
    expect(store.records.has('order-1')).toBe(true);
    const rec = store.records.get('order-1')!;
    expect(checkSentOrderRecord('order-1', rec)).toBe(rec);
    expect(rec).toMatchObject({
      version: 1, idempotencyKey: 'order-1', sessionId: SESSION, userAddress: USER, orderSequence: '0',
      taskId: res.taskId, taskHash: res.taskHash, signedOrderHex: toHex(w.headers[0]!.orderEnvelope),
      inputHash: hash32Text(sha256(PAYLOAD)), inputSizeBytes: String(PAYLOAD.length),
      inputMediaType: 'application/octet-stream', earliestSubmitHeight: '1000', orderExpireHeight: '1100', maxFee: '1000',
      feeDenom: 'utrueopen', orderSignedBy: 'wallet',
      context: { sessionAnchorHeight: '1000', latestHeight: '1000', builderSetHash: SET_HASH, timeoutBucketVersion: '1' },
    });
    // A second client on the same store (another process) resends the same bytes.
    const w2 = world({ store });
    await w2.client.openTask(PARAMS);
    expect(toHex(w2.headers[0]!.orderEnvelope)).toBe(toHex(w.headers[0]!.orderEnvelope));
  });

  it('a failing store write sends nothing and leaves the key free', async () => {
    let fail = true;
    const inner = memoryOpenTaskStore();
    const w = world({
      store: {
        get: (k) => inner.get(k),
        set: (k, r) => {
          if (fail) throw new Error('disk full');
          return inner.set(k, r);
        },
      },
    });
    await expect(w.client.openTask(PARAMS)).rejects.toMatchObject({ code: 'SDK_LOCAL_OPEN_TASK_STORE_FAILED' });
    expect(w.headers).toHaveLength(0);
    fail = false;
    await w.client.openTask(PARAMS);
    expect(w.headers).toHaveLength(1);
  });

  it('a malformed stored record is refused, not resent', async () => {
    const w = world({ store: { get: () => ({ version: 2 }) as never, set: () => undefined } });
    await expect(w.client.openTask(PARAMS)).rejects.toMatchObject({ code: 'SDK_LOCAL_OPEN_TASK_RECORD_INVALID' });
    expect(w.headers).toHaveLength(0);
  });

  it('a recovery re-sign updates the record, so an exact retry resends the latest version; retryParams is a new order', async () => {
    const store = spyStore();
    const w = world({ store });
    w.state.answer = new ConnectError('NEXUS_INGRESS_DISPATCH_NOT_READY: wait', Code.FailedPrecondition, undefined, [
      { desc: OpenTaskResponseSchema, value: { dispatchAvailableHeight: 1_001n } },
    ]);
    // The Builder becomes ready at 1001; recovery polls the height, then re-signs on a fresh context.
    w.state.after = () => {
      w.state.latest = 1_001n;
      w.state.answer = 'ack';
      w.state.after = undefined;
    };
    const result = await w.client.openTaskWithRecovery(PARAMS, { maxAttempts: 3, maxPolls: 3, pollIntervalMs: 0 });
    expect(result.accepted).toBe(true);
    expect(w.headers).toHaveLength(2);
    expect(toHex(w.headers[1]!.orderEnvelope)).not.toBe(toHex(w.headers[0]!.orderEnvelope));
    expect(store.sets).toHaveLength(2);
    const latest = store.records.get('order-1')!;
    expect(latest.signedOrderHex).toBe(toHex(w.headers[1]!.orderEnvelope));
    expect(latest.earliestSubmitHeight).toBe('1001');
    expect((result as { taskHash: string }).taskHash).toBe(latest.taskHash);

    // An exact retry resends the latest version.
    const again = await w.client.openTask(PARAMS);
    expect(toHex(w.headers[2]!.orderEnvelope)).toBe(latest.signedOrderHex);
    expect(again.taskHash).toBe(latest.taskHash);

    // retryParams carry a new key: a new, re-signed order with its own record.
    expect(again.retryParams.idempotencyKey).toBe(nextRetryIdempotencyKey('order-1'));
    w.state.latest = 1_002n;
    const retried = await w.client.openTask(again.retryParams);
    expect(retried.taskHash).not.toBe(again.taskHash);
    expect(retried.orderSequence).toBe(0n);
    expect(store.records.get('order-1#retry1')!.taskHash).toBe(retried.taskHash);
    expect(store.records.get('order-1')!.taskHash).toBe(latest.taskHash);
  });

  it('openTaskWithRecovery with a recorded key returns the recorded order once the chain has it', async () => {
    const w = world();
    w.state.answer = 'lose';
    await expect(w.client.openTask(PARAMS)).rejects.toBeDefined();
    const rec = (await (w.client as unknown as { openTaskStore: OpenTaskStore }).openTaskStore.get('order-1'))!;
    w.record(0n, rec.taskHash);
    w.headers.length = 0;
    const res = await w.client.openTaskWithRecovery(PARAMS, { maxAttempts: 2, maxPolls: 1, pollIntervalMs: 0 });
    expect(res).toMatchObject({ accepted: true, status: OpenTaskStatusV1.RECORDED, taskHash: rec.taskHash, orderSequence: 0n });
    expect(w.headers).toHaveLength(0);
    w.record(0n, hexOf(0xee));
    await expect(w.client.openTaskWithRecovery(PARAMS, { maxAttempts: 2, maxPolls: 1, pollIntervalMs: 0 }))
      .rejects.toMatchObject({ code: 'SDK_LOCAL_IDEMPOTENCY_SEQUENCE_CONSUMED' });
  });
});

describe('openTaskInputForSignedOrder', () => {
  it('builds the same OpenTask as buildOpenTaskRequest from the signed bytes', async () => {
    const w = world();
    const res = await w.client.openTask(PARAMS);
    const bytes = w.headers[0]!.orderEnvelope;
    const common = {
      payload: PAYLOAD, sessionId: SESSION, taskId: res.taskId, expiryHeight: 1_010n,
      requestNonce: new Uint8Array(32).fill(1), idempotencyKey: 'order-1', wallet, chainId: 'trueopen-localnet-1',
    };
    const out = await openTaskInputForSignedOrder({ ...common, signedOrder: bytes, taskHash: res.taskHash });
    expect(out.orderEnvelopeHex).toBe(toHex(bytes));
    expect(out.taskHash).toBe(res.taskHash);
    expect(out.input.orderSequence).toBe(0n);
    // The first send used nonce 1 too, so its envelope signature matches byte for byte.
    expect(toHex(out.input.requestEnvelope.signature)).toBe(toHex((w.headers[0]!.requestEnvelope as unknown as { signature: Uint8Array }).signature));
    await expect(openTaskInputForSignedOrder({ ...common, signedOrder: bytes, taskHash: res.taskHash, taskId: deriveTaskId(SESSION, 1n) }))
      .rejects.toMatchObject({ code: 'SDK_LOCAL_OPEN_TASK_ID_NOT_DERIVED' });
    await expect(openTaskInputForSignedOrder({ ...common, signedOrder: Uint8Array.of(0xff, 0xff), taskHash: res.taskHash }))
      .rejects.toMatchObject({ code: 'SDK_LOCAL_SIGNED_ORDER_INVALID' });
  });
});
