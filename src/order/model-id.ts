import { TrueOpenError } from '../errors/errors';
import { canonicalHashBytes } from '../codec/domain-hash';
import { canonicalOperatorAddressBytes } from '../codec/address';
import { toHex } from '../util/bytes';

const enc = new TextEncoder();

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

/** H_FIELDS_V1 domain of the model identity (wire registry/v1/domains.json). */
export const DOMAIN_MODEL_ID_V1 = 'TRUEOPEN_MODEL_ID_V1';

/**
 * Repository providers wire names. The token is case-sensitive and never normalized, and
 * only HUGGINGFACE derives an identity in this version -- OCI is canonical but not yet
 * accepted, which is a separate rejection from "not a canonical token at all".
 */
export const MODEL_PROVIDER = { HUGGINGFACE: 'HUGGINGFACE', OCI: 'OCI' } as const;
const SUPPORTED_PROVIDERS: readonly string[] = [MODEL_PROVIDER.HUGGINGFACE];

/** Each Hugging Face repo_id segment; the whole id is `<namespace>/<name>`. */
const REPO_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const MAX_REPO_ID_BYTES = 255;

function reject(code: string, message: string): never {
  throw new TrueOpenError('SDK_LOCAL', code, message);
}

function validateRepoId(repoId: string): void {
  // Checked before the charset test so " Qwen/x" reports the whitespace, not the charset.
  if (repoId !== repoId.trim()) reject('SDK_LOCAL_REPO_ID_INVALID', 'repo_id has leading or trailing whitespace');
  if (repoId.normalize('NFC') !== repoId) reject('SDK_LOCAL_REPO_ID_INVALID', 'repo_id is not in Unicode NFC');
  const bytes = enc.encode(repoId).length;
  if (bytes > MAX_REPO_ID_BYTES) {
    reject('SDK_LOCAL_REPO_ID_INVALID', `repo_id is ${bytes} bytes, above the ${MAX_REPO_ID_BYTES} limit`);
  }
  const segments = repoId.split('/');
  if (segments.length !== 2 || !segments.every((s) => REPO_SEGMENT_RE.test(s))) {
    reject(
      'SDK_LOCAL_REPO_ID_INVALID',
      `repo_id must be <namespace>/<name>, each segment non-empty [A-Za-z0-9._-]: ${JSON.stringify(repoId)}`,
    );
  }
}

/** The immutable repository coordinates an identity is derived from. */
export interface ModelIdInput {
  /** Must equal the chain the registration is submitted to; identities do not cross chains. */
  readonly chainId: string;
  /** A canonical provider token; see MODEL_PROVIDER. */
  readonly provider: string;
  /** Case-preserving; "Qwen/Qwen3-8B" and "qwen/qwen3-8b" are different models. */
  readonly repoId: string;
  /** Canonical lowercase Bech32 with the trueopen HRP; enters the preimage as codec bytes. */
  readonly proposerAddress: string;
}

/**
 * model_id = H_FIELDS_V1("TRUEOPEN_MODEL_ID_V1", chain_id, provider, repo_id,
 * proposer_address codec bytes). Returns the canonical lowercase 64-hex text form.
 *
 * The identity is owner-bound and chain-bound: the same repository registered by a
 * different proposer, or on a different chain, is a different model. Nothing here is
 * normalized -- a non-canonical provider, repo_id or address is rejected rather than
 * folded, because the Hub Keeper recomputes this digest from the registration signer and
 * would derive a different identity.
 *
 * Checked against every vector in wire testdata/v1/hub/model_id_v1.json.
 */
export function deriveModelId(input: ModelIdInput): string {
  if (input.chainId === '') reject('SDK_LOCAL_CHAIN_ID_INVALID', 'chain_id is required');
  if (!SUPPORTED_PROVIDERS.includes(input.provider)) {
    const known = (Object.values(MODEL_PROVIDER) as string[]).includes(input.provider);
    reject(
      'SDK_LOCAL_MODEL_PROVIDER_INVALID',
      known
        ? `provider ${JSON.stringify(input.provider)} is canonical but not supported yet`
        : `provider must be one of ${SUPPORTED_PROVIDERS.join(', ')}: ${JSON.stringify(input.provider)}`,
    );
  }
  validateRepoId(input.repoId);
  return toHex(
    canonicalHashBytes(
      enc.encode(DOMAIN_MODEL_ID_V1),
      enc.encode(input.chainId),
      enc.encode(input.provider),
      enc.encode(input.repoId),
      canonicalOperatorAddressBytes('proposer_address', input.proposerAddress),
    ),
  );
}
