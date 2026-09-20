import { ProtoWriter, ProtoReader } from '../codec/protobuf';
import { toHex, fromHex } from '../util/bytes';

/**
 * Hand-written proto encoding + response decoding for the task.v1 user Msgs (no codegen
 * needed). The authoritative field numbers come from TrueOpen/wire's (third_party/wire
 * submodule) proto/task/v1/msg_session.proto: MsgCreateSession / MsgCancelOrder and their
 * responses have been checked field-by-field against v0.1.2.
 *
 * Warning: MsgUserChallenge is an exception -- wire v0.1.2's msg_challenge.proto has
 * **entirely deleted** it ("V1 has NO public challenge or proof Msg"; K-BLOCK-03/04 is
 * still open, and neither the type URL nor the field numbers are kept, not even as
 * reserved). So the encodeMsgUserChallenge below and `/task.v1.MsgUserChallenge` are
 * guaranteed to be rejected on the current chain. This code is kept only as a reference
 * for when the contract is re-frozen -- don't treat it as a usable path.
 * Note: owner_signature / challenger_signature / evidence_digest are `string` in the
 * proto; the bytes-to-string encoding (hex vs base64) is a chain-side convention and an
 * integration test concern -- this layer only handles the proto wire format.
 *
 * Hash32 representation convention: on the node side, session_id / task_id are `bytes`
 * in the proto (raw 32 bytes), while nexus's IngressAPI requires canonical lowercase
 * 64-hex (`nodecontract.Hash32Bytes`). The SDK uses **lowercase 64-hex** as its single
 * internal representation, converting hex <-> bytes only at the node proto boundary:
 * bytes -> hex on decode, hex -> bytes on encode. That way the same string can be sent
 * to nexus as-is, with no re-encoding.
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
  userChallenge: '/task.v1.MsgUserChallenge',
} as const;

// ---- MsgCreateSession (signer=1) ----
export interface MsgCreateSession {
  readonly signer: string;
}
export function encodeMsgCreateSession(m: MsgCreateSession): Uint8Array {
  return new ProtoWriter().string(1, m.signer).finish();
}
/**
 * MsgCreateSessionResponse (node msg_session.proto):
 *   bytes session_id = 1; uint64 session_nonce = 2; MutationStatusV1 status = 3;
 * node does not return owner / next_session_nonce -- the caller fills in owner from the
 * tx signer (signer_address is the session owner); this layer never fabricates it.
 */
export interface MsgCreateSessionResponse {
  /** Canonical lowercase 64-hex (32-byte bytes field on the node side). */
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
      case 1: sessionId = toHex(r.bytes()); break;
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
  /** Canonical lowercase 64-hex; decoded to 32 bytes before writing to the wire. */
  readonly sessionId: string;
  readonly orderSequence: bigint;
}
export function encodeMsgCancelOrder(m: MsgCancelOrder): Uint8Array {
  return new ProtoWriter()
    .bytes(1, fromHex(m.sessionId))
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
  /** Canonical lowercase 64-hex (32-byte bytes field on the node side). */
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
      case 1: taskId = toHex(r.bytes()); break;
      case 2: cancelledSequence = r.uint64(); break;
      case 3: nextExpectedSequence = r.uint64(); break;
      case 4: status = mutationStatus(r.uint64()); break;
      default: r.skip(wire);
    }
  }
  return { taskId, cancelledSequence, nextExpectedSequence, status };
}

// ---- MsgUserChallenge (1..9, see file header) ----
export interface MsgUserChallenge {
  readonly signer: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly settlementId: string;
  readonly challengeKind: string;
  readonly evidenceDigest: string;
  readonly bondAmount: bigint;
  readonly requestedEvidence: readonly string[];
  readonly challengerSignature: string;
}
export function encodeMsgUserChallenge(m: MsgUserChallenge): Uint8Array {
  return new ProtoWriter()
    .string(1, m.signer)
    .string(2, m.sessionId)
    .string(3, m.taskId)
    .string(4, m.settlementId)
    .string(5, m.challengeKind)
    .string(6, m.evidenceDigest)
    .uint64(7, m.bondAmount)
    .repeatedString(8, m.requestedEvidence)
    .string(9, m.challengerSignature)
    .finish();
}
export interface MsgUserChallengeResponse {
  readonly challengeId: string;
  readonly status: string;
  readonly challengeDeadlineHeight: bigint;
  readonly resolveDeadlineHeight: bigint;
  readonly bondLockedAmount: bigint;
}
export function decodeMsgUserChallengeResponse(bytes: Uint8Array): MsgUserChallengeResponse {
  const r = new ProtoReader(bytes);
  let challengeId = '';
  let status = '';
  let challengeDeadlineHeight = 0n;
  let resolveDeadlineHeight = 0n;
  let bondLockedAmount = 0n;
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: challengeId = r.string(); break;
      case 2: status = r.string(); break;
      case 3: challengeDeadlineHeight = r.uint64(); break;
      case 4: resolveDeadlineHeight = r.uint64(); break;
      case 5: bondLockedAmount = r.uint64(); break;
      default: r.skip(wire);
    }
  }
  return { challengeId, status, challengeDeadlineHeight, resolveDeadlineHeight, bondLockedAmount };
}
