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
import { orderEnvelopeSigningBytes, deriveTaskId } from '../../src/order/order-signing';
import { sdkRequestSignBytes, openTaskBodyDigest } from '../../src/transport/sdk-request-envelope';
import {
  privKeySecp256k1Signer,
  secp256k1PublicKey,
  verifyCosmosSecp256k1,
} from '../../src/signer/secp256k1';
import {
  privKeyEip712Signer,
  ethSecp256k1Address,
  recoverEip712PubKey,
} from '../../src/signer/eth-secp256k1';
import { taskOrderEip712Digest } from '../../src/order/signed-order';
import { sha256 } from '../../src/codec/hash';
import { fromHex, toHex } from '../../src/util/bytes';

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const signer = privKeySecp256k1Signer(PRIV);
const orderSigner = privKeyEip712Signer(PRIV);
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
  requestNonce: rep(0xab, 16),
  idempotencyKey: 'idem-1',
  orderSigner,
  orderEip712: ORDER_EIP712,
  signer,
  signerPubKey: pub,
};

describe('buildOpenTaskRequest', () => {
  it("produces two signatures: the inner one signs the order's EIP-712 digest, the outer one signs hex(SignedOrderV2)", async () => {
    const r = await buildOpenTaskRequest(base);

    // Inner: the EIP-712 digest, a 65-byte recoverable signature that recovers back to the same account's public key.
    expect(r.taskHash).toBe(taskOrderHashHex(order));
    const inner = decodeSignedOrder(r.input.orderEnvelope).userSignature;
    expect(inner).toHaveLength(65);
    const digest = taskOrderEip712Digest(order, ORDER_EIP712);
    expect(toHex(recoverEip712PubKey(digest, inner))).toBe(toHex(pub));

    // Outer: per the nexus convention, the 5th field of domainHash is the hex text of the SignedOrderV2 bytes, a 64-byte signature.
    const outerBytes = orderEnvelopeSigningBytes(
      order.chainId, USER, SESSION, order.orderSequence, r.orderEnvelopeHex,
    );
    expect(verifyCosmosSecp256k1(outerBytes, r.input.signature, pub)).toBe(true);
    expect(r.orderEnvelopeHex).toBe(toHex(r.input.orderEnvelope));

    // The two signatures must differ -- they sign completely different bytes.
    expect(toHex(inner)).not.toBe(toHex(r.input.signature));
    expect(r.input.signature).toHaveLength(64);

    // The header's signature_scheme describes the **outer** 64-byte signature, and is still "secp256k1";
    // the order's inner EIP-712 signature is "eip712". nexus's validateOpenTaskHeader strictly checks the former,
    // and it also feeds into the 7th field of openTaskBodyDigest -- mixing the two up breaks both checks at once.
    expect(r.input.signatureScheme).toBe('secp256k1');
    expect(decodeSignedOrder(r.input.orderEnvelope).signatureScheme).toBe('eip712');
  });

  it('request envelope: method/endpoint are correct, body_digest can be recomputed field by field, and the signature verifies', async () => {
    const r = await buildOpenTaskRequest(base);
    const env = r.input.requestEnvelope;
    expect(env.method).toBe('OpenTask');
    expect(env.endpoint).toBe(OPEN_TASK_ENDPOINT);
    expect(env.expiryHeightOrTime).toBe(1_000n);

    const expected = openTaskBodyDigest({
      orderEnvelope: r.input.orderEnvelope,
      payloadRef: r.input.payloadRef,
      signature: r.input.signature,
      sessionId: SESSION,
      orderSequence: order.orderSequence,
      userAddress: USER,
      signatureScheme: 'secp256k1',
      inputSizeBytes: BigInt(PAYLOAD.length),
      inputHash: toHex(sha256(PAYLOAD)),
      inputMediaType: 'application/octet-stream',
    });
    expect(toHex(env.bodyDigest)).toBe(toHex(expected));
    expect(verifyCosmosSecp256k1(sdkRequestSignBytes(env), env.signature, pub)).toBe(true);
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
