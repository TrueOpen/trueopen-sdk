import { domainHash, canonicalHashBytes, uint64BE } from '../codec/domain-hash';
import { SIGN_DOMAINS } from '../codec/domains';
import { TrueOpenError } from '../errors/errors';
import { toHex, fromHex } from '../util/bytes';

const enc = new TextEncoder();

/**
 * The bytes covered by the user's signature (matches nexus's nodecontract.OrderSigningBytes /
 * CurrentOrderSigningBytes; validated byte-for-byte by the SubmitOrder handler in service.go):
 *   domainHash("TRUEOPEN_ORDER_V1", chain_id, owner_address, session_id,
 *              dec(order_sequence), canonical_order_envelope_json)
 * Returns 32 bytes; the user signs it with secp256k1 (see order-signer).
 * Note: owner_address / session_id / order_sequence must be part of what's signed, otherwise
 * nexus signature verification fails (types.ErrInvalidSignature="invalid signature"). See the
 * "order" vector in node's cross-language golden file
 * x/task/types/testdata/task_data_plane_v1_golden.json.
 */
export function orderEnvelopeSigningBytes(
  chainId: string,
  ownerAddress: string,
  sessionId: string,
  orderSequence: bigint,
  canonicalOrderEnvelopeJson: string,
): Uint8Array {
  return domainHash(
    SIGN_DOMAINS.order,
    chainId,
    ownerAddress,
    sessionId,
    orderSequence.toString(),
    canonicalOrderEnvelopeJson,
  );
}

/**
 * DeriveTaskID(session_id, order_sequence): matches node's
 * x/task/types.DeriveTaskIDFromRawSession and nexus's
 * nodecontract.DeriveTaskIDFromRawSession (nexus PR #46):
 *   hex( CanonicalHash( "TRUEOPEN_TASK_ID_V1", raw32(session_id), u64be(order_sequence) ) )
 * i.e. length-prefixed framing + **session_id's raw 32 bytes** (not hex text, not
 * pipe-delimited). session_id is passed in as canonical lowercase 64-hex and decoded to
 * 32 bytes here before framing.
 * Cross-language golden: node x/task/types/testdata/task_data_plane_v1_golden.json
 * (session=ab*32, seq=42 -> 0891a5c5704d4dff5671daab9b353f31c86f81ac53cf1b3c4ef5171322c19f50).
 */
export function deriveTaskId(sessionId: string, orderSequence: bigint): string {
  const hex = sessionId.trim();
  // Same format as nexus's nodecontract.Hash32Bytes: exactly 32 bytes, lowercase, no 0x prefix.
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'SDK_LOCAL_SESSION_ID_NOT_HASH32',
      `session_id must be canonical lowercase 64-hex Hash32, got ${JSON.stringify(sessionId)}`,
    );
  }
  return toHex(canonicalHashBytes(enc.encode(SIGN_DOMAINS.taskId), fromHex(hex), uint64BE(orderSequence)));
}

/** CanonicalCancelOrderSigningBytes(chain_id, owner_address, session_id, order_sequence). */
export function cancelOrderSigningBytes(
  chainId: string,
  ownerAddress: string,
  sessionId: string,
  orderSequence: bigint,
): Uint8Array {
  return domainHash(SIGN_DOMAINS.cancelOrder, chainId, ownerAddress, sessionId, orderSequence.toString());
}

/**
 * CanonicalUserChallengeSigningBytes: requested_evidence is joined with ";"
 * (currently the chain requires an empty list -> empty string).
 */
export function userChallengeSigningBytes(
  chainId: string,
  sessionId: string,
  taskId: string,
  settlementId: string,
  challengeKind: string,
  evidenceDigest: string,
  bondAmount: bigint,
  requestedEvidence: readonly string[],
): Uint8Array {
  return domainHash(
    SIGN_DOMAINS.userChallenge,
    chainId,
    sessionId,
    taskId,
    settlementId,
    challengeKind,
    evidenceDigest,
    bondAmount.toString(),
    requestedEvidence.join(';'),
  );
}
