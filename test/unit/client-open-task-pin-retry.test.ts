import { describe, it, expect } from 'vitest';
import { createRouterTransport, ConnectError, Code } from '@connectrpc/connect';
import type { Transport } from '@connectrpc/connect';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import type { OpenTaskRequest } from '../../src/gen/nexus/v1/ingress_pb.js';
import { TrueOpenClient } from '../../src/client';
import { TrueOpenError } from '../../src/errors/errors';
import type { ChainClient } from '../../src/transport/chain-client';
import type { TaskOrderIntent } from '../../src/order/task-order-input';
import { defaultGenerationParams } from '../../src/order/task-order-input';
import { TASK_TYPE, DEADLINE_LATENCY_CLASS } from '../../src/order/task-order';
import type { BuilderSetSnapshot, ServiceDescriptorRef, BeaconView, ParameterBucketView } from '../../src/types/hub';
import { privKeySecp256k1Signer, privKeySecp256k1DigestSigner, secp256k1PublicKey, secp256k1Address } from '../../src/signer/secp256k1';
import { privKeyEip712Signer } from '../../src/signer/eth-secp256k1';
import { fromHex, toHex } from '../../src/util/bytes';

// ADR-0015: after a Builder rotates its certificate, the new fingerprint goes on-chain, but the
// descriptor the client is holding may still be the old fingerprint. If the handshake check
// mismatches, re-read that Builder's descriptor, and if the fingerprint changed, retry once with
// the new fingerprint - only once.

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const signer = privKeySecp256k1Signer(PRIV);
const orderSigner = privKeyEip712Signer(PRIV);
const pub = secp256k1PublicKey(PRIV);
const USER = secp256k1Address(pub, 'trueopen');
const hexOf = (b: number): string => toHex(new Uint8Array(32).fill(b));
const amount = (atomicUnits: string) => ({ atomicUnits });
const SESSION = 'b793a05ff8441795fca46a890b906b0c81af9d8d7a4d53e82de53a1c917b9883';
const ADDRS = [
  'trueopen1yfse4c367uc2rja5g3905ynmnuv2hjk8gcgvfl',
  'trueopen1870sqtdru7dj3xgwpzcexry0dwvyz2ku7xv9mg',
  'trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man',
];
const STALE = 'aa'.repeat(32);
const FRESH = 'bb'.repeat(32);

const snapshot: BuilderSetSnapshot = {
  builderSetId: 'genesis-1', builderSetVersion: 1n, effectiveHeight: 1n, builders: ADDRS.join(','), setHash: hexOf(0x15), };

