import { describe, it, expect } from 'vitest';
import { ethSecp256k1Address, secp256k1Address } from '../../src/index';
import { TRUEOPEN_HD_PATH, deriveIdentity, resolveNexusCandidates, resolveNexusCandidateEndpoints, queryAcrossNexus } from '../../src/cli/context';
import type { Ctx } from '../../src/cli/context';
import { resolveConfig } from '../../src/cli/config';
import type { HubReader } from '../../src/transport/hub-reader';
import type { TrueOpenClient } from '../../src/client';

const MN = 'flee cover glad finish category story alpha envelope twelve tube glory athlete ugly road roof milk idle ketchup utility park source jewel head shift';

describe('cli context', () => {
  it('deriveIdentity uses the protocol HD path (coin_type 60) + keccak address', async () => {
    const id = await deriveIdentity(MN, 'trueopen');
    expect(TRUEOPEN_HD_PATH).toBe("m/44'/60'/0'/0/0");
    expect(id.address).toBe('trueopen1jah6xx0ve056wgl3cxlxhe393ywwwyuamfl037');
    expect(id.pubKey).toHaveLength(33);
    // Confirm the address really is derived from that public key via keccak (not coincidentally equal to some constant).
    expect(id.address).toBe(ethSecp256k1Address(id.pubKey, 'trueopen'));
  });

  // Both failure modes are pinned down: a wrong HD path and a wrong derivation algorithm both
  // present the same symptom (address does not match, account is empty), but the fix is
  // completely different in each case. Asserting them separately makes it obvious which one it is.
  it('changing the HD path or the derivation algorithm both yield a different address', async () => {
    const id = await deriveIdentity(MN, 'trueopen');
    // coin_type 118 (Cosmos convention) - same mnemonic, different private key.
    expect(id.address).not.toBe('trueopen14yrq4wjw4jkjejfcvxnt2ew2fyp84xzwknntwd');
    // Same private key but derived via ripemd160(sha256(compressed)) (the pre-v0.4.1 scheme).
    expect(id.address).not.toBe(secp256k1Address(id.pubKey, 'trueopen'));
  });

  it('resolveNexusCandidates returns only the explicit nexusUrl by itself', async () => {
    const cfg = resolveConfig({ nexusUrl: 'http://n:8080' }, {});
    expect(await resolveNexusCandidates(cfg, {} as HubReader)).toEqual(['http://n:8080']);
  });

  it('candidates for an explicit --nexus-url carry the --nexus-tls-pubkey-hash (manual endpoints can still pin a fingerprint)', async () => {
    const hash = 'cd'.repeat(32);
    const cfg = resolveConfig({ nexusUrl: 'https://n:8080', nexusTlsPubkeyHash: hash }, {});
    expect(await resolveNexusCandidateEndpoints(cfg, {} as HubReader))
      .toEqual([{ serviceEndpoint: 'https://n:8080', tlsPubkeyHash: hash, builderAddress: '' }]);
    // When no fingerprint is given it is an empty string, and the connection falls back to institutional certificate-chain validation (explicitNexusTransport).
    const bare = resolveConfig({ nexusUrl: 'https://n:8080' }, {});
    expect(await resolveNexusCandidateEndpoints(bare, {} as HubReader))
      .toEqual([{ serviceEndpoint: 'https://n:8080', tlsPubkeyHash: '', builderAddress: '' }]);
  });

  it('resolveNexusCandidates throws when there is no url and --auto is not set', async () => {
    const cfg = resolveConfig({}, {});
    await expect(resolveNexusCandidates(cfg, {} as HubReader)).rejects.toThrowError(/nexus/i);
  });

  it('--auto returns all ACTIVE builder endpoints (not just the first one)', async () => {
    const cfg = resolveConfig({ auto: true }, {});
    const hub = {
      listBuilders: async () => [
        { address: 'b1', status: 'BUILDER_STATUS_ACTIVE' },
        { address: 'b2', status: 'BUILDER_STATUS_ACTIVE' },
      ],
      getActiveBuilderSet: async () => ({
        builderSetId: 'genesis-1', builderSetVersion: 1n, effectiveHeight: 1n,
        builders: 'b1,b2', setHash: '00',
      }),
      getServiceDescriptor: async (id: string) => ({
        participantType: 'PARTICIPANT_TYPE_BUILDER', participantId: id, descriptorVersion: 1n,
        endpoints: [{ endpointKind: 'SERVICE_ENDPOINT_KIND_NEXUS_GRPC', uri: `grpc://${id}:8080`, protocolVersion: 'v1' }],
        descriptorHash: 'aa', updatedHeight: 1n,
      }),
    } as unknown as HubReader;
    expect(await resolveNexusCandidates(cfg, hub)).toEqual(['grpc://b1:8080', 'grpc://b2:8080']);
  });
});

/**
 * A task only has local state on the Task Builder that received the order; the others
 * respond NOT_FOUND. When querying status, the caller does not have the anchor from the
 * order and so cannot work out whom to ask - hence it must try each one in turn.
 */
describe('queryAcrossNexus', () => {
  const ctxWith = (endpoints: string[], answer: (url: string) => Promise<string>): Ctx =>
    ({
      nexusCandidates: endpoints,
      clientFor: (url: string) => ({ probe: () => answer(url) }) as unknown as TrueOpenClient,
    }) as unknown as Ctx;

  it('skips NOT_FOUND and returns the result from the first endpoint that responds', async () => {
    const ctx = ctxWith(['a', 'b', 'c'], async (url) => {
      if (url !== 'b') throw Object.assign(new Error('task not found'), { code: 5 });
      return 'from-b';
    });
    const tried: string[] = [];
    const got = await queryAcrossNexus(ctx, async (client) => {
      const r = await (client as unknown as { probe(): Promise<string> }).probe();
      tried.push(r);
      return r;
    });
    expect(got).toBe('from-b');
  });

  it('does not try the rest once the first endpoint succeeds', async () => {
    let calls = 0;
    const ctx = ctxWith(['a', 'b'], async () => { calls += 1; return 'ok'; });
    await queryAcrossNexus(ctx, (client) => (client as unknown as { probe(): Promise<string> }).probe());
    expect(calls).toBe(1);
  });

  it('aggregates errors with each endpoint reason when all fail', async () => {
    const ctx = ctxWith(['a', 'b'], async (url) => {
      throw Object.assign(new Error(`no task on ${url}`), { code: 5 });
    });
    await expect(
      queryAcrossNexus(ctx, (client) => (client as unknown as { probe(): Promise<string> }).probe()),
    ).rejects.toMatchObject({ code: 'CLI_NO_NEXUS_HAS_TASK' });
  });
});
