import { toHex } from '../util/bytes';
import { sha256 } from '../codec/hash';
import { TrueOpenError } from '../errors/errors';
import { signAndEncodeOrder } from './signed-order';
import type { OrderEip712Context } from './signed-order';
import { deriveTaskId } from './order-signing';
import { canonicalAccountAddressBytes } from '../codec/address';
import { signSdkRequestEnvelope, ingressEndpoint, HEIGHT_EXPIRY_THRESHOLD } from '../transport/sdk-request-envelope';
import { openTaskBodyDigest, openTaskPayloadRef } from '../transport/sdk-request-body';
import type { TaskOrderV3 } from './task-order';
import type { OpenTaskInput } from '../transport/ingress-client';
import type { TypedDataSigner } from '../signer/typed-data-signer';

/** OpenTask's Connect procedure path (goes into the SDKRequestEnvelope's endpoint field). */
export const OPEN_TASK_ENDPOINT = ingressEndpoint('OpenTask');

/** Values >= 1e12 are Unix milliseconds; OpenTask is signed with a chain height below it. */
export { HEIGHT_EXPIRY_THRESHOLD };

const DEFAULT_MEDIA_TYPE = 'application/octet-stream';

export interface BuildOpenTaskInput {
  /** The already-assembled, frozen order (see buildTaskOrder). */
  readonly order: TaskOrderV3;
  /** Two values the order's EIP-712 signing needs but that aren't part of the order itself: the EVM numeric chain ID and the fee denomination. */
  readonly orderEip712: OrderEip712Context;
  /** The plaintext input payload itself; must match order.inputHash / inputSizeBytes. */
  readonly payload: Uint8Array;
  /** The session the order belongs to, canonical lowercase 64-hex; must be the order's. */
  readonly sessionId: string;
  /** Must be TRUEOPEN_TASK_ID_V1(session_id, order_sequence) (deriveTaskId). */
  readonly taskId: string;
  /**
   * The request_envelope's expiry **chain height** (not a timestamp): 0 < expiry < 1e12. A value
   * of 1e12 or more is Unix milliseconds, which OpenTask does not accept.
   */
  readonly expiryHeight: bigint;
  readonly requestNonce: Uint8Array;
  /** Required; must stay identical across retries. */
  readonly idempotencyKey: string;
  readonly inputMediaType?: string;
  /**
   * The user's wallet. Signs the order's EIP-712 digest and the request envelope, both as
   * order.userAddress (the Keeper and the Builder recover the address from the signature).
   * Never a session key: OpenTask does not accept a session grant.
   */
  readonly wallet: TypedDataSigner;
  readonly chunkSizeBytes?: number;
  /**
   * The configured chain ID. When given, an order (and so an envelope) for another chain is
   * refused locally with SDK_LOCAL_CHAIN_ID_MISMATCH.
   */
  readonly chainId?: string;
}

export interface BuildOpenTaskResult {
  readonly input: OpenTaskInput;
  /** canonical task_hash (lowercase 64-hex), covered as a bytes32 field by the inner EIP-712 signature. */
  readonly taskHash: string;
  /** Hex of the SignedOrderV2 bytes sent as order_envelope. */
  readonly orderEnvelopeHex: string;
}

/**
 * End-to-end assembly of a single OpenTask order submission, producing input that can be
 * passed directly to IngressClient.openTask.
 *
 * The wallet signs twice, both EIP-712 typed data recovering to the order user:
 *
 *  1. SignedOrderV2.user_signature -- the "TrueOpen Task Order" v3 digest, with task_hash as one
 *     bytes32 field. This alone authorizes the order; the Keeper verifies it.
 *  2. The request envelope -- the "TrueOpen SDK Request" SDKRequest, whose bodyDigest is
 *     TRUEOPEN_SDK_BODY_OPEN_TASK_V1(task_hash, session_id, order_sequence, user_address,
 *     input_size_bytes, input_hash, input_media_type, idempotency_key). Never a session key.
 *
 * There is no outer order signature: OpenTaskHeader.signature and signature_scheme stay
 * empty. payload_ref is not signed but must be "nexus://sha256/" || lowercase_hex(input_hash).
 * The Builder also requires the user's account to hold its public key on chain already (the
 * user has submitted MsgCreateSession).
 */
