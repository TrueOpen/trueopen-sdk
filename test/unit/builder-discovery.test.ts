import { describe, it, expect } from 'vitest';
import {
  verifyAndParseBuilderDescriptor,
  resolveBuilderEndpoints,
} from '../../src/hub/builder-discovery';
import type { HubReader } from '../../src/transport/hub-reader';
import type { BuilderSetSnapshot, ServiceDescriptorRef } from '../../src/types/hub';
import { sha256 } from '../../src/codec/hash';
import { toHex } from '../../src/util/bytes';

// Real live-chain descriptor document (196 bytes, no trailing newline) + on-chain committed hash (verified byte-for-byte).
const GOLDEN_DOC =
  '{"schema_version":"trueopen-builder-descriptor-v1","builder_address":"trueopen1870sqtdru7dj3xgwpzcexry0dwvyz2ku7xv9mg","service_endpoint":"https://builder.example:8080","moniker":"","p2p_hint":""}';
const GOLDEN_HASH = 'ac70088f6a4de32fcf2da1f3a319c140f0abc374385e83fee14dd6df3778cd3c';
const enc = new TextEncoder();

describe('verifyAndParseBuilderDescriptor', () => {
  it('resolves service_endpoint when the hash matches (real live-chain golden value)', () => {
    const doc = verifyAndParseBuilderDescriptor(enc.encode(GOLDEN_DOC), GOLDEN_HASH);
    expect(doc.serviceEndpoint).toBe('https://builder.example:8080');
    expect(doc.schemaVersion).toBe('trueopen-builder-descriptor-v1');
    expect(doc.builderAddress).toBe('trueopen1870sqtdru7dj3xgwpzcexry0dwvyz2ku7xv9mg');
    // Self-check: confirm GOLDEN_HASH really is the sha256 of the document bytes
    expect(toHex(sha256(enc.encode(GOLDEN_DOC)))).toBe(GOLDEN_HASH);
  });

  it('tampering with one byte triggers DESCRIPTOR_HASH_MISMATCH', () => {
    const tampered = enc.encode(GOLDEN_DOC.replace(':8080', ':9090'));
    expect(() => verifyAndParseBuilderDescriptor(tampered, GOLDEN_HASH)).toThrowError(/DESCRIPTOR_HASH_MISMATCH|mismatch/);
  });

  it('throws for an unsupported schema (hash is still self-consistent)', () => {
    const bad = enc.encode('{"schema_version":"nope","service_endpoint":"x"}');
    expect(() => verifyAndParseBuilderDescriptor(bad, toHex(sha256(bad)))).toThrowError(/schema/i);
  });

  it('missing service_endpoint triggers DESCRIPTOR_MALFORMED', () => {
    const bad = enc.encode('{"schema_version":"trueopen-builder-descriptor-v1","service_endpoint":""}');
    expect(() => verifyAndParseBuilderDescriptor(bad, toHex(sha256(bad)))).toThrowError(/service_endpoint|MALFORMED/);
  });
});

// ---- resolveBuilderEndpoints: stub reader (#41 inline endpoint model) ----
function ref(participantId: string, uri: string): ServiceDescriptorRef {
  return {
    participantType: 'PARTICIPANT_TYPE_BUILDER', participantId, descriptorVersion: 2n,
    endpoints: [{ endpointKind: 'SERVICE_ENDPOINT_KIND_NEXUS_GRPC', uri, protocolVersion: 'v1' }],
    descriptorHash: 'aa', updatedHeight: 1n,
  };
}
function stubReader(activeBuilders: string[], refs: Record<string, ServiceDescriptorRef>): HubReader {
  const snap: BuilderSetSnapshot = {
    builderSetId: 'genesis-1', builderSetVersion: 1n, effectiveHeight: 1n,
    builders: activeBuilders.join(','), setHash: '00', };
  return {
    async getActiveBuilderSet() { return snap; },
    async getServiceDescriptor(id: string) {
      const r = refs[id];
      if (!r) throw new Error('no descriptor');
      return r;
    },
  } as unknown as HubReader;
}

describe('resolveBuilderEndpoints', () => {
  it('fetches inline NEXUS_GRPC endpoints for each builder in the active builder set', async () => {
    const reader = stubReader(['b-active'], { 'b-active': ref('b-active', 'https://builder.example:8080') });
    const res = await resolveBuilderEndpoints(reader);
    expect(res.errors).toHaveLength(0);
    expect(res.endpoints).toHaveLength(1);
    expect(res.endpoints[0]?.builderAddress).toBe('b-active');
    expect(res.endpoints[0]?.serviceEndpoint).toBe('https://builder.example:8080');
  });

  it('records a missing single builder descriptor in errors without blocking the rest', async () => {
    const reader = stubReader(['b1', 'b2'], { b1: ref('b1', 'https://d1:8080') });
    const res = await resolveBuilderEndpoints(reader);
    expect(res.endpoints.map((e) => e.builderAddress)).toEqual(['b1']);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.builderAddress).toBe('b2');
  });
});
