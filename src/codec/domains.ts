/**
 * Signing domains the SDK itself produces digests for (changing these breaks the protocol).
 *  - order: the outer OpenTask header signature over the order envelope (nexus-side).
 *  - taskId: task_id = H_FIELDS_V1("TRUEOPEN_TASK_ID_V1", raw32(session_id), u64be(order_sequence)).
 */
export const SIGN_DOMAINS = {
  order: 'TRUEOPEN_ORDER_V1',
  taskId: 'TRUEOPEN_TASK_ID_V1',
} as const;
