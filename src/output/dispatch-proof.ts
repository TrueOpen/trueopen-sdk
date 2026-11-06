import { toBinary } from '@bufbuild/protobuf';
import { secp256k1 } from '@noble/curves/secp256k1';
import type { DispatchResultHeaderV1 } from '../gen/nexus/v1/dispatch_pb.js';
import { DispatchResultHeaderV1Schema } from '../gen/nexus/v1/dispatch_pb.js';
import type { DispatchAcceptV1, DispatchTicketV1 } from '../gen/task/v1/dispatch_pb.js';
import type { CandidateMemberRefV1 } from '../gen/task/v1/open_verify_pb.js';
import { DispatchAcceptV1Schema, DispatchRecordStatusV1, DispatchTicketV1Schema } from '../gen/task/v1/dispatch_pb.js';
import { canonicalAccountAddressBytes } from '../codec/address';
import { canonicalFrameBytes, uint32BE, uint64BE } from '../codec/domain-hash';
import { sha256 } from '../codec/hash';
import { hash32Text, strictHash32 } from '../codec/hash32';
import { TrueOpenError, dataError } from '../errors/errors';
import type { ServiceKeyBinding } from '../types/hub';
import { PARTICIPANT_TYPE } from '../types/hub';
import type { ParticipantTypeName } from '../types/hub';
import { bytesEqual } from '../util/bytes';

/**
 * Direct-dispatch signing projections and signature checks for the three messages a client sees
 * before the chain records a dispatch: the Builder's DispatchTicketV1, the Worker's
 * DispatchAcceptV1 and the Builder-signed DispatchResultHeaderV1 that carries both.
 *
 * This is a port of wire's generated-code-free canonical verifier (`dispatch.SigningPreimage`,
 * `dispatch.SigningDigest`, `dispatch.VerifyDispatchProof`), limited to these messages. The
 * projection is computed from the strictly decoded protobuf, in schema field order:
 *
 *   preimage = FRAME_V1(domain, field_1, field_2, ...)   (signature fields left out)
 *
 * where a uint64 is 8 bytes big-endian, a uint32/enum 4 bytes big-endian, a bool one byte, an
 * address its 20 account bytes, a hash its raw 32 bytes (anything else is refused), other bytes
 * and strings as is, and a nested message FRAME_V1 of its own fields (nested signatures are kept:
 * the header's projection covers the ticket's and the accept's signatures). An absent field
 * projects as its zero value. Unknown fields, duplicate fields, non-minimal varints, wrong wire
 * types, out-of-range scalars, unknown enum values and invalid UTF-8 are refused, as wire refuses
 * them. The digest is SHA-256 of the preimage and is signed directly (no further hashing) with a
 * 64-byte low-S R||S signature.
 */

/** The dispatch messages this module projects. */
export type DispatchSignedMessageName =
  | 'nexus.v1.DispatchResultHeaderV1'
  | 'task.v1.DispatchTicketV1'
  | 'task.v1.DispatchAcceptV1';

/** Signing domains from wire's domain registry (registry/v1/domains.json). */
export const DOMAIN_DISPATCH_RESULT_HEADER_V1 = 'TRUEOPEN_DISPATCH_RESULT_HEADER_V1';
export const DOMAIN_DISPATCH_TICKET_V1 = 'TRUEOPEN_DISPATCH_TICKET_V1';
export const DOMAIN_DISPATCH_ACCEPT_V1 = 'TRUEOPEN_DISPATCH_ACCEPT_V1';

const SIGNING_DOMAINS: Readonly<Record<DispatchSignedMessageName, string>> = {
  'nexus.v1.DispatchResultHeaderV1': DOMAIN_DISPATCH_RESULT_HEADER_V1,
  'task.v1.DispatchTicketV1': DOMAIN_DISPATCH_TICKET_V1,
  'task.v1.DispatchAcceptV1': DOMAIN_DISPATCH_ACCEPT_V1,
};

