/**
 * Signing domains the SDK itself produces digests for (changing these breaks the protocol).
 *  - taskId: task_id = H_FIELDS_V1("TRUEOPEN_TASK_ID_V1", raw32(session_id), u64be(order_sequence)).
 */
export const SIGN_DOMAINS = {
  taskId: 'TRUEOPEN_TASK_ID_V1',
} as const;
