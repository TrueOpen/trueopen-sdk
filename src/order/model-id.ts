import { canonicalHashBytes } from '../codec/domain-hash';
import { TrueOpenError } from '../errors/errors';

const enc = new TextEncoder();

/** node x/shared/types/domain_registry.go: DomainModelIDV1. */
export const MODEL_ID_DOMAIN = 'TRUEOPEN_MODEL_ID_V1';

/**
 * Derive a model's on-chain Hash32 id from its registration inputs, byte-for-byte the
 * same algorithm as node's `DeriveModelIDV1` (x/hub/types/model_id.go):
 *
 *   H_FIELDS_V1("TRUEOPEN_MODEL_ID_V1", chain_id, provider, repo_id, proposer_address)
 *
 * `proposer_address` is the raw 20-byte address codec bytes (the EVM-style proposer
 * address), not its bech32 text. The vector is `testdata/v1/hub/model_id_v1.json`.
 */
export function deriveModelId(
  chainId: string,
  provider: string,
  repoId: string,
  proposerAddress: Uint8Array,
): Uint8Array {
  if (chainId === '') throw invalid('chain_id is required');
  if (provider !== 'HUGGINGFACE') throw invalid(`provider ${JSON.stringify(provider)} is not supported`);
  validateHuggingFaceRepoId(repoId);
  if (proposerAddress.length !== 20) throw invalid('proposer_address must be 20 bytes');
  return canonicalHashBytes(
    enc.encode(MODEL_ID_DOMAIN),
    enc.encode(chainId),
    enc.encode(provider),
    enc.encode(repoId),
    proposerAddress,
  );
}

/** node validateHuggingFaceRepoID: exactly one slash, both segments non-empty, canonical chars, at most 255 bytes. */
function validateHuggingFaceRepoId(repoId: string): void {
  if (repoId.length === 0 || repoId.length > 255) {
    throw invalid('repo_id must be a namespace/name of at most 255 bytes');
  }
  const segments = repoId.split('/');
  if (segments.length !== 2) throw invalid('repo_id must have exactly one slash (namespace/name)');
  if (segments[0] === '' || segments[1] === '') throw invalid('repo_id namespace and name must be non-empty');
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) throw invalid('repo_id contains a non-canonical character');
  }
}

function invalid(message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_MODEL_ID_INVALID', `model_id: ${message}`);
}
