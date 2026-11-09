import { toHex } from '../util/bytes';
import { hash32Text, strictHash32 } from '../codec/hash32';
import { sha256 } from '../codec/hash';
import { TrueOpenError } from '../errors/errors';
import { signAndEncodeOrder, decodeSignedOrder } from './signed-order';
import type { OrderEip712Context } from './signed-order';
import { deriveTaskId } from './order-signing';
import { canonicalAccountAddressBytes } from '../codec/address';
import { signSdkRequestEnvelope, ingressEndpoint, HEIGHT_EXPIRY_THRESHOLD } from '../transport/sdk-request-envelope';
import { signatureChainIdBigInt } from '../signature-chain-id';
import { openTaskBodyDigest, openTaskPayloadRef } from '../transport/sdk-request-body';
import type { TaskOrderV3 } from './task-order';
import type { OpenTaskInput } from '../transport/ingress-client';
import type { TypedDataSigner } from '../signer/typed-data-signer';
import type { ActiveSession } from '../session/session-grant';
import type { RegisteredSessionKey } from '../session/registered-session-key';

/** OpenTask's Connect procedure path (goes into the SDKRequestEnvelope's endpoint field). */
export const OPEN_TASK_ENDPOINT = ingressEndpoint('OpenTask');

/** Values >= 1e12 are Unix milliseconds; OpenTask is signed with a chain height below it. */
export { HEIGHT_EXPIRY_THRESHOLD };

const DEFAULT_MEDIA_TYPE = 'application/octet-stream';

export interface BuildOpenTaskInput {
  /** The already-assembled, frozen order (see buildTaskOrder). */
  readonly order: TaskOrderV3;
  /** Two values the order's EIP-712 signing needs but that aren't part of the order itself: the signer-chosen chain ID and the fee denomination. */
  readonly orderEip712: OrderEip712Context;
  /** The plaintext input payload itself; must match order.inputHash / inputSizeBytes. */
  readonly payload: Uint8Array;
  /** The session the order belongs to, `0x` + 64 lowercase hex; must be the order's. */
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
   * The user's wallet. Signs the order's EIP-712 digest as order.userAddress (the Keeper
   * recovers the address from it) unless `registeredKey` is given, and signs the request
   * envelope unless `session` or `registeredKey` is given.
   */
  readonly wallet: TypedDataSigner;
  /**
   * Signs the request envelope with this session key instead of the wallet, carrying its grant
   * (wire PR #43). The grant must be for order.userAddress. The order is still wallet-signed, so
   * this saves one wallet prompt per order.
   */
  readonly session?: ActiveSession;
  /**
   * The session's registered key (ADR-0037) signs both the order and the request envelope
   * instead of the wallet, so the order needs no wallet prompt at all. Its sessionId must be the
   * order's; exclusive with `session`. The order must also pass the on-chain key checks (the
   * key is the current one, not expired, within its spend cap), which this function does not see.
   */
  readonly registeredKey?: RegisteredSessionKey;
  readonly chunkSizeBytes?: number;
  /**
   * The configured chain ID. When given, an order (and so an envelope) for another chain is
   * refused locally with SDK_LOCAL_CHAIN_ID_MISMATCH.
   */
  readonly chainId?: string;
}

export interface BuildOpenTaskResult {
  readonly input: OpenTaskInput;
  /** canonical task_hash (`0x` + 64 lowercase hex), covered as a bytes32 field by the inner EIP-712 signature. */
  readonly taskHash: string;
  /** Hex of the SignedOrderV2 bytes sent as order_envelope. */
  readonly orderEnvelopeHex: string;
  /**
   * The same OpenTask input with the request envelope signed again under `requestNonce`, by the
   * same signer; the signed order is unchanged. A Builder consumes an OpenTask nonce before it
   * checks the order, so a re-send needs a fresh one. With a wallet-signed envelope this prompts
   * the wallet again.
   */
  readonly resign: (requestNonce: Uint8Array) => Promise<OpenTaskInput>;
}

/**
 * End-to-end assembly of a single OpenTask order submission, producing input that can be
 * passed directly to IngressClient.openTask.
 *
 * Two EIP-712 signatures, both on behalf of the order user:
 *
 *  1. SignedOrderV2.user_signature -- the "TrueOpen Task Order" v3 digest, with task_hash as one
 *     bytes32 field, by the wallet or by the session's registered key (`registeredKey`,
 *     ADR-0037). This alone authorizes the order; the Keeper verifies it, recovering the wallet's
 *     address or the session's registered key.
 *  2. The request envelope -- the "TrueOpen SDK Request" SDKRequest, whose bodyDigest is
 *     TRUEOPEN_SDK_BODY_OPEN_TASK_V1(task_hash, session_id, order_sequence, user_address,
 *     input_size_bytes, input_hash, input_media_type, idempotency_key). By the wallet, by a
 *     granted session key (`session`), or by the registered key (`registeredKey`, zero grant hash
 *     and no grant). With `session` the wallet prompts once per order; with `registeredKey`, not at all.
 *
 * There is no outer order signature: OpenTaskHeader.signature and signature_scheme stay
 * empty. payload_ref is not signed but must be "nexus://sha256/" || lowercase_hex(input_hash).
 * The Builder also requires the user's account to hold its public key on chain already (the
 * user has submitted MsgCreateSession).
 */
