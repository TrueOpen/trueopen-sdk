import { describe, it, expect } from 'vitest';
import { HubReader } from '../../src/transport/hub-reader';
import type { FetchLike, FetchResponse } from '../../src/transport/rest-chain-reader';
import { resolveBuilderEndpoints } from '../../src/hub/builder-discovery';
import { resolveTaskBuilderEndpoints } from '../../src/hub/stage1-routing';
import { fanOutToEndpoints } from '../../src/transport/fan-out-submit';
import { nexusGrpcEndpoint } from '../../src/types/hub';
import type { ServiceDescriptorRef } from '../../src/types/hub';

// On-chain tls_pubkey_hash is 32 raw bytes; REST returns it as base64; the SDK normalizes it to lowercase hex.
const HASH_HEX = '4b739f53e8a5a7c2ffd023301add8c2fa7b3d6070f16477979705ac193790900';
const HASH_B64 = Buffer.from(HASH_HEX, 'hex').toString('base64');
const ADDR = 'trueopen1870sqtdru7dj3xgwpzcexry0dwvyz2ku7xv9mg';

function readerFor(routes: Record<string, unknown>): HubReader {
  const fetch: FetchLike = async (url): Promise<FetchResponse> => {
    const path = url.replace('http://node:1317', '');
    const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit[1] };
  };
  return new HubReader({ baseUrl: 'http://node:1317/', fetch });
}

const descriptorBody = (tlsPubkeyHash?: string) => ({
  descriptor: {
    participant_type: 'PARTICIPANT_TYPE_BUILDER',
    operator_address: ADDR,
    descriptor_version: '3',
    endpoints: [
      { endpoint_kind: 'SERVICE_ENDPOINT_KIND_NEXUS_GRPC', uri: 'https://b.example:8443', protocol_version: 'v1', ...(tlsPubkeyHash ? { tls_pubkey_hash: tlsPubkeyHash } : {}) },
      { endpoint_kind: 'SERVICE_ENDPOINT_KIND_HEALTH_HTTPS', uri: 'https://b.example:8443/healthz', protocol_version: 'v1' },
    ],
    descriptor_hash: Buffer.alloc(32, 7).toString('base64'),
    updated_height: '10',
  },
});

describe('tls_pubkey_hash from the descriptor is plumbed all the way to the connection point', () => {
  it('HubReader decodes base64 tls_pubkey_hash into lowercase hex; defaults to an empty string', async () => {
    const ref = await readerFor({ '/TrueOpen/hub/v1/service_descriptor/': descriptorBody(HASH_B64) }).getServiceDescriptor(ADDR);
    expect(nexusGrpcEndpoint(ref)?.tlsPubkeyHash).toBe(HASH_HEX);
    expect(ref.endpoints[1]?.tlsPubkeyHash).toBe('');

    const plain = await readerFor({ '/TrueOpen/hub/v1/service_descriptor/': descriptorBody() }).getServiceDescriptor(ADDR);
    expect(nexusGrpcEndpoint(plain)?.tlsPubkeyHash).toBe('');
  });

  it('resolveBuilderEndpoints returns endpoints carrying tlsPubkeyHash', async () => {
    const descriptorReader = readerFor({ '/TrueOpen/hub/v1/service_descriptor/': descriptorBody(HASH_B64) });
    const reader = {
      async getActiveBuilderSet() {
        return { builderSetId: 'genesis-1', builderSetVersion: 1n, effectiveHeight: 1n, builders: ADDR, setHash: '00' };
      },
      getServiceDescriptor: (address: string) => descriptorReader.getServiceDescriptor(address),
    } as unknown as HubReader;
    const { endpoints } = await resolveBuilderEndpoints(reader);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.serviceEndpoint).toBe('https://b.example:8443');
    expect(endpoints[0]?.tlsPubkeyHash).toBe(HASH_HEX);
  });

  it('resolveTaskBuilderEndpoints returns endpoints carrying tlsPubkeyHash', async () => {
    const descRef: ServiceDescriptorRef = {
      participantType: 'PARTICIPANT_TYPE_BUILDER',
      participantId: ADDR,
      descriptorVersion: 1n,
      endpoints: [{ endpointKind: 'SERVICE_ENDPOINT_KIND_NEXUS_GRPC', uri: 'https://b.example:8443', protocolVersion: 'v1', tlsPubkeyHash: HASH_HEX }],
      descriptorHash: '00'.repeat(32),
      updatedHeight: 1n,
    };
    const { endpoints } = await resolveTaskBuilderEndpoints(
      {
        getActiveBuilderSet: async () => ({
          builderSetId: 'genesis-1', builderSetVersion: 1n, effectiveHeight: 1n, builders: ADDR, setHash: '11'.repeat(32),
        }),
        getServiceDescriptor: async () => descRef,
      },
      { chainId: 'trueopen', taskId: 'ab'.repeat(32), builderSetHash: '11'.repeat(32), sessionAnchorBlockHash: '22'.repeat(32), buildersPerTask: 1 },
    );
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.tlsPubkeyHash).toBe(HASH_HEX);
  });

  it('fanOutToEndpoints passes the whole endpoint object to the submitter, which uses it to build a verified transport', async () => {
    const seen: string[] = [];
    const endpoints = [{ serviceEndpoint: 'https://b.example:8443', tlsPubkeyHash: HASH_HEX }];
    const res = await fanOutToEndpoints({}, endpoints, async (endpoint) => {
      seen.push(endpoint.tlsPubkeyHash ?? '');
      return { accepted: true };
    });
    expect(res.accepted).toBe(true);
    expect(seen).toEqual([HASH_HEX]);
  });
});
