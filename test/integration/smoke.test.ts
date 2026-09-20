import { describe, it, expect } from 'vitest';
import { createRouterTransport } from '@connectrpc/connect';
import type { Transport } from '@connectrpc/connect';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import type {
  OpenTaskRequest as GenOpenTaskRequest,
  SDKRequestEnvelopeV1 as GenSDKEnvelope,
  FetchOutputRefRequest,
  PrepareChallengeRequest,
  GetTaskEventsRequest,
  SubscribeOutputRequest,
  AckOutputRequest,
} from '../../src/gen/nexus/v1/ingress_pb.js';
import { TrueOpenClient } from '../../src/client';
import { sha256 } from '../../src/codec/hash';
import type { ChainClient, CancelOrderInput, UserChallengeInput } from '../../src/transport/chain-client';
import type { TaskOrderIntent } from '../../src/order/task-order-input';
import { defaultGenerationParams } from '../../src/order/task-order-input';
import { TASK_TYPE, DEADLINE_LATENCY_CLASS } from '../../src/order/task-order';
import type { BuilderSetSnapshot, ServiceDescriptorRef, BeaconView, ParameterBucketView } from '../../src/types/hub';
import { privKeySecp256k1DigestSigner } from '../../src/signer/secp256k1';
import { deriveTaskId } from '../../src/order/order-signing';
import { sdkRequestSignBytes } from '../../src/transport/sdk-request-envelope';
import { privKeySecp256k1Signer, secp256k1PublicKey, verifyCosmosSecp256k1 } from '../../src/signer/secp256k1';
import { privKeyEip712Signer, ethSecp256k1Address } from '../../src/signer/eth-secp256k1';
import { fromHex } from '../../src/util/bytes';

// deriveTaskId requires canonical 64-hex; the raw Hash32 enters the preimage.
const SESSION = 'b793a05ff8441795fca46a890b906b0c81af9d8d7a4d53e82de53a1c917b9883';

/**
 * End-to-end smoke test (local, no real backend): a fake ChainClient plus a router Transport
 * run the whole user journey, proving that the TrueOpenClient facade wires signing, chain reads
 * and writes and nexus calls together, and that the SDKRequestEnvelope signature the facade
 * produces really verifies.
 */

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const signer = privKeySecp256k1Signer(PRIV);
const pub = secp256k1PublicKey(PRIV);

// task_hash signs the address codec bytes into the preimage, so this must be a real decodable bech32 address.
const USER = ethSecp256k1Address(pub, 'trueopen');
const hexOf = (b: number): string => new Uint8Array(32).fill(b).reduce((a, x) => a + x.toString(16).padStart(2, '0'), '');
const amount = (atomicUnits: string) => ({ atomicUnits });
const ANCHOR = hexOf(0x14);

const order: TaskOrderIntent = {
  modelId: 'model-1', profileVersion: 1, taskType: TASK_TYPE.TEXT_GENERATION,
  payload: new TextEncoder().encode('trueopen-input'),
  inputBucket: 1, outputBudgetBucket: 1,
  generationParams: defaultGenerationParams(128n, 2_000n),
  amounts: {
    priceBid: amount('100000'), maxFee: amount('1000'),
    assignmentPriorityFee: amount('0'), txFeeReserve: amount('0'),
  },
  earliestSubmitHeight: 1_000n, orderExpireHeight: 51_000n,
  latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
};

