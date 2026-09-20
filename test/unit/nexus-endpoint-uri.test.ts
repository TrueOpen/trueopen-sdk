import { describe, it, expect } from 'vitest';
import { nexusGrpcUri, nexusHttpBaseUri } from '../../src/types/hub';
import type { ServiceDescriptorRef } from '../../src/types/hub';

describe('nexusHttpBaseUri', () => {
  it('grpc:// -> http:// (node seed endpoint 0e22374 uses the grpc scheme, but Connect needs an http base URI)', () => {
    expect(nexusHttpBaseUri('grpc://builder.example:8080')).toBe('http://builder.example:8080');
  });

  it('grpcs:// → https://', () => {
    expect(nexusHttpBaseUri('grpcs://builder.example:8080')).toBe('https://builder.example:8080');
  });

  it('http(s):// is returned unchanged', () => {
    expect(nexusHttpBaseUri('http://a:8080')).toBe('http://a:8080');
    expect(nexusHttpBaseUri('https://a:8080')).toBe('https://a:8080');
  });

  it('an unrecognized scheme / empty string is returned unchanged', () => {
    expect(nexusHttpBaseUri('builder.example:8080')).toBe('builder.example:8080');
    expect(nexusHttpBaseUri('')).toBe('');
  });
});

describe('nexusGrpcUri', () => {
  const ref = (endpoints: ServiceDescriptorRef['endpoints']): ServiceDescriptorRef => ({
    participantType: 'PARTICIPANT_TYPE_BUILDER', participantId: 'b', descriptorVersion: 1n,
    endpoints, descriptorHash: 'aa', updatedHeight: 1n,
  });

  it("gets the NEXUS_GRPC endpoint's uri", () => {
    expect(
      nexusGrpcUri(ref([{ endpointKind: 'SERVICE_ENDPOINT_KIND_NEXUS_GRPC', uri: 'grpc://h:8080', protocolVersion: 'v1' }])),
    ).toBe('grpc://h:8080');
  });

  it('no NEXUS_GRPC endpoint -> empty string', () => {
    expect(
      nexusGrpcUri(ref([{ endpointKind: 'SERVICE_ENDPOINT_KIND_HEALTH_HTTPS', uri: 'grpc://h:8080/healthz', protocolVersion: 'v1' }])),
    ).toBe('');
  });
});
