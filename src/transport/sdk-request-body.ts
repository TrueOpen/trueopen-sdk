import { canonicalHashBytes, optionalV1, uint64BE } from '../codec/domain-hash';
import { canonicalAccountAddressBytes } from '../codec/address';
import { strictHash32 } from '../codec/hash32';
import { toHex } from '../util/bytes';
import { TrueOpenError } from '../errors/errors';

/**
 * Request body digests for the user requests to Builder Ingress (SDKRequestEnvelopeV2.body_digest).
 *
 * Each method has its own registered H_FIELDS_V1 domain (wire registry/v1/domains.json):
 *   preimage = u64_be(len(domain)) || domain || for each field u64_be(len(field)) || field
 *   digest   = SHA256(preimage)
 * The digest is the bytes32 bodyDigest of the EIP-712 SDKRequest, so the body is bound to one
 * chain by that signature, not by a field here.
 *
 * Field encodings: a Hash32 is its raw 32 bytes (the transport lowercase hex decoded first), a
 * uint64 is 8-byte big-endian, a string is UTF-8, an address is the 20 bytes decoded from its
 * canonical Bech32 text, and an optional field is OPTIONAL_V1: 0x00 when absent,
 * 0x01 || FRAME_V1(value) when present.
 *
 * Vectors: wire testdata/v1/task/sdk_request_body_v1.json.
 */
export const SDK_BODY_DOMAIN = {
  OpenTask: 'TRUEOPEN_SDK_BODY_OPEN_TASK_V1',
  SubscribeOutput: 'TRUEOPEN_SDK_BODY_SUBSCRIBE_OUTPUT_V1',
  AckOutput: 'TRUEOPEN_SDK_BODY_ACK_OUTPUT_V1',
  GetTaskEvents: 'TRUEOPEN_SDK_BODY_GET_TASK_EVENTS_V1',
  PrepareChallenge: 'TRUEOPEN_SDK_BODY_PREPARE_CHALLENGE_V1',
} as const;

const enc = new TextEncoder();
const U64_MAX = (1n << 64n) - 1n;

function malformed(what: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_REQUEST_BODY_MALFORMED', `request body: ${what}`);
}


function u64(field: string, v: bigint): Uint8Array {
  if (v < 0n || v > U64_MAX) throw malformed(`${field} ${v} is outside uint64`);
  return uint64BE(v);
}

function bodyDigest(domain: string, ...fields: Uint8Array[]): Uint8Array {
  return canonicalHashBytes(enc.encode(domain), ...fields);
}

/** The OpenTask body. `payload_ref` and the outer order signature are not in it. */
export interface OpenTaskBody {
  /** task_hash of the SignedOrderV2 carried in order_envelope, raw 32 bytes. */
  readonly taskHash: Uint8Array;
  readonly sessionId: string;
  readonly orderSequence: bigint;
  /** Canonical Bech32 account address; framed as its 20 address bytes. */
  readonly userAddress: string;
  readonly inputSizeBytes: bigint;
  /** Lowercase 64-hex. */
  readonly inputHash: string;
  readonly inputMediaType: string;
  readonly idempotencyKey: string;
}

/**
 * TRUEOPEN_SDK_BODY_OPEN_TASK_V1(task_hash, session_id, order_sequence, user_address,
 * input_size_bytes, input_hash, input_media_type, idempotency_key).
 *
 * The verifier recomputes task_hash from the order in order_envelope; the envelope bytes
 * themselves are not framed. payload_ref is checked on the transport only
 * (see openTaskPayloadRef).
 */
export function openTaskBodyDigest(b: OpenTaskBody): Uint8Array {
  if (b.taskHash.length !== 32) throw malformed(`task_hash must be 32 bytes, got ${b.taskHash.length}`);
  return bodyDigest(
    SDK_BODY_DOMAIN.OpenTask,
    b.taskHash,
    strictHash32('session_id', b.sessionId),
    u64('order_sequence', b.orderSequence),
    canonicalAccountAddressBytes('user_address', b.userAddress),
    u64('input_size_bytes', b.inputSizeBytes),
    strictHash32('input_hash', b.inputHash),
    enc.encode(b.inputMediaType),
    enc.encode(b.idempotencyKey),
  );
}

