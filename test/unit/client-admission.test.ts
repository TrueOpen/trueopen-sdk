import { describe, it, expect } from 'vitest';
import { createRouterTransport, ConnectError, Code } from '@connectrpc/connect';
import type { HandlerContext, Transport } from '@connectrpc/connect';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import type { GetTaskEventsRequest, OpenTaskHeader, OpenTaskRequest } from '../../src/gen/nexus/v1/ingress_pb.js';
import { TrueOpenClient, nextRetryIdempotencyKey } from '../../src/client';
import type { FacadeHubReader, OpenTaskParams, OpenTaskResult, OutputTaskReader } from '../../src/client';
import type { ChainClient } from '../../src/transport/chain-client';
import type { ChainTaskSnapshot, InferReceiptView, StreamStateView } from '../../src/types/node';
import type { TaskOrderIntent, TaskOrderChainContext } from '../../src/order/task-order-input';
import { buildTaskOrder, defaultGenerationParams } from '../../src/order/task-order-input';
import { TASK_TYPE, DEADLINE_LATENCY_CLASS } from '../../src/order/task-order';
import { decodeSignedOrder, taskOrderEip712Digest } from '../../src/order/signed-order';
import { sdkRequestEip712Digest } from '../../src/transport/sdk-request-envelope';
import type { BuilderSetSnapshot, ServiceDescriptorRef, BeaconView, ParameterBucketView } from '../../src/types/hub';
import { secp256k1PublicKey } from '../../src/signer/secp256k1';
import { ethSecp256k1Address, ethAddressBytes, recoverEip712PubKey } from '../../src/signer/eth-secp256k1';
import { privateKeyTypedDataSigner } from '../../src/signer/typed-data-signer';
import type { TypedData } from '../../src/signer/typed-data-signer';
import { generateSessionKey, sessionKeyFromPrivateKey } from '../../src/session/registered-session-key';
import { TrueOpenError } from '../../src/errors/errors';
import { fromHex, toHex } from '../../src/util/bytes';
import { hash32Text } from '../../src/codec/hash32';

// Minimal pieces copied from client-session-key.test.ts and client-wait-anchors.test.ts.

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const USER = ethSecp256k1Address(secp256k1PublicKey(PRIV), 'trueopen');
const USER_ADDRESS_HEX = toHex(ethAddressBytes(secp256k1PublicKey(PRIV)));
const EVM = 424242n;
const ORDER_EIP712 = { signatureChainId: EVM, feeDenom: 'utrueopen' };

const hexOf = (b: number): string => hash32Text(new Uint8Array(32).fill(b));
const SESSION = '0xb793a05ff8441795fca46a890b906b0c81af9d8d7a4d53e82de53a1c917b9883';
const SET_HASH = hexOf(0x15);
const ANCHOR_HASH = hexOf(0x14);
const ADDRS = [
  'trueopen1yfse4c367uc2rja5g3905ynmnuv2hjk8gcgvfl',
  'trueopen1870sqtdru7dj3xgwpzcexry0dwvyz2ku7xv9mg',
  'trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man',
];
const snapshot: BuilderSetSnapshot = {
  builderSetId: 'genesis-1', builderSetVersion: 1n, effectiveHeight: 1n, builders: ADDRS.join(','), setHash: SET_HASH,
};
const MAX_FEE = 1_000_000n;

