import { toHex } from '../util/bytes';
import { sha256 } from '../codec/hash';
import { TrueOpenError } from '../errors/errors';
import { signAndEncodeOrder, OPEN_TASK_HEADER_SIGNATURE_SCHEME } from './signed-order';
import type { OrderEip712Context } from './signed-order';
import { payloadRefFor } from './task-order-input';
import { orderEnvelopeSigningBytes } from './order-signing';
import { signSdkRequestEnvelope, ingressEndpoint, HEIGHT_EXPIRY_THRESHOLD } from '../transport/sdk-request-envelope';
import { openTaskBodyDigest } from '../transport/sdk-request-body';
import type { TaskOrderV3 } from './task-order';
import type { OpenTaskInput } from '../transport/ingress-client';
import type { CosmosSecp256k1Signer } from '../signer/secp256k1';
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
  /** The session the order belongs to, canonical lowercase 64-hex. */
  readonly sessionId: string;
  readonly taskId: string;
  /**
   * The request_envelope's expiry **chain height** (not a timestamp). nexus requires
   * 0 < expiry < 1e12, otherwise it is interpreted as a unix millisecond timestamp and rejected.
   */
  readonly expiryHeight: bigint;
  readonly requestNonce: Uint8Array;
  /** Required; must stay identical across retries. */
  readonly idempotencyKey: string;
  readonly inputMediaType?: string;
  /**
   * The user's wallet. Signs the order's EIP-712 digest and the request envelope, both as
   * order.userAddress (the Keeper and the Builder recover the address from the signature).
   */
  readonly wallet: TypedDataSigner;
  /** The "hash-then-sign" signer for the outer order envelope signature (verified by nexus). */
  readonly signer: CosmosSecp256k1Signer;
  readonly chunkSizeBytes?: number;
}

export interface BuildOpenTaskResult {
  readonly input: OpenTaskInput;
  /** canonical task_hash (lowercase 64-hex), covered as a bytes32 field by the inner EIP-712 signature. */
  readonly taskHash: string;
  /** Hex of the SignedOrderV2 bytes -- this exact text is what the outer signature covers. */
  readonly orderEnvelopeHex: string;
}

/**
 * End-to-end assembly of a single OpenTask order submission, producing input that can be
 * passed directly to IngressClient.openTask.
 *
 * A single order submission involves **two user signatures**, over different byte
 * encodings and hash schemes -- this is the easiest part of the flow to get wrong:
 *
 *  1. Inner SignedOrderV2.user_signature -- signs the digest of the EIP-712
 *     "TrueOpen Task Order" v2 domain (keccak, 65-byte R||S||V); task_hash is one
 *     bytes32 field of that message. Uses orderSigner.
 *  2. Outer OpenTaskHeader.signature -- signs
 *     domainHash("TRUEOPEN_ORDER_V1", chain_id, user, session_id, dec(order_sequence),
 *     hex(SignedOrderV2 bytes)), sha256 scheme, 64 bytes. Note that the 5th field is
 *     the **hex text** of the order bytes, because on the nexus side
 *     order.OrderEnvelope = hex.EncodeToString(raw). Uses signer.
 *
 * The two differ in hash function (keccak vs sha256), signature length (65 vs 64),
 * and signed object, and are not interchangeable.
 *
 * The third signature is the request envelope (SDKRequestEnvelopeV2, EIP-712 SDKRequest),
 * signed by the same wallet as the order user.
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
  if (input.idempotencyKey === '') {
    throw local('SDK_LOCAL_IDEMPOTENCY_KEY_REQUIRED', 'idempotency_key is required');
  }

  // (1) Inner: sign the order's EIP-712 digest (task_hash is one of its fields), encode as SignedOrderV2.
  const signed = await signAndEncodeOrder(input.order, input.orderEip712, input.wallet);
  const orderEnvelopeHex = toHex(signed.bytes);

  // (2) Outer: on the nexus side, order_envelope is fed into domainHash as hex text.
  // This matches nexus main's validateOpenTaskHeader (checked 2026-09-15, main@b19f6206):
  //   signer.VerifySig(requestEnvelope.signer_pubkey,
  //     nodecontract.CurrentOrderSigningBytes(chain_id, user, session_id, order_sequence,
  //                                           order.OrderEnvelope),
  //     header.signature)
  // i.e. **sha256 scheme, 64 bytes**, and header.signature_scheme is hard-checked to be
  // "secp256k1". The order itself switched to EIP-712, but this outer signature did not
  // change -- the two must not be mixed up.
  const outerFull = await input.signer(
    orderEnvelopeSigningBytes(
      input.order.chainId,
      input.order.userAddress,
      input.sessionId,
      input.order.orderSequence,
      orderEnvelopeHex,
    ),
  );
  const outerSignature = outerFull.length === 65 ? outerFull.subarray(0, 64) : outerFull;

  const payloadRef = payloadRefFor(input.payload);
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

  // (3) Request envelope: EIP-712 SDKRequest, wallet-signed as the order user, never a session key.
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
    { signerAddress: input.order.userAddress, signer: input.wallet, evmChainId: BigInt(input.orderEip712.evmChainId) },
  );

  return {
    input: {
      orderEnvelope: signed.bytes,
      payloadRef,
      signature: outerSignature,
      requestEnvelope,
      sessionId: input.sessionId,
      orderSequence: input.order.orderSequence,
      userAddress: input.order.userAddress,
      signatureScheme: OPEN_TASK_HEADER_SIGNATURE_SCHEME,
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