export async function buildOpenTaskRequest(input: BuildOpenTaskInput): Promise<BuildOpenTaskResult> {
  // Every envelope check runs before the order is signed (a wallet prompt), on the order's own fields.
  checkOpenTaskFacts(
    {
      chainId: input.order.chainId,
      userAddress: input.order.userAddress,
      sessionId: hash32Text(input.order.sessionId),
      orderSequence: input.order.orderSequence,
      inputHash: hash32Text(input.order.inputHash),
      inputSizeBytes: input.order.inputSizeBytes,
    },
    input,
  );

  // (1) The order's EIP-712 signature (task_hash is one of its fields), encoded as SignedOrderV2:
  // by the wallet, or by the registered key, recovering to the key's address.
  const rk = input.registeredKey;
  const signed =
    rk === undefined
      ? await signAndEncodeOrder(input.order, input.orderEip712, input.wallet)
      : await signAndEncodeOrder(input.order, input.orderEip712, rk.signer, { expectedSigner: rk.address });

  // (2) The request envelope, over the bytes just signed.
  const { order: _order, orderEip712: _eip712, ...envelope } = input;
  void _order;
  void _eip712;
  return openTaskInputForSignedOrder({ ...envelope, signedOrder: signed.bytes, taskHash: hash32Text(signed.taskHash) });
}

/** What openTaskInputForSignedOrder needs: an already-signed order plus everything about the request envelope. */
export interface SignedOrderOpenTaskInput extends Omit<BuildOpenTaskInput, 'order' | 'orderEip712'> {
  /**
   * SignedOrderV2 bytes exactly as signed (BuildOpenTaskResult.orderEnvelopeHex, decoded). They
   * are sent unchanged; the order fields the envelope binds (chain, user, session, sequence,
   * input hash and size, signature chain ID) are read from them.
   */
  readonly signedOrder: Uint8Array;
  /** The order's canonical task_hash (`0x` + 64 lowercase hex), as returned when it was built. */
  readonly taskHash: string;
}

/**
 * The OpenTask input for an order that is already signed: only the request envelope is signed
 * (under `requestNonce`, by the wallet, a granted session key or the registered key), and the
 * SignedOrderV2 bytes go out unchanged, so the order keeps its task_hash. buildOpenTaskRequest
 * uses it after signing the order; TrueOpenClient uses it to resend a recorded order exactly (an
 * openTask retry under the same idempotency key).
 *
 * The same local checks as buildOpenTaskRequest apply, against the order decoded from the
 * bytes. `taskHash` must be the order's: a Builder recomputes it, and a wrong one fails the
 * envelope's body digest there.
 */
export async function openTaskInputForSignedOrder(input: SignedOrderOpenTaskInput): Promise<BuildOpenTaskResult> {
  let decoded: ReturnType<typeof decodeSignedOrder>;
  try {
    decoded = decodeSignedOrder(input.signedOrder);
  } catch (cause) {
    throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_SIGNED_ORDER_INVALID', 'signedOrder is not SignedOrderV2 bytes', { cause });
  }
  const o = decoded.order;
  if (o === undefined) throw local('SDK_LOCAL_SIGNED_ORDER_INVALID', 'signedOrder carries no order');
  strictHash32('taskHash', input.taskHash);
  const facts: OpenTaskFacts = {
    chainId: o.chainId,
    userAddress: o.userAddress,
    sessionId: hash32Text(o.sessionId),
    orderSequence: o.orderSequence,
    inputHash: hash32Text(o.inputHash),
    inputSizeBytes: o.inputSizeBytes,
  };
  checkOpenTaskFacts(facts, input);
  const rk = input.registeredKey;
  const payloadRef = openTaskPayloadRef(facts.inputHash);
  const inputMediaType = input.inputMediaType ?? DEFAULT_MEDIA_TYPE;

  const bodyDigest = openTaskBodyDigest({
    taskHash: strictHash32('taskHash', input.taskHash),
    sessionId: input.sessionId,
    orderSequence: facts.orderSequence,
    userAddress: facts.userAddress,
    inputSizeBytes: BigInt(input.payload.length),
    inputHash: facts.inputHash,
    inputMediaType,
    idempotencyKey: input.idempotencyKey,
  });

  // Request envelope: EIP-712 SDKRequest as the order user -- by the wallet, by a session
  // key under a grant for that user, or by the session's registered key.
  const withEnvelope = async (requestNonce: Uint8Array): Promise<OpenTaskInput> => {
    const requestEnvelope = await signSdkRequestEnvelope(
      {
        chainId: facts.chainId,
        method: 'OpenTask',
        sessionId: input.sessionId,
        taskId: input.taskId,
        requestNonce,
        expiryHeightOrTime: input.expiryHeight,
        bodyDigest,
      },
      {
        signerAddress: facts.userAddress,
        signer: input.wallet,
        signatureChainId: signatureChainIdBigInt(decoded.signatureChainId),
        ...(input.chainId !== undefined ? { chainId: input.chainId } : {}),
        ...(input.session !== undefined ? { session: input.session } : {}),
        ...(rk !== undefined ? { registeredKey: rk } : {}),
      },
    );
    return {
      orderEnvelope: input.signedOrder,
      payloadRef,
      requestEnvelope,
      sessionId: input.sessionId,
      orderSequence: facts.orderSequence,
      userAddress: facts.userAddress,
      inputHash: facts.inputHash,
      inputMediaType,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      ...(input.chunkSizeBytes !== undefined ? { chunkSizeBytes: input.chunkSizeBytes } : {}),
    };
  };

  return {
    input: await withEnvelope(input.requestNonce),
    taskHash: input.taskHash,
    orderEnvelopeHex: toHex(input.signedOrder),
    resign: withEnvelope,
  };
}

