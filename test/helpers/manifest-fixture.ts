import { readFileSync } from 'node:fs';
import type { ProfileManifestState } from '../../src/manifest/model-manifest';

/** wire testdata/v1/hub/model_manifest_v4.json: the golden manifest bytes and manifest_hash. */
const MANIFEST = JSON.parse(readFileSync('third_party/wire/testdata/v1/hub/model_manifest_v4.json', 'utf8'));
export const GOLDEN_MANIFEST_BYTES = new TextEncoder().encode(MANIFEST.vectors[0].payload_utf8 as string);
export const GOLDEN_MANIFEST_HASH = MANIFEST.vectors[0].digest_hex as string;

/** The ProfileState a node would return for the golden manifest. */
export function goldenState(overrides: Partial<ProfileManifestState> = {}): ProfileManifestState {
  return {
    modelId: 'c65241d19b257f935ddea99ea59a19175b4b29751e259853d403fe59f04f4e4f',
    profileVersion: 1n,
    manifestHash: GOLDEN_MANIFEST_HASH,
    manifestUri: 'https://models.trueopen.example/manifests/golden-model/v1.json?rev=3&sig=ab',
    previousProfileVersion: 0n,
    tokenizerHash: '44'.repeat(32),
    schemaHash: '99'.repeat(32),
    runtimeClass: 'CAUSAL_LM_PREFILL_LOGPROBS_V1',
    requiredTopK: 20n,
    taskTypes: ['TEXT_GENERATION', 'CHAT'],
    generationType: 'SAMPLED',
    resourceTier: 2n,
    minStake: 1_000_000n,
    challengeOpenWindowBlocks: 100n,
    pricing: { initialOutputPrice: 10n, minOrderValue: 1000n, verifyRatioBps: 1000n },
    registrationDigest: '',
    proposerAddress: 'trueopen1rfjz7r3u8t65teavh5utquj3kwvsj983p3jclz',
    ...overrides,
  };
}

