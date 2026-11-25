import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fromBinary } from '@bufbuild/protobuf';
import { OrderInputTokensAttestationV1Schema } from '../../src/gen/task/v1/msg_assignment_pb.js';
import {
  ORDER_INPUT_TOKENS_DOMAIN,
  orderInputTokensDigest,
  orderInputTokensTypedData,
  signOrderInputTokens,
  encodeOrderInputTokens,
  committedInputTokenCount,
  checkInputTokenCount,
  inputTokenCountValue,
} from '../../src/order/input-tokens';
import { buildOpenTaskRequest, openTaskInputForSignedOrder } from '../../src/order/build-open-task';
import { buildTaskOrder, defaultGenerationParams } from '../../src/order/task-order-input';
import type { TaskOrderChainContext, TaskOrderRequest } from '../../src/order/task-order-input';
import { TASK_TYPE, DEADLINE_LATENCY_CLASS, taskOrderHash } from '../../src/order/task-order';
import { deriveTaskId } from '../../src/order/order-signing';
import { privateKeyTypedDataSigner, typedDataDigest } from '../../src/signer/typed-data-signer';
import { secp256k1PublicKey } from '../../src/signer/secp256k1';
import { ethAddressBytes, ethSecp256k1Address, recoverEip712PubKey } from '../../src/signer/eth-secp256k1';
import { registeredSessionKey } from '../../src/session/registered-session-key';
import { fromHex, toHex } from '../../src/util/bytes';
import { hash32Text } from '../../src/codec/hash32';

// Pinned by wire testdata/v1/task/order_input_tokens_v1.json.
interface Field { name: string; type: string; value?: number; utf8?: string; hex?: string }
interface Vector {
  domain: string;
  digest_hex: string;
  fields: Field[];
  replay: { chain_id: string; digest_hex: string }[];
  tamper: { name: string; digest_hex: string; field: number }[];
}
const vector = (JSON.parse(readFileSync('third_party/wire/testdata/v1/task/order_input_tokens_v1.json', 'utf8')) as { vectors: Vector[] })
  .vectors[0]!;
const field = (name: string): Field => vector.fields.find((f) => f.name === name)!;
const base = {
  chainId: field('chain_id').utf8!,
  orderDigest: fromHex(field('order_digest').hex!),
  inputTokenCount: BigInt(field('input_token_count').value!),
};

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const wallet = privateKeyTypedDataSigner(PRIV);
const pub = secp256k1PublicKey(PRIV);
const USER = ethSecp256k1Address(pub, 'trueopen');
const rep = (b: number, n: number): Uint8Array => new Uint8Array(n).fill(b);
const hexOf = (b: number): string => hash32Text(rep(b, 32));
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
  modelId: '0xad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b',
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
const common = {
  order,
  orderEip712: { signatureChainId: 424242n, feeDenom: 'utrue' },
  payload: PAYLOAD,
  sessionId: SESSION,
  taskId: deriveTaskId(SESSION, 1n),
  expiryHeight: 910n,
  requestNonce: rep(0x77, 32),
  idempotencyKey: 'idem-1',
  wallet,
  chainId: 'trueopen-localnet-1',
};

describe('input token attestation digest (wire vector)', () => {
  it('reproduces the published digest', () => {
    expect(vector.domain).toBe(ORDER_INPUT_TOKENS_DOMAIN);
    expect(toHex(orderInputTokensDigest(base))).toBe(vector.digest_hex);
  });

  it('is scoped to one chain', () => {
    for (const r of vector.replay) {
      expect(toHex(orderInputTokensDigest({ ...base, chainId: r.chain_id }))).toBe(r.digest_hex);
    }
  });

  it('changes with the count and with the order digest', () => {
    const byName = Object.fromEntries(vector.tamper.map((t) => [t.name, t.digest_hex]));
    expect(toHex(orderInputTokensDigest({ ...base, inputTokenCount: base.inputTokenCount ^ 1n }))).toBe(
      byName['input_token_count_last_byte'],
    );
    const digest = base.orderDigest.slice();
    digest[0]! ^= 1;
    expect(toHex(orderInputTokensDigest({ ...base, orderDigest: digest }))).toBe(byName['order_digest_first_byte']);
  });

  it('refuses a zero count, a short digest and an empty chain', () => {
    expect(() => orderInputTokensDigest({ ...base, inputTokenCount: 0n })).toThrow(/input_token_count/);
    expect(() => orderInputTokensDigest({ ...base, orderDigest: rep(1, 31) })).toThrow(/order_digest/);
    expect(() => orderInputTokensDigest({ ...base, chainId: '' })).toThrow(/chain_id/);
  });
});

describe('signing the attestation', () => {
  it('carries the order values and recovers to the signer', async () => {
    const att = await signOrderInputTokens({ ...base, signatureChainId: 424242n, signer: wallet, expectedSigner: ethAddressBytes(pub) });
    expect(att.schemaVersion).toBe(1);
    expect(att.chainId).toBe(base.chainId);
    expect(toHex(att.orderDigest)).toBe(toHex(base.orderDigest));
    expect(att.inputTokenCount).toBe(2n);
    expect(att.signatureScheme).toBe('eip712');
    expect(att.signatureChainId).toBe(424242n);
    expect(att.userSignature.length).toBe(65);
    const digest = typedDataDigest(orderInputTokensTypedData(base, 424242n));
    expect(toHex(ethAddressBytes(recoverEip712PubKey(digest, att.userSignature)))).toBe(toHex(ethAddressBytes(pub)));
    // The typed data binds the canonical digest.
    expect(toHex(orderInputTokensTypedData(base, 424242n).message['attestationDigest'] as Uint8Array)).toBe(vector.digest_hex);
  });

  it('fails locally when the signer is not the expected account', async () => {
    await expect(
      signOrderInputTokens({ ...base, signatureChainId: 424242n, signer: wallet, expectedSigner: rep(9, 20) }),
    ).rejects.toThrow(/recovers to/);
  });
});