/** The order fields the OpenTask request binds, in text form. */
interface OpenTaskFacts {
  readonly chainId: string;
  readonly userAddress: string;
  /** `0x` + 64 lowercase hex. */
  readonly sessionId: string;
  readonly orderSequence: bigint;
  /** `0x` + 64 lowercase hex. */
  readonly inputHash: string;
  readonly inputSizeBytes: bigint;
}

/** The local OpenTask checks, made before anything is signed. */
function checkOpenTaskFacts(order: OpenTaskFacts, input: Omit<BuildOpenTaskInput, 'order' | 'orderEip712'>): void {
  if (input.payload.length === 0) {
    throw local('SDK_LOCAL_PAYLOAD_EMPTY', 'payload must be non-empty');
  }
  // The order already signs input_hash / input_size_bytes into task_hash; this checks that
  // the payload matches: a mismatch would be rejected by nexus in validateOpenTaskHeader
  // (OpenTask input hash / commitment), so failing locally first is easier to diagnose.
  const payloadHashHex = hash32Text(sha256(input.payload));
  if (order.inputHash !== payloadHashHex) {
    throw local(
      'SDK_LOCAL_PAYLOAD_HASH_MISMATCH',
      `order.input_hash (${order.inputHash}) != sha256(payload) (${payloadHashHex})`,
    );
  }
  if (order.inputSizeBytes !== BigInt(input.payload.length)) {
    throw local(
      'SDK_LOCAL_PAYLOAD_SIZE_MISMATCH',
      `order commits to ${order.inputSizeBytes} bytes but payload is ${input.payload.length}`,
    );
  }
  if (input.expiryHeight <= 0n || input.expiryHeight >= HEIGHT_EXPIRY_THRESHOLD) {
    throw local(
      'SDK_LOCAL_EXPIRY_NOT_HEIGHT',
      `OpenTask expiry must be a chain height in (0, ${HEIGHT_EXPIRY_THRESHOLD}); got ${input.expiryHeight}`,
    );
  }
  if (input.chainId !== undefined && order.chainId !== input.chainId) {
    throw local('SDK_LOCAL_CHAIN_ID_MISMATCH', `order chain_id ${order.chainId} is not the configured chain ${input.chainId}`);
  }
  // user_address: canonical lowercase Bech32 with the account prefix, 20 bytes.
  canonicalAccountAddressBytes('user_address', order.userAddress);
  if (input.idempotencyKey === '') {
    throw local('SDK_LOCAL_IDEMPOTENCY_KEY_REQUIRED', 'idempotency_key is required');
  }
  // The Builder rejects an OpenTask whose task_id is not derived from the order's own session
  // and sequence; so does the SDK, before anything is signed.
  if (order.sessionId !== input.sessionId) {
    throw local('SDK_LOCAL_OPEN_TASK_SESSION_MISMATCH', `session_id ${input.sessionId} is not the order's ${order.sessionId}`);
  }
  const rk = input.registeredKey;
  if (rk !== undefined && input.session !== undefined) {
    throw local('SDK_LOCAL_REQUEST_MALFORMED', 'a session grant and a registered session key are exclusive');
  }
  if (rk !== undefined && rk.sessionId !== input.sessionId) {
    throw local('SDK_LOCAL_OPEN_TASK_SESSION_MISMATCH', `the registered session key is for session ${rk.sessionId}, not ${input.sessionId}`);
  }
  const derived = deriveTaskId(input.sessionId, order.orderSequence);
  if (input.taskId !== derived) {
    throw local('SDK_LOCAL_OPEN_TASK_ID_NOT_DERIVED', `task_id ${input.taskId} is not TRUEOPEN_TASK_ID_V1(session_id, order_sequence) = ${derived}`);
  }
}

function local(code: string, message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', code, message);
}