const intent: TaskOrderIntent = {
  modelId: '0xad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b',
  profileVersion: 1,
  taskType: TASK_TYPE.TEXT_GENERATION,
  payload: new TextEncoder().encode('trueopen-input'),
  inputBucket: 1,
  outputBudgetBucket: 1,
  generationParams: defaultGenerationParams(128n, 2_000n),
  amounts: {
    priceBid: { atomicUnits: '100000' }, maxFee: { atomicUnits: MAX_FEE.toString() },
    assignmentPriorityFee: { atomicUnits: '0' }, txFeeReserve: { atomicUnits: '0' },
  },
  earliestSubmitHeight: 1_000n,
  orderExpireHeight: 51_000n,
  latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
};
const PRICING = { minOrderValue: 0n, verifyRatioBps: 0n, initialOutputPrice: 0n };

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeHub(state: { latest: bigint }): FacadeHubReader {
  const hub = {
    getLatestHeight: async (): Promise<bigint> => state.latest,
    getBuilderSetAtHeight: async (): Promise<BuilderSetSnapshot> => snapshot,
    getBeacon: async (height: bigint): Promise<BeaconView> =>
      ({ height, blockHash: ANCHOR_HASH, randomnessHex: toHex(new Uint8Array(32).fill(0x01)), sourceTag: 'proposer_vrf_v1', verified: true }),
    getTaskGenerationLimits: async () => ({
      maxOutputTokens: 131_072n, topKMax: 1000n, stopSequenceMaxItems: 16n,
      stopSequenceMaxBytesEach: 128n, stopSequenceMaxTotalBytes: 1024n, stopTokenMaxItems: 64n,
    }),
    getParameterBucket: async (kind: string): Promise<ParameterBucketView> => ({
      bucketKind: kind, bucketKey: 'default', version: 1n, currentVersion: 1n, effectiveHeight: 0n,
    }),
    getBusinessDenom: async (): Promise<string> => 'utrueopen',
    getProfile: async () => ({ pricing: PRICING }),
    getAnchorFreshnessWindowBlocks: async (): Promise<bigint> => 100n,
    getServiceDescriptor: async (id: string): Promise<ServiceDescriptorRef> => ({
      participantType: 'PARTICIPANT_TYPE_BUILDER', participantId: id, descriptorVersion: 2n,
      endpoints: [{ endpointKind: 'SERVICE_ENDPOINT_KIND_NEXUS_GRPC', uri: `grpc://${id}:8080`, protocolVersion: 'v1' }],
      descriptorHash: hexOf(0xaa), updatedHeight: 1n,
    }),
    getMaxSessionKeyBlocks: async (): Promise<bigint> => 100n,
  };
  return hub as unknown as FacadeHubReader;
}

class FakeChain implements ChainClient {
  stream: StreamStateView = {
    sessionId: SESSION, owner: USER, nextExpectedSequence: 7n, lastActiveHeight: 0n, openPendingCount: 0n, status: 'ACTIVE',
    sessionKeyExpiryHeight: 0n, sessionKeySpendCap: '0', sessionKeySpent: '0', sessionKeySetHeight: 0n,
  };
  sessionReads = 0;
  /** Runs on each session read (e.g. the order landing between the task read and this one). */
  onSessionRead: (() => void) | undefined;
  async querySession(id: string): Promise<StreamStateView> {
    this.sessionReads += 1;
    this.onSessionRead?.();
    return { ...this.stream, sessionId: id };
  }
  async querySessionNonce() { return { nextSessionNonce: 0n }; }
  async createSession(): Promise<never> { throw new Error('unused'); }
  async updateSessionKey(): Promise<never> { throw new Error('unused'); }
  async cancelOrder(): Promise<never> { throw new Error('unused'); }
}

/** QueryTask: 404 until `task` is set. */
function taskReader() {
  const r = {
    reads: 0,
    taskHash: undefined as string | undefined,
    /** When true, each read waits until the test calls release(). */
    hold: false,
    held: [] as Array<() => void>,
    release(): void {
      r.held.shift()?.();
    },
    async queryTask(taskId: string): Promise<ChainTaskSnapshot> {
      r.reads += 1;
      if (r.hold) await new Promise<void>((resolve) => r.held.push(resolve));
      if (r.taskHash === undefined) throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_NOT_FOUND', `task ${taskId}: HTTP 404`);
      return {
        view: 'active', taskId, acceptedTaskHash: r.taskHash, winnerWorker: '',
        modelId: intent.modelId, profileVersion: 1n, orderSequence: 7n,
        acceptedInputHash: hexOf(0xaa), taskPhase: 'WORKER_ASSIGNMENT_PENDING',
      };
    },
    async queryInferReceipt(): Promise<InferReceiptView | undefined> {
      throw new Error('unused');
    },
  };
  return r satisfies OutputTaskReader;
}

/** Every Builder accepts OpenTask and keeps its GetTaskEvents stream open until the client aborts it. */
class Builders {
  headers: OpenTaskHeader[] = [];
  opened = 0;
  closed = 0;
  /** Builder address -> what its open event streams emit. */
  private readonly listeners = new Map<string, Set<(code: string) => void>>();
  /** Builders whose event stream fails at once. */
  readonly failing = new Set<string>();
  /** Refuse a GetTaskEvents not signed by the wallet, as Nexus does once the key changed. */
  refuseKeySigned = false;
  refused = 0;

