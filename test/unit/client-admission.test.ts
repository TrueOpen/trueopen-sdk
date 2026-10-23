import { describe, it, expect } from 'vitest';
import { createRouterTransport, ConnectError, Code } from '@connectrpc/connect';
import type { HandlerContext, Transport } from '@connectrpc/connect';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import type { GetTaskEventsRequest, OpenTaskHeader, OpenTaskRequest } from '../../src/gen/nexus/v1/ingress_pb.js';
import { TrueOpenClient, nextRetryIdempotencyKey, ABANDONED_REPORT, ORDER_REPLACEMENT_RETRY_ATTEMPTS } from '../../src/client';
import { DEFAULT_KEY_CHANGE_RETRY_ATTEMPTS } from '../../src/session/registered-session-key';
import { TaskBuilderAllEndpointsFailedError } from '../../src/transport/fan-out-submit';
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
  /** Builders whose GetTaskEvents answers NotFound (the task was abandoned). */
  readonly notFound = new Set<string>();
  /** What each Builder's GetTaskEvents replays first, before the live events. */
  readonly journal = new Map<string, string[]>();
  /** Builder address -> OpenTask headers it received. */
  readonly headersBy = new Map<string, OpenTaskHeader[]>();
  /** Builder address -> errors its next OpenTask calls throw, in order (then it accepts). */
  readonly openTaskErrors = new Map<string, ConnectError[]>();

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
          for await (const f of reqs) {
            if (f.frame.case !== 'header') continue;
            self.headers.push(f.frame.value);
            let list = self.headersBy.get(address);
            if (list === undefined) self.headersBy.set(address, (list = []));
            list.push(f.frame.value);
          }
          const err = self.openTaskErrors.get(address)?.shift();
          if (err !== undefined) throw err;
          return { taskId: '', accepted: true, reason: '', sessionId: SESSION };
        },
        async *getTaskEvents(req: GetTaskEventsRequest, ctx: HandlerContext) {
          if (self.failing.has(address)) throw new Error('events unavailable');
          if (self.notFound.has(address)) throw new ConnectError('task not found', Code.NotFound);
          if (self.refuseKeySigned && envelopeSigner(req.requestEnvelope!) !== USER_ADDRESS_HEX) {
            self.refused += 1;
            throw new ConnectError('SDK_AUTH_INVALID_SIGNATURE', Code.Unauthenticated);
          }
          self.opened += 1;
          // Counted on the signal itself (a stream the client aborts before this ran counts too).
          if (ctx.signal.aborted) self.closed += 1;
          else ctx.signal.addEventListener('abort', () => { self.closed += 1; }, { once: true });
          const queue: string[] = [...(self.journal.get(address) ?? [])];
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

function setup(extra: Partial<ConstructorParameters<typeof TrueOpenClient>[0]> = {}) {
  const hubState = { latest: 1_000n };
  let nonceCounter = 0;
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
    nonce: () => new Uint8Array(32).fill(1 + (nonceCounter++ % 250)),
    signatureChainId: EVM, feeDenom: 'utrueopen',
    sessionKeyChangeRetryMs: 1, orderReplacementRetryMs: 1,
    ...extra,
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
    // The window is kept relative to the context's latest height (1000).
    expect(r.orderWindow).toEqual({ earliestSubmitBlocks: 0n, orderExpireBlocks: 50_000n });
    expect(res.earliestSubmitHeight).toBe(1_000n);

    // A retry's own retry counts up; its window is rebased on its context.
    const res2 = await s.client.openTask({ ...r, context: context(1_001n, 1_000n) });
    expect(res2.orderSequence).toBe(7n);
    expect(res2.retryParams.idempotencyKey).toBe('k#retry2');
    expect(res2.earliestSubmitHeight).toBe(1_001n);
    expect(res2.orderExpireHeight).toBe(51_001n);
    expect(res2.retryParams.orderWindow).toEqual({ earliestSubmitBlocks: 0n, orderExpireBlocks: 50_000n });
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

  it('ASSIGN_ACCEPTED also triggers a read', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 60_000 });
    await tick(50);
    s.reader.taskHash = res.taskHash;
    s.builders.emit(res.builders[0]!.address, 'ASSIGN_ACCEPTED');
    expect(await waiting).toMatchObject({ kind: 'accepted' });
  });

  it('chain event codes Nexus never emits on GetTaskEvents do not trigger a read', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 60_000, timeoutMs: 300 });
    await tick(50);
    expect(s.reader.reads).toBe(1);
    s.reader.taskHash = res.taskHash;
    s.builders.emit(res.builders[0]!.address, 'WORKER_HANDRAISES_ACCEPTED');
    s.builders.emit(res.builders[1]!.address, 'WORKER_ASSIGNMENT_FINALIZED');
    await tick(50);
    expect(s.reader.reads).toBe(1);
    // Found only by the next poll, at the bound.
    expect(await waiting).toMatchObject({ kind: 'accepted' });
    expect(s.reader.reads).toBe(2);
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

    it('a failed height read is not past the deadline: the wait goes on and still decides', async () => {
      const s = setup();
      await withKey(s);
      const res = await s.client.openTask(BASE);
      clear(s);
      s.builders.refuseKeySigned = true;
      // The hub fails every height read for a while, then answers past the deadline.
      let failing = true;
      const real = s.client['cfg'].hub!.getLatestHeight.bind(s.client['cfg'].hub);
      (s.client['cfg'].hub as { getLatestHeight: () => Promise<bigint> }).getLatestHeight = async () => {
        if (failing) throw new Error('hub unavailable');
        return real();
      };
      const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 5, timeoutMs: 10_000 });
      await tick(50);
      s.hubState.latest = intent.orderExpireHeight + 1n;
      failing = false;
      expect(await waiting).toMatchObject({ kind: 'rejected', diagnosis: { reason: 'cleared' } });
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

