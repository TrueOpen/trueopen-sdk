import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { manifestHash, assertManifestMatchesChain } from '../../src/manifest/hash';
import { validateManifestV4 } from '../../src/manifest/validate';
import { toHex } from '../../src/util/bytes';
import { TrueOpenError } from '../../src/errors/errors';

const VECTOR = JSON.parse(readFileSync('test/fixtures/wire/model_manifest_v4.json', 'utf8')) as {
  manifest: Record<string, unknown>;
  vectors: { digest_hex: string }[];
};

describe('manifestHash', () => {
  it('reproduces wire\'s digest for the published manifest', () => {
    const m = validateManifestV4(VECTOR.manifest);
    expect(toHex(manifestHash(m))).toBe(VECTOR.vectors[0]!.digest_hex);
  });

  it('accepts a chain hash that matches and rejects one that does not', () => {
    const m = validateManifestV4(VECTOR.manifest);
    expect(() => assertManifestMatchesChain(m, VECTOR.vectors[0]!.digest_hex)).not.toThrow();
    expect(() => assertManifestMatchesChain(m, 'dd'.repeat(32))).toThrow(TrueOpenError);
  });

  it('changes the digest when any field changes', () => {
    // Cheap, but it is the property the whole layer exists for: if an altered manifest
    // hashed the same, comparing against the chain would prove nothing.
    const m = validateManifestV4(VECTOR.manifest);
    const altered = validateManifestV4({
      ...VECTOR.manifest,
      identity: { ...(VECTOR.manifest['identity'] as object), display_name: 'Different' },
    });
    expect(toHex(manifestHash(altered))).not.toBe(toHex(manifestHash(m)));
  });
});