export async function buildOpenTaskRequest(input: BuildOpenTaskInput): Promise<BuildOpenTaskResult> {
  if (input.payload.length === 0) {
    throw local('SDK_LOCAL_PAYLOAD_EMPTY', 'payload must be non-empty');
  }
  // The order already signs input_hash / input_size_bytes into task_hash; this checks that
  // the payload matches: a mismatch would be rejected by nexus in validateOpenTaskHeader
  // (OpenTask input hash / commitment), so failing locally first is easier to diagnose.
  const payloadHashHex = toHex(sha256(input.payload));
  const committedHashHex = toHex(input.order.inputHash);
  if (committedHashHex !== payloadHashHex) {
    throw local(
      'SDK_LOCAL_PAYLOAD_HASH_MISMATCH',
      `order.input_hash (${committedHashHex}) != sha256(payload) (${payloadHashHex})`,
    );
  }
  if (input.order.inputSizeBytes !== BigInt(input.payload.length)) {
    throw local(
      'SDK_LOCAL_PAYLOAD_SIZE_MISMATCH',
      `order commits to ${input.order.inputSizeBytes} bytes but payload is ${input.payload.length}`,
    );
  }
  if (input.expiryHeight <= 0n || input.expiryHeight >= HEIGHT_EXPIRY_THRESHOLD) {
    throw local(
      'SDK_LOCAL_EXPIRY_NOT_HEIGHT',
      `OpenTask expiry must be a chain height in (0, ${HEIGHT_EXPIRY_THRESHOLD}); got ${input.expiryHeight}`,
    );
  }
  if (input.chainId !== undefined && input.order.chainId !== input.chainId) {
    throw local('SDK_LOCAL_CHAIN_ID_MISMATCH', `order chain_id ${input.order.chainId} is not the configured chain ${input.chainId}`);
  }
  // user_address: canonical lowercase Bech32 with the account prefix, 20 bytes.
  canonicalAccountAddressBytes('user_address', input.order.userAddress);
  if (input.idempotencyKey === '') {
    throw local('SDK_LOCAL_IDEMPOTENCY_KEY_REQUIRED', 'idempotency_key is required');
  }
  // The Builder rejects an OpenTask whose task_id is not derived from the order's own session
  // and sequence; so does the SDK, before anything is signed.
  if (toHex(input.order.sessionId) !== input.sessionId) {
    throw local('SDK_LOCAL_OPEN_TASK_SESSION_MISMATCH', `session_id ${input.sessionId} is not the order's ${toHex(input.order.sessionId)}`);
  }
  const derived = deriveTaskId(input.sessionId, input.order.orderSequence);
  if (input.taskId !== derived) {
    throw local('SDK_LOCAL_OPEN_TASK_ID_NOT_DERIVED', `task_id ${input.taskId} is not TRUEOPEN_TASK_ID_V1(session_id, order_sequence) = ${derived}`);
  }

  // (1) The order's EIP-712 signature (task_hash is one of its fields), encoded as SignedOrderV2.
  const signed = await signAndEncodeOrder(input.order, input.orderEip712, input.wallet);
  const orderEnvelopeHex = toHex(signed.bytes);

  const payloadRef = openTaskPayloadRef(payloadHashHex);
  const inputMediaType = input.inputMediaType ?? DEFAULT_MEDIA_TYPE;

  const bodyDigest = openTaskBodyDigest({
    taskHash: signed.taskHash,
    sessionId: input.sessionId,
    orderSequence: input.order.orderSequence,
    userAddress: input.order.userAddress,
    inputSizeBytes: BigInt(input.payload.length),
    inputHash: payloadHashHex,
    inputMediaType,
    idempotencyKey: input.idempotencyKey,
  });

  // (2) Request envelope: EIP-712 SDKRequest, wallet-signed as the order user, never a session key.
  const requestEnvelope = await signSdkRequestEnvelope(
    {
      chainId: input.order.chainId,
      method: 'OpenTask',
      sessionId: input.sessionId,
      taskId: input.taskId,
      requestNonce: input.requestNonce,
      expiryHeightOrTime: input.expiryHeight,
      bodyDigest,
    },
    {
      signerAddress: input.order.userAddress,
      signer: input.wallet,
      evmChainId: BigInt(input.orderEip712.evmChainId),
      ...(input.chainId !== undefined ? { chainId: input.chainId } : {}),
    },
  );

  return {
    input: {
      orderEnvelope: signed.bytes,
      payloadRef,
      requestEnvelope,
      sessionId: input.sessionId,
      orderSequence: input.order.orderSequence,
      userAddress: input.order.userAddress,
      inputHash: payloadHashHex,
      inputMediaType,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      ...(input.chunkSizeBytes !== undefined ? { chunkSizeBytes: input.chunkSizeBytes } : {}),
    },
    taskHash: toHex(signed.taskHash),
    orderEnvelopeHex,
  };
}

function local(code: string, message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', code, message);
}