const nonceHex = (h: OpenTaskHeader): string => toHex(h.requestEnvelope!.requestNonce);

describe('waitForAdmission: a replayed journal (Nexus keeps an abandoned task\'s journal)', () => {
  it('[ORDER_RECEIVED, ASSIGN_REJECTED, ORDER_RECEIVED]: the old attempt\'s rejection does not count', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    for (const b of res.builders) s.builders.journal.set(b.address, ['ORDER_RECEIVED', 'ASSIGN_REJECTED', 'ORDER_RECEIVED']);
    s.chain.sessionReads = 0;
    const out = await s.client.waitForAdmission(res, { pollIntervalMs: 5, timeoutMs: 300 });
    expect(out).toEqual({ kind: 'timeout', taskId: res.taskId });
    expect(s.chain.sessionReads).toBe(0);
  });

  it('a rejection after the last ORDER_RECEIVED counts', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    for (const b of res.builders) {
      s.builders.journal.set(b.address, ['ORDER_RECEIVED', 'ASSIGN_TIMEOUT', 'ORDER_RECEIVED', 'ASSIGN_REJECTED']);
    }
    const out = await s.client.waitForAdmission(res, { pollIntervalMs: 5, timeoutMs: 10_000 });
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') expect(out.diagnosis.events.map((e) => e.eventCode)).toEqual(['ASSIGN_REJECTED', 'ASSIGN_REJECTED', 'ASSIGN_REJECTED']);
  });

  it('the old rejection replayed, then the new attempt rejected live: rejected', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    for (const b of res.builders) s.builders.journal.set(b.address, ['ORDER_RECEIVED', 'ASSIGN_REJECTED', 'ORDER_RECEIVED']);
    const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 5, timeoutMs: 10_000 });
    await tick(50);
    rejectAll(s.builders, res, 'ASSIGN_TIMEOUT');
    const out = await waiting;
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') expect(out.diagnosis.events.map((e) => e.eventCode)).toEqual(['ASSIGN_TIMEOUT', 'ASSIGN_TIMEOUT', 'ASSIGN_TIMEOUT']);
  });
});

describe('waitForAdmission: GetTaskEvents NotFound from an acked Builder', () => {
  it('counts as that Builder\'s report: every Builder abandoned the task -> rejected', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    for (const b of res.builders) s.builders.notFound.add(b.address);
    const out = await s.client.waitForAdmission(res, { pollIntervalMs: 5, timeoutMs: 10_000 });
    expect(out.kind).toBe('rejected');
    if (out.kind !== 'rejected') return;
    expect(out.diagnosis.events.map((e) => e.eventCode)).toEqual([ABANDONED_REPORT, ABANDONED_REPORT, ABANDONED_REPORT]);
  });

  it('mixed with event reports: rejected once every Builder reported', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    s.builders.notFound.add(res.builders[0]!.address);
    const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 60_000 });
    await tick(50);
    s.builders.emit(res.builders[1]!.address, 'ASSIGN_REJECTED');
    s.builders.emit(res.builders[2]!.address, 'ASSIGN_TIMEOUT');
    expect(await waiting).toMatchObject({ kind: 'rejected' });
  });

  it('only some Builders abandoned: not a rejection', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    s.builders.notFound.add(res.builders[0]!.address);
    expect(await s.client.waitForAdmission(res, { pollIntervalMs: 5, timeoutMs: 200 })).toMatchObject({ kind: 'timeout' });
  });

  it('the chain still wins: a task on chain is accepted', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    for (const b of res.builders) s.builders.notFound.add(b.address);
    s.reader.taskHash = res.taskHash;
    expect(await s.client.waitForAdmission(res, { pollIntervalMs: 5 })).toMatchObject({ kind: 'accepted' });
  });
});

