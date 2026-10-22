import { describe, it, expect } from 'vitest';
import { nexusTransportOptions, prewarmNexusConnections, sharedPinnedHttpsAgent, PinnedHttpsAgent } from '../../src/transport/nexus-tls';

// No listener here: these only build transport options, or fail before connecting.
const HASH = `0x${'ab'.repeat(32)}`;
const OTHER = `0x${'cd'.repeat(32)}`;

describe('shared pinned agents', () => {
  it('every transport for the same pinned key shares one keep-alive agent, so a warm connection is reusable', () => {
    const a = nexusTransportOptions('https://nexus.example:8443', HASH).nodeOptions?.agent;
    const b = nexusTransportOptions('grpcs://nexus.example:8443', HASH).nodeOptions?.agent;
    expect(a).toBeInstanceOf(PinnedHttpsAgent);
    expect(b).toBe(a);
    expect(sharedPinnedHttpsAgent(HASH)).toBe(a);
    expect(nexusTransportOptions('https://nexus.example:8443', OTHER).nodeOptions?.agent).not.toBe(a);
  });

  it('shareConnections: false keeps a private agent per transport', () => {
    const a = nexusTransportOptions('https://nexus.example:8443', HASH, { shareConnections: false }).nodeOptions?.agent;
    expect(a).toBeInstanceOf(PinnedHttpsAgent);
    expect(a).not.toBe(sharedPinnedHttpsAgent(HASH));
  });

  it('prewarm applies the same endpoint policy as the transport', async () => {
    await expect(prewarmNexusConnections('http://nexus.example:8080')).rejects.toMatchObject({ code: 'NEXUS_INSECURE_HTTP_REFUSED' });
    await expect(prewarmNexusConnections('https://nexus.example:8443', 'not-a-hash')).rejects.toMatchObject({ code: 'NEXUS_TLS_PUBKEY_HASH_MALFORMED' });
  });
});
