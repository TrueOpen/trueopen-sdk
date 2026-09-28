import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  modelManifestHash,
  parseModelManifestV4,
  projectionFromManifest,
  chainProjectionHash,
  registrationDigest,
  verifyManifestBytes,
  MAX_MANIFEST_BYTES,
} from '../../src/manifest/model-manifest';
import type { ProfileManifestState } from '../../src/manifest/model-manifest';
import { canonicalJsonBytes } from '../../src/codec/canonical-json';
import { framedV1Preimage } from '../../src/codec/domain-hash';
import { toHex } from '../../src/util/bytes';
import { goldenState } from '../helpers/manifest-fixture';

/**
 * Anchored to wire testdata/v1/hub/model_manifest_v4.json (manifest bytes and
 * manifest_hash) and model_profile_canonical_v3.json (projection bytes,
 * chain_projection_hash and registration digest).
 */
const MANIFEST = JSON.parse(readFileSync('third_party/wire/testdata/v1/hub/model_manifest_v4.json', 'utf8'));
const PROJECTION = JSON.parse(readFileSync('third_party/wire/testdata/v1/hub/model_profile_canonical_v3.json', 'utf8'));
const VECTOR = MANIFEST.vectors[0];
const enc = new TextEncoder();
const BYTES = enc.encode(VECTOR.payload_utf8 as string);
const HASH = VECTOR.digest_hex as string;

describe('manifest_hash (H_V1 TRUEOPEN_MODEL_MANIFEST_V4)', () => {
  it('reproduces the published preimage and digest', () => {
    expect(BYTES.length).toBe(MANIFEST.canonical_manifest_bytes);
    expect(toHex(framedV1Preimage(VECTOR.domain, BYTES))).toBe(VECTOR.preimage_hex);
    expect(toHex(modelManifestHash(BYTES))).toBe(HASH);
  });

  it('the fixture manifest object re-encodes to exactly the payload bytes', () => {
    const parsed = parseModelManifestV4(BYTES);
    expect(toHex(canonicalJsonBytes(parsed.raw))).toBe(toHex(BYTES));
    expect(parsed.modelId).toBe(goldenState().modelId);
  });
});

describe('projection rebuilt from the manifest (model_profile_canonical_v3.json)', () => {
  const manifest = parseModelManifestV4(BYTES);
  const want = PROJECTION.canonical_projection;
  const projection = projectionFromManifest(manifest, {
    // The projection vector takes manifest_hash as an opaque input.
    manifestHash: (want.manifest_hash as string).slice(2),
    manifestUri: want.manifest_uri,
    registrationFee: { amount: BigInt(want.registration_fee.amount), denom: want.registration_fee.denom },
  });

  it('manifest_uri comes from the chain input and contains a literal &', () => {
    expect(projection['manifest_uri']).toBe(want.manifest_uri);
    expect(new TextDecoder().decode(canonicalJsonBytes(projection))).toContain('?rev=3&sig=ab');
  });

  it('canonical projection bytes and chain_projection_hash match', () => {
    expect(canonicalJsonBytes(projection).length).toBe(PROJECTION.canonical_projection_bytes);
    expect(toHex(chainProjectionHash(projection))).toBe(PROJECTION.chain_projection_hash);
  });

  it('registration digest matches, including its published payload bytes', () => {
    const digest = registrationDigest({
      chainId: PROJECTION.chain_id,
      chainProjectionHash: chainProjectionHash(projection),
      manifestHash: (want.manifest_hash as string).slice(2),
      profileVersion: 1n,
      proposerAddress: PROJECTION.proposer_address,
    });
    expect(toHex(digest)).toBe(PROJECTION.registration_digest);
  });

  it('a different manifest_uri changes chain_projection_hash', () => {
    const other = { ...projection, manifest_uri: `${want.manifest_uri as string}x` };
    expect(toHex(chainProjectionHash(other))).not.toBe(PROJECTION.chain_projection_hash);
  });
});