describe('openTask: the order window', () => {
  it('refuses locally an order whose order_expire_height is below the latest height', async () => {
    const s = setup();
    await expect(s.client.openTask({ ...BASE, context: context(51_001n, 51_000n) })).rejects.toMatchObject({
      family: 'SDK_LOCAL', code: 'SDK_LOCAL_ORDER_EXPIRED',
    });
    expect(s.builders.headers).toHaveLength(0);
    // At the height itself it is still sent.
    await expect(s.client.openTask({ ...BASE, context: context(51_000n, 51_000n) })).resolves.toMatchObject({ orderExpireHeight: 51_000n });
  });

  it('a retry after the deadline passed is rebased on the fresh context, not expired', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    // Rejected past order_expire_height: the chain is now beyond the old window.
    s.hubState.latest = intent.orderExpireHeight + 5n;
    for (const b of res.builders) s.builders.notFound.add(b.address);
    const out = await s.client.waitForAdmission(res, { pollIntervalMs: 5, timeoutMs: 10_000 });
    expect(out.kind).toBe('rejected');
    if (out.kind !== 'rejected') return;
    const latest = s.hubState.latest;
    const res2 = await s.client.openTask(out.retry);
    expect(res2.context.latestHeight).toBe(latest);
    expect(res2.earliestSubmitHeight).toBe(latest);
    expect(res2.orderExpireHeight).toBe(latest + 50_000n);
    const order = decodeSignedOrder(s.builders.headers.at(-1)!.orderEnvelope).order!;
    expect(order.orderExpireHeight).toBe(latest + 50_000n);
    expect(res2.taskHash).not.toBe(res.taskHash);
  });

  it('a caller-set orderWindow is applied (and clamped at height 1)', async () => {
    const s = setup();
    const res = await s.client.openTask({ ...BASE, orderWindow: { earliestSubmitBlocks: -5_000n, orderExpireBlocks: 100n } });
    expect(res.earliestSubmitHeight).toBe(1n);
    expect(res.orderExpireHeight).toBe(1_100n);
    await expect(s.client.openTask({ ...BASE, orderWindow: { earliestSubmitBlocks: 0, orderExpireBlocks: 1n } as never }))
      .rejects.toMatchObject({ code: 'SDK_LOCAL_ORDER_WINDOW_INVALID' });
  });
});

describe('openTask: a retry identical to the rejected order', () => {
  it('with the caller\'s context unchanged: SDK_LOCAL_RETRY_ORDER_UNCHANGED, nothing sent', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    const sent = s.builders.headers.length;
    await expect(s.client.openTask({ ...res.retryParams, context: context(1_000n, 1_000n) })).rejects.toMatchObject({
      code: 'SDK_LOCAL_RETRY_ORDER_UNCHANGED',
    });
    expect(s.builders.headers).toHaveLength(sent);
  });

  it('resolves one fresh context, bypassing the anchor-reuse cache', async () => {
    const s = setup();
    const { context: _c, expiryHeight: _e, ...noContext } = BASE;
    void _c;
    void _e;
    const res = await s.client.openTask(noContext);
    // Same latest height, same reused anchor: the retry would be identical, until the cache is
    // invalidated and a block passes.
    const cache = s.client['contextCache']!;
    const invalidate = cache.invalidate.bind(cache);
    let invalidations = 0;
    cache.invalidate = () => {
      invalidations += 1;
      s.hubState.latest += 1n;
      invalidate();
    };
    const res2 = await s.client.openTask(res.retryParams);
    expect(invalidations).toBe(1);
    expect(res2.taskHash).not.toBe(res.taskHash);
    expect(res2.context.latestHeight).toBe(1_001n);
  });

  it('still identical after the fresh context: SDK_LOCAL_RETRY_ORDER_UNCHANGED', async () => {
    const s = setup();
    const { context: _c, expiryHeight: _e, ...noContext } = BASE;
    void _c;
    void _e;
    const res = await s.client.openTask(noContext);
    const sent = s.builders.headers.length;
    await expect(s.client.openTask(res.retryParams)).rejects.toMatchObject({ code: 'SDK_LOCAL_RETRY_ORDER_UNCHANGED', retriable: true });
    expect(s.builders.headers).toHaveLength(sent);
  });

  it('a changed retry (object spread of the params) is sent', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    const changed = {
      ...res.retryParams,
      context: context(1_000n, 1_000n),
      order: { ...intent, amounts: { ...intent.amounts, maxFee: { atomicUnits: (MAX_FEE + 1n).toString() } } },
    };
    await expect(s.client.openTask(changed)).resolves.toMatchObject({ maxFee: MAX_FEE + 1n });
  });
});

