import { describe, it, expect } from 'vitest';
import { createRouterTransport } from '@connectrpc/connect';
import { bech32 } from '@scure/base';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import type { OpenTaskRequest } from '../../src/gen/nexus/v1/ingress_pb.js';
import { IngressClient, DEFAULT_OPEN_TASK_CHUNK_BYTES } from '../../src/transport/ingress-client';
import { buildOpenTaskRequest, OPEN_TASK_ENDPOINT, HEIGHT_EXPIRY_THRESHOLD } from '../../src/order/build-open-task';
import { buildTaskOrder, defaultGenerationParams } from '../../src/order/task-order-input';
import type { TaskOrderChainContext, TaskOrderRequest } from '../../src/order/task-order-input';
import { TASK_TYPE, DEADLINE_LATENCY_CLASS, taskOrderHashHex } from '../../src/order/task-order';
import { decodeSignedOrder } from '../../src/order/signed-order';
import { deriveTaskId } from '../../src/order/order-signing';
import { sdkRequestEip712Digest } from '../../src/transport/sdk-request-envelope';
import { privateKeyTypedDataSigner } from '../../src/signer/typed-data-signer';
import { openTaskBodyDigest } from '../../src/transport/sdk-request-body';
import {
  secp256k1PublicKey,
} from '../../src/signer/secp256k1';
import {
  ethSecp256k1Address,
  recoverEip712PubKey,
  recoverEip712Address,
} from '../../src/signer/eth-secp256k1';
import { taskOrderEip712Digest } from '../../src/order/signed-order';
import { sha256 } from '../../src/codec/hash';
import { fromHex, toHex } from '../../src/util/bytes';

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const wallet = privateKeyTypedDataSigner(PRIV);
const pub = secp256k1PublicKey(PRIV);
const USER = ethSecp256k1Address(pub, 'trueopen');

const rep = (b: number, n: number): Uint8Array => new Uint8Array(n).fill(b);
const hexOf = (b: number): string => toHex(rep(b, 32));
const amount = (atomicUnits: string) => ({ atomicUnits });
const SESSION = hexOf(0x12);
const PAYLOAD = new TextEncoder().encode('trueopen-input-payload');

const ctx: TaskOrderChainContext = {
  chainId: 'trueopen-localnet-1',
  sessionAnchorHeight: 900n,
  sessionAnchorBlockHash: hexOf(0x14),
  builderSetId: 'genesis-1',
  builderSetHash: hexOf(0x15),
  timeoutBucketVersion: 1n,
  // Matches task/v1/params.generation as observed on devnet.
  generationLimits: {
    maxOutputTokens: 131_072n, topKMax: 1000n, stopSequenceMaxItems: 16n,
    stopSequenceMaxBytesEach: 128n, stopSequenceMaxTotalBytes: 1024n, stopTokenMaxItems: 64n,
  },
  latestHeight: 902n,
};

const req: TaskOrderRequest = {
  userAddress: USER,
  sessionId: SESSION,
  orderSequence: 1n,
  modelId: 'ad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b',
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
  earliestSubmitHeight: 900n,
  orderExpireHeight: 50_900n,
  latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
};

const order = buildTaskOrder(ctx, req);
/** The two extra fields the order's EIP-712 signing needs: the numeric EVM chain ID and the fee denom, neither of which lives in TaskOrderV2. */
const ORDER_EIP712 = { evmChainId: 424242n, feeDenom: 'utrueopen' };
const TASK_ID = deriveTaskId(SESSION, 1n);

const base = {
  order,
  payload: PAYLOAD,
  sessionId: SESSION,
  taskId: TASK_ID,
  expiryHeight: 1_000n,
  requestNonce: rep(0xab, 32),
  idempotencyKey: 'idem-1',
  wallet,
  orderEip712: ORDER_EIP712,
};