/** wire dispatch.MaxMessageBytes. */
const MAX_MESSAGE_BYTES = 1_048_576;
const MAX_DEPTH = 24;

interface FieldSpec {
  readonly name: string;
  readonly kind: 'varint' | 'string' | 'bytes' | 'message';
  readonly message?: string;
  readonly bits32?: true;
  readonly boolean?: true;
  readonly address?: true;
  readonly hash?: true;
  readonly enumValues?: readonly number[];
}

// Pinned field metadata, copied from wire dispatch/tables.go. None of these messages has a
// repeated, optional or oneof field.
const TABLES: Readonly<Record<string, Readonly<Record<number, FieldSpec>>>> = {
  'nexus.v1.DispatchResultHeaderV1': {
    1: { name: 'task_id', kind: 'bytes', hash: true },
    2: { name: 'winner_ticket', kind: 'message', message: 'task.v1.DispatchTicketV1' },
    3: { name: 'accept', kind: 'message', message: 'task.v1.DispatchAcceptV1' },
    4: { name: 'record_status', kind: 'varint', bits32: true, enumValues: [0, 1, 2, 3] },
    5: { name: 'builder_service_signature', kind: 'bytes' },
    6: { name: 'service_authorization_nonce', kind: 'varint' },
  },
  'task.v1.DispatchTicketV1': {
    1: { name: 'schema_version', kind: 'varint', bits32: true },
    2: { name: 'chain_id', kind: 'string' },
    3: { name: 'task_id', kind: 'bytes', hash: true },
    4: { name: 'task_hash', kind: 'bytes', hash: true },
    5: { name: 'session_id', kind: 'bytes', hash: true },
    6: { name: 'order_sequence', kind: 'varint' },
    7: { name: 'builder_address', kind: 'string', address: true },
    8: { name: 'reference_height', kind: 'varint' },
    9: { name: 'candidate_pool_snapshot_id', kind: 'bytes', hash: true },
    10: { name: 'vrf_epoch', kind: 'varint' },
    11: { name: 'vrf_output', kind: 'bytes', hash: true },
    12: { name: 'vrf_proof', kind: 'bytes' },
    13: { name: 'randomness_scheme', kind: 'varint', bits32: true, enumValues: [0, 1] },
    14: { name: 'roster_hash', kind: 'bytes', hash: true },
    15: { name: 'handraise_root_digest', kind: 'bytes', hash: true },
    16: { name: 'dispatch_round', kind: 'varint', bits32: true },
    17: { name: 'rank', kind: 'varint', bits32: true },
    18: { name: 'target', kind: 'message', message: 'task.v1.CandidateMemberRefV1' },
    19: { name: 'accept_deadline_ms', kind: 'varint' },
    20: { name: 'input_hash', kind: 'bytes', hash: true },
    21: { name: 'bound_change_height', kind: 'varint' },
    22: { name: 'sticky_anchor_sequence', kind: 'varint' },
    23: { name: 'sticky_run_count', kind: 'varint', bits32: true },
    25: { name: 'builder_service_signature', kind: 'bytes' },
    27: { name: 'service_authorization_nonce', kind: 'varint' },
  },
  'task.v1.DispatchAcceptV1': {
    1: { name: 'schema_version', kind: 'varint', bits32: true },
    2: { name: 'chain_id', kind: 'string' },
    3: { name: 'task_id', kind: 'bytes', hash: true },
    4: { name: 'task_hash', kind: 'bytes', hash: true },
    5: { name: 'dispatch_ticket_hash', kind: 'bytes', hash: true },
    6: { name: 'member', kind: 'message', message: 'task.v1.CandidateMemberRefV1' },
    7: { name: 'service_authorization_nonce', kind: 'varint' },
    8: { name: 'service_signature', kind: 'bytes' },
  },
  'task.v1.CandidateMemberRefV1': {
    1: { name: 'candidate_pool_snapshot_id', kind: 'bytes', hash: true },
    2: { name: 'slot', kind: 'varint', bits32: true },
    3: { name: 'slot_version', kind: 'varint' },
    4: { name: 'operator_address', kind: 'string', address: true },
  },
};