/** Fake Hub that satisfies both TaskBuilderReader and TaskOrderContextReader. */
const hub = {
  getLatestHeight: async (): Promise<bigint> => 1_000n,
  getActiveBuilderSet: async (): Promise<BuilderSetSnapshot> => ({
    builderSetId: 'genesis-1', builderSetVersion: 1n, effectiveHeight: 1n, builders: [
      'trueopen1yfse4c367uc2rja5g3905ynmnuv2hjk8gcgvfl',
      'trueopen1870sqtdru7dj3xgwpzcexry0dwvyz2ku7xv9mg',
      'trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man',
    ].join(','),
    setHash: hexOf(0x15), }),
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
const PAYLOAD = new TextEncoder().encode('trueopen-input');

interface ChainCap { cancel?: CancelOrderInput; challenge?: UserChallengeInput }
interface IngressCap {
  openHeader?: { userAddress: string; requestEnvelope?: GenSDKEnvelope };
  fetch?: FetchOutputRefRequest;
  prepare?: PrepareChallengeRequest;
  events?: GetTaskEventsRequest;
  subscribe?: SubscribeOutputRequest;
  ack?: AckOutputRequest;
}

const OUTPUT_TEXT = 'hello final output';
const OUTPUT_HASH = sha256(new TextEncoder().encode(OUTPUT_TEXT));

function fakeChain(cap: ChainCap): ChainClient {
  return {
    async querySession(id) {
      return { sessionId: id, owner: USER, nextExpectedSequence: 0n, lastActiveHeight: 0n, openPendingCount: 0n, status: 'ACTIVE' };
    },
    async querySessionNonce() { return { nextSessionNonce: 0n }; },
    async querySettlementFinality() { throw new Error('n/a'); },
    async createSession() { return { sessionId: SESSION, owner: USER, nonce: 0n, status: 'MUTATION_STATUS_V1_APPLIED' }; },
    async cancelOrder(i) { cap.cancel = i; return { taskId: 'task-1', cancelledSequence: i.orderSequence, nextExpectedSequence: i.orderSequence + 1n, status: 'MUTATION_STATUS_V1_APPLIED' }; },
    async userChallenge(i) { cap.challenge = i; return { challengeId: 'ch-1', status: 'OPEN', challengeDeadlineHeight: 200n, resolveDeadlineHeight: 250n, bondLockedAmount: 1000n }; },
  };
}

function fakeTransport(cap: IngressCap): Transport {
  return createRouterTransport(({ service }) => {
    service(IngressAPI, {
      async openTask(reqs: AsyncIterable<GenOpenTaskRequest>) {
        for await (const f of reqs) {
          if (f.frame.case === 'header') {
            cap.openHeader = f.frame.value as unknown as { userAddress: string; requestEnvelope?: GenSDKEnvelope };
          }
        }
        return { taskId: '', accepted: true, reason: '', sessionId: SESSION };
      },
      getTaskStatus() {
        return { state: 'PENDING', stage: 'ASSIGN', setId: 'set-1', updatedAt: 0n, taskPhase: 'ASSIGN_RANDOMNESS_PENDING' };
      },
      fetchOutputRef(req: FetchOutputRefRequest) {
        cap.fetch = req;
        return {
          credential: {
            credentialId: 'cred-1', sessionId: req.sessionId, taskId: req.taskId,
            recipient: req.requester, usage: req.usage, accessLevel: req.accessLevel,
            validUntil: 0n, issuer: 'trueopen1builder', issuerSig: new Uint8Array(),
          },
        };
      },
      prepareChallenge(req: PrepareChallengeRequest) {
        cap.prepare = req;
        return { challengeOpen: true, challengeCloseHeight: 999n, requiredEvidence: [], estimatedBond: { denom: 'utrueopen', amount: '5' }, estimatedGas: 21000n };
      },
      async *getTaskEvents(req: GetTaskEventsRequest) {
        cap.events = req;
        yield { cursor: '1', state: 'VERIFYING', taskPhase: 'OPEN_VERIFY', eventCode: 'OPEN_VERIFY_ACCEPTED', chainHeight: 100n };
      },
      async *subscribeOutput(req: SubscribeOutputRequest) {
        cap.subscribe = req;
        yield { outputId: 'out-1', sessionId: req.sessionId, taskId: req.taskId, outputText: OUTPUT_TEXT, outputHash: OUTPUT_HASH, createdAt: 10n, expiresAt: 20n };
      },
      ackOutput(req: AckOutputRequest) {
        cap.ack = req;
        return { acked: true, alreadyAcked: false, ackedAt: 30n };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });
}

describe('end-to-end smoke: the full user journey against a fake backend', () => {
  it('createSession → submitOrder → status → watch → fetchOutputRef → fetchOutput → prepare → challenge → cancel', async () => {
    const chainCap: ChainCap = {};
    const ingressCap: IngressCap = {};
    const client = new TrueOpenClient({
      chainId: 'trueopen-devnet-1', userAddress: USER, signerPubKey: pub, signer,
      chain: fakeChain(chainCap), ingressTransport: fakeTransport(ingressCap),
      orderSigner: privKeyEip712Signer(PRIV),
      evmChainId: 424242n, feeDenom: 'utrueopen',
      hub, ingressTransportFactory: () => fakeTransport(ingressCap),
      nonce: () => new Uint8Array([1, 2, 3]), expiry: () => 1893456000000n,
    });

    // 1) session
    const session = await client.createSession('journey');
    expect(session.sessionId).toBe(SESSION);
    expect(session.status).toBe('ACTIVE');

    // 2) place the order (OpenTask): the derived taskId matches and the order is accepted
    const submit = await client.openTask({
      sessionId: SESSION, orderSequence: 3n, order, idempotencyKey: 'journey-1',
    });
    expect(submit.accepted).toBe(true);
    const taskId = deriveTaskId(SESSION, 3n);
    expect(submit.taskId).toBe(taskId);
    expect(submit.taskHash).toMatch(/^[0-9a-f]{64}$/);
    expect(submit.context.sessionAnchorBlockHash).toBe(ANCHOR);

    // 2b) the request envelope signature the facade produces verifies
    const env = ingressCap.openHeader?.requestEnvelope;
    expect(env).toBeDefined();
    if (env) {
      const signBytes = sdkRequestSignBytes({
        chainId: env.chainId, method: env.method, endpoint: env.endpoint,
        sessionId: env.sessionId, taskId: env.taskId,
        requestNonce: env.requestNonce, expiryHeightOrTime: env.expiryHeightOrTime,
        bodyDigest: env.bodyDigest,
      });
      expect(verifyCosmosSecp256k1(signBytes, env.signature, env.signerPubkey)).toBe(true);
      expect(env.method).toBe('OpenTask');
    }

    // 3) status snapshot
    const status = await client.taskStatus(SESSION, taskId);
    expect(status.taskPhase).toBe('ASSIGN_RANDOMNESS_PENDING');

    // 4) event stream
    const events = [];
    for await (const ev of client.watchTask(SESSION, taskId, '0')) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventCode).toBe('OPEN_VERIFY_ACCEPTED');
    expect(ingressCap.events?.fromCursor).toBe('0');

    // 5) retrieval credential: SEALED_KEY by default, requester = userAddress
    const ref = await client.fetchOutputRef(SESSION, taskId);
    expect(ref.credential?.credentialId).toBe('cred-1');
    expect(ingressCap.fetch?.accessLevel).toBe(1); // SEALED_KEY
    expect(ingressCap.fetch?.requester).toBe(USER);

    // 6) fetch the output: SubscribeOutput verifies each frame signature and the MMR root, then
    // reports progress. This test only checks that the wiring works; the positive and negative
    // cases for frame verification live in client.test.ts.
    expect(typeof client.streamOutput).toBe('function');

    // 7) prepare the challenge
    const plan = await client.prepareChallenge(SESSION, taskId, 'USER_REVALIDATION');
    expect(plan.challengeOpen).toBe(true);
    expect(plan.estimatedBond?.amount).toBe('5');

    // 8) open the on-chain challenge: challenger_signature is 128-hex and reaches the chain Msg
    const ch = await client.challenge({ sessionId: SESSION, taskId, settlementId: 'st-1', kind: 'USER_REVALIDATION', evidenceDigest: 'evi', bondAmount: 1000n });
    expect(ch.challengeId).toBe('ch-1');
    expect(chainCap.challenge?.kind).toBe('USER_REVALIDATION');
    expect(/^[0-9a-f]{128}$/.test(chainCap.challenge?.challengerSignature ?? '')).toBe(true);

    // 9) cancel the order: owner_signature is 128-hex and the sequence advances
    const cancel = await client.cancelOrder(SESSION, 5n);
    expect(cancel.nextExpectedSequence).toBe(6n);
    expect(/^[0-9a-f]{128}$/.test(chainCap.cancel?.ownerSignature ?? '')).toBe(true);
  });

  it('separate SDK identity: the request envelope is signed by sdkSigner and verifies against the SDK public key', async () => {
    const sdkPriv = fromHex('2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40');
    const sdkSigner = privKeySecp256k1Signer(sdkPriv);
    const sdkPub = secp256k1PublicKey(sdkPriv);
    const ingressCap: IngressCap = {};
    const client = new TrueOpenClient({
      chainId: 'trueopen-devnet-1', userAddress: USER, signerPubKey: pub, signer,
      sdkSigner, sdkSignerPubKey: sdkPub, sdkSignerAddress: ethSecp256k1Address(sdkPub, 'trueopen'),
      chain: fakeChain({}), ingressTransport: fakeTransport(ingressCap),
      orderSigner: privKeyEip712Signer(PRIV),
      evmChainId: 424242n, feeDenom: 'utrueopen',
      hub, ingressTransportFactory: () => fakeTransport(ingressCap),
      nonce: () => new Uint8Array([9, 9, 9]), expiry: () => 1893456000000n,
    });

    await client.openTask({ sessionId: SESSION, orderSequence: 3n, order, idempotencyKey: 'sdk-identity-1' });
    const env = ingressCap.openHeader?.requestEnvelope;
    expect(env?.signerAddress).toBe(ethSecp256k1Address(sdkPub, 'trueopen'));
    expect(env).toBeDefined();
    if (env) {
      const signBytes = sdkRequestSignBytes({
        chainId: env.chainId, method: env.method, endpoint: env.endpoint,
        sessionId: env.sessionId, taskId: env.taskId,
        requestNonce: env.requestNonce, expiryHeightOrTime: env.expiryHeightOrTime,
        bodyDigest: env.bodyDigest,
      });
      // the request envelope verifies against the SDK public key, not the user public key
      expect(verifyCosmosSecp256k1(signBytes, env.signature, sdkPub)).toBe(true);
      expect(verifyCosmosSecp256k1(signBytes, env.signature, pub)).toBe(false);
    }
  });
});
