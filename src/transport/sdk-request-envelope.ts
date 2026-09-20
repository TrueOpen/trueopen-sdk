import { sha256 } from '../codec/hash';
import { frame4, i64be, u64be } from '../codec/frame';
import type { CosmosSecp256k1Signer } from '../signer/secp256k1';

export type AccessLevelName = 'PACKAGE' | 'SEALED_KEY';

const enc = new TextEncoder();

/** Fixed domain separator (nexus internal/sdkauth RequestDomain). */
export const SDK_REQUEST_DOMAIN = 'TRUEOPEN_SDK_REQUEST_V1';

/** The fields of SDKRequestEnvelopeV1 that go into the signature (excludes signer_address/signature/pubkey). */
export interface SdkRequestEnvelopeFields {
  readonly chainId: string;
  readonly method: string;
  readonly endpoint: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly requestNonce: Uint8Array;
  readonly expiryHeightOrTime: bigint;
  readonly bodyDigest: Uint8Array;
}

/**
 * Sign bytes (nexus sdkauth.SignBytes): a frame with 4-byte length prefixes,
 * in field order:
 * domain, chain_id, method, endpoint, session_id, task_id, request_nonce, i64be(expiry), body_digest.
 * Request signature = secp256k1(sha256(SignBytes)); the sha256 step is done by CosmosSecp256k1Signer.
 */
export function sdkRequestSignBytes(f: SdkRequestEnvelopeFields): Uint8Array {
  return frame4(
    enc.encode(SDK_REQUEST_DOMAIN),
    enc.encode(f.chainId),
    enc.encode(f.method),
    enc.encode(f.endpoint),
    enc.encode(f.sessionId),
    enc.encode(f.taskId),
    f.requestNonce,
    i64be(f.expiryHeightOrTime),
    f.bodyDigest,
  );
}

/** Generic request body digest (nexus sdkauth.BodyDigest): sha256(4-byte-prefixed frame(fields...)). Field order is defined per method. */
export function bodyDigest(...fields: Uint8Array[]): Uint8Array {
  return sha256(frame4(...fields));
}

/**
 * body_digest for SubmitOrder (field order matches nexus submitOrderBodyDigest).
 * Since nexus PR#10, the payload is appended at the end (the plaintext input body; the V1 dataplane transmits it in plaintext).
 */
export function submitOrderBodyDigest(m: {
  readonly orderEnvelope: Uint8Array;
  readonly payloadRef: string;
  readonly signature: Uint8Array; // raw 64-byte user order signature
  readonly sessionId: string;
  readonly orderSequence: bigint;
  readonly userAddress: string;
  readonly signatureScheme: string;
  readonly payload: Uint8Array; // the plaintext input body
}): Uint8Array {
  return bodyDigest(
    m.orderEnvelope,
    enc.encode(m.payloadRef),
    m.signature,
    enc.encode(m.sessionId),
    u64be(m.orderSequence),
    enc.encode(m.userAddress),
    enc.encode(m.signatureScheme),
    m.payload,
  );
}

/**
 * body_digest for OpenTask (field order strictly matches openTaskBodyDigest in
 * nexus internal/ingress/taskdata.go:240-247):
 *   order_envelope, payload_ref, signature, session_id, u64be(order_sequence),
 *   user_address, signature_scheme, u64be(input_size_bytes), input_hash, input_media_type
 *
 * Differences from SubmitOrder: **no payload** (the input body travels as
 * chunk frames, not part of the digest), and input_size_bytes / input_hash /
 * input_media_type are appended at the end. It also **excludes
 * idempotency_key** -- contract §8.1 hasn't frozen whether it's folded into
 * BodyDigest, and nexus currently doesn't count it.
 */
export function openTaskBodyDigest(m: {
  readonly orderEnvelope: Uint8Array;
  readonly payloadRef: string;
  readonly signature: Uint8Array; // the outer raw 64-byte user order signature
  readonly sessionId: string;
  readonly orderSequence: bigint;
  readonly userAddress: string;
  readonly signatureScheme: string;
  readonly inputSizeBytes: bigint;
  /** canonical lowercase 64-hex (a string in the header, not bytes). */
  readonly inputHash: string;
  readonly inputMediaType: string;
}): Uint8Array {
  return bodyDigest(
    m.orderEnvelope,
    enc.encode(m.payloadRef),
    m.signature,
    enc.encode(m.sessionId),
    u64be(m.orderSequence),
    enc.encode(m.userAddress),
    enc.encode(m.signatureScheme),
    u64be(m.inputSizeBytes),
    enc.encode(m.inputHash),
    enc.encode(m.inputMediaType),
  );
}

