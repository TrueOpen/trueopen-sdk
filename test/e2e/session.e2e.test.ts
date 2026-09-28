/**
 * Session grants on the simulated network: the fake Builders verify every grant and every
 * session-key signature with the SDK-independent checks (support/independent.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { OpenTaskHeaderSchema, OpenTaskRequestSchema } from '../../src/gen/nexus/v1/ingress_pb.js';
import type { OpenTaskRequest } from '../../src/gen/nexus/v1/ingress_pb.js';
import { TrueOpenError } from '../../src/errors/errors';
import { privateKeyTypedDataSigner } from '../../src/signer/typed-data-signer';
import type { TypedData, TypedDataSigner } from '../../src/signer/typed-data-signer';
import { sdkRequestTypedData, signSdkRequestEnvelope } from '../../src/transport/sdk-request-envelope';
import { ackOutputBodyDigest } from '../../src/transport/sdk-request-body';
import { envelopeMessage } from '../../src/transport/ingress-client';
import { resolveTaskOrderContext, buildTaskOrder } from '../../src/order/task-order-input';
import { buildOpenTaskRequest } from '../../src/order/build-open-task';
import type { OutputStreamEvent, TrueOpenClient } from '../../src/client';
import { startWorld, acceptOnChain, drawWinner, landReceipt, outputText, STREAM } from './support/harness';
import type { World } from './support/harness';
import * as w from './support/world';
import { MAX_SESSION_GRANT_BLOCKS } from './support/fake-nexus';

let world: World;
let sessionId: string;
beforeEach(async () => {
  world = await startWorld();
  sessionId = world.node.seedSession(w.USER.address);
});
afterEach(async () => { await world.close(); });

/** The user's wallet, counting what it is asked to sign. */
function countingWallet(): TypedDataSigner & { prompts: string[] } {
  const inner = privateKeyTypedDataSigner(w.USER.privKey);
  const prompts: string[] = [];
  return { prompts, signTypedData: async (d: TypedData) => { prompts.push(d.primaryType); return inner.signTypedData(d); } };
}

const sessionClient = (wallet: TypedDataSigner, i = 0): TrueOpenClient =>
  world.client(i, { wallet, session: { maxGrantBlocks: Number(MAX_SESSION_GRANT_BLOCKS) } });

async function drain(it: AsyncIterable<OutputStreamEvent>): Promise<OutputStreamEvent[]> {
  const out: OutputStreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

async function caught(p: Promise<unknown>): Promise<TrueOpenError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TrueOpenError);
    return e as TrueOpenError;
  }
  throw new Error('expected a TrueOpenError, got success');
}

