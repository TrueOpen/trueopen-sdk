import { describe, it, expect } from 'vitest';
import { createRouterTransport } from '@connectrpc/connect';
import type { Transport } from '@connectrpc/connect';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import type { OpenTaskRequest } from '../../src/gen/nexus/v1/ingress_pb.js';
import { TrueOpenClient } from '../../src/client';
import type { ChainClient } from '../../src/transport/chain-client';
import type { TaskOrderIntent } from '../../src/order/task-order-input';
import { defaultGenerationParams } from '../../src/order/task-order-input';
import { TASK_TYPE, DEADLINE_LATENCY_CLASS } from '../../src/order/task-order';
import type { BuilderSetSnapshot, ServiceDescriptorRef, BeaconView, ParameterBucketView } from '../../src/types/hub';
import { deriveTaskId } from '../../src/order/order-signing';
import {
  privKeySecp256k1Signer,
    secp256k1PublicKey,
  secp256k1Address,
} from '../../src/signer/secp256k1';
import { privKeyEip712Signer } from '../../src/signer/eth-secp256k1';
import { fromHex, toHex } from '../../src/util/bytes';

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const signer = privKeySecp256k1Signer(PRIV);
const orderSigner = privKeyEip712Signer(PRIV);
const pub = secp256k1PublicKey(PRIV);
const USER = secp256k1Address(pub, 'trueopen');

const hexOf = (b: number): string => toHex(new Uint8Array(32).fill(b));
const amount = (atomicUnits: string) => ({ atomicUnits });
const SESSION = 'b793a05ff8441795fca46a890b906b0c81af9d8d7a4d53e82de53a1c917b9883';
const SET_HASH = hexOf(0x15);
const ANCHOR = hexOf(0x14);
const PAYLOAD = new TextEncoder().encode('trueopen-input');

const ADDRS = [
  'trueopen1yfse4c367uc2rja5g3905ynmnuv2hjk8gcgvfl',
  'trueopen1870sqtdru7dj3xgwpzcexry0dwvyz2ku7xv9mg',
  'trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man',
];

const snapshot: BuilderSetSnapshot = {
  builderSetId: 'genesis-1', builderSetVersion: 1n, effectiveHeight: 1n,
  builders: ADDRS.join(','), setHash: SET_HASH,
};

/** Satisfies both TaskBuilderReader and TaskOrderContextReader. */
const hub = {
  getLatestHeight: async (): Promise<bigint> => 1_000n,
  getActiveBuilderSet: async (): Promise<BuilderSetSnapshot> => snapshot,
  getBeacon: async (height: bigint): Promise<BeaconView> => ({
    height, blockHash: ANCHOR, randomnessHex: hexOf(0x01), sourceTag: 'proposer_vrf_v1', verified: true,
  }),
  getTaskGenerationLimits: async () => ({
    maxOutputTokens: 131_072n, topKMax: 1000n, stopSequenceMaxItems: 16n,
    stopSequenceMaxBytesEach: 128n, stopSequenceMaxTotalBytes: 1024n, stopTokenMaxItems: 64n,
  }),
  getParameterBucket: async (kind: string): Promise<ParameterBucketView> => ({
    bucketKind: kind, bucketKey: 'default', version: 1n, currentVersion: 1n, effectiveHeight: 0n,
  }),
  getServiceDescriptor: async (id: string): Promise<ServiceDescriptorRef> => ({
    participantType: 'PARTICIPANT_TYPE_BUILDER', participantId: id, descriptorVersion: 2n,
    endpoints: [{ endpointKind: 'SERVICE_ENDPOINT_KIND_NEXUS_GRPC', uri: `grpc://${id}:8080`, protocolVersion: 'v1' }],
    descriptorHash: hexOf(0xaa), updatedHeight: 1n,
  }),
} as never;

