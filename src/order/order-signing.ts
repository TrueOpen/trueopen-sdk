import { canonicalHashBytes, uint64BE } from '../codec/domain-hash';
import { SIGN_DOMAINS } from '../codec/domains';
import { TrueOpenError } from '../errors/errors';
import { hash32Text, isHash32Text } from '../codec/hash32';
import { fromHex } from '../util/bytes';

const enc = new TextEncoder();

/**
 * task_id = H_FIELDS_V1("TRUEOPEN_TASK_ID_V1", raw32(session_id), u64be(order_sequence)), returned
 * as `0x` + 64 lowercase hex. session_id is passed in the same text form and decoded to its raw 32 bytes
 * before framing (not hex text). Checked against wire
 * testdata/v1/task/task_data_plane_v1_golden.json.
 */
export function deriveTaskId(sessionId: string, orderSequence: bigint): string {
  // The ingress Hash32 spelling (ADR-0034): 0x followed by exactly 64 lowercase hex characters.
  if (!isHash32Text(sessionId)) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'SDK_LOCAL_SESSION_ID_NOT_HASH32',
      `session_id must be 0x followed by 64 lowercase hex characters, got ${JSON.stringify(sessionId)}`,
    );
  }
  return hash32Text(canonicalHashBytes(enc.encode(SIGN_DOMAINS.taskId), fromHex(sessionId.slice(2)), uint64BE(orderSequence)));
}
