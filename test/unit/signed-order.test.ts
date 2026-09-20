import { describe, it, expect } from 'vitest';
import { bech32 } from '@scure/base';
import { toBinary } from '@bufbuild/protobuf';
import { SignedOrderV2Schema } from '../../src/gen/task/v1/msg_assignment_pb.js';
import {
  signAndEncodeOrder,
  encodeSignedOrder,
  decodeSignedOrder,
  SIGNATURE_SCHEME,
} from '../../src/order/signed-order';
import {
  taskOrderHashHex,
  TASK_TYPE,
  DEADLINE_LATENCY_CLASS,
  GENERATION_PARAMS_SCHEMA_VERSION_V1,
  TASK_ORDER_SCHEMA_VERSION_V2,
} from '../../src/order/task-order';
import type { TaskOrderV2, AmountV1 } from '../../src/order/task-order';
import { taskOrderEip712Digest } from '../../src/order/signed-order';
import {
  privKeySecp256k1Signer,
  secp256k1PublicKey,
  verifyCosmosSecp256k1,
} from '../../src/signer/secp256k1';
import {
  privKeyEip712Signer,
  recoverEip712PubKey,
  verifyEip712,
  ethSecp256k1Address,
} from '../../src/signer/eth-secp256k1';
import { fromHex, toHex } from '../../src/util/bytes';

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const signer = privKeyEip712Signer(PRIV);
const hashingSigner = privKeySecp256k1Signer(PRIV);
const pub = secp256k1PublicKey(PRIV);

const rep = (byte: number, size: number): Uint8Array => new Uint8Array(size).fill(byte);
const amount = (atomicUnits: string): AmountV1 => ({ atomicUnits });
const accAddress = (raw: Uint8Array): string => bech32.encode('trueopen', bech32.toWords(raw));
/** The two fields the order's EIP-712 signing needs that are not in TaskOrderV2. */
const ORDER_EIP712 = { evmChainId: 424242n, feeDenom: 'utrueopen' };

// The same order as the node golden fixture in task-order.test.ts.
function fixture(): TaskOrderV2 {
  return {
    schemaVersion: TASK_ORDER_SCHEMA_VERSION_V2,
    chainId: 'trueopen-test-1',
    userAddress: accAddress(rep(0x11, 20)),
    sessionId: rep(0x12, 32),
    orderSequence: 7n,
    modelId: 'model-task-order',
    profileVersion: 3,
    taskType: TASK_TYPE.TEXT_GENERATION,
    inputHash: rep(0x13, 32),
    inputSizeBytes: 99n,
    inputBucket: 2,
    outputBudgetBucket: 4,
    generationParams: {
      generationParamsSchemaVersion: GENERATION_PARAMS_SCHEMA_VERSION_V1,
      maxOutputTokens: 128n,
      maxOutputDuration: 2_000n,
      decodingParams: {
        samplingEnabled: true,
        temperatureMilli: 700,
        topPPpm: 900_000,
        topK: 40,
        seed: 17n,
        presencePenaltyMilli: -100,
        frequencyPenaltyMilli: 200,
        repetitionPenaltyPpm: 1_050_000,
        stopSequences: ['END', 'STOP'],
        stopTokenIds: [2, 9],
      },
    },
    priceBid: amount('2'),
    maxFee: amount('1000'),
    assignmentPriorityFee: amount('50'),
    txFeeReserve: amount('100'),
    earliestSubmitHeight: 20n,
    orderExpireHeight: 80n,
    deadlinePolicy: { latencyClass: DEADLINE_LATENCY_CLASS.STANDARD },
    timeoutBucketVersion: 6n,
    sessionAnchorHeight: 10n,
    sessionAnchorBlockHash: rep(0x14, 32),
    builderSetId: '7',
    builderSetHash: rep(0x15, 32),
  };
}

/** Rebuild the SDK view from the decoded proto -- if the hand-written view drifts from the proto, this will show missing fields or mismatched types. */
function viewFromProto(bytes: Uint8Array): TaskOrderV2 {
  const o = decodeSignedOrder(bytes).order;
  if (!o) throw new Error('missing order');
  const d = o.generationParams?.decodingParams;
  if (!o.generationParams || !d) throw new Error('missing generation params');
  return {
    schemaVersion: o.schemaVersion,
    chainId: o.chainId,
    userAddress: o.userAddress,
    sessionId: o.sessionId,
    orderSequence: o.orderSequence,
    modelId: o.modelId,
    profileVersion: o.profileVersion,
    taskType: o.taskType,
    inputHash: o.inputHash,
    inputSizeBytes: o.inputSizeBytes,
    inputBucket: o.inputBucket,
    outputBudgetBucket: o.outputBudgetBucket,
    generationParams: {
      generationParamsSchemaVersion: o.generationParams.generationParamsSchemaVersion,
      maxOutputTokens: o.generationParams.maxOutputTokens,
      maxOutputDuration: o.generationParams.maxOutputDuration,
      decodingParams: {
        samplingEnabled: d.samplingEnabled,
        temperatureMilli: d.temperatureMilli,
        topPPpm: d.topPPpm,
        topK: d.topK,
        seed: d.seed,
        presencePenaltyMilli: d.presencePenaltyMilli,
        frequencyPenaltyMilli: d.frequencyPenaltyMilli,
        repetitionPenaltyPpm: d.repetitionPenaltyPpm,
        stopSequences: d.stopSequences,
        stopTokenIds: d.stopTokenIds,
      },
    },
    priceBid: { atomicUnits: o.priceBid?.atomicUnits ?? '' },
    maxFee: { atomicUnits: o.maxFee?.atomicUnits ?? '' },
    assignmentPriorityFee: { atomicUnits: o.assignmentPriorityFee?.atomicUnits ?? '' },
    txFeeReserve: { atomicUnits: o.txFeeReserve?.atomicUnits ?? '' },
    earliestSubmitHeight: o.earliestSubmitHeight,
    orderExpireHeight: o.orderExpireHeight,
    deadlinePolicy: { latencyClass: o.deadlinePolicy?.latencyClass ?? 0 },
    timeoutBucketVersion: o.timeoutBucketVersion,
    sessionAnchorHeight: o.sessionAnchorHeight,
    sessionAnchorBlockHash: o.sessionAnchorBlockHash,
    builderSetId: o.builderSetId,
    builderSetHash: o.builderSetHash,
  };
}