const order: TaskOrderIntent = {
  modelId: 'hf-ad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b',
  profileVersion: 1,
  taskType: TASK_TYPE.TEXT_GENERATION,
  payload: PAYLOAD,
  inputBucket: 1,
  outputBudgetBucket: 1,
  generationParams: defaultGenerationParams(128n, 2_000n),
  amounts: {
    priceBid: amount('100000'), maxFee: amount('1000'),
    assignmentPriorityFee: amount('0'), txFeeReserve: amount('0'),
  },
  earliestSubmitHeight: 1_000n,
  orderExpireHeight: 51_000n,
  latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
};

function fakeChain(): ChainClient {
  return {
    async querySession(id) {
      return { sessionId: id, owner: USER, nextExpectedSequence: 0n, lastActiveHeight: 0n, openPendingCount: 0n, status: 'ACTIVE' };
    },
    async querySessionNonce() { return { nextSessionNonce: 0n }; },
    async querySettlementFinality() { throw new Error('n/a'); },
    async createSession() { return { sessionId: SESSION, owner: USER, nonce: 0n, status: 'MUTATION_STATUS_V1_APPLIED' }; },
    async cancelOrder(i) { return { taskId: 'task-1', cancelledSequence: i.orderSequence, nextExpectedSequence: i.orderSequence + 1n, status: 'MUTATION_STATUS_V1_APPLIED' }; },
    async userChallenge() { return { challengeId: 'ch-1', status: 'OPEN', challengeDeadlineHeight: 200n, resolveDeadlineHeight: 250n, bondLockedAmount: 1000n }; },
  };
}

