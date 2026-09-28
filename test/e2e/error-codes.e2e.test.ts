/**
 * The error code the simulated Builder answers for each auth failure the contract pins, and how
 * the SDK classifies it. The SDK refuses most of these locally, so the bad requests are sent raw.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { bech32 } from '@scure/base';
import { OpenTaskHeaderSchema, OpenTaskRequestSchema } from '../../src/gen/nexus/v1/ingress_pb.js';
import type { OpenTaskRequest, SDKRequestEnvelopeV2 } from '../../src/gen/nexus/v1/ingress_pb.js';
import { TrueOpenError } from '../../src/errors/errors';
import { privateKeyTypedDataSigner } from '../../src/signer/typed-data-signer';
import { sdkRequestTypedData } from '../../src/transport/sdk-request-envelope';
import type { SdkRequestFields } from '../../src/transport/sdk-request-envelope';
import { ackOutputBodyDigest } from '../../src/transport/sdk-request-body';
import { envelopeMessage } from '../../src/transport/ingress-client';
import type { OpenTaskInput } from '../../src/transport/ingress-client';
import { TASK_DATA_OBJECT_KIND } from '../../src/transport/task-data-signbytes';
import { resolveTaskOrderContext, buildTaskOrder } from '../../src/order/task-order-input';
import { buildOpenTaskRequest } from '../../src/order/build-open-task';
import { startWorld, acceptOnChain, drawWinner, landReceipt, STREAM } from './support/harness';
import type { World } from './support/harness';
import { MAX_SERVICE_MATERIAL_EXPIRY_BLOCKS } from './support/fake-nexus';
import * as w from './support/world';

let world: World;
let sessionId: string;
beforeEach(async () => {
  world = await startWorld();
  sessionId = world.node.seedSession(w.USER.address);
});
afterEach(async () => { await world.close(); });

const wallet = () => privateKeyTypedDataSigner(w.USER.privKey);

async function caught(p: Promise<unknown>): Promise<TrueOpenError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TrueOpenError);
    return e as TrueOpenError;
  }
  throw new Error('expected a TrueOpenError, got success');
}

/** A raw envelope signed by the user's key over exactly `fields`. */
async function rawEnvelope(fields: SdkRequestFields, signerAddress = w.USER.address): Promise<SDKRequestEnvelopeV2> {
  const signature = await wallet().signTypedData(sdkRequestTypedData(fields, w.EVM_CHAIN_ID));
  return envelopeMessage({ ...fields, requestDomain: 'TRUEOPEN_SDK_REQUEST_V2', endpoint: `/nexus.v1.IngressAPI/${fields.method}`, signerAddress, signature });
}

async function signedOpenTask(): Promise<OpenTaskInput> {
  const ctx = await resolveTaskOrderContext(world.hub, w.CHAIN_ID);
  const order = buildTaskOrder(ctx, { ...w.orderIntent(), userAddress: w.USER.address, sessionId, orderSequence: 0n }, undefined);
  const built = await buildOpenTaskRequest({
    order, payload: w.PAYLOAD, sessionId, taskId: STREAM.task_id, expiryHeight: ctx.latestHeight + 10n,
    requestNonce: new Uint8Array(32).fill(4), idempotencyKey: 'k', wallet: wallet(),
    orderEip712: { evmChainId: w.EVM_CHAIN_ID, feeDenom: w.BUSINESS_DENOM },
  });
  return built.input;
}

function openTaskFrames(h: OpenTaskInput, requestEnvelope: SDKRequestEnvelopeV2): AsyncIterable<OpenTaskRequest> {
  return (async function* () {
    yield create(OpenTaskRequestSchema, {
      frame: {
        case: 'header',
        value: create(OpenTaskHeaderSchema, {
          orderEnvelope: h.orderEnvelope, payloadRef: h.payloadRef, requestEnvelope, sessionId: h.sessionId,
          orderSequence: h.orderSequence, userAddress: h.userAddress, inputSizeBytes: BigInt(h.payload.length),
          inputHash: h.inputHash, inputMediaType: h.inputMediaType, idempotencyKey: h.idempotencyKey,
        }),
      },
    });
    yield create(OpenTaskRequestSchema, { frame: { case: 'chunk', value: h.payload } });
  })();
}

