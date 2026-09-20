import { describe, it, expect } from 'vitest';
import { createRouterTransport } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import {
  IngressAPI,
  CredentialV1Schema,
} from '../../src/gen/nexus/v1/ingress_pb.js';
import type {
  FetchOutputRefRequest,
  RefreshCredentialRequest,
  PrepareChallengeRequest,
  GetTaskEventsRequest,
  SubscribeOutputRequest,
  AckOutputRequest,
} from '../../src/gen/nexus/v1/ingress_pb.js';
import { IngressClient } from '../../src/transport/ingress-client';
import type { IngressAuth } from '../../src/transport/ingress-client';
import {
  fetchOutputRefBodyDigest,
  getTaskEventsBodyDigest,
  refreshCredentialBodyDigest,
  prepareChallengeBodyDigest,
  subscribeOutputBodyDigest,
  ackOutputBodyDigest,
} from '../../src/transport/sdk-request-envelope';
import { toHex, fromHex } from '../../src/util/bytes';
import { privKeySecp256k1Signer, secp256k1PublicKey } from '../../src/signer/secp256k1';

// Independent Python oracle golden values (per-method field order for nexus body_digest)
const G = {
  fetch: 'dc59dcf8cce7492629cbd6536747bf79e23db60af9f49baf980e09a3df8c185b',
  events: '1b778156e522d5f03f85fe3f5fb32966585408a9cab40e1887815ab9cfd332d8',
  refresh: 'e48446194c29b2a25851568219ba5891f87831b6cbc4670630e62e14a6c9d17a',
  prepare: 'ba8ef5c4f10b559d8e67e2bc2c0786e48b5b9305eb72b6335ae15b2fbd9b70ea',
  subscribe: '2e2aed93c4a53d587cec600418f365a52a2be80a2e99694a08e0be1c39ed321f',
  // Three fields (session_id, task_id, output_id). output_id is deprecated but still goes into
  // the signature, matching nexus main's ackOutputStream. Over the streaming path the SDK sends
  // an empty string, so the golden value uses the empty-string variant; the variant with a value
  // is listed separately as ackWithOutputId, to prove the third field really is part of the digest.
  ack: '6214a0124e3da6b4fde3b93072394d7a88e3c8adeb8089b59acf654074b8a074',
  ackWithOutputId: 'cbe324c92c2eb5b9d2230f81af050e7704a98058d5c2d4a1f460d4718d270ec8',
};

describe('body_digest builders (nexus oracle golden)', () => {
  it('every method\'s field order matches byte-for-byte', () => {
    expect(toHex(fetchOutputRefBodyDigest('sess-1', 'task-1', 'trueopen1u', 'SEALED_KEY', 'SDK_DELIVERY'))).toBe(G.fetch);
    expect(toHex(getTaskEventsBodyDigest('sess-1', 'task-1', '42'))).toBe(G.events);
    expect(toHex(refreshCredentialBodyDigest('cred-1', 'sess-1', 'task-1', 'trueopen1u', 'SDK_DELIVERY', 1893456000000n))).toBe(G.refresh);
    expect(toHex(prepareChallengeBodyDigest('sess-1', 'task-1', 'USER_REVALIDATION', new Uint8Array([0xde, 0xad])))).toBe(G.prepare);
    expect(toHex(subscribeOutputBodyDigest('sess-1', 'task-1'))).toBe(G.subscribe);
    expect(toHex(ackOutputBodyDigest('sess-1', 'task-1'))).toBe(G.ack);
    // output_id defaults to an empty string; a value changes the digest - proving the third field really does participate.
    expect(toHex(ackOutputBodyDigest('sess-1', 'task-1', ''))).toBe(G.ack);
    expect(toHex(ackOutputBodyDigest('sess-1', 'task-1', 'out-1'))).toBe(G.ackWithOutputId);
    // An empty third field is not the same as "this field is absent": under length-prefixed framing, it has 4 extra bytes of zero-length prefix compared to the two-field version.
    expect(G.ack).not.toBe(G.subscribe);
  });
});

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const auth: IngressAuth = {
  chainId: 'trueopen-devnet-1',
  userAddress: 'trueopen1u',
  signerPubKey: secp256k1PublicKey(PRIV),
  signer: privKeySecp256k1Signer(PRIV),
  nonce: () => new Uint8Array([1, 2, 3]),
  expiry: () => 1893456000000n,
};

