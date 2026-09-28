import { describe, it, expect } from 'vitest';
import { createRouterTransport } from '@connectrpc/connect';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import type {
  PrepareChallengeRequest,
  GetTaskEventsRequest,
  SubscribeOutputRequest,
  AckOutputRequest,
} from '../../src/gen/nexus/v1/ingress_pb.js';
import { IngressClient } from '../../src/transport/ingress-client';
import type { IngressAuth } from '../../src/transport/ingress-client';
import {
  getTaskEventsBodyDigest,
  prepareChallengeBodyDigest,
  subscribeOutputBodyDigest,
  ackOutputBodyDigest,
} from '../../src/transport/sdk-request-body';
import { toHex, fromHex } from '../../src/util/bytes';
import { privateKeyTypedDataSigner } from '../../src/signer/typed-data-signer';
import { ethSecp256k1Address } from '../../src/signer/eth-secp256k1';
import { secp256k1PublicKey } from '../../src/signer/secp256k1';
import { sdkRequestEip712Digest } from '../../src/transport/sdk-request-envelope';
import { recoverEip712Address } from '../../src/signer/eth-secp256k1';

// Base vectors of wire testdata/v1/task/sdk_request_body_v1.json and its replay rows
// (sdk-request-body.test.ts reproduces the whole file; these pin what the client sends).
const S = '77625100ba4faa1306ae6eaf5a872a661443aa94f87c5530c4b178614e3d62f7';
const T = 'bce966ae829f212a35982bcd85aaea77d8893539afa04f32ea540c46ff8323b0';
const EVIDENCE = fromHex('77'.repeat(32));
const G = {
  events: '2fd7bcf6e3f290484b0dc8b81c8d0614f6d5c63d67af639fd9b7c394e29c0bc1',
  events42: '508b01f226f6eb039409c3d6ee689d4d6e5eb24328ca6ea9cc43022dd87a1347',
  prepare: '0a0495f67bf1ca40f83d34ad2fe2a538095f31580ba3c592c4e270b66d1eaa7c',
  subscribe: 'e319c6b85eeacab31efcaa60691628f0fbf232d6be43191b253d93c94e1d868a',
  subscribeResume17: '7b230a93c7f5fc5cb6360eb6177c072c75c4e16c7c1070d94b8a0107271ca128',
  ack17: '219f5f4df140e7bb3de73f7c09277c7b75cda76186ddd5cdd691cefa370e11fa',
};

describe('body_digest builders (wire vectors)', () => {
  it('every method matches its vector', () => {
    expect(toHex(getTaskEventsBodyDigest(S, T, ''))).toBe(G.events);
    expect(toHex(getTaskEventsBodyDigest(S, T, '42'))).toBe(G.events42);
    expect(toHex(prepareChallengeBodyDigest(S, T, 'USER_DISPUTE', EVIDENCE))).toBe(G.prepare);
    expect(toHex(subscribeOutputBodyDigest(S, T))).toBe(G.subscribe);
    expect(toHex(subscribeOutputBodyDigest(S, T, 17n))).toBe(G.subscribeResume17);
    expect(toHex(ackOutputBodyDigest(S, T, 17n))).toBe(G.ack17);
  });
});

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const USER = ethSecp256k1Address(secp256k1PublicKey(PRIV), 'trueopen');
const auth: IngressAuth = {
  chainId: 'trueopen-devnet-1',
  userAddress: USER,
  wallet: privateKeyTypedDataSigner(PRIV),
  evmChainId: 424242n,
  nonce: () => new Uint8Array(32).fill(3),
  expiry: () => 1893456000000n,
};

interface Captured {
  prepare?: PrepareChallengeRequest;
  events?: GetTaskEventsRequest;
  subscribe?: SubscribeOutputRequest;
  ack?: AckOutputRequest;
}