/** Signature fields never enter their own message's projection. */
const SIGNATURE_FIELDS: ReadonlySet<string> = new Set(['service_signature', 'builder_service_signature']);

type Decoded = Map<number, { readonly varint: bigint; readonly bytes: Uint8Array }>;

const malformed = (what: string): TrueOpenError =>
  dataError('DATA_OUTPUT_DISPATCH_PROOF_MALFORMED', `dispatch proof: ${what}`);

const utf8 = new TextDecoder('utf-8', { fatal: true });

function readVarint(raw: Uint8Array, at: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  for (let i = at; i < raw.length && i < at + 10; i++) {
    const b = raw[i]!;
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      if (value >> 64n !== 0n) throw malformed('varint overflows 64 bits');
      const next = i + 1;
      // Minimal: re-encoding the value takes exactly as many bytes.
      if (varintLength(value) !== next - at) throw malformed('nonminimal varint');
      return { value, next };
    }
    shift += 7n;
  }
  throw malformed('malformed varint');
}

function varintLength(v: bigint): number {
  let n = 1;
  while (v > 0x7fn) {
    v >>= 7n;
    n++;
  }
  return n;
}

function decode(name: string, raw: Uint8Array, depth: number): Decoded {
  if (raw.length > MAX_MESSAGE_BYTES || depth > MAX_DEPTH) throw malformed('size or nesting limit');
  const spec = TABLES[name];
  if (spec === undefined) throw malformed(`unregistered message ${name}`);
  const out: Decoded = new Map();
  let at = 0;
  while (at < raw.length) {
    const t = readVarint(raw, at);
    at = t.next;
    const number = t.value >> 3n;
    if (number === 0n || number > (1n << 29n) - 1n) throw malformed('invalid field number');
    const field = spec[Number(number)];
    if (field === undefined) throw malformed(`unknown ${name} field ${number}`);
    if (out.has(Number(number))) throw malformed(`duplicate ${name}.${field.name}`);
    const wire = Number(t.value & 7n);
    if (field.kind === 'varint') {
      if (wire !== 0) throw malformed(`wrong wire type for ${name}.${field.name}`);
      const v = readVarint(raw, at);
      at = v.next;
      if (field.bits32 === true && v.value > 0xffffffffn) throw malformed(`${name}.${field.name} out of range`);
      if (field.boolean === true && v.value > 1n) throw malformed(`${name}.${field.name} out of range`);
      if (field.enumValues !== undefined && !field.enumValues.includes(Number(v.value))) {
        throw malformed(`${name}.${field.name} has an unknown enum value`);
      }
      out.set(Number(number), { varint: v.value, bytes: new Uint8Array() });
      continue;
    }
    if (wire !== 2) throw malformed(`wrong wire type for ${name}.${field.name}`);
    const l = readVarint(raw, at);
    at = l.next;
    if (l.value > BigInt(raw.length - at) || l.value > BigInt(MAX_MESSAGE_BYTES)) throw malformed('bytes length');
    const bytes = raw.subarray(at, at + Number(l.value));
    at += Number(l.value);
    if (field.kind === 'string') {
      try {
        utf8.decode(bytes);
      } catch {
        throw malformed(`${name}.${field.name} is not valid UTF-8`);
      }
    }
    if (field.kind === 'message') decode(field.message!, bytes, depth + 1);
    out.set(Number(number), { varint: 0n, bytes });
  }
  return out;
}