describe('verifyManifestBytes: processing order', () => {
  it('accepts the golden body', () => {
    const v = verifyManifestBytes(BYTES, goldenState());
    expect(v.manifest.profileVersion).toBe(1n);
  });

  it('rejects a wrong hash before parsing (even a non-JSON body reports the hash)', () => {
    expect(() => verifyManifestBytes(enc.encode('not json'), goldenState())).toThrow(/does not match on-chain manifest_hash/);
  });

  it('rejects a body that hashes correctly but is not canonical JSON', () => {
    // Pretty-printed: parses fine, re-encodes differently.
    const pretty = enc.encode(JSON.stringify(JSON.parse(VECTOR.payload_utf8), null, 1));
    const state = goldenState({ manifestHash: toHex(modelManifestHash(pretty)) });
    expect(() => verifyManifestBytes(pretty, state)).toThrow(expect.objectContaining({ code: 'MANIFEST_NOT_CANONICAL' }));
  });

  it('rejects a body that hashes correctly but fails the schema', () => {
    const doc = JSON.parse(VECTOR.payload_utf8);
    doc.manifest_version = 3;
    const bytes = canonicalJsonBytes(doc);
    const state = goldenState({ manifestHash: toHex(modelManifestHash(bytes)) });
    expect(() => verifyManifestBytes(bytes, state)).toThrow(expect.objectContaining({ code: 'MANIFEST_SCHEMA_INVALID' }));
  });

  it('rejects an unknown top-level section and a missing one', () => {
    const doc = JSON.parse(VECTOR.payload_utf8);
    doc.extra = {};
    expect(() => parseModelManifestV4(canonicalJsonBytes(doc))).toThrow(/unknown: \[extra\]/);
    const doc2 = JSON.parse(VECTOR.payload_utf8);
    delete doc2.tool_calling;
    expect(() => parseModelManifestV4(canonicalJsonBytes(doc2))).toThrow(/missing: \[tool_calling\]/);
  });

  it('rejects duplicate keys and floats even when the hash would match', () => {
    const dup = enc.encode(VECTOR.payload_utf8.replace('{"artifacts"', '{"manifest_version":4,"artifacts"'));
    expect(() => verifyManifestBytes(dup, goldenState({ manifestHash: toHex(modelManifestHash(dup)) }))).toThrow(/duplicate key/);
    const flt = enc.encode(VECTOR.payload_utf8.replace('"manifest_version":4', '"manifest_version":4.0'));
    expect(() => verifyManifestBytes(flt, goldenState({ manifestHash: toHex(modelManifestHash(flt)) }))).toThrow(/only integers/);
  });

  it.each([
    ['model_id', { modelId: '11'.repeat(32) }],
    ['profile_version', { profileVersion: 2n }],
    ['tokenizer_hash', { tokenizerHash: '45'.repeat(32) }],
    ['runtime_class', { runtimeClass: 'OTHER' }],
    ['task_types\\[0\\]', { taskTypes: ['CHAT', 'TEXT_GENERATION'] }],
    ['min_stake', { minStake: 1n }],
    ['pricing_profile.min_order_value', { pricing: { initialOutputPrice: 10n, minOrderValue: 1n, verifyRatioBps: 1000n } }],
  ] as const)('rejects a projection mismatch on %s', (name, override) => {
    expect(() => verifyManifestBytes(BYTES, goldenState(override as Partial<ProfileManifestState>))).toThrow(
      new RegExp(`${name.replace('.', '\\.')} differs`),
    );
  });

  /**
   * Comparing task_types as a joined string makes ["A,B"] and ["A","B"] equal, and hides
   * a length difference. Both must be caught element by element.
   */
  it('compares task_types element by element, not as a joined string', () => {
    const onChain = goldenState().taskTypes;
    expect(onChain.length).toBeGreaterThan(0);
    expect(() => verifyManifestBytes(BYTES, goldenState({ taskTypes: [onChain.join(',')] }))).toThrow(
      /task_types length differs/,
    );
    expect(() => verifyManifestBytes(BYTES, goldenState({ taskTypes: [...onChain, 'CHAT'] }))).toThrow(
      /task_types length differs/,
    );
  });

  it('reports whether the whole projection was bound, so a partial check cannot read as a full one', () => {
    // Without RegistrationCheck only the scalars ProfileState exposes are compared;
    // min_stake.denom has nothing on chain to compare against.
    expect(verifyManifestBytes(BYTES, goldenState()).projectionFullyBound).toBe(false);
  });

  it('optional registration check binds the whole projection with the chain manifest_uri', () => {
    const manifest = parseModelManifestV4(BYTES);
    const fee = { amount: 1_000_000n, denom: 'uusdc' };
    const state0 = goldenState();
    const projection = projectionFromManifest(manifest, { manifestHash: HASH, manifestUri: state0.manifestUri, registrationFee: fee });
    const digest = toHex(
      registrationDigest({
        chainId: 'trueopen-golden-1',
        chainProjectionHash: chainProjectionHash(projection),
        manifestHash: HASH,
        profileVersion: 1n,
        proposerAddress: state0.proposerAddress,
      }),
    );
    const state = goldenState({ registrationDigest: digest });
    const check = { chainId: 'trueopen-golden-1', registrationFee: fee };
    expect(() => verifyManifestBytes(BYTES, state, check)).not.toThrow();
    expect(verifyManifestBytes(BYTES, state, check).projectionFullyBound).toBe(true);
    // Same manifest, different chain manifest_uri: the rebuilt digest no longer matches.
    expect(() => verifyManifestBytes(BYTES, { ...state, manifestUri: 'https://other.example/m.json' }, check)).toThrow(
      /registration digest/,
    );
  });

  it('rejects a body above max_manifest_bytes without hashing it', () => {
    const big = new Uint8Array(MAX_MANIFEST_BYTES + 1);
    expect(() => verifyManifestBytes(big, goldenState())).toThrow(expect.objectContaining({ code: 'MANIFEST_TOO_LARGE' }));
  });
});
