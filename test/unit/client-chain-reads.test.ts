import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouterTransport, ConnectError, Code } from '@connectrpc/connect';
import type { Transport } from '@connectrpc/connect';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import type { OpenTaskRequest } from '../../src/gen/nexus/v1/ingress_pb.js';
import { fromBinary } from '@bufbuild/protobuf';
import { SignedOrderV2Schema } from '../../src/gen/task/v1/msg_assignment_pb.js';
import { TrueOpenClient } from '../../src/client';
import type { TrueOpenClientConfig } from '../../src/client';
import type { ChainClient } from '../../src/transport/chain-client';
import type { TaskOrderIntent } from '../../src/order/task-order-input';
import { defaultGenerationParams } from '../../src/order/task-order-input';
import { TASK_TYPE, DEADLINE_LATENCY_CLASS } from '../../src/order/task-order';
import type { BuilderSetSnapshot, ParameterBucketView, ServiceDescriptorRef } from '../../src/types/hub';
import type { StreamStateView } from '../../src/types/node';
import { secp256k1PublicKey } from '../../src/signer/secp256k1';
import { ethSecp256k1Address } from '../../src/signer/eth-secp256k1';
import { privateKeyTypedDataSigner } from '../../src/signer/typed-data-signer';
import { fromHex } from '../../src/util/bytes';
import { hash32Text } from '../../src/codec/hash32';
import { MAX_CHAIN_READ_CACHE_TTL_MS } from '../../src/transport/chain-read-cache';

// Counts the chain round trips an order makes, against in-memory fakes only. Every hub and
// session read is one round trip; `rounds` is how many of them had to wait for an earlier one
// (a read that starts after another read finished is one round deeper than it).

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const wallet = privateKeyTypedDataSigner(PRIV);
const USER = ethSecp256k1Address(secp256k1PublicKey(PRIV), 'trueopen');
const hexOf = (b: number): string => hash32Text(new Uint8Array(32).fill(b));
const SESSION = '0xb793a05ff8441795fca46a890b906b0c81af9d8d7a4d53e82de53a1c917b9883';
const ADDRS = [
  'trueopen1yfse4c367uc2rja5g3905ynmnuv2hjk8gcgvfl',
  'trueopen1870sqtdru7dj3xgwpzcexry0dwvyz2ku7xv9mg',
  'trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man',
];
const SET_A: BuilderSetSnapshot = { builderSetId: 'set-a', builderSetVersion: 1n, effectiveHeight: 1n, builders: ADDRS.join(','), setHash: hexOf(0x15) };
const SET_B: BuilderSetSnapshot = { builderSetId: 'set-b', builderSetVersion: 2n, effectiveHeight: 900n, builders: ADDRS.join(','), setHash: hexOf(0x16) };

const order: TaskOrderIntent = {
  modelId: '0xad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b',
  profileVersion: 1,
  taskType: TASK_TYPE.TEXT_GENERATION,
  payload: new TextEncoder().encode('trueopen-input'),
  inputBucket: 1,
  outputBudgetBucket: 1,
  generationParams: defaultGenerationParams(128n, 2_000n),
  amounts: { priceBid: { atomicUnits: '100000' }, maxFee: { atomicUnits: '1000' }, assignmentPriorityFee: { atomicUnits: '0' }, txFeeReserve: { atomicUnits: '0' } },
  earliestSubmitHeight: 1_000n,
  orderExpireHeight: 1_100n,
  latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
};

/** Mutable chain state behind the fakes. */
interface ChainState {
  height: bigint;
  set: BuilderSetSnapshot;
  bucketVersion: bigint;
  nextSequence: bigint;
}

class Meter {
  readonly calls: string[] = [];
  private finishedDepth = 0;
  rounds = 0;
  async read<T>(name: string, value: () => T): Promise<T> {
    const depth = this.finishedDepth + 1;
    this.calls.push(name);
    // A macrotask: reads started in the same step finish together, as concurrent requests would.
    await new Promise((r) => setTimeout(r, 0));
    this.finishedDepth = Math.max(this.finishedDepth, depth);
    this.rounds = Math.max(this.rounds, depth);
    return value();
  }
  get count(): number {
    return this.calls.length;
  }
  reset(): void {
    this.calls.length = 0;
    this.finishedDepth = 0;
    this.rounds = 0;
  }
}