function acceptTransport(seen: { calls: number; frames: OpenTaskRequest[] }): Transport {
  return createRouterTransport(({ service }) => {
    service(IngressAPI, {
      async openTask(reqs: AsyncIterable<OpenTaskRequest>) {
        seen.calls += 1;
        for await (const f of reqs) seen.frames.push(f);
        return { taskId: '', accepted: true, reason: '', sessionId: SESSION };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });
}

function makeClient(seen: { calls: number; frames: OpenTaskRequest[] }, opts: { orderSigner?: unknown } = {}): TrueOpenClient {
  return new TrueOpenClient({
    chainId: 'trueopen-localnet-1', userAddress: USER, signerPubKey: pub, signer,
    chain: fakeChain(), ingressTransport: acceptTransport({ calls: 0, frames: [] }),
    hub, ingressTransportFactory: () => acceptTransport(seen),
    nonce: () => new Uint8Array([1, 2, 3]),
    evmChainId: 424242n,
    feeDenom: 'utrueopen',
    ...('orderSigner' in opts ? { orderSigner: opts.orderSigner as never } : { orderSigner }),
  });
}

describe('TrueOpenClient.openTask', () => {
  it('assembles once, sends to every selected Task Builder, and succeeds if any one accepts', async () => {
    const seen = { calls: 0, frames: [] as OpenTaskRequest[] };
    const res = await makeClient(seen).openTask({
      sessionId: SESSION, orderSequence: 3n, order, idempotencyKey: 'idem-1',
    });

    expect(res.accepted).toBe(true);
    expect(res.endpointsTried).toBe(3);
    expect(seen.calls).toBe(3); // each of the 3 endpoints receives one call
    expect(res.taskId).toBe(deriveTaskId(SESSION, 3n));
    expect(res.taskHash).toMatch(/^[0-9a-f]{64}$/);

    // Context is fetched from the chain and returned, for reuse/debugging.
    expect(res.context.sessionAnchorBlockHash).toBe(ANCHOR);
    expect(res.context.builderSetId).toBe('genesis-1');
    expect(res.context.timeoutBucketVersion).toBe(1n);
    // anchor is latestHeight - 2.
    expect(res.context.sessionAnchorHeight).toBe(998n);
  });

  it('expiry uses block height rather than a timestamp (nexus only accepts block height for OpenTask)', async () => {
    const seen = { calls: 0, frames: [] as OpenTaskRequest[] };
    await makeClient(seen).openTask({ sessionId: SESSION, orderSequence: 3n, order, idempotencyKey: 'idem-1' });
    const header = seen.frames.find((f) => f.frame.case === 'header')?.frame.value as { requestEnvelope?: { expiryHeightOrTime: bigint } };
    const expiry = header.requestEnvelope?.expiryHeightOrTime as bigint;
    // latestHeight(1000) + default 10-block window.
    expect(expiry).toBe(1_010n);
    // Constraint 1: must be a block height, not a unix millisecond timestamp (ingress/taskdata.go:221).
    expect(expiry).toBeLessThan(1_000_000_000_000n);
    // Constraint 2: must also fall within [height, height + RequestTTLBlocks]; nexus's default TTL is
    // 20 blocks (taskdata/authorizer.go:327). Using 300 gets rejected as NEXUS_DATA_EXPIRED - verified against a live chain.
    expect(expiry - 1_000n).toBeLessThanOrEqual(20n);
  });

  it('does not read the chain again when reusing an external context', async () => {
    const seen = { calls: 0, frames: [] as OpenTaskRequest[] };
    const first = await makeClient(seen).openTask({
      sessionId: SESSION, orderSequence: 3n, order, idempotencyKey: 'idem-1',
    });
    const again = await makeClient(seen).openTask({
      sessionId: SESSION, orderSequence: 4n, order, idempotencyKey: 'idem-2', context: first.context,
    });
    expect(again.context).toEqual(first.context);
    // Same order content but a different order_sequence must yield a different task_hash.
    expect(again.taskHash).not.toBe(first.taskHash);
  });

  // Two identities kept separate: the request envelope can be signed by an independent SDK identity, while the order still belongs to the user.
  it('sdkSigner configured: the SDK identity goes into the request envelope, user_address stays the user', async () => {
    const seen = { calls: 0, frames: [] as OpenTaskRequest[] };
    const sdkPriv = fromHex('02030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2021');
    const sdkPub = secp256k1PublicKey(sdkPriv);
    const client = new TrueOpenClient({
      chainId: 'trueopen-localnet-1', userAddress: USER, signerPubKey: pub, signer, orderSigner,
      evmChainId: 424242n, feeDenom: 'utrueopen',
      chain: fakeChain(), ingressTransport: acceptTransport({ calls: 0, frames: [] }),
      hub, ingressTransportFactory: () => acceptTransport(seen),
      nonce: () => new Uint8Array([1, 2, 3]),
      sdkSigner: privKeySecp256k1Signer(sdkPriv),
      sdkSignerPubKey: sdkPub,
      sdkSignerAddress: secp256k1Address(sdkPub, 'trueopen'),
    });
    await client.openTask({ sessionId: SESSION, orderSequence: 3n, order, idempotencyKey: 'idem-1' });
    const header = seen.frames.find((f) => f.frame.case === 'header')?.frame.value as {
      userAddress: string;
      requestEnvelope?: { signerAddress: string };
    };
    expect(header.requestEnvelope?.signerAddress).toBe(secp256k1Address(sdkPub, 'trueopen'));
    expect(header.userAddress).toBe(USER);
  });

  it('errors clearly when orderSigner is not configured (a hash-first signer cannot stand in for it)', async () => {
    const seen = { calls: 0, frames: [] as OpenTaskRequest[] };
    await expect(
      makeClient(seen, { orderSigner: undefined }).openTask({
        sessionId: SESSION, orderSequence: 3n, order, idempotencyKey: 'idem-1',
      }),
    ).rejects.toMatchObject({ code: 'SDK_LOCAL_ORDER_SIGNER_REQUIRED' });
  });

  it('throws when hub/transportFactory is not configured', async () => {
    const client = new TrueOpenClient({
      chainId: 'trueopen-localnet-1', userAddress: USER, signerPubKey: pub, signer, orderSigner,
      evmChainId: 424242n, feeDenom: 'utrueopen',
      chain: fakeChain(), ingressTransport: acceptTransport({ calls: 0, frames: [] }),
      nonce: () => new Uint8Array([1, 2, 3]),
    });
    await expect(
      client.openTask({ sessionId: SESSION, orderSequence: 3n, order, idempotencyKey: 'idem-1' }),
    ).rejects.toMatchObject({ code: 'SDK_LOCAL_ROUTING_UNCONFIGURED' });
  });
});