  emit(address: string, code: string): void {
    for (const l of this.listeners.get(address) ?? []) l(code);
  }

  transport(serviceEndpoint: string): Transport {
    const address = ADDRS.find((a) => serviceEndpoint.includes(a))!;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return createRouterTransport(({ service }) => {
      service(IngressAPI, {
        async openTask(reqs: AsyncIterable<OpenTaskRequest>) {
          for await (const f of reqs) if (f.frame.case === 'header') self.headers.push(f.frame.value);
          return { taskId: '', accepted: true, reason: '', sessionId: SESSION };
        },
        async *getTaskEvents(req: GetTaskEventsRequest, ctx: HandlerContext) {
          if (self.failing.has(address)) throw new Error('events unavailable');
          if (self.refuseKeySigned && envelopeSigner(req.requestEnvelope!) !== USER_ADDRESS_HEX) {
            self.refused += 1;
            throw new ConnectError('SDK_AUTH_INVALID_SIGNATURE', Code.Unauthenticated);
          }
          self.opened += 1;
          // Counted on the signal itself (a stream the client aborts before this ran counts too).
          if (ctx.signal.aborted) self.closed += 1;
          else ctx.signal.addEventListener('abort', () => { self.closed += 1; }, { once: true });
          const queue: string[] = [];
          let notify: (() => void) | undefined;
          const l = (code: string): void => { queue.push(code); notify?.(); };
          let set = self.listeners.get(address);
          if (set === undefined) self.listeners.set(address, (set = new Set()));
          set.add(l);
          try {
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
          } finally {
            set.delete(l);
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    });
  }
}

/** What a request envelope's signature recovers to (no grant is configured in these tests). */
function envelopeSigner(env: NonNullable<GetTaskEventsRequest['requestEnvelope']>): string {
  const digest = sdkRequestEip712Digest(
    { chainId: env.chainId, method: env.method, sessionId: env.sessionId, taskId: env.taskId, requestNonce: env.requestNonce, expiryHeightOrTime: env.expiryHeightOrTime, bodyDigest: env.bodyDigest },
    EVM,
  );
  return toHex(ethAddressBytes(recoverEip712PubKey(digest, env.signature)));
}

function setup() {
  const hubState = { latest: 1_000n };
  const chain = new FakeChain();
  const reader = taskReader();
  const builders = new Builders();
  const prompts: TypedData[] = [];
  const inner = privateKeyTypedDataSigner(PRIV);
  const wallet = { signTypedData: async (d: TypedData) => { prompts.push(d); return inner.signTypedData(d); } };
  const client = new TrueOpenClient({
    chainId: 'trueopen-localnet-1', userAddress: USER, wallet, chain,
    ingressTransport: builders.transport(ADDRS[0]!), hub: makeHub(hubState),
    ingressTransportFactory: (uri) => builders.transport(uri),
    taskReader: reader,
    nonce: () => new Uint8Array(32).fill(1),
    signatureChainId: EVM, feeDenom: 'utrueopen',
  });
  return { client, chain, hubState, reader, builders, prompts };
}

function context(latestHeight: bigint, anchorHeight: bigint): TaskOrderChainContext {
  return {
    chainId: 'trueopen-localnet-1', sessionAnchorHeight: anchorHeight, sessionAnchorBlockHash: ANCHOR_HASH,
    builderSetId: 'genesis-1', builderSetHash: SET_HASH, timeoutBucketVersion: 1n,
    generationLimits: {
      maxOutputTokens: 131_072n, topKMax: 1000n, stopSequenceMaxItems: 16n,
      stopSequenceMaxBytesEach: 128n, stopSequenceMaxTotalBytes: 1024n, stopTokenMaxItems: 64n,
    },
    latestHeight,
  };
}

const BASE: OpenTaskParams = {
  sessionId: SESSION, order: intent, idempotencyKey: 'k', pricing: PRICING,
  context: context(1_000n, 1_000n), expiryHeight: 1_010n,
};

/** Loads a registered key on the client and registers it on the fake chain (set at height 990). */
async function withKey(s: ReturnType<typeof setup>): Promise<Uint8Array> {
  const m = generateSessionKey();
  s.chain.stream = { ...s.chain.stream, sessionKey: m.address, sessionKeyExpiryHeight: 1_100n, sessionKeySpendCap: '0', sessionKeySetHeight: 990n };
  await s.client.useSessionKey(SESSION, m.privateKey);
  return m.address;
}

const rejectAll = (b: Builders, res: OpenTaskResult, code = 'ASSIGN_REJECTED'): void => {
  for (const x of res.builders) b.emit(x.address, code);
};

describe('openTask result: sequence, signer, max fee and retry params', () => {
  it('records the order and derives a same-sequence retry with a new idempotency key', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    expect(res.orderSequence).toBe(7n);
    expect(res.orderSignedBy).toBe('wallet');
    expect(res.orderSignerAddress).toBeUndefined();
    expect(res.maxFee).toBe(MAX_FEE);
    expect(res.context.sessionAnchorHeight).toBe(1_000n);
    const r = res.retryParams;
    expect(r.orderSequence).toBe(7n);
    expect(r.idempotencyKey).toBe('k#retry1');
    expect('context' in r).toBe(false);
    expect('expiryHeight' in r).toBe(false);
    expect(r.order).toBe(BASE.order);
    expect(r.order.payload).toBe(intent.payload);
    expect(r.pricing).toBe(PRICING);

    // A retry's own retry counts up.
    const res2 = await s.client.openTask({ ...r, context: context(1_000n, 1_000n) });
    expect(res2.orderSequence).toBe(7n);
    expect(res2.retryParams.idempotencyKey).toBe('k#retry2');
  });

  it('nextRetryIdempotencyKey', () => {
    expect(nextRetryIdempotencyKey('k')).toBe('k#retry1');
    expect(nextRetryIdempotencyKey('k#retry1')).toBe('k#retry2');
    expect(nextRetryIdempotencyKey('k#retry9')).toBe('k#retry10');
    expect(nextRetryIdempotencyKey('a#retry2#retry41')).toBe('a#retry2#retry42');
    expect(nextRetryIdempotencyKey('k#retry0')).toBe('k#retry0#retry1');
    expect(nextRetryIdempotencyKey('k#retry')).toBe('k#retry#retry1');
  });

  it('a key-signed order records the key address, never its private key', async () => {
    const s = setup();
    const addr = await withKey(s);
    const res = await s.client.openTask(BASE);
    expect(res.orderSignedBy).toBe('session-key');
    expect(toHex(res.orderSignerAddress!)).toBe(toHex(addr));
    expect(s.prompts).toHaveLength(0);
  });
});

describe("openTask orderSigner: 'wallet'", () => {
  it('the wallet signs the order and the envelope with a key loaded, and no key precheck runs', async () => {
    const s = setup();
    await withKey(s);
    // The key was cleared on chain: 'auto' refuses before signing, 'wallet' does not even look.
    const { sessionKey: _, ...rest } = s.chain.stream;
    void _;
    s.chain.stream = { ...rest, sessionKeyExpiryHeight: 0n, sessionKeySpendCap: '0', sessionKeySetHeight: 0n };
    await expect(s.client.openTask(BASE)).rejects.toMatchObject({ code: 'SDK_LOCAL_SESSION_KEY_NOT_REGISTERED' });
    s.chain.sessionReads = 0;
    const res = await s.client.openTask({ ...BASE, orderSequence: 7n, orderSigner: 'wallet' });
    expect(s.chain.sessionReads).toBe(0);
    expect(res.orderSignedBy).toBe('wallet');
    expect(res.orderSignerAddress).toBeUndefined();
    expect(s.builders.headers).toHaveLength(3);
    const header = s.builders.headers[0]!;
    const order = buildTaskOrder(res.context, { ...intent, userAddress: USER, sessionId: SESSION, orderSequence: 7n }, PRICING);
    const sig = decodeSignedOrder(header.orderEnvelope).userSignature;
    expect(toHex(ethAddressBytes(recoverEip712PubKey(taskOrderEip712Digest(order, ORDER_EIP712), sig)))).toBe(USER_ADDRESS_HEX);
    const env = header.requestEnvelope!;
    const envDigest = sdkRequestEip712Digest(
      { chainId: env.chainId, method: env.method, sessionId: env.sessionId, taskId: env.taskId, requestNonce: env.requestNonce, expiryHeightOrTime: env.expiryHeightOrTime, bodyDigest: env.bodyDigest },
      EVM,
    );
    expect(toHex(ethAddressBytes(recoverEip712PubKey(envDigest, env.signature)))).toBe(USER_ADDRESS_HEX);
    expect(env.sessionGrant).toBeUndefined();
    expect(s.prompts).toHaveLength(2);
    // The retry keeps the choice.
    expect(res.retryParams.orderSigner).toBe('wallet');
  });

  it('refuses an unknown orderSigner', async () => {
    const s = setup();
    await expect(s.client.openTask({ ...BASE, orderSigner: 'key' as never })).rejects.toMatchObject({ code: 'SDK_LOCAL_ORDER_SIGNER_INVALID' });
  });
});

describe('waitForAdmission', () => {
  it('accepted: the chain has the task with this task_hash', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    s.reader.taskHash = res.taskHash;
    expect(await s.client.waitForAdmission(res, { pollIntervalMs: 5 })).toEqual({ kind: 'accepted', taskId: res.taskId });
    await tick(10);
    expect(s.builders.opened).toBe(3);
    expect(s.builders.closed).toBe(3);
  });

  it('accepted by polling once the task lands', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 5, timeoutMs: 10_000 });
    await tick(50);
    s.reader.taskHash = res.taskHash;
    expect(await waiting).toEqual({ kind: 'accepted', taskId: res.taskId });
    expect(s.reader.reads).toBeGreaterThan(1);
  });