describe('OpenTask with an input token count', () => {
  it('sends nothing new when no count is given', async () => {
    const built = await buildOpenTaskRequest(common);
    expect(built.input.inputTokensAttestation).toBeUndefined();
    expect(built.inputTokensAttestationHex).toBeUndefined();
    expect('inputTokensAttestation' in built.input).toBe(false);
  });

  it('leaves the signed order untouched and binds the statement to it', async () => {
    const plain = await buildOpenTaskRequest(common);
    const built = await buildOpenTaskRequest({ ...common, inputTokenCount: 7n });
    expect(built.orderEnvelopeHex).toBe(plain.orderEnvelopeHex);
    expect(built.taskHash).toBe(plain.taskHash);
    const att = built.input.inputTokensAttestation!;
    expect(att.inputTokenCount).toBe(7n);
    expect(att.chainId).toBe(order.chainId);
    expect(toHex(att.orderDigest)).toBe(toHex(taskOrderHash(order)));
    expect(att.signatureChainId).toBe(424242n);
    expect(built.inputTokensAttestationHex).toBe(toHex(encodeOrderInputTokens(att)));
    // A re-signed envelope keeps the same statement.
    const again = await built.resign(rep(0x78, 32));
    expect(again.inputTokensAttestation).toEqual(att);
  });

  it('is signed by the registered session key when that key signs the order', async () => {
    const keyPriv = fromHex('1111111111111111111111111111111111111111111111111111111111111111');
    const rk = registeredSessionKey(SESSION, keyPriv);
    const built = await buildOpenTaskRequest({ ...common, registeredKey: rk, inputTokenCount: 7n });
    const att = built.input.inputTokensAttestation!;
    const digest = typedDataDigest(
      orderInputTokensTypedData({ chainId: order.chainId, orderDigest: taskOrderHash(order), inputTokenCount: 7n }, 424242n),
    );
    expect(toHex(ethAddressBytes(recoverEip712PubKey(digest, att.userSignature)))).toBe(toHex(rk.address));
  });

  it('resends a stored statement unchanged and refuses one for another order', async () => {
    const built = await buildOpenTaskRequest({ ...common, inputTokenCount: 7n });
    const { order: _o, orderEip712: _e, ...envelope } = common;
    void _o;
    void _e;
    const resent = await openTaskInputForSignedOrder({
      ...envelope,
      signedOrder: fromHex(built.orderEnvelopeHex),
      taskHash: built.taskHash,
      inputTokensAttestation: fromHex(built.inputTokensAttestationHex!),
    });
    expect(resent.input.inputTokensAttestation).toEqual(built.input.inputTokensAttestation);

    const other = encodeOrderInputTokens(
      await signOrderInputTokens({ ...base, chainId: order.chainId, signatureChainId: 424242n, signer: wallet, expectedSigner: ethAddressBytes(pub) }),
    );
    await expect(
      openTaskInputForSignedOrder({
        ...envelope,
        signedOrder: fromHex(built.orderEnvelopeHex),
        taskHash: built.taskHash,
        inputTokensAttestation: other,
      }),
    ).rejects.toThrow(/not a statement for this order/);
    // And the bytes decode as the wire message.
    expect(fromBinary(OrderInputTokensAttestationV1Schema, fromHex(built.inputTokensAttestationHex!)).inputTokenCount).toBe(7n);
  });
});

describe('counter values', () => {
  it('normalises and refuses bad counts', () => {
    expect(inputTokenCountValue(undefined)).toBeUndefined();
    expect(inputTokenCountValue(5)).toBe(5n);
    expect(inputTokenCountValue(5n)).toBe(5n);
    expect(() => inputTokenCountValue(0)).toThrow();
    expect(() => inputTokenCountValue(1.5)).toThrow();
    expect(() => inputTokenCountValue(-1n)).toThrow();
  });
});

describe('attested count against the receipt', () => {
  it('derives the committed count as wire TOKEN_USAGE_V1 does', () => {
    // input [1, 256] = 12 bytes, generated [2, 257, 65535] = 16 bytes: S = 28, G = 3.
    expect(committedInputTokenCount(28n, 3n)).toBe(2n);
    expect(committedInputTokenCount(7n, 0n)).toBeUndefined();
    expect(committedInputTokenCount(30n, 3n)).toBeUndefined();
    expect(committedInputTokenCount(20n, 3n)).toBeUndefined();
  });

  it('reports match, mismatch and unavailable', () => {
    expect(checkInputTokenCount({ attested: 2n, tokenOpeningEncodedSizeBytes: 28n, generatedTokenCount: 3n })).toEqual({
      status: 'match', attested: 2n, committed: 2n, difference: 0n,
    });
    expect(checkInputTokenCount({ attested: 5n, tokenOpeningEncodedSizeBytes: 28n, generatedTokenCount: 3n })).toEqual({
      status: 'mismatch', attested: 5n, committed: 2n, difference: -3n,
    });
    expect(checkInputTokenCount({ attested: 5n, tokenOpeningEncodedSizeBytes: 3n, generatedTokenCount: 3n })).toEqual({
      status: 'unavailable', attested: 5n,
    });
  });
});
