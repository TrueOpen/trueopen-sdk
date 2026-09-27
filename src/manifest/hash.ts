import { hV1 } from '../codec/h-v1';
import { canonicalJsonV1Bytes } from './canonical';
import { TrueOpenError } from '../errors/errors';
import { toHex } from '../util/bytes';
import type { ModelProfileManifestV4 } from './types';

/** wire registry: domain `TRUEOPEN_MODEL_MANIFEST_V4`, framing `H_V1`, field
 *  `canonical_json_v1(ModelProfileManifestV4)`. */
export const MODEL_MANIFEST_V4_DOMAIN = 'TRUEOPEN_MODEL_MANIFEST_V4';

export function manifestHash(manifest: ModelProfileManifestV4): Uint8Array {
  return hV1(MODEL_MANIFEST_V4_DOMAIN, canonicalJsonV1Bytes(manifest));
}

/**
 * The whole point of this layer: the chain stores only `manifest_hash`, so a manifest
 * fetched from anywhere is worth nothing until it re-derives to that value.
 *
 * A mismatch is a DATA error, not an SDK_LOCAL one -- the document is well-formed, it simply
 * is not the document the chain committed to.
 */
export function assertManifestMatchesChain(
  manifest: ModelProfileManifestV4,
  chainManifestHashHex: string,
): void {
  const want = chainManifestHashHex.startsWith('0x') ? chainManifestHashHex.slice(2) : chainManifestHashHex;
  const got = toHex(manifestHash(manifest));
  if (got !== want.toLowerCase()) {
    throw new TrueOpenError(
      'DATA',
      'MANIFEST_HASH_MISMATCH',
      `recomputed manifest_hash ${got} does not match the chain's ${want}`,
    );
  }
}
