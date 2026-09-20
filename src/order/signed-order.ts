import { create, toBinary, fromBinary } from '@bufbuild/protobuf';
import { SignedOrderV2Schema, TaskOrderV2Schema } from '../gen/task/v1/msg_assignment_pb.js';
import type { TaskType as ProtoTaskType } from '../gen/shared/v1/model_profile_pb.js';
import type {
  DeadlineLatencyClass as ProtoLatencyClass,
  TaskOrderV2 as ProtoTaskOrderV2,
  SignedOrderV2 as ProtoSignedOrderV2,
} from '../gen/task/v1/msg_assignment_pb.js';
import type { TaskOrderV2 } from './task-order';
import { taskOrderHash } from './task-order';
import type { Eip712Types, Eip712Struct } from '../codec/eip712';
import { eip712Digest } from '../codec/eip712';
import type { Eip712Signer } from '../signer/eth-secp256k1';
import { TrueOpenError } from '../errors/errors';

/**
 * The **inner** SignedOrderV2.signature_scheme: only this lowercase literal is accepted.
 * It describes the order's EIP-712 recoverable signature (65 bytes), verified by the Keeper.
 */
export const SIGNATURE_SCHEME = 'eip712';

/**
 * The **outer** OpenTaskHeader.signature_scheme: still "secp256k1" - don't confuse it with the one above.
 *
 * It describes header.signature - the 64-byte signature nexus verifies with
 * CurrentOrderSigningBytes + VerifySig (sha256-based), which is a completely separate
 * signature from the order's EIP-712 signature. nexus main's
 * internal/ingress/taskdata.go:validateOpenTaskHeader hard-validates this literal
 * (`header.GetSignatureScheme() != "secp256k1"` is treated as malformed), and it also
 * feeds into field 7 of openTaskBodyDigest - getting it wrong breaks both "header
 * validation" and "envelope signature verification" at once.
 */
export const OPEN_TASK_HEADER_SIGNATURE_SCHEME = 'secp256k1';

/** EIP-712 order domain; values are frozen by task_order.domain in account_signing_v1.json. */
export const ORDER_EIP712_DOMAIN_NAME = 'TrueOpen Task Order';
export const ORDER_EIP712_DOMAIN_VERSION = '2';

/**
 * Type table for the order's EIP-712 payload. The message has only 11 fields - it is
 * **not** a full-field mirror of TaskOrderV2, but a "human-readable summary + taskHash":
 * the wallet prompt shows the first 10 fields, and the 11th field, taskHash, binds the
 * canonical hash of the full order into the same signature. So the signature effectively
 * covers all 25 fields.
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
    { name: 'modelId', type: 'string' },
    { name: 'profileVersion', type: 'uint32' },
    { name: 'maxFee', type: 'string' },
    { name: 'feeDenom', type: 'string' },
    { name: 'earliestSubmitHeight', type: 'uint64' },
    { name: 'orderExpireHeight', type: 'uint64' },
    { name: 'taskHash', type: 'bytes32' },
  ],
};

/** Two values the order's EIP-712 payload needs but that don't live on TaskOrderV2. */
export interface OrderEip712Context {
  /**
   * The chainId in the EIP-712 domain is the **EVM numeric chain ID** (424242 in the
   * test vectors), which is distinct from TaskOrderV2.chain_id (the cosmos string chain
   * ID) - both are included in the signature.
   */
  readonly evmChainId: bigint | number | string;
  /** Fee denom. shared.v1.Amount only carries atomic_units; the denom comes from chain params. */
  readonly feeDenom: string;
}

/** The order's EIP-712 signing digest (32 bytes). */
export function taskOrderEip712Digest(order: TaskOrderV2, ctx: OrderEip712Context): Uint8Array {
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
  return eip712Digest(
    ORDER_EIP712_TYPES,
    {
      name: ORDER_EIP712_DOMAIN_NAME,
      version: ORDER_EIP712_DOMAIN_VERSION,
      chainId: typeof ctx.evmChainId === 'number' ? BigInt(ctx.evmChainId) : ctx.evmChainId,
    },
    'TaskOrder',
    message,
  );
}

/**
 * Convert the SDK-side TaskOrderV2 view into the frozen protobuf message.
 *
 * We deliberately keep two parallel representations: the hand-written view is the input
 * to task_hash (taskOrderHash depends only on it, which keeps it easy to assert as a
 * pure function), while the generated type is only responsible for wire encoding. Any
 * drift between the two is caught by the "task_hash is unchanged after a proto
 * round-trip" test case in signed-order.test.ts.
 */
function toProtoTaskOrder(order: TaskOrderV2): ProtoTaskOrderV2 {
  const d = order.generationParams.decodingParams;
  return create(TaskOrderV2Schema, {
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
  });
}

/** SignedOrderV2's protobuf bytes, plus derived values that the outer signature can reuse. */
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
 * As of v0.4.1, users **no longer sign the raw task_hash directly**: they sign the
 * digest of the EIP-712 "TrueOpen Task Order" v2 domain, with task_hash embedded as one
 * of its bytes32 fields. The signature shape changes accordingly, from a 64-byte R||S to
 * a **65-byte R||S||V** (V in {27,28}, low-S); the chain recovers the address from the
 * recoverable signature and no longer needs the public key passed in.
 *
 * Note the distinction from the **outer** signature: OpenTaskHeader.signature signs
 * nexus's SDK request envelope domain, which uses a different signing object and hash
 * function (keccak vs sha256) from the order signature here. Placing an order produces
 * two separate signatures.
 */
export async function signAndEncodeOrder(
  order: TaskOrderV2,
  ctx: OrderEip712Context,
  signer: Eip712Signer,
): Promise<EncodedSignedOrder> {
  const taskHash = taskOrderHash(order);
  const signingDigest = taskOrderEip712Digest(order, ctx);
  const userSignature = await signer(signingDigest);
  if (userSignature.length !== 65) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'SDK_LOCAL_BAD_SIGNATURE_LEN',
      `user_signature must be 65 bytes R||S||V, got ${userSignature.length}`,
    );
  }
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
export function encodeSignedOrder(order: TaskOrderV2, userSignature: Uint8Array): Uint8Array {
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
 * from TrueOpen/wire (third_party/wire, v0.4.1) rather than hand-copied as a subset.
 */
export function decodeSignedOrder(bytes: Uint8Array): ProtoSignedOrderV2 {
  return fromBinary(SignedOrderV2Schema, bytes);
}
