import { create, toBinary, fromBinary } from '@bufbuild/protobuf';
import { SignedOrderV2Schema, TaskOrderV3Schema } from '../gen/task/v1/msg_assignment_pb.js';
import type { PayloadModeV1 as ProtoPayloadMode } from '../gen/task/v1/assignment_pb.js';
import type { TaskType as ProtoTaskType } from '../gen/shared/v1/model_profile_pb.js';
import type {
  DeadlineLatencyClass as ProtoLatencyClass,
  TaskOrderV3 as ProtoTaskOrderV3,
  SignedOrderV2 as ProtoSignedOrderV2,
} from '../gen/task/v1/msg_assignment_pb.js';
import type { TaskOrderV3 } from './task-order';
import { taskOrderHash } from './task-order';
import type { Eip712Types, Eip712Struct } from '../codec/eip712';
import type { TypedData, TypedDataSigner } from '../signer/typed-data-signer';
import { signTypedDataAs, typedDataDigest } from '../signer/typed-data-signer';
import { canonicalAccountAddressBytes } from '../codec/address';

/**
 * SignedOrderV2.signature_scheme: only this lowercase literal is accepted. It describes the
 * order's EIP-712 recoverable signature (65 bytes), verified by the Keeper.
 */
export const SIGNATURE_SCHEME = 'eip712';

/** EIP-712 order domain; values are frozen by task_order.domain in account_signing_v1.json. */
export const ORDER_EIP712_DOMAIN_NAME = 'TrueOpen Task Order';
export const ORDER_EIP712_DOMAIN_VERSION = '3';

/**
 * Type table for the order's EIP-712 payload. The message has only 11 fields - it is
 * **not** a full-field mirror of TaskOrderV3, but a "human-readable summary + taskHash":
 * the wallet prompt shows the first 10 fields, and the 11th field, taskHash, binds the
 * canonical hash of the full order into the same signature. So the signature effectively
 * covers all 28 fields. Domain version 3 binds modelId as a raw bytes32.
 */
export const ORDER_EIP712_TYPES: Eip712Types = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
  ],
  TaskOrder: [
    { name: 'chainId', type: 'string' },
    { name: 'user', type: 'string' },
    { name: 'sessionId', type: 'bytes32' },
    { name: 'orderSequence', type: 'uint64' },
    { name: 'modelId', type: 'bytes32' },
    { name: 'profileVersion', type: 'uint32' },
    { name: 'maxFee', type: 'string' },
    { name: 'feeDenom', type: 'string' },
    { name: 'earliestSubmitHeight', type: 'uint64' },
    { name: 'orderExpireHeight', type: 'uint64' },
    { name: 'taskHash', type: 'bytes32' },
  ],
};

/** Two values the order's EIP-712 payload needs but that don't live on TaskOrderV3. */
export interface OrderEip712Context {
  /**
   * The chainId in the EIP-712 domain is the **EVM numeric chain ID** (424242 in the
   * test vectors), which is distinct from TaskOrderV3.chain_id (the cosmos string chain
   * ID) - both are included in the signature.
   */
  readonly evmChainId: bigint | number | string;
  /** Fee denom. shared.v1.Amount only carries atomic_units; the denom comes from chain params. */
  readonly feeDenom: string;
}

/** The order's EIP-712 typed data, as a wallet signs it. */
export function taskOrderTypedData(order: TaskOrderV3, ctx: OrderEip712Context): TypedData {
  const message: Eip712Struct = {
    chainId: order.chainId,
    user: order.userAddress,
    sessionId: order.sessionId,
    orderSequence: order.orderSequence,
    modelId: order.modelId,
    profileVersion: order.profileVersion,
    maxFee: order.maxFee.atomicUnits,
    feeDenom: ctx.feeDenom,
    earliestSubmitHeight: order.earliestSubmitHeight,
    orderExpireHeight: order.orderExpireHeight,
    taskHash: taskOrderHash(order),
  };
  return {
    types: ORDER_EIP712_TYPES,
    primaryType: 'TaskOrder',
    domain: {
      name: ORDER_EIP712_DOMAIN_NAME,
      version: ORDER_EIP712_DOMAIN_VERSION,
      chainId: BigInt(ctx.evmChainId),
    },
    message,
  };
}

/** The order's EIP-712 signing digest (32 bytes). */
export function taskOrderEip712Digest(order: TaskOrderV3, ctx: OrderEip712Context): Uint8Array {
  return typedDataDigest(taskOrderTypedData(order, ctx));
}

/**
 * Convert the SDK-side TaskOrderV3 view into the frozen protobuf message.
 *
 * We deliberately keep two parallel representations: the hand-written view is the input
 * to task_hash (taskOrderHash depends only on it, which keeps it easy to assert as a
 * pure function), while the generated type is only responsible for wire encoding. Any
 * drift between the two is caught by the "task_hash is unchanged after a proto
 * round-trip" test case in signed-order.test.ts.
 */
