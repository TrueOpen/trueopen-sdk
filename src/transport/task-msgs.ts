import { ProtoWriter, ProtoReader } from '../codec/protobuf';
import { hash32Text, strictHash32 } from '../codec/hash32';
import { TrueOpenError } from '../errors/errors';

/**
 * Hand-written proto encoding + response decoding for the task.v1 user Msgs (no codegen
 * needed). The authoritative field numbers come from TrueOpen/wire's (third_party/wire
 * submodule) proto/task/v1/msg_session.proto: MsgCreateSession / MsgCancelOrder and their
 * responses have been checked field-by-field against the pinned wire release.
 *
 * The challenge Msg in wire is MsgOpenChallengeRound, which the SDK does not support yet.
 *
 * Hash32 representation convention: on the node side, session_id / task_id are `bytes`
 * in the proto (raw 32 bytes), while nexus's IngressAPI requires the Hash32 text form,
 * `0x` + 64 lowercase hex (ADR-0034). The SDK uses that text form as its single
 * representation, converting text <-> bytes only at the node proto boundary:
 * bytes -> text on decode, text -> bytes (strictly) on encode. That way the same string can
 * be sent to nexus as-is, with no re-encoding.
 */

/** hub.v1.MutationStatusV1 (enum, wire=varint). */
const MUTATION_STATUS_V1 = [
  'MUTATION_STATUS_V1_UNSPECIFIED',
  'MUTATION_STATUS_V1_APPLIED',
  'MUTATION_STATUS_V1_NOOP',
] as const;

function mutationStatus(value: bigint): string {
  return MUTATION_STATUS_V1[Number(value)] ?? `MUTATION_STATUS_V1_UNKNOWN_${value.toString()}`;
}

export const TYPE_URL = {
  createSession: '/task.v1.MsgCreateSession',
  cancelOrder: '/task.v1.MsgCancelOrder',
  updateSessionKey: '/task.v1.MsgUpdateSessionKey',
} as const;

/**
 * task.v1.SessionKeyGrantV1 (msg_session.proto):
 *   bytes session_key = 1; uint64 expiry_height = 2; shared.v1.Amount spend_cap = 3;
 * (Amount { string atomic_units = 1; }). A registered session key signs delegated orders and
 * SDK requests on the owner's behalf (ADR-0037).
 */
export interface SessionKeyGrant {
  /** The key's 20-byte address (not the public key). */
  readonly sessionKey: Uint8Array;
  /** Block height after which the key is no longer valid. */
  readonly expiryHeight: bigint;
  /** Canonical decimal in atomic units; "0" means unlimited. */
  readonly spendCap: string;
}

function invalidGrant(why: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_SESSION_KEY_INVALID', `invalid session key grant: ${why}`);
}

/**
 * Checks what an encoder can know without the chain height: key length and non-zero, the cap
 * form, and a non-zero expiry. The owner-address and height-window checks belong to the client.
 */
function validateGrant(g: SessionKeyGrant): void {
  if (g.sessionKey.length !== 20) throw invalidGrant(`session_key must be 20 bytes, got ${g.sessionKey.length}`);
  if (g.sessionKey.every((b) => b === 0)) throw invalidGrant('session_key must not be all zero');
  if (!/^(0|[1-9][0-9]*)$/.test(g.spendCap)) {
    throw invalidGrant(`spend_cap must be a canonical decimal (0 or [1-9][0-9]*), got ${JSON.stringify(g.spendCap)}`);
  }
  if (g.expiryHeight <= 0n) throw invalidGrant('expiry_height must be non-zero');
}

/** Amount { atomic_units = 1 }; written even for "0" so an unlimited cap is explicit. */
function encodeAmount(atomicUnits: string): Uint8Array {
  return new ProtoWriter().string(1, atomicUnits).finish();
}

function encodeGrant(g: SessionKeyGrant): Uint8Array {
  validateGrant(g);
  return new ProtoWriter()
    .bytes(1, g.sessionKey)
    .uint64(2, g.expiryHeight)
    .message(3, encodeAmount(g.spendCap))
    .finish();
}

// ---- MsgCreateSession (signer_address=1, session_key=2) ----
export interface MsgCreateSession {
  readonly signer: string;
  /** Optional session key registered together with the session. */
  readonly sessionKey?: SessionKeyGrant;
}
export function encodeMsgCreateSession(m: MsgCreateSession): Uint8Array {
  const w = new ProtoWriter().string(1, m.signer);
  if (m.sessionKey !== undefined) w.message(2, encodeGrant(m.sessionKey));
  return w.finish();
}
/**
 * MsgCreateSessionResponse (node msg_session.proto):
 *   bytes session_id = 1; uint64 session_nonce = 2; MutationStatusV1 status = 3;
 * node does not return owner / next_session_nonce -- the caller fills in owner from the
 * tx signer (signer_address is the session owner); this layer never fabricates it.
 */
export interface MsgCreateSessionResponse {
  /** Hash32 text, `0x` + 64 lowercase hex (32-byte bytes field on the node side). */
  readonly sessionId: string;
  readonly sessionNonce: bigint;
  readonly status: string;
}
export function decodeMsgCreateSessionResponse(bytes: Uint8Array): MsgCreateSessionResponse {
  const r = new ProtoReader(bytes);
  let sessionId = '';
  let sessionNonce = 0n;
  let status = mutationStatus(0n);
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: sessionId = hash32Text(r.bytes()); break;
      case 2: sessionNonce = r.uint64(); break;
      case 3: status = mutationStatus(r.uint64()); break;
      default: r.skip(wire);
    }
  }
  return { sessionId, sessionNonce, status };
}