/** OpenTaskHeader.payload_ref: "nexus://sha256/" || lowercase_hex(input_hash). Not signed, but checked. */
export function openTaskPayloadRef(inputHash: string): string {
  return `nexus://sha256/${toHex(strictHash32('input_hash', inputHash))}`;
}

/**
 * TRUEOPEN_SDK_BODY_SUBSCRIBE_OUTPUT_V1(session_id, task_id, OPTIONAL_V1(resume_after_seq)).
 * Follows transport presence: undefined is absent, 0n is present 0.
 */
export function subscribeOutputBodyDigest(sessionId: string, taskId: string, resumeAfterSeq?: bigint): Uint8Array {
  return bodyDigest(
    SDK_BODY_DOMAIN.SubscribeOutput,
    strictHash32('session_id', sessionId),
    strictHash32('task_id', taskId),
    optionalV1(resumeAfterSeq === undefined ? undefined : u64('resume_after_seq', resumeAfterSeq)),
  );
}

/** TRUEOPEN_SDK_BODY_ACK_OUTPUT_V1(session_id, task_id, last_seq). The deprecated output_id is not in it. */
export function ackOutputBodyDigest(sessionId: string, taskId: string, lastSeq: bigint): Uint8Array {
  return bodyDigest(
    SDK_BODY_DOMAIN.AckOutput,
    strictHash32('session_id', sessionId),
    strictHash32('task_id', taskId),
    u64('last_seq', lastSeq),
  );
}

/**
 * GetTaskEventsRequest.from_cursor as the body projects it: "" is absent; otherwise unsigned
 * decimal without leading zeros ("0" is valid), at most 2^64-1. Anything else is refused.
 */
export function parseFromCursor(fromCursor: string): bigint | undefined {
  if (fromCursor === '') return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(fromCursor)) {
    throw malformed(`from_cursor must be unsigned decimal without leading zeros, got ${JSON.stringify(fromCursor)}`);
  }
  const v = BigInt(fromCursor);
  if (v > U64_MAX) throw malformed(`from_cursor ${fromCursor} exceeds 2^64-1`);
  return v;
}

/** TRUEOPEN_SDK_BODY_GET_TASK_EVENTS_V1(session_id, task_id, OPTIONAL_V1(from_cursor as uint64)). */
export function getTaskEventsBodyDigest(sessionId: string, taskId: string, fromCursor: string): Uint8Array {
  const cursor = parseFromCursor(fromCursor);
  return bodyDigest(
    SDK_BODY_DOMAIN.GetTaskEvents,
    strictHash32('session_id', sessionId),
    strictHash32('task_id', taskId),
    optionalV1(cursor === undefined ? undefined : uint64BE(cursor)),
  );
}

/**
 * TRUEOPEN_SDK_BODY_PREPARE_CHALLENGE_V1(session_id, task_id, challenge_kind,
 * OPTIONAL_V1(local_evidence_digest)). An empty digest is absent, exactly 32 bytes is present,
 * any other length is refused.
 */
export function prepareChallengeBodyDigest(
  sessionId: string,
  taskId: string,
  challengeKind: string,
  localEvidenceDigest: Uint8Array = new Uint8Array(),
): Uint8Array {
  if (localEvidenceDigest.length !== 0 && localEvidenceDigest.length !== 32) {
    throw malformed(`local_evidence_digest must be empty or 32 bytes, got ${localEvidenceDigest.length}`);
  }
  return bodyDigest(
    SDK_BODY_DOMAIN.PrepareChallenge,
    strictHash32('session_id', sessionId),
    strictHash32('task_id', taskId),
    enc.encode(challengeKind),
    optionalV1(localEvidenceDigest.length === 0 ? undefined : localEvidenceDigest),
  );
}
