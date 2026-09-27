import { TrueOpenError } from '../errors/errors';

/**
 * A model ID is a raw 32-byte Hash32. The SDK's text form is canonical lowercase 64-hex,
 * which is also how chain REST encodes it (REST_BYTES_ENCODING_HASH32_LOWER_HEX).
 */
export const MODEL_ID_GRAMMAR = '^[0-9a-f]{64}$';

const MODEL_ID_RE = /^[0-9a-f]{64}$/;
const ZERO_MODEL_ID = '0'.repeat(64);

/** Whether this is a canonical model ID: lowercase 64-hex and not all zero. */
export function isValidModelId(modelId: string): boolean {
  return MODEL_ID_RE.test(modelId) && modelId !== ZERO_MODEL_ID;
}

/**
 * Validates a model ID; throws `SDK_LOCAL_MODEL_ID_INVALID` if invalid.
 * Uppercase hex, a 0x prefix, a legacy text slug or the zero hash never name a
 * registered model, so the SDK fails before producing an order the chain would reject.
 */
export function validateModelId(modelId: string): void {
  if (!isValidModelId(modelId)) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'SDK_LOCAL_MODEL_ID_INVALID',
      `model_id must be a non-zero canonical lowercase 64-hex Hash32: ${JSON.stringify(modelId)}`,
    );
  }
}
