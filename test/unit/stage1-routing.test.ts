import { describe, it, expect } from 'vitest';
import { resolveTaskBuilderEndpoints } from '../../src/hub/stage1-routing';
import { selectTaskBuilders } from '../../src/hub/builder-selection';
import type { BuilderSetSnapshot, ServiceDescriptorRef } from '../../src/types/hub';
import { toHex } from '../../src/util/bytes';

const A = 'trueopen1yfse4c367uc2rja5g3905ynmnuv2hjk8gcgvfl';
const B = 'trueopen1870sqtdru7dj3xgwpzcexry0dwvyz2ku7xv9mg';
const C = 'trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man';
const hexOf = (b: number): string => toHex(new Uint8Array(32).fill(b));

const SET_HASH = '33530796a5c450a2c5264ec40d1eeabf0e581d3f84dc09b45c35ac8259f4706a';
const ANCHOR = hexOf(0x14);
const TASK = '4f5fc5f611e7fe40cecd95c945bdb8a3383ddbd7d55545758ae8c860546ce193';

const SNAP: BuilderSetSnapshot = {
  builderSetId: 'genesis-1', builderSetVersion: 1n, effectiveHeight: 1n,
  builders: `${B},${C},${A}`,
  setHash: SET_HASH,
  };

// #41: descriptor inlines endpoints[] (including the NEXUS_GRPC uri).
const descRef = (id: string, withNexus = true): ServiceDescriptorRef => ({
  participantType: 'PARTICIPANT_TYPE_BUILDER',
  participantId: id,
  descriptorVersion: 2n,
  endpoints: withNexus
    ? [{ endpointKind: 'SERVICE_ENDPOINT_KIND_NEXUS_GRPC', uri: `grpc://${id}:8080`, protocolVersion: 'v1' }]
    : [{ endpointKind: 'SERVICE_ENDPOINT_KIND_HEALTH_HTTPS', uri: `https://${id}:8080/healthz`, protocolVersion: 'v1' }],
  descriptorHash: hexOf(0xaa),
  updatedHeight: 1n,
});

const reader = {
  getActiveBuilderSet: async (): Promise<BuilderSetSnapshot> => SNAP,
  getServiceDescriptor: async (id: string): Promise<ServiceDescriptorRef> => descRef(id),
};

const input = {
  chainId: 'trueopen-localnet-1',
  taskId: TASK,
  builderSetHash: SET_HASH,
  sessionAnchorBlockHash: ANCHOR,
};

describe('resolveTaskBuilderEndpoints', () => {
  it('selects Task Builders and takes the nexus uri from inline endpoints (ordered by rank)', async () => {
    const { endpoints, errors, builderSetId } = await resolveTaskBuilderEndpoints(reader, input);
    expect(builderSetId).toBe('genesis-1');
    expect(errors).toHaveLength(0);
    expect(endpoints.map((e) => e.rank)).toEqual([1, 2, 3]);
    // Matches the result of calling the selection algorithm directly (routing introduces no extra ordering).
    const expected = selectTaskBuilders({
      chainId: input.chainId,
      taskId: TASK,
      builderSetHash: SET_HASH,
      sessionAnchorBlockHash: ANCHOR,
      members: [B, C, A].map((address) => ({ address, status: 'BUILDER_STATUS_ACTIVE' })),
    });
    expect(endpoints.map((e) => e.address)).toEqual(expected.map((s) => s.address));
    expect(endpoints[0]?.serviceEndpoint).toBe(`grpc://${expected[0]?.address}:8080`);
  });

  it('anchor change -> routing result changes accordingly (bound to the anchor recorded in the order)', async () => {
    const a = await resolveTaskBuilderEndpoints(reader, input);
    const b = await resolveTaskBuilderEndpoints(reader, { ...input, sessionAnchorBlockHash: hexOf(0x77) });
    expect(b.endpoints).toHaveLength(3);
    // At least the ranking distribution differs (choosing 3 of 3 gives the same set, but the ranking order is determined by rank).
    expect(b.endpoints.map((e) => e.address)).not.toEqual(a.endpoints.map((e) => e.address));
  });

  it('records an error when a builder\'s descriptor has no NEXUS_GRPC endpoint, without blocking the rest', async () => {
    const noNexusForA = {
      getActiveBuilderSet: async (): Promise<BuilderSetSnapshot> => SNAP,
      getServiceDescriptor: async (id: string): Promise<ServiceDescriptorRef> => descRef(id, id !== A),
    };
    const { endpoints, errors } = await resolveTaskBuilderEndpoints(noNexusForA, input);
    expect(endpoints).toHaveLength(2);
    expect(errors.map((e: { address: string }) => e.address)).toEqual([A]);
  });

  it('does not depend on the snapshot\'s member list when members is passed explicitly', async () => {
    const { endpoints } = await resolveTaskBuilderEndpoints(reader, {
      ...input,
      members: [A, B].map((address) => ({ address, status: 'BUILDER_STATUS_ACTIVE' })),
      buildersPerTask: 2,
    });
    expect(endpoints).toHaveLength(2);
    expect(endpoints.map((e) => e.address).sort()).toEqual([A, B].sort());
  });
});