function canonicalValue(field: FieldSpec, v: { readonly varint: bigint; readonly bytes: Uint8Array }, depth: number): Uint8Array {
  switch (field.kind) {
    case 'varint':
      if (field.boolean === true) return Uint8Array.of(Number(v.varint));
      return field.bits32 === true ? uint32BE(Number(v.varint)) : uint64BE(v.varint);
    case 'message':
      return canonicalFrameBytes(...canonicalFields(field.message!, v.bytes, false, depth + 1));
    default:
      if (field.address === true) {
        try {
          return canonicalAccountAddressBytes(field.name, utf8.decode(v.bytes));
        } catch {
          throw malformed(`${field.name} is not a canonical account address`);
        }
      }
      if (field.hash === true && v.bytes.length !== 32) throw malformed(`${field.name} requires raw32`);
      return v.bytes;
  }
}

function canonicalFields(name: string, raw: Uint8Array, excludeSignatures: boolean, depth: number): Uint8Array[] {
  const values = decode(name, raw, depth);
  const spec = TABLES[name]!;
  const numbers = Object.keys(spec).map(Number).sort((a, b) => a - b);
  const fields: Uint8Array[] = [];
  for (const n of numbers) {
    const field = spec[n]!;
    if (excludeSignatures && SIGNATURE_FIELDS.has(field.name)) continue;
    fields.push(canonicalValue(field, values.get(n) ?? { varint: 0n, bytes: new Uint8Array() }, depth));
  }
  return fields;
}

/**
 * The signing preimage of a dispatch message from its protobuf bytes (wire
 * `dispatch.SigningPreimage`). Throws DATA_OUTPUT_DISPATCH_PROOF_MALFORMED on material wire
 * would refuse.
 */
export function dispatchSigningPreimage(name: DispatchSignedMessageName, raw: Uint8Array): Uint8Array {
  const domain = SIGNING_DOMAINS[name];
  if (domain === undefined) throw malformed(`unregistered signing message ${String(name)}`);
  return canonicalFrameBytes(new TextEncoder().encode(domain), ...canonicalFields(name, raw, true, 0));
}

/** SHA-256 of dispatchSigningPreimage: the digest the service key signs directly (wire `dispatch.SigningDigest`). */
export function dispatchSigningDigest(name: DispatchSignedMessageName, raw: Uint8Array): Uint8Array {
  return sha256(dispatchSigningPreimage(name, raw));
}

/**
 * A DispatchTicketV1's signing digest: the dispatch_ticket_hash that names the attempt in the
 * accept, in every output frame and in the chain's dispatch record.
 */
export function dispatchTicketDigest(ticket: DispatchTicketV1): Uint8Array {
  return dispatchSigningDigest('task.v1.DispatchTicketV1', toBinary(DispatchTicketV1Schema, ticket));
}

/** A DispatchAcceptV1's signing digest (the dispatch_accept_digest). */
export function dispatchAcceptDigest(accept: DispatchAcceptV1): Uint8Array {
  return dispatchSigningDigest('task.v1.DispatchAcceptV1', toBinary(DispatchAcceptV1Schema, accept));
}

/** A DispatchResultHeaderV1's signing digest. */
export function dispatchResultHeaderDigest(header: DispatchResultHeaderV1): Uint8Array {
  return dispatchSigningDigest('nexus.v1.DispatchResultHeaderV1', toBinary(DispatchResultHeaderV1Schema, header));
}

/**
 * wire `dispatch.VerifyDigestSignature`: a 64-byte compact R||S, low-S, by a 33-byte compressed
 * secp256k1 key, made directly over a 32-byte digest.
 */
export function verifyServiceDigestSignature(pubKey: Uint8Array, digest: Uint8Array, signature: Uint8Array): boolean {
  if (digest.length !== 32 || signature.length !== 64) return false;
  if (pubKey.length !== 33 || (pubKey[0] !== 2 && pubKey[0] !== 3)) return false;
  try {
    return secp256k1.verify(signature, digest, pubKey, { lowS: true });
  } catch {
    return false;
  }
}