/**
 * MsgCancelOrder (node msg_session.proto):
 *   bytes session_id = 1; uint64 order_sequence = 2; string signer_address = 3;
 * The frozen contract has **no** owner_signature: authorization is carried entirely by
 * the Cosmos account signature (signer=owner), with no second detached signature layer.
 * So CancelOrderInput.ownerSignature is never sent (see the comment in chain-client.ts),
 * and this encoder never writes that field.
 */
export interface MsgCancelOrder {
  readonly signer: string;
  /** Hash32 text, `0x` + 64 lowercase hex; decoded to 32 bytes before writing to the wire. */
  readonly sessionId: string;
  readonly orderSequence: bigint;
}
export function encodeMsgCancelOrder(m: MsgCancelOrder): Uint8Array {
  return new ProtoWriter()
    .bytes(1, strictHash32('session_id', m.sessionId))
    .uint64(2, m.orderSequence)
    .string(3, m.signer)
    .finish();
}

/**
 * MsgCancelOrderResponse (node msg_session.proto):
 *   bytes task_id = 1; uint64 cancelled_sequence = 2;
 *   uint64 next_expected_sequence = 3; MutationStatusV1 status = 4;
 * Note that field 1 is task_id (not session_id).
 */
export interface MsgCancelOrderResponse {
  /** Hash32 text, `0x` + 64 lowercase hex (32-byte bytes field on the node side). */
  readonly taskId: string;
  readonly cancelledSequence: bigint;
  readonly nextExpectedSequence: bigint;
  readonly status: string;
}
export function decodeMsgCancelOrderResponse(bytes: Uint8Array): MsgCancelOrderResponse {
  const r = new ProtoReader(bytes);
  let taskId = '';
  let cancelledSequence = 0n;
  let nextExpectedSequence = 0n;
  let status = mutationStatus(0n);
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: taskId = hash32Text(r.bytes()); break;
      case 2: cancelledSequence = r.uint64(); break;
      case 3: nextExpectedSequence = r.uint64(); break;
      case 4: status = mutationStatus(r.uint64()); break;
      default: r.skip(wire);
    }
  }
  return { taskId, cancelledSequence, nextExpectedSequence, status };
}

/**
 * MsgUpdateSessionKey (node msg_session.proto):
 *   string signer_address = 1; bytes session_id = 2;
 *   oneof action { SessionKeyGrantV1 set = 3; ClearSessionKeyV1 clear = 4; }
 * ClearSessionKeyV1 is an empty message, so CLEAR is a length-0 field 4.
 */
export interface MsgUpdateSessionKey {
  readonly signer: string;
  /** Hash32 text, `0x` + 64 lowercase hex; decoded to 32 bytes before writing to the wire. */
  readonly sessionId: string;
  readonly action: { readonly set: SessionKeyGrant } | { readonly clear: true };
}
export function encodeMsgUpdateSessionKey(m: MsgUpdateSessionKey): Uint8Array {
  const w = new ProtoWriter().string(1, m.signer).bytes(2, strictHash32('session_id', m.sessionId));
  if ('set' in m.action) w.message(3, encodeGrant(m.action.set));
  else w.message(4, new Uint8Array(0));
  return w.finish();
}

/**
 * MsgUpdateSessionKeyResponse (node msg_session.proto):
 *   optional bytes session_key_or_empty = 1; uint64 expiry_height = 2; Amount spend_cap = 3;
 *   Amount spent = 4; uint64 set_height = 5; MutationStatusV1 status = 6;
 * The state after the update. An absent (or empty) key means the session has no key.
 */
export interface MsgUpdateSessionKeyResponse {
  readonly sessionKey?: Uint8Array;
  readonly expiryHeight: bigint;
  readonly spendCap: string;
  readonly spent: string;
  readonly setHeight: bigint;
  readonly status: string;
}

function decodeAmount(bytes: Uint8Array): string {
  const r = new ProtoReader(bytes);
  let atomicUnits = '';
  while (!r.eof) {
    const { field, wire } = r.tag();
    if (field === 1) atomicUnits = r.string();
    else r.skip(wire);
  }
  // An unset atomic_units is the proto3 default, i.e. zero.
  return atomicUnits === '' ? '0' : atomicUnits;
}

export function decodeMsgUpdateSessionKeyResponse(bytes: Uint8Array): MsgUpdateSessionKeyResponse {
  const r = new ProtoReader(bytes);
  let sessionKey: Uint8Array | undefined;
  let expiryHeight = 0n;
  let spendCap = '0';
  let spent = '0';
  let setHeight = 0n;
  let status = mutationStatus(0n);
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: {
        const k = r.bytes();
        sessionKey = k.length > 0 ? k : undefined;
        break;
      }
      case 2: expiryHeight = r.uint64(); break;
      case 3: spendCap = decodeAmount(r.bytes()); break;
      case 4: spent = decodeAmount(r.bytes()); break;
      case 5: setHeight = r.uint64(); break;
      case 6: status = mutationStatus(r.uint64()); break;
      default: r.skip(wire);
    }
  }
  return { ...(sessionKey !== undefined ? { sessionKey } : {}), expiryHeight, spendCap, spent, setHeight, status };
}
