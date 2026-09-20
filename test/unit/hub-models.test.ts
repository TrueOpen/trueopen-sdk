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
      model_id: 'hf-ad410', proposer_address: 'trueopen1p', status: 'MODEL_PROFILE_STATUS_ACTIVE',
      active_profile_count: 1, latest_profile_version: 1, status_source: 'MODEL_STATUS_SOURCE_AUTO_PROFILE',
      registration_fee_paid: '1000000', created_height: '1', updated_height: '2',
    },
  ],
};
const PROFILES = {
  profiles: [
    {
      model_id: 'hf-ad410', profile_version: 1, runtime_class: 'CAUSAL_LM_PREFILL_LOGPROBS_V1',
      required_top_k: 20, task_types: ['TASK_TYPE_CHAT', 'TASK_TYPE_TEXT_GENERATION'],
      generation_type: 'GENERATION_TYPE_SAMPLED', resource_tier: 1, status: 'MODEL_PROFILE_STATUS_ACTIVE',
    },
  ],
};

describe('HubReader Models/Profiles discovery queries', () => {
  it('listModels parses ModelState (uint32=number / uint64=string)', async () => {
    const r = await readerFor({ '/hub/v1/models': MODELS }).listModels();
    expect(r).toHaveLength(1);
    expect(r[0]?.modelId).toBe('hf-ad410');
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

  it('listProfiles parses the trimmed ProfileInfo + task_types array', async () => {
    const r = await readerFor({ '/hub/v1/profiles': PROFILES }).listProfiles({ modelId: 'hf-ad410' });
    expect(r[0]?.profileVersion).toBe(1n);
    expect(r[0]?.resourceTier).toBe(1n);
    expect(r[0]?.requiredTopK).toBe(20n);
    expect(r[0]?.runtimeClass).toBe('CAUSAL_LM_PREFILL_LOGPROBS_V1');
    expect(r[0]?.taskTypes).toEqual(['TASK_TYPE_CHAT', 'TASK_TYPE_TEXT_GENERATION']);
  });

  it('listModels tolerates an omitted zero-value uint64, defaulting to 0n', async () => {
    const M = { models: [{ model_id: 'm', status: 'MODEL_PROFILE_STATUS_REGISTERED', active_profile_count: 0, latest_profile_version: 0 }] };
    const r = await readerFor({ '/hub/v1/models': M }).listModels();
    expect(r[0]?.registrationFeePaid).toBe(0n);
    expect(r[0]?.activeProfileCount).toBe(0n);
  });
});
