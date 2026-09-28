import { describe, it, expect } from 'vitest';
import { HubReader } from '../../src/transport/hub-reader';
import type { FetchLike, FetchResponse } from '../../src/transport/rest-chain-reader';

function readerFor(routes: Record<string, unknown>): HubReader {
  const fetch: FetchLike = async (url): Promise<FetchResponse> => {
    for (const [suffix, body] of Object.entries(routes)) {
      if (url.includes(suffix)) return { ok: true, status: 200, json: async () => body };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return new HubReader({ baseUrl: 'http://node:1317/', fetch });
}

// Real live-chain shape: uint32 is a JSON number, uint64 is a string.
const MODELS = {
  models: [
    {
      model_id: 'ad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b', proposer_address: 'trueopen1p', status: 'MODEL_PROFILE_STATUS_ACTIVE',
      active_profile_count: 1, latest_profile_version: 1, status_source: 'MODEL_STATUS_SOURCE_AUTO_PROFILE',
      registration_fee_paid: '1000000', created_height: '1', updated_height: '2',
    },
  ],
};
const PROFILES = {
  profiles: [
    {
      model_id: 'ad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b', profile_version: 1, runtime_class: 'CAUSAL_LM_PREFILL_LOGPROBS_V1',
      required_top_k: 20, task_types: ['TASK_TYPE_CHAT', 'TASK_TYPE_TEXT_GENERATION'],
      generation_type: 'GENERATION_TYPE_SAMPLED', resource_tier: 1, status: 'MODEL_PROFILE_STATUS_ACTIVE',
    },
  ],
};

describe('HubReader Models/Profiles discovery queries', () => {
  it('listModels parses ModelState (uint32=number / uint64=string)', async () => {
    const r = await readerFor({ '/hub/v1/models': MODELS }).listModels();
    expect(r).toHaveLength(1);
    expect(r[0]?.modelId).toBe('ad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b');
    expect(r[0]?.status).toBe('MODEL_PROFILE_STATUS_ACTIVE');
    expect(r[0]?.activeProfileCount).toBe(1n);
    expect(r[0]?.latestProfileVersion).toBe(1n);
    expect(r[0]?.registrationFeePaid).toBe(1000000n);
    expect(r[0]?.updatedHeight).toBe(2n);
  });

  it('listModels builds a query string with a status filter', async () => {
    let seen = '';
    const fetch: FetchLike = async (url): Promise<FetchResponse> => {
      seen = url;
      return { ok: true, status: 200, json: async () => MODELS };
    };
    await new HubReader({ baseUrl: 'http://n:1317', fetch }).listModels('ACTIVE');
    expect(seen).toContain('/hub/v1/models?status=ACTIVE');
  });

  it('getProfile parses the trimmed ProfileInfo + task_types array', async () => {
    const one = { profile: (PROFILES as { profiles: unknown[] }).profiles[0] };
    const r = [await readerFor({ '/hub/v1/profile/': one }).getProfile('ad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b', 1n)];
    expect(r[0]?.profileVersion).toBe(1n);
    expect(r[0]?.resourceTier).toBe(1n);
    expect(r[0]?.requiredTopK).toBe(20n);
    expect(r[0]?.runtimeClass).toBe('CAUSAL_LM_PREFILL_LOGPROBS_V1');
    expect(r[0]?.taskTypes).toEqual(['TASK_TYPE_CHAT', 'TASK_TYPE_TEXT_GENERATION']);
  });

  it('listModels tolerates an omitted zero-value uint64, defaulting to 0n', async () => {
    const M = { models: [{ model_id: '5555555555555555555555555555555555555555555555555555555555555555', status: 'MODEL_PROFILE_STATUS_REGISTERED', active_profile_count: 0, latest_profile_version: 0 }] };
    const r = await readerFor({ '/hub/v1/models': M }).listModels();
    expect(r[0]?.registrationFeePaid).toBe(0n);
    expect(r[0]?.activeProfileCount).toBe(0n);
  });

  it('getProfileManifestState reads manifest_hash, manifest_uri and projection fields', async () => {
    const MID = 'c65241d19b257f935ddea99ea59a19175b4b29751e259853d403fe59f04f4e4f';
    const PROFILE = {
      profile: {
        model_id: MID,
        profile_version: 1,
        manifest_hash: '6f083a958dbbc828b48b5de8c4524f591fc420e9d3fada1d953fe92336ce65dd',
        manifest_uri: 'https://models.trueopen.example/manifests/golden-model/v1.json?rev=3&sig=ab',
        previous_profile_version: 0,
        // A base64 Hash32 is accepted too (older gateways).
        tokenizer_hash: Buffer.from('44'.repeat(32), 'hex').toString('base64'),
        schema_hash: '99'.repeat(32),
        runtime_class: 'CAUSAL_LM_PREFILL_LOGPROBS_V1',
        required_top_k: 20,
        task_types: ['TASK_TYPE_TEXT_GENERATION', 'TASK_TYPE_CHAT'],
        generation_type: 'GENERATION_TYPE_SAMPLED',
        resource_tier: 2,
        min_stake: '1000000',
        challenge_open_window_blocks: '100',
        pricing_profile: { initial_output_price: '10', min_order_value: '1000', verify_ratio_bps: 1000 },
        registration_digest: '',
        proposer_address: 'trueopen1rfjz7r3u8t65teavh5utquj3kwvsj983p3jclz',
      },
    };
    let seen = '';
    const fetch: FetchLike = async (url): Promise<FetchResponse> => {
      seen = url;
      return { ok: true, status: 200, json: async () => PROFILE };
    };
    const s = await new HubReader({ baseUrl: 'http://node:1317', fetch }).getProfileManifestState(MID, 1n);
    expect(seen).toBe(`http://node:1317/TrueOpen/hub/v1/profile/${MID}/1`);
    expect(s).toMatchObject({
      modelId: MID,
      profileVersion: 1n,
      manifestUri: PROFILE.profile.manifest_uri,
      tokenizerHash: '44'.repeat(32),
      taskTypes: ['TEXT_GENERATION', 'CHAT'],
      generationType: 'SAMPLED',
      minStake: 1_000_000n,
      challengeOpenWindowBlocks: 100n,
      pricing: { initialOutputPrice: 10n, minOrderValue: 1000n, verifyRatioBps: 1000n },
      registrationDigest: '',
    });
  });
});