interface Captured {
  fetch?: FetchOutputRefRequest;
  refresh?: RefreshCredentialRequest;
  prepare?: PrepareChallengeRequest;
  events?: GetTaskEventsRequest;
  subscribe?: SubscribeOutputRequest;
  ack?: AckOutputRequest;
}

function client(cap: Captured, withAuth = true): IngressClient {
  const transport = createRouterTransport(({ service }) => {
    service(IngressAPI, {
      fetchOutputRef(req: FetchOutputRefRequest) {
        cap.fetch = req;
        return { outputRef: undefined, credential: undefined };
      },
      refreshCredential(req: RefreshCredentialRequest) {
        cap.refresh = req;
        return { credential: undefined, outputRef: undefined };
      },
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
  it('fetchOutputRef signs and maps access_level/usage', async () => {
    const cap: Captured = {};
    await client(cap).fetchOutputRef({ sessionId: 'sess-1', taskId: 'task-1', requester: 'trueopen1u', accessLevel: 'SEALED_KEY', usage: 'SDK_DELIVERY' });
    expect(cap.fetch?.accessLevel).toBe(1); // SEALED_KEY
    expect(toHex(cap.fetch?.requestEnvelope?.bodyDigest as Uint8Array)).toBe(G.fetch);
    expect(cap.fetch?.requestEnvelope?.method).toBe('FetchOutputRef');
  });

  it('refreshCredential body_digest uses credential_id', async () => {
    const cap: Captured = {};
    const credential = create(CredentialV1Schema, { credentialId: 'cred-1' });
    await client(cap).refreshCredential({ credential, sessionId: 'sess-1', taskId: 'task-1', recipient: 'trueopen1u', usage: 'SDK_DELIVERY', requestedValidUntil: 1893456000000n });
    expect(toHex(cap.refresh?.requestEnvelope?.bodyDigest as Uint8Array)).toBe(G.refresh);
  });

  it('prepareChallenge maps the request and returns a plan', async () => {
    const cap: Captured = {};
    const res = await client(cap).prepareChallenge({ sessionId: 'sess-1', taskId: 'task-1', challengeKind: 'USER_REVALIDATION', localEvidenceDigest: new Uint8Array([0xde, 0xad]) });
    expect(toHex(cap.prepare?.requestEnvelope?.bodyDigest as Uint8Array)).toBe(G.prepare);
    expect(res.challengeOpen).toBe(true);
    expect(res.estimatedBond?.amount).toBe('5');
  });

  it('getTaskEvents streams + body_digest', async () => {
    const cap: Captured = {};
    const events = [];
    for await (const ev of client(cap).getTaskEvents({ sessionId: 'sess-1', taskId: 'task-1', fromCursor: '42' })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.eventCode).toBe('OPEN_VERIFY_ACCEPTED');
    expect(toHex(cap.events?.requestEnvelope?.bodyDigest as Uint8Array)).toBe(G.events);
  });

  it('subscribeOutput signs + body_digest + yields frame by frame', async () => {
    const cap: Captured = {};
    let n = 0;
    for await (const _ of client(cap).subscribeOutput({ sessionId: 'sess-1', taskId: 'task-1' })) n += 1;
    expect(n).toBeGreaterThan(0);
    expect(cap.subscribe?.requestEnvelope?.method).toBe('SubscribeOutput');
    expect(toHex(cap.subscribe?.requestEnvelope?.bodyDigest as Uint8Array)).toBe(G.subscribe);
  });

  it('ackOutput signs + body_digest', async () => {
    const cap: Captured = {};
    const res = await client(cap).ackOutput({ sessionId: 'sess-1', taskId: 'task-1', lastSeq: 2n });
    expect(res.acked).toBe(true);
    expect(cap.ack?.requestEnvelope?.method).toBe('AckOutput');
    expect(toHex(cap.ack?.requestEnvelope?.bodyDigest as Uint8Array)).toBe(G.ack);
  });

  it('a signed method throws when there is no auth', async () => {
    await expect(
      client({}, false).fetchOutputRef({ sessionId: 's', taskId: 't', requester: 'r', accessLevel: 'PACKAGE', usage: 'u' }),
    ).rejects.toThrow(/auth/);
  });
});