function fakes(state: ChainState, meter: Meter) {
  const hub = {
    getLatestHeight: () => meter.read('height', () => state.height),
    getBuilderSetAtHeight: (h: bigint) => meter.read('builderSet', () => (h >= state.set.effectiveHeight ? state.set : SET_A)),
    getParameterBucket: (kind: string) =>
      meter.read('timeoutBucket', (): ParameterBucketView => ({ bucketKind: kind, bucketKey: 'default', version: state.bucketVersion, currentVersion: state.bucketVersion, effectiveHeight: 0n })),
    getTaskGenerationLimits: () =>
      meter.read('generationLimits', () => ({
        maxOutputTokens: 131_072n, topKMax: 1000n, stopSequenceMaxItems: 16n,
        stopSequenceMaxBytesEach: 128n, stopSequenceMaxTotalBytes: 1024n, stopTokenMaxItems: 64n,
      })),
    getBusinessDenom: () => meter.read('businessDenom', () => 'utrueopen'),
    getProfile: () => meter.read('profile', () => ({ pricing: { minOrderValue: 0n, verifyRatioBps: 0n, initialOutputPrice: 0n } })),
    getServiceDescriptor: (id: string) =>
      meter.read('descriptor', (): ServiceDescriptorRef => ({
        participantType: 'PARTICIPANT_TYPE_BUILDER', participantId: id, descriptorVersion: 2n,
        endpoints: [{ endpointKind: 'SERVICE_ENDPOINT_KIND_NEXUS_GRPC', uri: `grpc://${id}:8080`, protocolVersion: 'v1' }],
        descriptorHash: hexOf(0xaa), updatedHeight: 1n,
      })),
  };
  const session = (id: string): StreamStateView => ({
    boundBuilder: ADDRS[0]!, sessionId: id, owner: USER, nextExpectedSequence: state.nextSequence, lastActiveHeight: 0n,
    openPendingCount: 0n, status: 'ACTIVE', sessionKeyExpiryHeight: 0n, sessionKeySpendCap: '0', sessionKeySpent: '0', sessionKeySetHeight: 0n,
  } as StreamStateView);
  const chain: ChainClient = {
    querySession: (id) =>
      meter.read('session', () => {
        if (id !== SESSION) throw new Error(`no session ${id}`);
        return session(id);
      }),
    async querySessionNonce() { return { nextSessionNonce: 0n }; },
    async createSession() { throw new Error('unused'); },
    async cancelOrder() { throw new Error('unused'); },
    async updateSessionKey() { throw new Error('unused'); },
  };
  return { hub, chain };
}