  it('accepted through ASSIGNMENT_FINALIZED long before the next poll', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    const started = Date.now();
    const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 60_000 });
    await tick(50);
    expect(s.reader.reads).toBe(1);
    s.reader.taskHash = res.taskHash;
    s.builders.emit(res.builders[1]!.address, 'ASSIGNMENT_FINALIZED');
    expect(await waiting).toEqual({ kind: 'accepted', taskId: res.taskId });
    expect(s.reader.reads).toBe(2);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('WORKER_HANDRAISES_ACCEPTED also triggers a read', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 60_000 });
    await tick(50);
    s.reader.taskHash = res.taskHash;
    s.builders.emit(res.builders[0]!.address, 'WORKER_HANDRAISES_ACCEPTED');
    expect(await waiting).toMatchObject({ kind: 'accepted' });
  });

  it('superseded: the chain task for task_id has another task_hash', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    s.reader.taskHash = hexOf(0x77);
    expect(await s.client.waitForAdmission(res, { pollIntervalMs: 5 }))
      .toEqual({ kind: 'superseded', taskId: res.taskId, chainTaskHash: hexOf(0x77) });
  });

  it('accepted even when every Builder reported a rejection: the chain wins', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 60_000 });
    await tick(50);
    s.reader.taskHash = res.taskHash;
    rejectAll(s.builders, res);
    expect(await waiting).toMatchObject({ kind: 'accepted' });
  });

  it('one Builder rejecting while the others are silent is not a rejection: it times out', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    s.chain.sessionReads = 0;
    const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 5, timeoutMs: 300 });
    await tick(50);
    expect(s.builders.opened).toBe(3);
    s.builders.emit(res.builders[0]!.address, 'ASSIGN_REJECTED');
    s.builders.emit(res.builders[1]!.address, 'ASSIGN_TIMEOUT');
    expect(await waiting).toEqual({ kind: 'timeout', taskId: res.taskId });
    expect(s.chain.sessionReads).toBe(0);
    await tick(10);
    expect(s.builders.closed).toBe(3);
  });

  it('a Builder whose event stream fails never reports, so the wait times out', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    s.builders.failing.add(res.builders[2]!.address);
    const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 5, timeoutMs: 300 });
    await tick(50);
    expect(s.builders.opened).toBe(2);
    s.builders.emit(res.builders[0]!.address, 'ASSIGN_REJECTED');
    s.builders.emit(res.builders[1]!.address, 'ASSIGN_REJECTED');
    expect(await waiting).toMatchObject({ kind: 'timeout' });
  });

  it('rejected once every acked Builder reported and a later chain read shows no task (wallet order: unrelated)', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 60_000 });
    await tick(50);
    const readsBefore = s.reader.reads;
    rejectAll(s.builders, res);
    const out = await waiting;
    expect(s.reader.reads).toBeGreaterThan(readsBefore);
    expect(out.kind).toBe('rejected');
    if (out.kind !== 'rejected') return;
    expect(out.diagnosis.reason).toBe('unrelated');
    expect(out.diagnosis.sequenceFree).toBe(true);
    expect(out.diagnosis.session.nextExpectedSequence).toBe(7n);
    expect(out.diagnosis.events.map((e) => e.eventCode)).toEqual(['ASSIGN_REJECTED', 'ASSIGN_REJECTED', 'ASSIGN_REJECTED']);
    expect(new Set(out.diagnosis.events.map((e) => e.builderAddress))).toEqual(new Set(res.builders.map((b) => b.address)));
    expect(out.retry).toBe(res.retryParams);
    expect(out.retry.orderSequence).toBe(7n);
    expect(out.retry.idempotencyKey).toBe('k#retry1');
    await tick(10);
    expect(s.builders.closed).toBe(3);
  });

  it('only the Builders that acked count', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    const [a, b, c] = res.builders;
    const partial: OpenTaskResult = {
      ...res,
      builders: [a!, b!, { ...c!, ack: { ...c!.ack!, accepted: false } }],
    };
    const waiting = s.client.waitForAdmission(partial, { pollIntervalMs: 60_000 });
    await tick(50);
    expect(s.builders.opened).toBe(2);
    s.builders.emit(a!.address, 'ASSIGN_REJECTED');
    s.builders.emit(b!.address, 'ASSIGN_TIMEOUT');
    expect(await waiting).toMatchObject({ kind: 'rejected' });
  });

  it('sequence no longer free and no task (e.g. MsgCancelOrder): rejected, retry without orderSequence', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    s.chain.stream = { ...s.chain.stream, nextExpectedSequence: 8n };
    const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 60_000 });
    await tick(50);
    rejectAll(s.builders, res);
    const out = await waiting;
    expect(out.kind).toBe('rejected');
    if (out.kind !== 'rejected') return;
    expect(out.diagnosis.sequenceFree).toBe(false);
    expect('orderSequence' in out.retry).toBe(false);
    expect(out.retry.idempotencyKey).toBe('k#retry1');
    // The result's own retryParams are untouched.
    expect(res.retryParams.orderSequence).toBe(7n);
  });

  describe('diagnosis of a key-signed order', () => {
    const cases: Array<{ name: string; reason: string; mutate: (s: ReturnType<typeof setup>, key: Uint8Array) => void }> = [
      { name: 'session closed', reason: 'session-closed', mutate: (s) => { s.chain.stream = { ...s.chain.stream, status: 'CLOSED' }; } },
      {
        name: 'key cleared', reason: 'cleared', mutate: (s) => {
          const { sessionKey: _, ...rest } = s.chain.stream;
          void _;
          s.chain.stream = { ...rest, sessionKeyExpiryHeight: 0n, sessionKeySpendCap: '0', sessionKeySetHeight: 0n };
        },
      },
      { name: 'key rotated', reason: 'rotated', mutate: (s) => { s.chain.stream = { ...s.chain.stream, sessionKey: generateSessionKey().address }; } },
      { name: 'key expired', reason: 'expired', mutate: (s) => { s.hubState.latest = 1_101n; } },
      { name: 'key re-registered after the anchor', reason: 'anchor-before-set-height', mutate: (s) => { s.chain.stream = { ...s.chain.stream, sessionKeySetHeight: 1_001n }; } },
      {
        name: 'cap used up by concurrent orders', reason: 'spend-cap',
        mutate: (s) => { s.chain.stream = { ...s.chain.stream, sessionKeySpendCap: (MAX_FEE * 2n).toString(), sessionKeySpent: (MAX_FEE + 1n).toString() }; },
      },
      {
        name: 'cap exactly fits', reason: 'unrelated',
        mutate: (s) => { s.chain.stream = { ...s.chain.stream, sessionKeySpendCap: (MAX_FEE * 2n).toString(), sessionKeySpent: MAX_FEE.toString() }; },
      },
      { name: 'nothing visible on chain', reason: 'unrelated', mutate: () => {} },
    ];
    for (const c of cases) {
      it(`${c.name} -> ${c.reason}`, async () => {
        const s = setup();
        const key = await withKey(s);
        const res = await s.client.openTask(BASE);
        expect(res.orderSignedBy).toBe('session-key');
        c.mutate(s, key);
        const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 60_000 });
        await tick(50);
        rejectAll(s.builders, res, 'ASSIGN_TIMEOUT');
        const out = await waiting;
        expect(out).toMatchObject({ kind: 'rejected', diagnosis: { reason: c.reason, sequenceFree: true } });
        if (out.kind === 'rejected') expect(out.diagnosis.session.sessionId).toBe(SESSION);
      });
    }

    it("a wallet-signed order (orderSigner: 'wallet') is 'unrelated' even with the key cleared", async () => {
      const s = setup();
      await withKey(s);
      const res = await s.client.openTask({ ...BASE, orderSigner: 'wallet', orderSequence: 7n });
      const { sessionKey: _, ...rest } = s.chain.stream;
      void _;
      s.chain.stream = { ...rest, sessionKeyExpiryHeight: 0n, sessionKeySpendCap: '0', sessionKeySetHeight: 0n };
      const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 60_000 });
      await tick(50);
      rejectAll(s.builders, res);
      expect(await waiting).toMatchObject({ kind: 'rejected', diagnosis: { reason: 'unrelated' } });
    });
  });

  describe('the order deadline decides when Builders cannot report', () => {
    const clear = (s: ReturnType<typeof setup>): void => {
      const { sessionKey: _, ...rest } = s.chain.stream;
      void _;
      s.chain.stream = { ...rest, sessionKeyExpiryHeight: 0n, sessionKeySpendCap: '0', sessionKeySetHeight: 0n };
    };
    const cases: Array<{ reason: string; mutate: (s: ReturnType<typeof setup>) => void }> = [
      { reason: 'cleared', mutate: clear },
      { reason: 'rotated', mutate: (s) => { s.chain.stream = { ...s.chain.stream, sessionKey: generateSessionKey().address }; } },
      { reason: 'session-closed', mutate: (s) => { s.chain.stream = { ...s.chain.stream, status: 'CLOSED' }; } },
    ];
    for (const c of cases) {
      it(`key-signed event streams refused, chain past order_expire_height with no task -> rejected (${c.reason})`, async () => {
        const s = setup();
        await withKey(s);
        const res = await s.client.openTask(BASE);
        expect(res.orderExpireHeight).toBe(intent.orderExpireHeight);
        c.mutate(s);
        s.builders.refuseKeySigned = true;
        const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 5, timeoutMs: 10_000 });
        await tick(50);
        // Every stream was refused (key-signed), so no Builder can report.
        expect(s.builders.refused).toBe(3);
        expect(s.builders.opened).toBe(0);
        const readsBefore = s.reader.reads;
        s.hubState.latest = intent.orderExpireHeight + 1n;
        const out = await waiting;
        expect(out).toMatchObject({ kind: 'rejected', diagnosis: { reason: c.reason, sequenceFree: true, events: [] } });
        // Decided by a read made after the deadline was seen.
        expect(s.reader.reads).toBeGreaterThan(readsBefore);
        if (out.kind === 'rejected') expect(out.retry.orderSequence).toBe(7n);
      });
    }

    it('not past the deadline yet: still waiting, and the bound ends it as timeout', async () => {
      const s = setup();
      await withKey(s);
      const res = await s.client.openTask(BASE);
      clear(s);
      s.builders.refuseKeySigned = true;
      s.hubState.latest = intent.orderExpireHeight; // at, not past
      s.chain.sessionReads = 0;
      expect(await s.client.waitForAdmission(res, { pollIntervalMs: 5, timeoutMs: 200 })).toEqual({ kind: 'timeout', taskId: res.taskId });
      expect(s.chain.sessionReads).toBe(0);
    });

    it('past the deadline but the task is on chain: accepted', async () => {
      const s = setup();
      const res = await s.client.openTask(BASE);
      s.hubState.latest = intent.orderExpireHeight + 5n;
      s.reader.hold = true;
      const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 60_000 });
      // The first read finds nothing; the confirming read after the height check finds the task.
      await tick(30);
      s.reader.release();
      await tick(30);
      expect(s.reader.reads).toBe(2);
      s.reader.taskHash = res.taskHash;
      s.reader.hold = false;
      s.reader.release();
      expect(await waiting).toMatchObject({ kind: 'accepted' });
    });
  });

  it('a task with no valid accepted task_hash decides nothing: polling continues', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    s.reader.taskHash = '';
    const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 5, timeoutMs: 10_000 });
    await tick(50);
    // Even all Builders reporting is not a rejection while a task exists.
    rejectAll(s.builders, res);
    await tick(50);
    const readsBefore = s.reader.reads;
    expect(readsBefore).toBeGreaterThan(1);
    s.reader.taskHash = res.taskHash;
    expect(await waiting).toMatchObject({ kind: 'accepted' });
    expect(s.chain.sessionReads).toBe(1); // openTask's sequence read only
  });

  it('a report landing while a read is in flight forces a further read before rejected', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    s.reader.hold = true;
    let settled = false;
    const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 60_000 }).then((o) => { settled = true; return o; });
    await tick(50);
    expect(s.reader.reads).toBe(1);
    // All reports land while read #1 is still in flight.
    rejectAll(s.builders, res);
    await tick(30);
    s.reader.release(); // read #1: not found, but it started before the last report
    await tick(30);
    expect(settled).toBe(false);
    expect(s.reader.reads).toBe(2);
    s.reader.hold = false;
    s.reader.release(); // read #2: not found, started after every report
    expect(await waiting).toMatchObject({ kind: 'rejected' });
    expect(s.reader.reads).toBe(2);
  });

  for (const same of [true, false]) {
    it(`sequence moved on, then the task appears on the re-read: ${same ? 'accepted' : 'superseded'}`, async () => {
      const s = setup();
      const res = await s.client.openTask(BASE);
      s.chain.stream = { ...s.chain.stream, nextExpectedSequence: 8n };
      s.chain.onSessionRead = () => { s.reader.taskHash = same ? res.taskHash : hexOf(0x55); };
      const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 60_000 });
      await tick(50);
      rejectAll(s.builders, res);
      expect(await waiting).toEqual(
        same ? { kind: 'accepted', taskId: res.taskId } : { kind: 'superseded', taskId: res.taskId, chainTaskHash: hexOf(0x55) },
      );
    });
  }

  it('abort throws ORDER_ADMISSION_WAIT_ABORTED and closes every event stream', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    const ac = new AbortController();
    const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 60_000, signal: ac.signal }).catch((x: unknown) => x);
    await tick(50);
    expect(s.builders.opened).toBe(3);
    ac.abort();
    expect(await waiting).toMatchObject({ family: 'SDK_LOCAL', code: 'ORDER_ADMISSION_WAIT_ABORTED' });
    await tick(10);
    expect(s.builders.closed).toBe(3);
    await expect(s.client.waitForAdmission(res, { signal: ac.signal })).rejects.toMatchObject({ code: 'ORDER_ADMISSION_WAIT_ABORTED' });
  });

  it('timeout resolves { kind: "timeout" } and closes every event stream', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    expect(await s.client.waitForAdmission(res, { pollIntervalMs: 5, timeoutMs: 300 })).toEqual({ kind: 'timeout', taskId: res.taskId });
    expect(s.reader.reads).toBeGreaterThanOrEqual(1);
    await tick(10);
    expect(s.builders.opened).toBe(3);
    expect(s.builders.closed).toBe(3);
  });

  it('rejects a bad poll interval or timeout', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    for (const pollIntervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(s.client.waitForAdmission(res, { pollIntervalMs })).rejects.toMatchObject({ code: 'SDK_LOCAL_POLL_INTERVAL_INVALID' });
    }
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(s.client.waitForAdmission(res, { timeoutMs })).rejects.toMatchObject({ code: 'SDK_LOCAL_TIMEOUT_INVALID' });
    }
    expect(s.builders.opened).toBe(0);
  });

  it('needs taskReader, ingressTransportFactory and hub up front', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    const base = {
      chainId: 'trueopen-localnet-1', userAddress: USER, wallet: privateKeyTypedDataSigner(PRIV), chain: s.chain,
      ingressTransport: s.builders.transport(ADDRS[0]!), signatureChainId: EVM,
    };
    const parts = { hub: makeHub({ latest: 1n }), taskReader: s.reader, ingressTransportFactory: (u: string) => s.builders.transport(u) };
    for (const missing of ['hub', 'taskReader', 'ingressTransportFactory'] as const) {
      const { [missing]: _, ...rest } = parts;
      void _;
      await expect(new TrueOpenClient({ ...base, ...rest }).waitForAdmission(res)).rejects.toMatchObject({ code: 'SDK_LOCAL_ADMISSION_UNCONFIGURED' });
    }
    expect(s.builders.opened).toBe(0);
  });

  it('a failed chain read (not a 404) is thrown', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    s.reader.queryTask = async () => { throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_HTTP_500', 'boom', { retriable: true }); };
    await expect(s.client.waitForAdmission(res, { pollIntervalMs: 5 })).rejects.toMatchObject({ code: 'CHAIN_QUERY_HTTP_500' });
    await tick(10);
    expect(s.builders.closed).toBe(s.builders.opened);
  });
});
