export const DOMAINS = {
  session: 'TRUEOPEN_SESSION_V1',
  sdkRequest: 'TRUEOPEN_SDK_REQUEST_V1',
  sdkSubmit: 'TRUEOPEN_SDK_SUBMIT_V1',
  credential: 'TRUEOPEN_OBJECT_CREDENTIAL_V1',
  sealedKey: 'TRUEOPEN_SEALED_KEY_V1',
} as const;

/** node x/task/types signing domain separation constants (changing these breaks the protocol). */
export const SIGN_DOMAINS = {
  order: 'TRUEOPEN_ORDER_V1',
  cancelOrder: 'TRUEOPEN_CANCEL_ORDER_V1',
  userChallenge: 'TRUEOPEN_USER_CHALLENGE_V1',
  taskId: 'TRUEOPEN_TASK_ID_V1',
} as const;

export type DomainName = keyof typeof DOMAINS;

/** node x/hub builder stage selection domains (the first segment of the rendezvous seed; changing them breaks selection consistency). */
export const BUILDER_SELECTION_DOMAINS = {
  stage1Assign: 'TRUEOPEN_BUILDER_STAGE1_V1',
  stage2OpenVerify: 'TRUEOPEN_BUILDER_STAGE2_V1',
  stage3Settle: 'TRUEOPEN_BUILDER_STAGE3_V1',
} as const;