describe('SignedOrderV1 encoding', () => {
  // Same self-consistent regression value as task-order.test.ts (not a cross-language golden value; see that file for details).
  const GOLDEN = 'd1456a9d1b78598387f6d9aa3aa8a2fd27e9ab4c9193ce2eec142060819da362';

  it('task_hash is unchanged after a proto round trip (a drift gate between the hand-written view and the generated type)', () => {
    const bytes = encodeSignedOrder(fixture(), rep(0xaa, 64));
    expect(taskOrderHashHex(viewFromProto(bytes))).toBe(GOLDEN);
  });

  it("round-tripped bytes are byte-for-byte identical -- no unknown fields (matches nexus's DiscardUnknown + proto.Equal check)", () => {
    const bytes = encodeSignedOrder(fixture(), rep(0xaa, 64));
    const reencoded = toBinary(SignedOrderV2Schema, decodeSignedOrder(bytes));
    expect(toHex(reencoded)).toBe(toHex(bytes));
  });

  it('signature_scheme is secp256k1, and user_signature keeps its 64 bytes', () => {
    const sig = rep(0xbb, 64);
    const decoded = decodeSignedOrder(encodeSignedOrder(fixture(), sig));
    expect(decoded.signatureScheme).toBe(SIGNATURE_SCHEME);
    expect(toHex(decoded.userSignature)).toBe(toHex(sig));
  });

  it("signAndEncodeOrder: the inner signature is a 65-byte recoverable signature over the order's EIP-712 digest", async () => {
    const order = fixture();
    const r = await signAndEncodeOrder(order, ORDER_EIP712, signer);
    expect(toHex(r.taskHash)).toBe(GOLDEN);
    expect(r.userSignature.length).toBe(65);
    // What's signed is the EIP-712 digest, not the raw task_hash; task_hash is covered as one of its bytes32 fields.
    expect(toHex(r.signingDigest)).toBe(toHex(taskOrderEip712Digest(order, ORDER_EIP712)));
    expect(toHex(r.signingDigest)).not.toBe(toHex(r.taskHash));
    // On chain the address is recovered from the signature; the public key is no longer transmitted.
    expect(toHex(recoverEip712PubKey(r.signingDigest, r.userSignature))).toBe(toHex(pub));
    expect(verifyEip712(r.signingDigest, r.userSignature, ethSecp256k1Address(pub, 'trueopen'), 'trueopen')).toBe(true);
    // The signature does end up in the envelope.
    expect(toHex(decodeSignedOrder(r.bytes).userSignature)).toBe(toHex(r.userSignature));
  });

  // Regression guard: the two signing conventions (keccak/EIP-712's 65 bytes vs sha256's 64-byte Cosmos signature)
  // must never verify against each other. Mixing them up even once shows up on chain as "invalid signature", with no local symptom at all.
  it('the two signing conventions never verify against each other', async () => {
    const digest = taskOrderEip712Digest(fixture(), ORDER_EIP712);
    const cosmosSig = await hashingSigner(digest);
    expect(verifyEip712(digest, cosmosSig, ethSecp256k1Address(pub, 'trueopen'), 'trueopen')).toBe(false);
    // Conversely: an EIP-712 65-byte signature does not satisfy the "sha256 first, then verify" convention.
    const eip712Sig = await signer(digest);
    expect(verifyCosmosSecp256k1(digest, eip712Sig, pub)).toBe(false);
  });

  it('changing any field of the order changes both the encoded bytes and the task_hash', async () => {
    const a = await signAndEncodeOrder(fixture(), ORDER_EIP712, signer);
    const b = await signAndEncodeOrder({ ...fixture(), orderSequence: 8n }, ORDER_EIP712, signer);
    expect(toHex(b.taskHash)).not.toBe(toHex(a.taskHash));
    expect(toHex(b.bytes)).not.toBe(toHex(a.bytes));
  });
});