describe('e2e: pinned auth error codes', () => {
  it('OpenTask with a Unix-millisecond expiry: NEXUS_INGRESS_MALFORMED', async () => {
    const h = await signedOpenTask();
    const e = h.requestEnvelope;
    const env = await rawEnvelope({ ...e, requestNonce: new Uint8Array(32).fill(9), expiryHeightOrTime: BigInt(Date.now() + 60_000) });
    const err = await caught(world.client(0).ingress.raw.openTask(openTaskFrames(h, env)));
    expect(err).toMatchObject({ code: 'NEXUS_INGRESS_MALFORMED', category: 'invalid', retriable: false });
  });

  it('OpenTask with a height expiry outside [h, h + request_ttl_blocks]: SDK_AUTH_EXPIRED', async () => {
    // Every selected Builder refuses it, so openTask fails with each Builder's error.
    const err = await caught(world.client(0).openTask({ sessionId, idempotencyKey: 'k', order: w.orderIntent(), expiryHeight: w.LATEST_HEIGHT + 21n }));
    const results = (err as TrueOpenError & { results: { error?: unknown }[] }).results;
    expect(results).toHaveLength(3);
    for (const r of results) expect(r.error).toMatchObject({ code: 'SDK_AUTH_EXPIRED', category: 'expired', retriable: true });
  });

  it('an envelope for another chain_id: SDK_AUTH_INVALID_SIGNATURE', async () => {
    acceptOnChain(world);
    const fields = { chainId: 'trueopen-other-1', method: 'AckOutput', sessionId, taskId: STREAM.task_id, requestNonce: new Uint8Array(32).fill(6), expiryHeightOrTime: BigInt(Date.now() + 60_000), bodyDigest: ackOutputBodyDigest(sessionId, STREAM.task_id, 0n) };
    const err = await caught(world.client(0).ingress.raw.ackOutput({ sessionId, taskId: STREAM.task_id, lastSeq: 0n, requestEnvelope: await rawEnvelope(fields) }));
    expect(err).toMatchObject({ code: 'SDK_AUTH_INVALID_SIGNATURE', category: 'auth' });
  });

  it('a signer_address with another prefix: NEXUS_INGRESS_MALFORMED', async () => {
    acceptOnChain(world);
    const fields = { chainId: w.CHAIN_ID, method: 'AckOutput', sessionId, taskId: STREAM.task_id, requestNonce: new Uint8Array(32).fill(7), expiryHeightOrTime: BigInt(Date.now() + 60_000), bodyDigest: ackOutputBodyDigest(sessionId, STREAM.task_id, 0n) };
    const other = bech32.encode('cosmos', bech32.decode(w.USER.address as `${string}1${string}`).words);
    const err = await caught(world.client(0).ingress.raw.ackOutput({ sessionId, taskId: STREAM.task_id, lastSeq: 0n, requestEnvelope: await rawEnvelope(fields, other) }));
    expect(err).toMatchObject({ code: 'NEXUS_INGRESS_MALFORMED' });
  });

  describe('Task data requests', () => {
    const objectRef = () => ({ taskHash: STREAM.task_hash, sessionId, taskId: STREAM.task_id, objectKind: TASK_DATA_OBJECT_KIND.OUTPUT, contentHash: STREAM.output_hash });
    beforeEach(() => { acceptOnChain(world); drawWinner(world); landReceipt(world); });

    it('the window is max_service_material_expiry_blocks, not the 20-block OpenTask TTL', async () => {
      const ok = await world.client(0).ingress.getTaskDataMetadata({ objectRef: objectRef(), builderAddress: w.BUILDERS[0]!.address, expiresAtHeight: w.LATEST_HEIGHT + 50n });
      expect(ok?.sizeBytes).toBe(BigInt(STREAM.output_size_bytes));
    });

    it('expiry past the window: NEXUS_DATA_EXPIRED, retried by re-signing on the same Builder', async () => {
      const err = await caught(world.client(0).ingress.getTaskDataMetadata({
        objectRef: objectRef(), builderAddress: w.BUILDERS[0]!.address, expiresAtHeight: w.LATEST_HEIGHT + MAX_SERVICE_MATERIAL_EXPIRY_BLOCKS + 1n,
      }));
      expect(err).toMatchObject({ code: 'NEXUS_DATA_EXPIRED', category: 'expired', retriable: true, switchSource: false });
    });

    it('a request addressed to another Builder: DATA_ACCESS_DENIED', async () => {
      const err = await caught(world.client(0).ingress.getTaskDataMetadata({ objectRef: objectRef(), builderAddress: w.BUILDERS[1]!.address, expiresAtHeight: w.LATEST_HEIGHT + 5n }));
      expect(err).toMatchObject({ code: 'DATA_ACCESS_DENIED', category: 'auth', retriable: false });
    });

    it('the default expiry (latest + 10) fits the window', async () => {
      const out = await world.client(0).fetchTaskOutput({ sessionId, taskId: STREAM.task_id, builderAddress: w.BUILDERS[0]!.address });
      expect(out.outputHash).toBe(STREAM.output_hash);
    });
  });
});