describe('openTask retry: NEXUS_INGRESS_ORDER_REPLACEMENT_UNSUPPORTED', () => {
  const replacement = (): ConnectError =>
    new ConnectError('NEXUS_INGRESS_ORDER_REPLACEMENT_UNSUPPORTED: this Builder already tracks another version of the task; do not retry', Code.FailedPrecondition);

  it('a Builder still tracking the old version is retried after about a block, with a fresh nonce', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    const a = res.builders[0]!.address;
    s.builders.headersBy.clear();
    s.builders.openTaskErrors.set(a, [replacement(), replacement()]);
    const res2 = await s.client.openTask({ ...res.retryParams, context: context(1_001n, 1_000n) });
    const mine = s.builders.headersBy.get(a)!;
    expect(mine).toHaveLength(3);
    expect(new Set(mine.map(nonceHex)).size).toBe(3);
    // The signed order is the same on every attempt.
    expect(new Set(mine.map((h) => toHex(h.orderEnvelope))).size).toBe(1);
    expect(res2.builders.find((b) => b.address === a)!.ack?.accepted).toBe(true);
    for (const b of res2.builders.slice(1)) expect(s.builders.headersBy.get(b.address)).toHaveLength(1);
  });

  it('bounded: past ORDER_REPLACEMENT_RETRY_ATTEMPTS the refusal is the result', async () => {
    const s = setup();
    const res = await s.client.openTask(BASE);
    const a = res.builders[0]!.address;
    s.builders.headersBy.clear();
    s.builders.openTaskErrors.set(a, Array.from({ length: 10 }, replacement));
    const res2 = await s.client.openTask({ ...res.retryParams, context: context(1_001n, 1_000n) });
    expect(s.builders.headersBy.get(a)).toHaveLength(1 + ORDER_REPLACEMENT_RETRY_ATTEMPTS);
    expect(res2.builders.find((b) => b.address === a)!.error).toMatchObject({ code: 'NEXUS_INGRESS_ORDER_REPLACEMENT_UNSUPPORTED' });
  });

  it('not a retry: the refusal is final at once', async () => {
    const s = setup();
    s.builders.openTaskErrors.set(ADDRS[0]!, [replacement()]);
    const res = await s.client.openTask(BASE);
    const r = res.builders.find((b) => b.address === ADDRS[0]);
    if (r !== undefined) {
      expect(s.builders.headersBy.get(ADDRS[0]!)).toHaveLength(1);
      expect(r.error).toMatchObject({ code: 'NEXUS_INGRESS_ORDER_REPLACEMENT_UNSUPPORTED' });
    }
  });
});

