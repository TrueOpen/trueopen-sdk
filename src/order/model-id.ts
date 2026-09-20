import { TrueOpenError } from '../errors/errors';

/** node x/shared/types/model_id.go: modelIDGrammar (lowercase-only, path-safe). */
export const MODEL_ID_GRAMMAR = '^[a-z0-9][a-z0-9_-]{0,127}$';

const MODEL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** Whether this is a valid model_id (byte-for-byte aligned with node's `ValidateModelID`: first char [a-z0-9], remaining chars [a-z0-9_-], length 1..128). */
export function isValidModelId(modelId: string): boolean {
  return MODEL_ID_RE.test(modelId);
}

/**
 * Validates model_id; throws `SDK_LOCAL_MODEL_ID_INVALID` if invalid.
 * fail-fast: node's CanonicalAssignmentOrderEnvelopeV1 / ParseAssignmentOrderEnvelopeV1 reject
 * an invalid id (e.g. containing `/` or uppercase letters); the SDK catches it here first to
 * avoid producing an order that the chain would reject anyway.
 */
export function validateModelId(modelId: string): void {
  if (!isValidModelId(modelId)) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'SDK_LOCAL_MODEL_ID_INVALID',
      `model_id must match ${MODEL_ID_GRAMMAR}: ${JSON.stringify(modelId)}`,
    );
  }
}