describe('buildOpenTaskRequest', () => {
  it('one wallet signs the order and the envelope; there is no outer order signature', async () => {
    const r = await buildOpenTaskRequest(base);

    // The order: the EIP-712 digest, a 65-byte recoverable signature by the account.
    expect(r.taskHash).toBe(taskOrderHashHex(order));
    const inner = decodeSignedOrder(r.input.orderEnvelope).userSignature;
    expect(inner).toHaveLength(65);
    const digest = taskOrderEip712Digest(order, ORDER_EIP712);
    expect(toHex(recoverEip712PubKey(digest, inner))).toBe(toHex(pub));
    expect(decodeSignedOrder(r.input.orderEnvelope).signatureScheme).toBe('eip712');
    expect(r.orderEnvelopeHex).toBe(toHex(r.input.orderEnvelope));

    // No outer signature and no signature scheme on the header input.
    expect('signature' in r.input).toBe(false);
    expect('signatureScheme' in r.input).toBe(false);
  });

  it('the header sends signature and signature_scheme empty', async () => {
    const seen = { frames: [] as OpenTaskRequest[] };
    const transport = createRouterTransport(({ service }) => {
      service(IngressAPI, {
        async openTask(reqs: AsyncIterable<OpenTaskRequest>) {
          for await (const f of reqs) seen.frames.push(f);
          return { taskId: TASK_ID, accepted: true, reason: '', sessionId: SESSION };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    });
    await new IngressClient(transport).openTask((await buildOpenTaskRequest(base)).input);
    const h = seen.frames[0]?.frame.value as { signature: Uint8Array; signatureScheme: string; requestEnvelope?: { sessionGrant?: unknown } };
    expect(h.signature).toHaveLength(0);
    expect(h.signatureScheme).toBe('');
    expect(h.requestEnvelope?.sessionGrant).toBeUndefined();
  });

  it('refuses a task_id not derived from the order, and a session other than the order\'s', async () => {
    await expect(buildOpenTaskRequest({ ...base, taskId: '11'.repeat(32) })).rejects.toMatchObject({ code: 'SDK_LOCAL_OPEN_TASK_ID_NOT_DERIVED' });
    await expect(buildOpenTaskRequest({ ...base, sessionId: hexOf(0x13) })).rejects.toMatchObject({ code: 'SDK_LOCAL_OPEN_TASK_SESSION_MISMATCH' });
  });

  it('request envelope: method/endpoint are correct, body_digest can be recomputed field by field, and the signature verifies', async () => {
    const r = await buildOpenTaskRequest(base);
    const env = r.input.requestEnvelope;
    expect(env.method).toBe('OpenTask');
    expect(env.endpoint).toBe(OPEN_TASK_ENDPOINT);
    expect(env.expiryHeightOrTime).toBe(1_000n);

    const expected = openTaskBodyDigest({
      taskHash: fromHex(r.taskHash),
      sessionId: SESSION,
      orderSequence: order.orderSequence,
      userAddress: USER,
      inputSizeBytes: BigInt(PAYLOAD.length),
      inputHash: toHex(sha256(PAYLOAD)),
      inputMediaType: 'application/octet-stream',
      idempotencyKey: 'idem-1',
    });
    expect(toHex(env.bodyDigest)).toBe(toHex(expected));
    expect(env.signature).toHaveLength(65);
    expect(env.signerAddress).toBe(USER);
    expect(recoverEip712Address(sdkRequestEip712Digest(env, ORDER_EIP712.evmChainId), env.signature, 'trueopen')).toBe(USER);
  });

  it('payload_ref / input_hash match the payload', async () => {
    const r = await buildOpenTaskRequest(base);
    const hex = toHex(sha256(PAYLOAD));
    expect(r.input.inputHash).toBe(hex);
    expect(r.input.payloadRef).toBe(`nexus://sha256/${hex}`);
  });

  // This is the easiest pitfall with OpenTask compared to SubmitOrder: nexus only accepts a block height.
  it('passing a unix-millisecond timestamp as expiry is rejected locally', async () => {
    await expect(
      buildOpenTaskRequest({ ...base, expiryHeight: BigInt(Date.now()) + 300_000n }),
    ).rejects.toMatchObject({ code: 'SDK_LOCAL_EXPIRY_NOT_HEIGHT' });
    expect(BigInt(Date.now())).toBeGreaterThan(HEIGHT_EXPIRY_THRESHOLD);
  });

  it("payload not matching the order's commitment / missing idempotency_key is rejected locally", async () => {
    await expect(
      buildOpenTaskRequest({ ...base, payload: new TextEncoder().encode('different') }),
    ).rejects.toMatchObject({ code: 'SDK_LOCAL_PAYLOAD_HASH_MISMATCH' });
    await expect(buildOpenTaskRequest({ ...base, idempotencyKey: '' })).rejects.toMatchObject({
      code: 'SDK_LOCAL_IDEMPOTENCY_KEY_REQUIRED',
    });
  });
});

describe('IngressClient.openTask (streaming frame splitting)', () => {
  function captureTransport(seen: { frames: OpenTaskRequest[] }) {
    return createRouterTransport(({ service }) => {
      service(IngressAPI, {
        async openTask(reqs: AsyncIterable<OpenTaskRequest>) {
          for await (const f of reqs) seen.frames.push(f);
          return { taskId: TASK_ID, accepted: true, reason: '', sessionId: SESSION };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    });
  }

  it('sends the header frame first, then chunk frames, and the chunks reassemble into the original payload', async () => {
    const seen = { frames: [] as OpenTaskRequest[] };
    const r = await buildOpenTaskRequest(base);
    const ack = await new IngressClient(captureTransport(seen)).openTask(r.input);

    expect(ack.accepted).toBe(true);
    expect(ack.taskId).toBe(TASK_ID);

    expect(seen.frames[0]?.frame.case).toBe('header');
    const chunks = seen.frames.slice(1);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.every((f) => f.frame.case === 'chunk')).toBe(true);

    const joined = new Uint8Array(PAYLOAD.length);
    let off = 0;
    for (const f of chunks) {
      const c = f.frame.value as Uint8Array;
      expect(c.length).toBeGreaterThan(0); // nexus rejects empty chunks
      joined.set(c, off);
      off += c.length;
    }
    expect(toHex(joined)).toBe(toHex(PAYLOAD));

    // header fields pass through correctly.
    const h = seen.frames[0]?.frame.value as { sessionId: string; idempotencyKey: string; inputSizeBytes: bigint };
    expect(h.sessionId).toBe(SESSION);
    expect(h.idempotencyKey).toBe('idem-1');
    expect(h.inputSizeBytes).toBe(BigInt(PAYLOAD.length));
  });

  it('a large payload is split according to chunkSizeBytes, and no single chunk exceeds the limit', async () => {
    const big = new Uint8Array(5000).fill(7);
    const seen = { frames: [] as OpenTaskRequest[] };
    const r = await buildOpenTaskRequest({
      ...base,
      order: buildTaskOrder(ctx, { ...req, payload: big }),
      payload: big,
      chunkSizeBytes: 1024,
    });
    await new IngressClient(captureTransport(seen)).openTask(r.input);

    const chunks = seen.frames.slice(1);
    expect(chunks).toHaveLength(5); // ceil(5000/1024)
    for (const f of chunks) expect((f.frame.value as Uint8Array).length).toBeLessThanOrEqual(1024);
  });

  it("the default chunk size is conservative, below nexus's default limit of 256 KiB", () => {
    expect(DEFAULT_OPEN_TASK_CHUNK_BYTES).toBeLessThanOrEqual(256 * 1024);
  });
});