describe('openTask: Builders lagging a key change (key-change window)', () => {
  const invalidSig = (): ConnectError => new ConnectError('SDK_AUTH_INVALID_SIGNATURE: signature does not verify', Code.Unauthenticated);

  /** A key registered at `setHeight` (the key-change height useSessionKey records); latest is 1000. */
  async function keyAt(s: ReturnType<typeof setup>, setHeight: bigint): Promise<void> {
    const m = generateSessionKey();
    s.chain.stream = { ...s.chain.stream, sessionKey: m.address, sessionKeyExpiryHeight: 1_100n, sessionKeySpendCap: '0', sessionKeySetHeight: setHeight };
    await s.client.useSessionKey(SESSION, m.privateKey);
  }

  it('inside the window (latest < change + 10): refused key-signed OpenTasks are re-signed and re-sent', async () => {
    const s = setup();
    await keyAt(s, 995n);
    for (const a of ADDRS) s.builders.openTaskErrors.set(a, [invalidSig(), invalidSig()]);
    const res = await s.client.openTask(BASE);
    expect(res.orderSignedBy).toBe('session-key');
    for (const a of ADDRS) {
      const mine = s.builders.headersBy.get(a)!;
      expect(mine).toHaveLength(3);
      expect(new Set(mine.map(nonceHex)).size).toBe(3);
    }
    expect(res.builders.every((b) => b.ack?.accepted === true)).toBe(true);
  });

  it('bounded by DEFAULT_KEY_CHANGE_RETRY_ATTEMPTS', async () => {
    const s = setup();
    await keyAt(s, 995n);
    for (const a of ADDRS) s.builders.openTaskErrors.set(a, Array.from({ length: 50 }, invalidSig));
    const err = await s.client.openTask(BASE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskBuilderAllEndpointsFailedError);
    for (const a of ADDRS) expect(s.builders.headersBy.get(a)).toHaveLength(1 + DEFAULT_KEY_CHANGE_RETRY_ATTEMPTS);
  });

  it('outside the window the refusal is final', async () => {
    const s = setup();
    await keyAt(s, 990n); // 1000 >= 990 + 10
    for (const a of ADDRS) s.builders.openTaskErrors.set(a, [invalidSig()]);
    const err = await s.client.openTask(BASE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskBuilderAllEndpointsFailedError);
    for (const a of ADDRS) expect(s.builders.headersBy.get(a)).toHaveLength(1);
    const results = (err as TaskBuilderAllEndpointsFailedError<never, never>).results;
    expect(results.every((r) => (r.error as TrueOpenError).code === 'SDK_AUTH_INVALID_SIGNATURE')).toBe(true);
  });

  it('a wallet-signed order is never retried for it', async () => {
    const s = setup();
    await keyAt(s, 995n);
    for (const a of ADDRS) s.builders.openTaskErrors.set(a, [invalidSig()]);
    await expect(s.client.openTask({ ...BASE, orderSigner: 'wallet', orderSequence: 7n })).rejects.toBeInstanceOf(TaskBuilderAllEndpointsFailedError);
    for (const a of ADDRS) expect(s.builders.headersBy.get(a)).toHaveLength(1);
  });

  it('a key-signed OpenTask refused SDK_AUTH_SESSION_GRANT_EXPIRED outside the window is not retriable', async () => {
    const s = setup();
    await keyAt(s, 990n);
    for (const a of ADDRS) {
      s.builders.openTaskErrors.set(a, [new ConnectError('SDK_AUTH_SESSION_GRANT_EXPIRED: the session\'s registered key has expired', Code.DeadlineExceeded)]);
    }
    const err = (await s.client.openTask(BASE).catch((e: unknown) => e)) as TaskBuilderAllEndpointsFailedError<never, never>;
    for (const r of err.results) expect(r.error).toMatchObject({ code: 'SDK_AUTH_SESSION_GRANT_EXPIRED', retriable: false });
  });
});

describe('openTask: the order window against the registered key\'s expiry', () => {
  it('earliest_submit_height after the key expiry: SDK_LOCAL_SESSION_KEY_EXPIRED before signing', async () => {
    const s = setup();
    await withKey(s); // expiry 1100
    const order = { ...intent, earliestSubmitHeight: 1_101n };
    await expect(s.client.openTask({ ...BASE, order })).rejects.toMatchObject({ code: 'SDK_LOCAL_SESSION_KEY_EXPIRED' });
    expect(s.builders.headers).toHaveLength(0);
    await expect(s.client.openTask({ ...BASE, order: { ...intent, earliestSubmitHeight: 1_100n } })).resolves.toBeDefined();
  });

  it('a window that ends after the expiry is sent, flagged keyExpiresInOrderWindow', async () => {
    const s = setup();
    await withKey(s);
    const res = await s.client.openTask(BASE); // order_expire_height 51000 > 1100
    expect(res.keyExpiresInOrderWindow).toBe(true);
    expect(res.sessionKeyExpiryHeight).toBe(1_100n);
    const inside = await s.client.openTask({ ...BASE, order: { ...intent, orderExpireHeight: 1_100n } });
    expect(inside.keyExpiresInOrderWindow).toBeUndefined();
    const wallet = await s.client.openTask({ ...BASE, orderSigner: 'wallet', orderSequence: 7n });
    expect(wallet.keyExpiresInOrderWindow).toBeUndefined();
    expect(wallet.sessionKeyExpiryHeight).toBeUndefined();
  });

  it('diagnosis: expired when the key expires before earliest_submit_height, though not before latest', async () => {
    const s = setup();
    await withKey(s);
    const res = await s.client.openTask({ ...BASE, order: { ...intent, earliestSubmitHeight: 1_050n } });
    // The chain now shows an expiry between latest (1000) and earliest_submit_height (1050).
    s.chain.stream = { ...s.chain.stream, sessionKeyExpiryHeight: 1_040n };
    const waiting = s.client.waitForAdmission(res, { pollIntervalMs: 60_000 });
    await tick(50);
    rejectAll(s.builders, res);
    expect(await waiting).toMatchObject({ kind: 'rejected', diagnosis: { reason: 'expired' } });
  });
});