/**
 * Picks the key that verifies a retained dispatch proof, by the proof's own signed
 * service_authorization_nonce, from the signer's chain binding (wire `resolveProofKey` and
 * `verifySignedGeneration`):
 *
 * - the nonce must be positive;
 * - the current generation verifies while ACTIVE, and while REVOKED; an explicit emergency
 *   revoke (revoked_height) admits only proofs whose height is below it;
 * - the one previous generation verifies only proofs whose height is below its
 *   previous_retired_height;
 * - any other generation is unavailable.
 *
 * `proofHeight` is max(order earliest_submit_height, ticket bound_change_height); when it is
 * not known, a generation with a cutoff is refused. Returns the 33-byte key, or throws
 * DATA_OUTPUT_DISPATCH_KEY_UNAVAILABLE.
 */
export function selectServiceProofKey(binding: ServiceKeyBinding, signedNonce: bigint, proofHeight: bigint | undefined): Uint8Array {
  const unavailable = (why: string): TrueOpenError =>
    dataError('DATA_OUTPUT_DISPATCH_KEY_UNAVAILABLE', `service key of ${binding.operatorAddress} for nonce ${signedNonce}: ${why}`);
  if (signedNonce <= 0n) throw unavailable('signed proof nonce must be positive');
  let key: Uint8Array;
  let cutoff = 0n;
  if (binding.serviceAuthorizationNonce !== 0n && signedNonce === binding.serviceAuthorizationNonce) {
    if (binding.status === 'ACTIVE') {
      if ((binding.revokedHeight ?? 0n) !== 0n) throw unavailable('an active key has a revoke height');
    } else if (binding.status === 'REVOKED') {
      cutoff = binding.revokedHeight ?? 0n;
    } else {
      throw unavailable(`current key status ${binding.status || 'unset'} is not eligible`);
    }
    key = binding.servicePubKey;
  } else if (binding.previousServiceAuthorizationNonce !== undefined && binding.previousServiceAuthorizationNonce !== 0n &&
    signedNonce === binding.previousServiceAuthorizationNonce && binding.previousServicePubKey !== undefined) {
    cutoff = binding.previousRetiredHeight ?? 0n;
    if (cutoff === 0n) throw unavailable('previous key has no retirement height');
    key = binding.previousServicePubKey;
  } else {
    throw unavailable('unknown key generation');
  }
  if (cutoff !== 0n && (proofHeight === undefined || proofHeight >= cutoff)) {
    throw unavailable(proofHeight === undefined
      ? 'the key has a cutoff and the order earliest_submit_height is not known'
      : `proof height ${proofHeight} is not below the key cutoff ${cutoff}`);
  }
  return key;
}

/** The chain reads verifyDispatchResultHeader needs (HubReader provides it). */
export interface DispatchProofKeyReader {
  getCurrentServiceKey(participantType: ParticipantTypeName, operatorAddress: string): Promise<ServiceKeyBinding>;
}

export interface VerifyDispatchResultHeaderParams {
  readonly chainId: string;
  /** Hash32 text of the order's session_id. */
  readonly sessionId: string;
  /** Hash32 text of the task_id. */
  readonly taskId: string;
  /** Hash32 text of the task_hash the client signed into the order (OpenTaskResult.taskHash). */
  readonly taskHash: string;
  /** The Builders the order was sent to; the winner ticket's Builder must be one of them. */
  readonly builders: readonly string[];
  /**
   * The order's earliest_submit_height (OpenTaskResult.earliestSubmitHeight). Needed only to
   * accept a signature by a previous or emergency-revoked key, which verifies only proofs of
   * orders below its cutoff; without it such a signature is refused.
   */
  readonly earliestSubmitHeight?: bigint;
  /** Service key reads; resolved once per signer for this call. */
  readonly keys: DispatchProofKeyReader;
}

