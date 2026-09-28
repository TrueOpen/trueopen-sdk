import { canonicalHashBytes, uint64BE } from '../codec/domain-hash';
import { SIGN_DOMAINS } from '../codec/domains';
import { TrueOpenError } from '../errors/errors';
import { toHex, fromHex } from '../util/bytes';

const enc = new TextEncoder();

/**
 * task_id = hex(H_FIELDS_V1("TRUEOPEN_TASK_ID_V1", raw32(session_id), u64be(order_sequence))).
 * session_id is passed in as canonical lowercase 64-hex and decoded to its raw 32 bytes
 * before framing (not hex text). Checked against wire
 * testdata/v1/task/task_data_plane_v1_golden.json.
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