function client(cap: Captured, withAuth = true): IngressClient {
  const transport = createRouterTransport(({ service }) => {
    service(IngressAPI, {
      prepareChallenge(req: PrepareChallengeRequest) {
        cap.prepare = req;
        return { challengeOpen: true, challengeCloseHeight: 999n, requiredEvidence: ['e1'], estimatedBond: { denom: 'utrueopen', amount: '5' }, estimatedGas: 21000n };
      },
      async *getTaskEvents(req: GetTaskEventsRequest) {
        cap.events = req;
        yield { cursor: '43', state: 'VERIFYING', taskPhase: 'OPEN_VERIFY', eventCode: 'OPEN_VERIFY_ACCEPTED', chainHeight: 100n };
      },
      async *subscribeOutput(req: SubscribeOutputRequest) {
        cap.subscribe = req;
        yield { outputId: 'out-1', sessionId: req.sessionId, taskId: req.taskId, outputText: 'hi', outputHash: new Uint8Array(), createdAt: 1n, expiresAt: 2n };
      },
      ackOutput(req: AckOutputRequest) {
        cap.ack = req;
        return { acked: true, alreadyAcked: false, ackedAt: 3n };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });
  return withAuth ? new IngressClient(transport, auth) : new IngressClient(transport);
}

describe('IngressClient signed methods (router transport)', () => {
  it('prepareChallenge maps the request and returns a plan', async () => {
    const cap: Captured = {};
    const res = await client(cap).prepareChallenge({ sessionId: S, taskId: T, challengeKind: 'USER_DISPUTE', localEvidenceDigest: EVIDENCE });
    expect(toHex(cap.prepare?.requestEnvelope?.bodyDigest as Uint8Array)).toBe(G.prepare);
    expect(res.challengeOpen).toBe(true);
    expect(res.estimatedBond?.amount).toBe('5');
  });

  it('getTaskEvents streams + body_digest', async () => {
    const cap: Captured = {};
    const events = [];
    for await (const ev of client(cap).getTaskEvents({ sessionId: S, taskId: T, fromCursor: '42' })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.eventCode).toBe('OPEN_VERIFY_ACCEPTED');
    expect(toHex(cap.events?.requestEnvelope?.bodyDigest as Uint8Array)).toBe(G.events42);
  });

  it('subscribeOutput signs + body_digest + yields frame by frame', async () => {
    const cap: Captured = {};
    let n = 0;
    for await (const _ of client(cap).subscribeOutput({ sessionId: S, taskId: T, resumeAfterSeq: 17n })) n += 1;
    expect(n).toBeGreaterThan(0);
    expect(cap.subscribe?.requestEnvelope?.method).toBe('SubscribeOutput');
    expect(toHex(cap.subscribe?.requestEnvelope?.bodyDigest as Uint8Array)).toBe(G.subscribeResume17);
    expect(cap.subscribe?.resumeAfterSeq).toBe(17n);
  });

  it('ackOutput signs + body_digest', async () => {
    const cap: Captured = {};
    const res = await client(cap).ackOutput({ sessionId: S, taskId: T, lastSeq: 17n });
    expect(res.acked).toBe(true);
    expect(cap.ack?.requestEnvelope?.method).toBe('AckOutput');
    expect(toHex(cap.ack?.requestEnvelope?.bodyDigest as Uint8Array)).toBe(G.ack17);
    expect(cap.ack?.lastSeq).toBe(17n);
    const env = cap.ack!.requestEnvelope!;
    expect(env.requestDomain).toBe('TRUEOPEN_SDK_REQUEST_V2');
    expect(env.endpoint).toBe('/nexus.v1.IngressAPI/AckOutput');
    expect(env.signerAddress).toBe(USER);
    expect(env.signerPubkey).toHaveLength(0);
    expect(env.signature).toHaveLength(65);
    const digest = sdkRequestEip712Digest({
      chainId: env.chainId, method: env.method, sessionId: env.sessionId, taskId: env.taskId,
      requestNonce: env.requestNonce, expiryHeightOrTime: BigInt(env.expiryHeightOrTime), bodyDigest: env.bodyDigest,
    }, 424242n);
    expect(recoverEip712Address(digest, env.signature, 'trueopen')).toBe(USER);
  });

  it('a nonce that is not 32 bytes, or a height expiry, is refused before signing', async () => {
    const transport = createRouterTransport(() => {});
    const short = new IngressClient(transport, { ...auth, nonce: () => new Uint8Array(16) });
    await expect(short.ackOutput({ sessionId: S, taskId: T, lastSeq: 1n })).rejects.toMatchObject({ code: 'SDK_LOCAL_REQUEST_MALFORMED' });
    const height = new IngressClient(transport, { ...auth, expiry: () => 1000n });
    await expect(height.ackOutput({ sessionId: S, taskId: T, lastSeq: 1n })).rejects.toMatchObject({ code: 'SDK_LOCAL_EXPIRY_NOT_TIME' });
  });

  it('a signed method throws when there is no auth', async () => {
    await expect(
      client({}, false).prepareChallenge({ sessionId: S, taskId: T, challengeKind: 'USER_DISPUTE' }),
    ).rejects.toThrow(/auth/);
  });
});