const order: TaskOrderIntent = {
  modelId: 'hf-ad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b',
  profileVersion: 1, taskType: TASK_TYPE.TEXT_GENERATION, payload: new TextEncoder().encode('trueopen-input'),
  inputBucket: 1, outputBudgetBucket: 1, generationParams: defaultGenerationParams(128n, 2_000n),
  amounts: {
    priceBid: amount('100000'), maxFee: amount('1000'),
    assignmentPriorityFee: amount('0'), txFeeReserve: amount('0'),
  },
  earliestSubmitHeight: 1_000n, orderExpireHeight: 51_000n, latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
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

/** hub stub: each Builder's descriptor first returns the stale fingerprint, then fresh after being re-read (or stays stale). */
function makeHub(afterReread: string) {
  const reads: Record<string, number> = {};
  const hub = {
    getLatestHeight: async (): Promise<bigint> => 1_000n,
    getActiveBuilderSet: async (): Promise<BuilderSetSnapshot> => snapshot,
    getBeacon: async (height: bigint): Promise<BeaconView> => ({
      height, blockHash: hexOf(0x14), randomnessHex: hexOf(0x01), sourceTag: 'proposer_vrf_v1', verified: true,
    }),
    getTaskGenerationLimits: async () => ({
      maxOutputTokens: 131_072n, topKMax: 1000n, stopSequenceMaxItems: 16n,
      stopSequenceMaxBytesEach: 128n, stopSequenceMaxTotalBytes: 1024n, stopTokenMaxItems: 64n,
    }),
    getParameterBucket: async (kind: string): Promise<ParameterBucketView> => ({
      bucketKind: kind, bucketKey: 'default', version: 1n, currentVersion: 1n, effectiveHeight: 0n,
    }),
    getServiceDescriptor: async (id: string): Promise<ServiceDescriptorRef> => {
      reads[id] = (reads[id] ?? 0) + 1;
      const hash = reads[id] === 1 ? STALE : afterReread;
      return {
        participantType: 'PARTICIPANT_TYPE_BUILDER', participantId: id, descriptorVersion: BigInt(reads[id]),
        endpoints: [{ endpointKind: 'SERVICE_ENDPOINT_KIND_NEXUS_GRPC', uri: `https://${id}:8443`, protocolVersion: 'v1', tlsPubkeyHash: hash }],
        descriptorHash: hexOf(0xaa), updatedHeight: 1n,
      };
    },
  } as never;
  return { hub, reads };
}

/**
 * transport stub: a connection with the stale fingerprint fails the handshake check - this is a
 * client-side socket-layer error (thrown by PinnedHttpsAgent, wrapped by Connect as
 * ConnectError.cause), not an error returned by the server, so the transport method rejects
 * directly; a fresh fingerprint is accepted.
 */
function pinAwareFactory(seen: { pins: string[] }) {
  return (_endpoint: string, tlsPubkeyHash = ''): Transport => {
    seen.pins.push(tlsPubkeyHash);
    if (tlsPubkeyHash !== FRESH) {
      const mismatch = new TrueOpenError('NEXUS_INGRESS', 'NEXUS_TLS_PUBKEY_MISMATCH', `presented ${FRESH}, descriptor commits ${tlsPubkeyHash}`);
      const wrapped = ConnectError.from(mismatch, Code.Unavailable);
      return { unary: () => Promise.reject(wrapped), stream: () => Promise.reject(wrapped) } as unknown as Transport;
    }
    return createRouterTransport(({ service }) => {
      service(IngressAPI, {
        async openTask(reqs: AsyncIterable<OpenTaskRequest>) {
          for await (const _f of reqs) { /* drain */ }
          return { taskId: '', accepted: true, reason: '', sessionId: SESSION };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    });
  };
}

function makeClient(hub: unknown, seen: { pins: string[] }): TrueOpenClient {
  const factory = pinAwareFactory(seen);
  return new TrueOpenClient({
    chainId: 'trueopen-localnet-1', userAddress: USER, signerPubKey: pub, signer, orderSigner,
      evmChainId: 424242n, feeDenom: 'utrueopen',
    // The default transport used for construction is not counted in seen: openTask only goes through ingressTransportFactory.
    chain: fakeChain(), ingressTransport: pinAwareFactory({ pins: [] })('unused', FRESH),
    hub: hub as never, ingressTransportFactory: factory,
    nonce: () => new Uint8Array([1, 2, 3]),
  });
}

describe('openTask: re-reads the descriptor and retries once on a fingerprint mismatch', () => {
  it('when the fingerprint changed after re-reading, retries with the new fingerprint and gets accepted; each Builder is re-read only once', async () => {
    const { hub, reads } = makeHub(FRESH);
    const seen = { pins: [] as string[] };
    const res = await makeClient(hub, seen).openTask({ sessionId: SESSION, orderSequence: 3n, order, idempotencyKey: 'idem-1' });

    expect(res.accepted).toBe(true);
    // 3 endpoints: one stale failure plus one fresh success each.
    expect(seen.pins.filter((p) => p === STALE)).toHaveLength(3);
    expect(seen.pins.filter((p) => p === FRESH)).toHaveLength(3);
    for (const address of ADDRS) expect(reads[address]).toBe(2);
  });

  it('when the fingerprint did not change after re-reading, does not retry again, and the original error stays in the details', async () => {
    const { hub, reads } = makeHub(STALE);
    const seen = { pins: [] as string[] };
    await expect(
      makeClient(hub, seen).openTask({ sessionId: SESSION, orderSequence: 3n, order, idempotencyKey: 'idem-1' }),
    ).rejects.toMatchObject({ code: 'TASK_BUILDER_ALL_ENDPOINTS_FAILED' });
    expect(seen.pins).toHaveLength(3); // no second connection
    for (const address of ADDRS) expect(reads[address]).toBe(2); // re-read once
  });
});
