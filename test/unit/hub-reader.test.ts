import { describe, it, expect } from 'vitest';
import { HubReader } from '../../src/transport/hub-reader';
import { nexusGrpcUri } from '../../src/types/hub';
import type { FetchLike, FetchResponse } from '../../src/transport/rest-chain-reader';

const ADDR = 'trueopen1870sqtdru7dj3xgwpzcexry0dwvyz2ku7xv9mg';

// Real live-chain response shape (snake_case + uint64 as string).
const BUILDERS = {
  builders: [
    {
      address: ADDR, status: 'ACTIVE',
      enrolled_height: '1', last_active_height: '2', capability_score: '0',
      accepted_tx_count: '0', uncleared_fault_count: '0', active_term: '1',
      jail_until_height: '0', current_service_key_version: '1', current_descriptor_version: '1',
    },
  ],
};

// #41: service_descriptor inlines endpoints[], participant_type is the enum name, descriptor_hash is base64.
const DESCRIPTOR = {
  descriptor: {
    participant_type: 'PARTICIPANT_TYPE_BUILDER', operator_address: ADDR,
    descriptor_version: '2', endpoint_count: 3,
    endpoints: [
      { endpoint_kind: 'SERVICE_ENDPOINT_KIND_NEXUS_GRPC', uri: 'https://builder.example:8080', protocol_version: 'v1' },
      { endpoint_kind: 'SERVICE_ENDPOINT_KIND_OBJECT_GATEWAY_HTTPS', uri: 'https://builder.example:8080', protocol_version: 'v1' },
      { endpoint_kind: 'SERVICE_ENDPOINT_KIND_HEALTH_HTTPS', uri: 'https://builder.example:8080/healthz', protocol_version: 'v1' },
    ],
    descriptor_hash: '/7aLj6bQOrYiP75/2or5mec12HqShxtoYbHZLfOMA9o=',
    updated_height: '2735',
  },
};

// #44: builder_set/by_term, response top-key `set`, active_builders array, builder_set_hash as base64.
// Shape verified field-for-field against devnet (trueopen-localnet-1's builder_set/by_height).
const SET = {
  set: {
    builder_set_id: 'genesis-1', builder_set_version: '1', effective_height: '1',
    builder_set_hash: 'M1MHlqXEUKLFJk7EDR7qvw5YHT+E3Am0XDWsgln0cGo=',
    body_status: 'STORED_BODY_STATUS_ACTIVE',
    active_builders: [ADDR, 'trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man'],
    active_builder_count: 2,
  },
};
// Lowercase hex after decoding the base64 builder_set_hash (nexus's selection algorithm uses the hex string).
const SET_HASH_HEX = '33530796a5c450a2c5264ec40d1eeabf0e581d3f84dc09b45c35ac8259f4706a';

function readerFor(routes: Record<string, unknown>): HubReader {
  const fetch: FetchLike = async (url): Promise<FetchResponse> => {
    for (const [suffix, body] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return { ok: true, status: 200, json: async () => body };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return new HubReader({ baseUrl: 'http://node:1317/', fetch });
}

describe('HubReader (REST field mapping)', () => {
  it('listBuilders maps BuilderState', async () => {
    const r = await readerFor({ '/hub/v1/builders': BUILDERS }).listBuilders();
    expect(r).toHaveLength(1);
    expect(r[0]?.address).toBe(ADDR);
    expect(r[0]?.status).toBe('ACTIVE');
    expect(r[0]?.currentDescriptorVersion).toBe(1n);
    expect(r[0]?.lastActiveHeight).toBe(2n);
    expect(typeof r[0]?.jailUntilHeight).toBe('bigint');
  });

  it('getServiceDescriptor maps inline endpoints + base64 hash (new route #41)', async () => {
    const ref = await readerFor({
      [`/service_descriptor/PARTICIPANT_TYPE_BUILDER/${ADDR}`]: DESCRIPTOR,
    }).getServiceDescriptor(ADDR);
    expect(ref.participantId).toBe(ADDR);
    expect(ref.descriptorVersion).toBe(2n);
    expect(ref.endpoints).toHaveLength(3);
    expect(nexusGrpcUri(ref)).toBe('https://builder.example:8080');
    expect(ref.descriptorHash).toBe('ffb68b8fa6d03ab6223fbe7fda8af999e735d87a92871b6861b1d92df38c03da');
  });

  it('a 404 throws CHAIN_QUERY_NOT_FOUND', async () => {
    await expect(readerFor({}).getBuilder('trueopen1missing')).rejects.toMatchObject({ code: 'CHAIN_QUERY_NOT_FOUND' });
  });

  it('getBuilderSetAtHeight: active_builders + builder_set_hash (base64 -> hex)', async () => {
    const snap = await readerFor({ '/hub/v1/builder_set/by_height/1': SET }).getBuilderSetAtHeight(1n);
    expect(snap.builderSetId).toBe('genesis-1');
    expect(snap.setHash).toBe(SET_HASH_HEX);
    expect(snap.builders.split(',')).toHaveLength(2);
  });

  it('getActiveBuilderSet: blocks/latest -> by_height', async () => {
    const snap = await readerFor({
      '/cosmos/base/tendermint/v1beta1/blocks/latest': { block: { header: { height: '100' } } },
      '/hub/v1/builder_set/by_height/100': SET,
    }).getActiveBuilderSet();
    expect(snap.builderSetId).toBe('genesis-1');
    expect(snap.setHash).toBe(SET_HASH_HEX);
  });

  // node has changed REST proto bytes from base64 to canonical lowercase 64-hex (verified against a live chain).
  // Base64-decoding a hex string again would produce a garbage setHash and outright break Stage-1
  // selection, so it must be passed through as-is.
  it('passes builder_set_hash through unchanged when it is already 64-hex (no longer base64-decoded)', async () => {
    const hexSet = { set: { ...SET.set, builder_set_hash: SET_HASH_HEX } };
    const snap = await readerFor({ '/hub/v1/builder_set/by_height/1': hexSet }).getBuilderSetAtHeight(1n);
    expect(snap.setHash).toBe(SET_HASH_HEX);
  });

  it('passes descriptor_hash through unchanged when it is already 64-hex (live-chain shape: grpc:// endpoint)', async () => {
    const liveHash = 'ea6e7c83f2506a8ca8db7d359cbeb0fcb2b96d0c6a630af8872281ded4c953d0';
    const live = {
      descriptor: {
        participant_type: 'PARTICIPANT_TYPE_BUILDER', operator_address: ADDR,
        descriptor_version: '1', endpoint_count: 1,
        endpoints: [{
          endpoint_kind: 'SERVICE_ENDPOINT_KIND_NEXUS_GRPC',
          uri: 'grpc://builder.example:8080', protocol_version: 'trueopen-nexus-ingress-v1',
        }],
        descriptor_hash: liveHash, updated_height: '1',
      },
    };
    const ref = await readerFor({
      [`/service_descriptor/PARTICIPANT_TYPE_BUILDER/${ADDR}`]: live,
    }).getServiceDescriptor(ADDR);
    expect(ref.descriptorHash).toBe(liveHash);
    expect(nexusGrpcUri(ref)).toBe('grpc://builder.example:8080');
  });
});