/** What a verified DispatchResultHeaderV1 establishes. Hashes are Hash32 text. */
export interface VerifiedDispatchResult {
  readonly taskId: string;
  readonly taskHash: string;
  /** The winner ticket's signing digest: the attempt every output frame is bound to. */
  readonly dispatchTicketHash: string;
  readonly dispatchAcceptDigest: string;
  /** The winner ticket's Builder, which signed the ticket and the header. */
  readonly builder: string;
  /** The Worker that accepted the ticket (the ticket's target). */
  readonly winnerWorker: string;
  /**
   * The Worker's current service key, which signs the live output frames. It must be ACTIVE:
   * a retained accept may verify with an older key, but live output never does.
   */
  readonly workerServicePubKey: Uint8Array;
  /** The Builder's view of the chain's dispatch record when it signed the header. */
  readonly recordStatus: 'PENDING' | 'RECORDED' | 'REJECTED';
}

function memberEqual(a: CandidateMemberRefV1 | undefined, b: CandidateMemberRefV1 | undefined): boolean {
  return a !== undefined && b !== undefined && a.operatorAddress !== '' && a.operatorAddress === b.operatorAddress &&
    a.slot === b.slot && a.slotVersion === b.slotVersion && bytesEqual(a.candidatePoolSnapshotId, b.candidatePoolSnapshotId);
}

const RECORD_STATUS: Readonly<Partial<Record<DispatchRecordStatusV1, VerifiedDispatchResult['recordStatus']>>> = {
  [DispatchRecordStatusV1.PENDING]: 'PENDING',
  [DispatchRecordStatusV1.RECORDED]: 'RECORDED',
  [DispatchRecordStatusV1.REJECTED]: 'REJECTED',
};

/**
 * Verifies a DispatchResultHeaderV1 before trusting who won the dispatch:
 *
 * 1. the winner ticket binds this order (chain_id, session_id, task_id, the client's task_hash),
 *    its Builder is one the order was sent to, the accept names the same task, task_hash and
 *    ticket digest, and the accept's member is the ticket's target;
 * 2. the header is signed by the winner ticket's Builder, with the key its own signed nonce
 *    selects; that nonce is not older than the ticket's (wire `VerifyDispatchProof`);
 * 3. the ticket is signed by its Builder, and the accept by the target Worker, each with the key
 *    its own signed nonce selects (the header's signature does not vouch for either);
 * 4. the Worker's current service key is ACTIVE; it is the key the output frames verify with.
 *
 * Each key binding read must name the signer it was read for (Builder for the header and
 * ticket, Cortex for the accept), else DATA_OUTPUT_DISPATCH_KEY_UNAVAILABLE. This does not
 * verify the VRF draw or the roster behind the ticket: it trusts the ticket's Builder about who
 * won, until the chain records the dispatch.
 *
 * Previous and revoked keys follow selectServiceProofKey, with the proof height
 * max(earliestSubmitHeight, ticket bound_change_height). Throws a DATA error on anything that
 * does not verify; a failed key read is thrown as is.
 */