describe('e2e: session grants', () => {
  it('one wallet prompt: subscribe, ack and fetch are signed by the session key; OpenTask by the wallet', async () => {
    const wallet = countingWallet();
    const client = sessionClient(wallet);
    const opened = await client.openTask({ sessionId, idempotencyKey: `${sessionId}:0`, order: w.orderIntent() });
    expect(opened.accepted).toBe(true);
    acceptOnChain(world);
    drawWinner(world);
    landReceipt(world);

    const events = await drain(client.streamOutput({ sessionId, taskId: STREAM.task_id }));
    expect(events.at(-1)).toMatchObject({ kind: 'fin', attested: true });
    const fetched = await client.fetchTaskOutput({ sessionId, taskId: STREAM.task_id, builderAddress: w.BUILDERS[0]!.address, maxRangeBytes: 16 });
    expect(fetched.text).toBe(outputText(STREAM));

    // The wallet signed the order, the OpenTask envelope and one grant; nothing else.
    expect(wallet.prompts).toEqual(['TaskOrder', 'SDKRequest', 'SessionGrant']);
    const n = world.nexus[0]!;
    expect(n.verifications.filter((x) => x.outcome !== 'ok')).toEqual([]);
    const byMethod = (m: string) => n.signers.filter((s) => s.method === m);
    expect(byMethod('OpenTask')).toEqual([{ method: 'OpenTask' }]);
    const key = client.sessionGrants !== undefined ? Buffer.from((await client.sessionGrants.current()).grant.sessionKey).toString('hex') : '';
    for (const m of ['SubscribeOutput', 'AckOutput', 'GetTaskDataMetadata', 'FetchTaskData']) {
      expect(byMethod(m).length, m).toBeGreaterThan(0);
      for (const s of byMethod(m)) expect(s.sessionKey, m).toBe(key);
    }
  });

  it('a grant the Builder sees as expired is renewed, and the request succeeds', async () => {
    acceptOnChain(world);
    drawWinner(world);
    const wallet = countingWallet();
    const client = sessionClient(wallet);
    // First grant at height 1000: expiry 1000 + 398.
    await client.ingress.ackOutput({ sessionId, taskId: STREAM.task_id, lastSeq: 0n });
    const first = (await client.sessionGrants!.current()).grant;
    expect(first.expiryHeight).toBe(w.LATEST_HEIGHT + MAX_SESSION_GRANT_BLOCKS - 2n);

    // The SDK's node is at 1250 (the grant still looks good to it); the Builder's view is 200
    // blocks ahead, past the grant's expiry.
    world.node.height = 1250n;
    world.nexus[0]!.heightAhead = 200n;
    const events = await drain(client.streamOutput({ sessionId, taskId: STREAM.task_id, sources: [{ id: 'b0', ingress: client.ingress }] }));
    expect(events.at(-1)).toMatchObject({ kind: 'fin', attested: true });

    const n = world.nexus[0]!;
    expect(n.verifications.map((x) => x.outcome).filter((o) => o !== 'ok')).toEqual([
      expect.stringContaining('SDK_AUTH_SESSION_GRANT_EXPIRED'),
    ]);
    const renewed = (await client.sessionGrants!.current()).grant;
    expect(renewed).not.toBe(first);
    expect(renewed.expiryHeight).toBe(1250n + MAX_SESSION_GRANT_BLOCKS - 2n);
    expect(wallet.prompts.filter((p) => p === 'SessionGrant')).toHaveLength(2);
    expect(n.signers.filter((s) => s.method === 'SubscribeOutput').map((s) => s.sessionKey)).toEqual([Buffer.from(renewed.sessionKey).toString('hex')]);
  });

  it('a session grant attached to OpenTask is rejected (SDK_AUTH_SESSION_METHOD_NOT_ALLOWED)', async () => {
    const client = sessionClient(countingWallet());
    const session = await client.sessionGrants!.current();
    const ctx = await resolveTaskOrderContext(world.hub, w.CHAIN_ID);
    const order = buildTaskOrder(ctx, { ...w.orderIntent(), userAddress: w.USER.address, sessionId, orderSequence: 0n }, undefined);
    const built = await buildOpenTaskRequest({
      order, payload: w.PAYLOAD, sessionId, taskId: STREAM.task_id, expiryHeight: ctx.latestHeight + 10n,
      requestNonce: new Uint8Array(32).fill(8), idempotencyKey: 'k',
      wallet: privateKeyTypedDataSigner(w.USER.privKey), orderEip712: { evmChainId: w.EVM_CHAIN_ID, feeDenom: w.BUSINESS_DENOM },
    });
    // The SDK never does this; re-sign the envelope with the session key and attach the grant by hand.
    const e = built.input.requestEnvelope;
    const signature = await session.key.signTypedData(sdkRequestTypedData(e, w.EVM_CHAIN_ID, session.grantHash));
    const envelope = envelopeMessage({ ...e, signature, sessionGrant: session.grant });
    const h = built.input;
    async function* frames(): AsyncGenerator<OpenTaskRequest> {
      yield create(OpenTaskRequestSchema, {
        frame: {
          case: 'header',
          value: create(OpenTaskHeaderSchema, {
            orderEnvelope: h.orderEnvelope, payloadRef: h.payloadRef, requestEnvelope: envelope, sessionId: h.sessionId,
            orderSequence: h.orderSequence, userAddress: h.userAddress, inputSizeBytes: BigInt(h.payload.length),
            inputHash: h.inputHash, inputMediaType: h.inputMediaType, idempotencyKey: h.idempotencyKey,
          }),
        },
      });
      yield create(OpenTaskRequestSchema, { frame: { case: 'chunk', value: h.payload } });
    }
    const err = await caught(client.ingress.raw.openTask(frames()));
    expect(err).toMatchObject({ code: 'SDK_AUTH_SESSION_METHOD_NOT_ALLOWED', category: 'auth', retriable: false });
    // And the SDK refuses to build it in the first place.
    await expect(client.ingress.openTask({ ...h, requestEnvelope: { ...e, sessionGrant: session.grant } })).rejects.toMatchObject({ code: 'SDK_LOCAL_REQUEST_MALFORMED' });
  });

  for (const signedBy of ['wallet', 'session key'] as const) {
    it(`a last_seq changed after signing is rejected (${signedBy})`, async () => {
      acceptOnChain(world);
      const client = sessionClient(countingWallet());
      const session = signedBy === 'session key' ? await client.sessionGrants!.current() : undefined;
      const env = await signSdkRequestEnvelope(
        {
          chainId: w.CHAIN_ID, method: 'AckOutput', sessionId, taskId: STREAM.task_id, requestNonce: new Uint8Array(32).fill(signedBy === 'wallet' ? 1 : 2),
          expiryHeightOrTime: BigInt(Date.now() + 60_000), bodyDigest: ackOutputBodyDigest(sessionId, STREAM.task_id, 3n),
        },
        { signerAddress: w.USER.address, signer: privateKeyTypedDataSigner(w.USER.privKey), evmChainId: w.EVM_CHAIN_ID, ...(session !== undefined ? { session } : {}) },
      );
      const err = await caught(client.ingress.raw.ackOutput({ sessionId, taskId: STREAM.task_id, lastSeq: 2n, requestEnvelope: envelopeMessage(env) }));
      expect(err).toMatchObject({ code: 'SDK_AUTH_INVALID_SIGNATURE', category: 'auth' });
      expect(world.nexus[0]!.acks).toEqual([]);
      // The untouched request is accepted.
      await client.ingress.raw.ackOutput({ sessionId, taskId: STREAM.task_id, lastSeq: 3n, requestEnvelope: envelopeMessage(env) });
      expect(world.nexus[0]!.acks).toEqual([{ lastSeq: 3n, outputId: '' }]);
    });
  }

  it('ConfirmOpenTask is not callable (NEXUS_INGRESS_CONTRACT_NOT_FROZEN)', async () => {
    const err = await caught(world.client(0).ingress.raw.confirmOpenTask({ sessionId, taskId: STREAM.task_id }));
    expect(err).toMatchObject({ code: 'NEXUS_INGRESS_CONTRACT_NOT_FROZEN', retriable: false });
  });
});