function toProtoTaskOrder(order: TaskOrderV3): ProtoTaskOrderV3 {
  const d = order.generationParams.decodingParams;
  return create(TaskOrderV3Schema, {
    schemaVersion: order.schemaVersion,
    chainId: order.chainId,
    userAddress: order.userAddress,
    sessionId: order.sessionId,
    orderSequence: order.orderSequence,
    modelId: order.modelId,
    profileVersion: order.profileVersion,
    taskType: order.taskType as ProtoTaskType,
    inputHash: order.inputHash,
    inputSizeBytes: order.inputSizeBytes,
    inputBucket: order.inputBucket,
    outputBudgetBucket: order.outputBudgetBucket,
    generationParams: {
      generationParamsSchemaVersion: order.generationParams.generationParamsSchemaVersion,
      maxOutputTokens: order.generationParams.maxOutputTokens,
      maxOutputDuration: order.generationParams.maxOutputDuration,
      decodingParams: {
        samplingEnabled: d.samplingEnabled,
        temperatureMilli: d.temperatureMilli,
        topPPpm: d.topPPpm,
        topK: d.topK,
        seed: d.seed,
        presencePenaltyMilli: d.presencePenaltyMilli,
        frequencyPenaltyMilli: d.frequencyPenaltyMilli,
        repetitionPenaltyPpm: d.repetitionPenaltyPpm,
        stopSequences: [...d.stopSequences],
        stopTokenIds: [...d.stopTokenIds],
      },
    },
    priceBid: { atomicUnits: order.priceBid.atomicUnits },
    maxFee: { atomicUnits: order.maxFee.atomicUnits },
    assignmentPriorityFee: { atomicUnits: order.assignmentPriorityFee.atomicUnits },
    txFeeReserve: { atomicUnits: order.txFeeReserve.atomicUnits },
    earliestSubmitHeight: order.earliestSubmitHeight,
    orderExpireHeight: order.orderExpireHeight,
    deadlinePolicy: { latencyClass: order.deadlinePolicy.latencyClass as ProtoLatencyClass },
    timeoutBucketVersion: order.timeoutBucketVersion,
    sessionAnchorHeight: order.sessionAnchorHeight,
    sessionAnchorBlockHash: order.sessionAnchorBlockHash,
    builderSetId: order.builderSetId,
    builderSetHash: order.builderSetHash,
    payloadMode: order.payloadMode as ProtoPayloadMode,
    inputKeyCommitment: order.inputKeyCommitment,
    userRecipientPubkey: order.userRecipientPubkey,
  });
}

/** SignedOrderV2's protobuf bytes, plus derived values the OpenTask body reuses. */
export interface EncodedSignedOrder {
  /** SignedOrderV2's protobuf-serialized bytes, submitted directly as the order_envelope. */
  readonly bytes: Uint8Array;
  /** The user's 65-byte signature over the EIP-712 digest (SignedOrderV2.user_signature). */
  readonly userSignature: Uint8Array;
  /** The canonical task_hash (raw 32 bytes). */
  readonly taskHash: Uint8Array;
  /** The EIP-712 digest that was actually signed (lets you diff directly against test vectors when debugging). */
  readonly signingDigest: Uint8Array;
}

/**
 * Sign an order and encode it into a frozen SignedOrderV2.
 *
 * Users **no longer sign the raw task_hash directly**: they sign the
 * digest of the EIP-712 "TrueOpen Task Order" v3 domain, with task_hash embedded as one
 * of its bytes32 fields. The signature shape changes accordingly, from a 64-byte R||S to
 * a **65-byte R||S||V** (V in {27,28}, low-S); the chain recovers the address from the
 * recoverable signature and no longer needs the public key passed in.
 *
 * This signature alone authorizes the order: OpenTask has no outer order signature. The
 * OpenTask request envelope is a second EIP-712 signature by the same wallet, under the SDK
 * Request domain.
 */
export async function signAndEncodeOrder(
  order: TaskOrderV3,
  ctx: OrderEip712Context,
  signer: TypedDataSigner,
): Promise<EncodedSignedOrder> {
  const taskHash = taskOrderHash(order);
  const data = taskOrderTypedData(order, ctx);
  const signingDigest = typedDataDigest(data);
  // The Keeper recovers the order user from this signature; check it here, not on chain.
  const userSignature = await signTypedDataAs(signer, data, canonicalAccountAddressBytes('user_address', order.userAddress));
  const signed = create(SignedOrderV2Schema, {
    order: toProtoTaskOrder(order),
    signatureScheme: SIGNATURE_SCHEME,
    userSignature,
  });
  return { bytes: toBinary(SignedOrderV2Schema, signed), userSignature, taskHash, signingDigest };
}

/**
 * Encode only (no signing), for tests and offline assembly: the resulting bytes can be
 * fed back into fromBinary to check the round trip. Passing an empty array for
 * user_signature gets it omitted by proto3, and nexus will reject it outright because
 * the length isn't 65 - so this function is only used on the local validation path.
 */
export function encodeSignedOrder(order: TaskOrderV3, userSignature: Uint8Array): Uint8Array {
  return toBinary(
    SignedOrderV2Schema,
    create(SignedOrderV2Schema, {
      order: toProtoTaskOrder(order),
      signatureScheme: SIGNATURE_SCHEME,
      userSignature,
    }),
  );
}

/**
 * Decode SignedOrderV2 bytes (for symmetric validation).
 * nexus re-decodes with DiscardUnknown and compares with proto.Equal, rejecting outright
 * any payload carrying unknown fields, so the SDK's generated types must share their
 * source of truth with the on-chain contract - which is why they're generated directly
 * from TrueOpen/wire (third_party/wire) rather than hand-copied as a subset.
 */
export function decodeSignedOrder(bytes: Uint8Array): ProtoSignedOrderV2 {
  return fromBinary(SignedOrderV2Schema, bytes);
}