export async function verifyDispatchResultHeader(header: DispatchResultHeaderV1, p: VerifyDispatchResultHeaderParams): Promise<VerifiedDispatchResult> {
  const ticket = header.winnerTicket;
  const accept = header.accept;
  const taskId = strictHash32('task_id', p.taskId);
  const taskHash = strictHash32('task_hash', p.taskHash);
  const recordStatus = RECORD_STATUS[header.recordStatus];
  if (!ticket || !accept || ticket.schemaVersion !== 1 || accept.schemaVersion !== 1 || recordStatus === undefined ||
      p.chainId === '' || ticket.chainId !== p.chainId || accept.chainId !== p.chainId ||
      !bytesEqual(header.taskId, taskId) || !bytesEqual(ticket.taskId, taskId) || !bytesEqual(accept.taskId, taskId) ||
      !bytesEqual(ticket.sessionId, strictHash32('session_id', p.sessionId)) ||
      !bytesEqual(ticket.taskHash, taskHash) || !bytesEqual(accept.taskHash, taskHash) ||
      !memberEqual(ticket.target, accept.member)) {
    throw dataError('DATA_OUTPUT_DISPATCH_HEADER_INVALID', 'DispatchResultHeaderV1 does not bind this order, or its accept is not of its ticket');
  }
  if (!p.builders.includes(ticket.builderAddress)) {
    throw dataError('DATA_OUTPUT_DISPATCH_BUILDER_UNEXPECTED', `winner ticket Builder ${ticket.builderAddress} is not one this order was sent to`);
  }
  const ticketDigest = dispatchTicketDigest(ticket);
  if (!bytesEqual(accept.dispatchTicketHash, ticketDigest)) {
    throw dataError('DATA_OUTPUT_DISPATCH_HEADER_INVALID', 'the accept names another dispatch ticket');
  }
  if (ticket.serviceAuthorizationNonce === 0n || header.serviceAuthorizationNonce < ticket.serviceAuthorizationNonce) {
    throw dataError('DATA_OUTPUT_DISPATCH_KEY_UNAVAILABLE', 'the header signed generation precedes its dispatch ticket');
  }
  const acceptDigest = dispatchAcceptDigest(accept);
  const headerDigest = dispatchResultHeaderDigest(header);
  const proofHeight = p.earliestSubmitHeight === undefined
    ? undefined
    : p.earliestSubmitHeight > ticket.boundChangeHeight ? p.earliestSubmitHeight : ticket.boundChangeHeight;

  const worker = accept.member!.operatorAddress;
  const [builderKey, workerKey] = await Promise.all([
    p.keys.getCurrentServiceKey(PARTICIPANT_TYPE.BUILDER, ticket.builderAddress),
    p.keys.getCurrentServiceKey(PARTICIPANT_TYPE.CORTEX, worker),
  ]);
  // A reader that answers for another participant must not supply the key.
  const requireSigner = (binding: ServiceKeyBinding, participantType: ParticipantTypeName, operator: string): void => {
    if (binding.participantType !== participantType || binding.operatorAddress !== operator) {
      throw dataError('DATA_OUTPUT_DISPATCH_KEY_UNAVAILABLE',
        `service key read for ${participantType} ${operator} returned the binding of ${binding.participantType || 'unset'} ${binding.operatorAddress || 'unset'}`);
    }
  };
  requireSigner(builderKey, PARTICIPANT_TYPE.BUILDER, ticket.builderAddress);
  requireSigner(workerKey, PARTICIPANT_TYPE.CORTEX, worker);
  const check = (what: string, binding: ServiceKeyBinding, nonce: bigint, digest: Uint8Array, signature: Uint8Array): void => {
    const key = selectServiceProofKey(binding, nonce, proofHeight);
    if (!verifyServiceDigestSignature(key, digest, signature)) {
      throw dataError('DATA_OUTPUT_DISPATCH_SIGNATURE_INVALID', `${what} signature does not verify`);
    }
  };
  check('DispatchResultHeaderV1 Builder', builderKey, header.serviceAuthorizationNonce, headerDigest, header.builderServiceSignature);
  check('DispatchTicketV1 Builder', builderKey, ticket.serviceAuthorizationNonce, ticketDigest, ticket.builderServiceSignature);
  check('DispatchAcceptV1 Worker', workerKey, accept.serviceAuthorizationNonce, acceptDigest, accept.serviceSignature);
  if (workerKey.status !== 'ACTIVE') {
    throw new TrueOpenError('CHAIN_REJECT', 'OUTPUT_TRUST_ANCHOR_WORKER_KEY_INACTIVE',
      `winner Worker ${worker} service key status is ${workerKey.status || 'unset'}, not ACTIVE`);
  }
  return {
    taskId: hash32Text(taskId),
    taskHash: hash32Text(taskHash),
    dispatchTicketHash: hash32Text(ticketDigest),
    dispatchAcceptDigest: hash32Text(acceptDigest),
    builder: ticket.builderAddress,
    winnerWorker: worker,
    workerServicePubKey: workerKey.servicePubKey,
    recordStatus,
  };
}