const e = enc;

/** FetchOutputRef body_digest (field order matches nexus fetchOutputRefBodyDigest). */
export function fetchOutputRefBodyDigest(
  sessionId: string,
  taskId: string,
  requester: string,
  accessLevel: AccessLevelName,
  usage: string,
): Uint8Array {
  return bodyDigest(e.encode(sessionId), e.encode(taskId), e.encode(requester), e.encode(accessLevel), e.encode(usage));
}

/** body_digest for GetTaskEvents. */
export function getTaskEventsBodyDigest(sessionId: string, taskId: string, fromCursor: string): Uint8Array {
  return bodyDigest(e.encode(sessionId), e.encode(taskId), e.encode(fromCursor));
}

/** body_digest for RefreshCredential (requested_valid_until is i64be). */
export function refreshCredentialBodyDigest(
  credentialId: string,
  sessionId: string,
  taskId: string,
  recipient: string,
  usage: string,
  requestedValidUntil: bigint,
): Uint8Array {
  return bodyDigest(
    e.encode(credentialId),
    e.encode(sessionId),
    e.encode(taskId),
    e.encode(recipient),
    e.encode(usage),
    i64be(requestedValidUntil),
  );
}

/** body_digest for PrepareChallenge (local_evidence_digest is raw bytes, and may be empty). */
export function prepareChallengeBodyDigest(
  sessionId: string,
  taskId: string,
  challengeKind: string,
  localEvidenceDigest: Uint8Array,
): Uint8Array {
  return bodyDigest(e.encode(sessionId), e.encode(taskId), e.encode(challengeKind), localEvidenceDigest);
}

/** body_digest for SubscribeOutput (nexus ingress service.go:269). */
/**
 * body_digest for SubscribeOutput: two fields. resume_after_seq is **not** part of the
 * signature. Matches nexus main's internal/ingress/outputstream.go:subscribeOutputStream.
 */
export function subscribeOutputBodyDigest(sessionId: string, taskId: string): Uint8Array {
  return bodyDigest(e.encode(sessionId), e.encode(taskId));
}

/**
 * body_digest for AckOutput: **three fields, output_id must be present even when empty**.
 *
 * Matches nexus main's internal/ingress/outputstream.go:ackOutputStream -- this line
 * hasn't changed in ADR-0017's streaming branch:
 *   body := sdkauth.BodyDigest(sessionID, taskID, outputID)
 * output_id is marked deprecated in the proto, but it's still part of the signature.
 * BodyDigest is a length-prefixed frame, and an empty string contributes a "4-byte
 * zero-length prefix", not nothing at all -- dropping it produces a different digest,
 * and nexus will report SDK_AUTH_INVALID_SIGNATURE.
 *
 * last_seq is **not** part of body_digest (confirmed in the same source file).
 */
export function ackOutputBodyDigest(sessionId: string, taskId: string, outputId = ''): Uint8Array {
  return bodyDigest(e.encode(sessionId), e.encode(taskId), e.encode(outputId));
}

/** A signed SDKRequestEnvelopeV1 (maps directly to the proto / Connect-JSON form). */
export interface SignedSdkRequestEnvelope extends SdkRequestEnvelopeFields {
  readonly requestDomain: typeof SDK_REQUEST_DOMAIN;
  readonly signerAddress: string;
  readonly signature: Uint8Array; // 64-byte r||s
  readonly signerPubKey: Uint8Array; // 33-byte compressed public key
}

/** Signs the request envelope and returns the full envelope ready to send. */
export async function signSdkRequestEnvelope(
  fields: SdkRequestEnvelopeFields,
  signerAddress: string,
  signerPubKey: Uint8Array,
  signer: CosmosSecp256k1Signer,
): Promise<SignedSdkRequestEnvelope> {
  const sig = await signer(sdkRequestSignBytes(fields));
  const raw = sig.length === 65 ? sig.subarray(0, 64) : sig;
  return { requestDomain: SDK_REQUEST_DOMAIN, ...fields, signerAddress, signature: raw, signerPubKey };
}