/** A Builder that accepts, or refuses an order signed against another BuilderSet than the chain's current one. */
function builder(state: ChainState, seen: { calls: number; setIds: string[] }): Transport {
  return createRouterTransport(({ service }) => {
    service(IngressAPI, {
      async openTask(reqs: AsyncIterable<OpenTaskRequest>) {
        seen.calls += 1;
        let setId = '';
        for await (const f of reqs) {
          if (f.frame.case === 'header') {
            setId = fromBinary(SignedOrderV2Schema, (f.frame.value as { orderEnvelope: Uint8Array }).orderEnvelope).order!.builderSetId;
          }
        }
        seen.setIds.push(setId);
        if (setId !== state.set.builderSetId) {
          throw new ConnectError(`NEXUS_INGRESS_BUILDER_SET_STALE: order names BuilderSet "${setId}", current is "${state.set.builderSetId}"`, Code.FailedPrecondition);
        }
        return { taskId: '', accepted: true, reason: '', sessionId: SESSION, status: 1 };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });
}

function setup(extra: Partial<TrueOpenClientConfig> = {}) {
  const state: ChainState = { height: 1_000n, set: SET_A, bucketVersion: 1n, nextSequence: 0n };
  const meter = new Meter();
  const { hub, chain } = fakes(state, meter);
  const seen = { calls: 0, setIds: [] as string[] };
  const client = new TrueOpenClient({
    chainId: 'trueopen-localnet-1', userAddress: USER, wallet, chain, hub: hub as never,
    ingressTransport: builder(state, seen), ingressTransportFactory: () => builder(state, seen),
    signatureChainId: 424242n, feeDenom: 'utrueopen',
    ...extra,
  });
  return { state, meter, client, seen };
}

let key = 0;
const params = (extra: object = {}) => ({ sessionId: SESSION, order, idempotencyKey: `idem-${++key}`, ...extra });
const policy = { maxAttempts: 3, maxPolls: 2, pollIntervalMs: 0 };

afterEach(() => {
  vi.useRealTimers();
});

describe('chain round trips per order, without the read cache', () => {
  it('openTask resolves only the dispatching Builder: 8 reads in 3 rounds', async () => {
    const { meter, client } = setup();
    await client.openTask(params());
    expect(meter.calls.filter((c) => c === 'descriptor')).toHaveLength(1);
    expect(meter.count).toBe(8);
    expect(meter.rounds).toBe(3);
  });

  it('openTask with a caller context and expiryHeight reads no latest height', async () => {
    const { meter, client } = setup();
    const first = await client.openTask(params());
    meter.reset();
    await client.openTask(params({ context: first.context, expiryHeight: 1_010n }));
    expect(meter.calls).not.toContain('height');
    // business denom, profile, session and the BuilderSet at the context's anchor in one round,
    // then the dispatching Builder's descriptor.
    expect(meter.count).toBe(5);
    expect(meter.rounds).toBe(2);
  });

  it('openTaskWithRecovery reads the session once and the BuilderSet once', async () => {
    const { meter, client } = setup();
    const res = await client.openTaskWithRecovery(params(), policy);
    expect(res.accepted).toBe(true);
    expect(meter.calls.filter((c) => c === 'session')).toHaveLength(1);
    expect(meter.calls.filter((c) => c === 'builderSet')).toHaveLength(1);
    expect(meter.calls.filter((c) => c === 'height')).toHaveLength(1);
    expect(meter.count).toBe(8);
    expect(meter.rounds).toBe(4);
  });

  it('sends no request with a session grant beyond what an order without one reads', async () => {
    const { meter, client } = setup({ session: { maxGrantBlocks: 100 } });
    await client.openTask(params());
    expect(meter.calls.filter((c) => c === 'height')).toHaveLength(1);
  });
});

describe('chain read cache', () => {
  it('a warm openTask reads only the latest height and the session, in one round', async () => {
    const { meter, client } = setup({ chainReadCache: true });
    await client.openTask(params());
    expect(meter.count).toBe(8);
    meter.reset();
    await client.openTask(params());
    expect(meter.calls.sort()).toEqual(['height', 'session']);
    expect(meter.rounds).toBe(1);
  });

  it('a warm openTaskWithRecovery reads only the latest height and the session', async () => {
    const { meter, client } = setup({ chainReadCache: { ttlMs: 30_000 } });
    await client.openTaskWithRecovery(params(), policy);
    meter.reset();
    const res = await client.openTaskWithRecovery(params(), policy);
    expect(res.accepted).toBe(true);
    expect(meter.calls.sort()).toEqual(['height', 'session']);
    expect(meter.rounds).toBe(1);
  });

  it('a warm openTask with a caller context and expiryHeight reads only the session', async () => {
    const { meter, client } = setup({ chainReadCache: true });
    const first = await client.openTask(params());
    meter.reset();
    await client.openTask(params({ context: first.context, expiryHeight: 1_010n }));
    expect(meter.calls).toEqual(['session']);
  });

  it('prefetch warms the cache so the first order pays no cold reads', async () => {
    const { meter, client } = setup({ chainReadCache: true });
    const warm = await client.prefetch({ sessionId: SESSION, model: order });
    expect(warm.errors).toEqual([]);
    meter.reset();
    await client.openTask(params());
    expect(meter.calls.sort()).toEqual(['height', 'session']);
  });

  it('prefetch reports read failures instead of rejecting', async () => {
    const { client } = setup({ chainReadCache: true });
    const warm = await client.prefetch({ sessionId: 'not-a-session', model: order });
    expect(warm.errors).toHaveLength(1);
  });

  it('expires entries after the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { meter, client } = setup({ chainReadCache: true });
    await client.openTask(params());
    vi.setSystemTime(Date.now() + MAX_CHAIN_READ_CACHE_TTL_MS + 1);
    meter.reset();
    await client.openTask(params());
    expect(meter.count).toBe(8);
  });

  it('a BuilderSet the Builder calls stale drops the cache and retries exactly once with fresh reads', async () => {
    const { state, meter, client, seen } = setup({ chainReadCache: true });
    await client.openTask(params());
    // A new BuilderSet takes effect; the cached one is now stale.
    state.set = SET_B;
    state.height = 1_001n;
    meter.reset();
    seen.calls = 0;
    seen.setIds.length = 0;
    const res = await client.openTask(params());
    expect(res.accepted).toBe(true);
    expect(seen.setIds).toEqual(['set-a', 'set-b']);
    expect(res.context.builderSetId).toBe('set-b');
    // The retry re-read everything the cache held.
    expect(meter.calls.filter((c) => c === 'builderSet')).toHaveLength(1);
    expect(meter.calls).toContain('businessDenom');
    expect(meter.calls).toContain('descriptor');
  });

  it('retries a stale rejection only once', async () => {
    // The Builder keeps refusing whatever set the chain reports.
    const state: ChainState = { height: 1_000n, set: SET_A, bucketVersion: 1n, nextSequence: 0n };
    const refusing: ChainState = { ...state, set: SET_B };
    const seen = { calls: 0, setIds: [] as string[] };
    const { hub, chain } = fakes(state, new Meter());
    const client = new TrueOpenClient({
      chainId: 'trueopen-localnet-1', userAddress: USER, wallet, chain, hub: hub as never,
      ingressTransport: builder(refusing, seen), ingressTransportFactory: () => builder(refusing, seen),
      signatureChainId: 424242n, feeDenom: 'utrueopen', chainReadCache: true,
    });
    await expect(client.openTask(params())).rejects.toMatchObject({ code: 'TASK_BUILDER_ALL_ENDPOINTS_FAILED' });
    expect(seen.calls).toBe(2);
  });

  it('without the cache a stale rejection is not retried', async () => {
    const state: ChainState = { height: 1_000n, set: SET_A, bucketVersion: 1n, nextSequence: 0n };
    const refusing: ChainState = { ...state, set: SET_B };
    const seen = { calls: 0, setIds: [] as string[] };
    const { hub, chain } = fakes(state, new Meter());
    const client = new TrueOpenClient({
      chainId: 'trueopen-localnet-1', userAddress: USER, wallet, chain, hub: hub as never,
      ingressTransport: builder(refusing, seen), ingressTransportFactory: () => builder(refusing, seen),
      signatureChainId: 424242n, feeDenom: 'utrueopen',
    });
    await expect(client.openTask(params())).rejects.toMatchObject({ code: 'TASK_BUILDER_ALL_ENDPOINTS_FAILED' });
    expect(seen.calls).toBe(1);
  });

  it('a changed timeout bucket version drops every cached entry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    const { state, meter, client } = setup({ chainReadCache: true });
    await client.openTask(params());
    // The profile is cached 40 s later than the rest.
    vi.setSystemTime(t0 + 40_000);
    await client.prefetch({ model: { modelId: order.modelId, profileVersion: 2 } });
    // The rest expires; the fresh timeout bucket read shows a new params version.
    vi.setSystemTime(t0 + MAX_CHAIN_READ_CACHE_TTL_MS + 1);
    state.bucketVersion = 2n;
    const v2 = { ...order, profileVersion: 2 };
    expect((await client.openTask(params({ order: v2 }))).context.timeoutBucketVersion).toBe(2n);
    meter.reset();
    // The profile cached at +40 s was dropped with the version change; the new bucket was kept.
    await client.openTask(params({ order: v2 }));
    expect(meter.calls).toContain('profile');
    expect(meter.calls).not.toContain('timeoutBucket');
  });

  it('invalidateChainReadCache drops every entry', async () => {
    const { meter, client } = setup({ chainReadCache: true });
    await client.openTask(params());
    client.invalidateChainReadCache();
    meter.reset();
    await client.openTask(params());
    expect(meter.count).toBe(8);
  });

  it('rejects a TTL above 60 s', () => {
    expect(() => setup({ chainReadCache: { ttlMs: MAX_CHAIN_READ_CACHE_TTL_MS + 1 } })).toThrow(/chainReadCache/);
    expect(() => setup({ chainReadCache: { ttlMs: 0 } })).toThrow(/chainReadCache/);
  });
});
