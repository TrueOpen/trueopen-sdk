import { describe, it, expect, vi, afterEach } from 'vitest';
import { ManifestSource, MemoryManifestCache, boundedWebFetch } from '../../src/manifest/manifest-source';
import type { ManifestFetcher, ProfileManifestReader } from '../../src/manifest/manifest-source';
import type { ProfileManifestState } from '../../src/manifest/model-manifest';
import { MAX_MANIFEST_BYTES } from '../../src/manifest/model-manifest';
import { createNodeManifestSource } from '../../src/node';
import { GOLDEN_MANIFEST_BYTES, GOLDEN_MANIFEST_HASH, goldenState } from '../helpers/manifest-fixture';

const WRONG = new TextEncoder().encode('{"not":"it"}');
const IPFS_URI = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/manifests/golden.json';

function readerOf(state: ProfileManifestState): ProfileManifestReader & { calls: number } {
  const r = {
    calls: 0,
    async getProfileManifestState(): Promise<ProfileManifestState> {
      r.calls++;
      return state;
    },
  };
  return r;
}

/** A fetcher that serves fixed bodies by URL and records every call. */
function stubFetcher(bodies: Record<string, Uint8Array | Error>): ManifestFetcher & { urls: string[] } {
  const urls: string[] = [];
  const f = Object.assign(async (url: string): Promise<Uint8Array> => {
    urls.push(url);
    const b = bodies[url];
    if (b === undefined) throw new Error(`unexpected ${url}`);
    if (b instanceof Error) throw b;
    return b;
  }, { urls });
  return f;
}

const MIRROR = 'https://mirror.example/m/{manifest_hash}.json';
const MIRROR_URL = `https://mirror.example/m/${GOLDEN_MANIFEST_HASH}.json`;

describe('ManifestSource: fetch order and verification', () => {
  it('reads manifest_hash and manifest_uri from ProfileState and verifies the body from manifest_uri', async () => {
    const state = goldenState();
    const fetcher = stubFetcher({ [state.manifestUri]: GOLDEN_MANIFEST_BYTES });
    const reader = readerOf(state);
    const r = await new ManifestSource({ reader, fetcher }).fetchManifest(state.modelId, 1n);
    expect(reader.calls).toBe(1);
    expect(r.source).toBe('manifest_uri');
    expect(r.url).toBe(state.manifestUri);
    expect(r.bytes).toEqual(GOLDEN_MANIFEST_BYTES);
    expect(fetcher.urls).toEqual([state.manifestUri]);
  });

  it('uses a cached body for the same manifest_hash without a network fetch', async () => {
    const cache = new MemoryManifestCache();
    cache.set(GOLDEN_MANIFEST_HASH, GOLDEN_MANIFEST_BYTES);
    const fetcher = stubFetcher({});
    const r = await new ManifestSource({ reader: readerOf(goldenState()), fetcher, cache }).fetchManifest('x', 1n);
    expect(r.source).toBe('cache');
    expect(fetcher.urls).toEqual([]);
  });

  it('stores a verified network body in the cache', async () => {
    const cache = new MemoryManifestCache();
    const state = goldenState();
    const fetcher = stubFetcher({ [state.manifestUri]: GOLDEN_MANIFEST_BYTES });
    const src = new ManifestSource({ reader: readerOf(state), fetcher, cache });
    await src.fetchForState(state);
    expect(cache.get(GOLDEN_MANIFEST_HASH)).toEqual(GOLDEN_MANIFEST_BYTES);
    expect((await src.fetchForState(state)).source).toBe('cache');
    expect(fetcher.urls).toHaveLength(1);
  });

  it('re-verifies a cached body: a poisoned entry is discarded and the network is tried', async () => {
    const cache = new MemoryManifestCache();
    cache.set(GOLDEN_MANIFEST_HASH, WRONG);
    const state = goldenState();
    const fetcher = stubFetcher({ [state.manifestUri]: GOLDEN_MANIFEST_BYTES });
    const r = await new ManifestSource({ reader: readerOf(state), fetcher, cache }).fetchForState(state);
    expect(r.source).toBe('manifest_uri');
    expect(r.attempts).toEqual([expect.objectContaining({ source: 'cache', code: 'MANIFEST_HASH_MISMATCH' })]);
  });

  it('discards a wrong-hash body from manifest_uri and moves on to the mirror', async () => {
    const state = goldenState();
    const fetcher = stubFetcher({ [state.manifestUri]: WRONG });
    const trusted = stubFetcher({ [MIRROR_URL]: GOLDEN_MANIFEST_BYTES });
    const r = await new ManifestSource({ reader: readerOf(state), fetcher, trustedFetcher: trusted, mirrors: [MIRROR] }).fetchForState(state);
    expect(r.source).toBe('mirror');
    expect(r.url).toBe(MIRROR_URL);
    expect(r.attempts).toEqual([expect.objectContaining({ source: 'manifest_uri', code: 'MANIFEST_HASH_MISMATCH' })]);
  });

  it('moves on after a fetch error', async () => {
    const state = goldenState();
    const fetcher = stubFetcher({ [state.manifestUri]: new Error('boom') });
    const trusted = stubFetcher({ [MIRROR_URL]: GOLDEN_MANIFEST_BYTES });
    const r = await new ManifestSource({ reader: readerOf(state), fetcher, trustedFetcher: trusted, mirrors: [MIRROR] }).fetchForState(state);
    expect(r.source).toBe('mirror');
    expect(r.attempts[0]).toMatchObject({ code: 'MANIFEST_FETCH_FAILED', message: 'boom' });
  });

  it('a mirror serving a non-canonical body with the right hash is still rejected', async () => {
    // Only possible if the chain committed to non-canonical bytes: the hash matches, the canonical check fails.
    const pretty = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(GOLDEN_MANIFEST_BYTES)), null, 2));
    const { modelManifestHash } = await import('../../src/manifest/model-manifest');
    const { toHex } = await import('../../src/util/bytes');
    const state = goldenState({ manifestHash: toHex(modelManifestHash(pretty)), manifestUri: '' });
    const mirrorUrl = MIRROR.replace('{manifest_hash}', state.manifestHash);
    const trusted = stubFetcher({ [mirrorUrl]: pretty });
    await expect(new ManifestSource({ reader: readerOf(state), trustedFetcher: trusted, mirrors: [MIRROR] }).fetchForState(state)).rejects.toMatchObject({
      code: 'MANIFEST_UNAVAILABLE',
      message: expect.stringContaining('MANIFEST_NOT_CANONICAL'),
    });
  });

  it('fails with every attempt listed when no source verifies', async () => {
    const state = goldenState();
    const fetcher = stubFetcher({ [state.manifestUri]: WRONG });
    const trusted = stubFetcher({ [MIRROR_URL]: WRONG });
    const err = await new ManifestSource({ reader: readerOf(state), fetcher, trustedFetcher: trusted, mirrors: [MIRROR] })
      .fetchForState(state)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'MANIFEST_UNAVAILABLE', retriable: true });
    expect((err as Error).message).toContain('manifest_uri');
    expect((err as Error).message).toContain('mirror');
  });

  it('rejects a profile without a canonical manifest_hash', async () => {
    const src = new ManifestSource({ reader: readerOf(goldenState()), fetcher: stubFetcher({}) });
    await expect(src.fetchForState(goldenState({ manifestHash: '' }))).rejects.toMatchObject({ code: 'MANIFEST_NOT_REGISTERED' });
  });

  it('a manifest_uri failing syntax is never fetched', async () => {
    const state = goldenState({ manifestUri: 'http://models.trueopen.example/m.json' });
    const fetcher = stubFetcher({});
    const trusted = stubFetcher({ [MIRROR_URL]: GOLDEN_MANIFEST_BYTES });
    const r = await new ManifestSource({ reader: readerOf(state), fetcher, trustedFetcher: trusted, mirrors: [MIRROR] }).fetchForState(state);
    expect(fetcher.urls).toEqual([]);
    expect(r.attempts[0]).toMatchObject({ source: 'manifest_uri', code: 'MANIFEST_URI_INVALID' });
  });

  it('honors a chain max_manifest_uri_bytes below the URI length', async () => {
    const state = goldenState();
    const fetcher = stubFetcher({ [state.manifestUri]: GOLDEN_MANIFEST_BYTES });
    const trusted = stubFetcher({ [MIRROR_URL]: GOLDEN_MANIFEST_BYTES });
    const src = new ManifestSource({ reader: readerOf(state), fetcher, trustedFetcher: trusted, mirrors: [MIRROR], maxManifestUriBytes: 10 });
    expect((await src.fetchForState(state)).source).toBe('mirror');
    expect(fetcher.urls).toEqual([]);
  });

  it('passes the 4 MiB and timeout limits to every fetcher', async () => {
    const state = goldenState();
    const seen: unknown[] = [];
    const fetcher: ManifestFetcher = async (_url, limits) => {
      seen.push(limits);
      return GOLDEN_MANIFEST_BYTES;
    };
    await new ManifestSource({ reader: readerOf(state), fetcher, timeoutMs: 1234 }).fetchForState(state);
    expect(seen).toEqual([{ maxBytes: MAX_MANIFEST_BYTES, timeoutMs: 1234 }]);
  });
});

describe('ManifestSource: ipfs://', () => {
  it('fetches only through the configured gateway', async () => {
    const state = goldenState({ manifestUri: IPFS_URI });
    const gatewayUrl = 'http://127.0.0.1:8080/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/manifests/golden.json';
    const fetcher = stubFetcher({});
    const trusted = stubFetcher({ [gatewayUrl]: GOLDEN_MANIFEST_BYTES });
    const r = await new ManifestSource({ reader: readerOf(state), fetcher, trustedFetcher: trusted, ipfsGateway: 'http://127.0.0.1:8080/' }).fetchForState(state);
    expect(r).toMatchObject({ source: 'manifest_uri', url: gatewayUrl });
    expect(fetcher.urls).toEqual([]);
  });

  it('without a gateway, skips ipfs:// and falls through to mirrors', async () => {
    const state = goldenState({ manifestUri: IPFS_URI });
    const trusted = stubFetcher({ [MIRROR_URL]: GOLDEN_MANIFEST_BYTES });
    const r = await new ManifestSource({ reader: readerOf(state), fetcher: stubFetcher({}), trustedFetcher: trusted, mirrors: [MIRROR] }).fetchForState(state);
    expect(r.source).toBe('mirror');
    expect(r.attempts[0]).toMatchObject({ code: 'MANIFEST_URI_SKIPPED' });
  });
});

describe('ManifestSource: runtime configuration', () => {
  it('refuses to construct with no network source (browser without fetcher or mirror)', () => {
    expect(() => new ManifestSource({ reader: readerOf(goldenState()) })).toThrow(/no network source/);
  });

  it('browser setup: mirror only, manifest_uri skipped rather than fetched unsafely', async () => {
    const state = goldenState();
    const trusted = stubFetcher({ [MIRROR_URL]: GOLDEN_MANIFEST_BYTES });
    const r = await new ManifestSource({ reader: readerOf(state), trustedFetcher: trusted, mirrors: [MIRROR] }).fetchForState(state);
    expect(r.source).toBe('mirror');
    expect(r.attempts[0]).toMatchObject({ source: 'manifest_uri', code: 'MANIFEST_URI_SKIPPED' });
  });

  it('validates mirror templates and the gateway URL', () => {
    const reader = readerOf(goldenState());
    expect(() => new ManifestSource({ reader, mirrors: ['https://mirror.example/m.json'] })).toThrow(/\{manifest_hash\}/);
    expect(() => new ManifestSource({ reader, mirrors: ['ftp://m.example/{manifest_hash}'] })).toThrow(/http\(s\)/);
    expect(() => new ManifestSource({ reader, ipfsGateway: 'not a url' })).toThrow(/not a URL/);
  });

  it('createNodeManifestSource wires in the SSRF-safe fetcher', async () => {
    // A manifest_uri on a loopback literal is syntactically valid but must be refused at connect time.
    const state = goldenState({ manifestUri: 'https://127.0.0.1/m.json' });
    const src = createNodeManifestSource({ reader: readerOf(state), fetcherOptions: { retries: 0 } });
    await expect(src.fetchForState(state)).rejects.toMatchObject({
      code: 'MANIFEST_UNAVAILABLE',
      message: expect.stringContaining('MANIFEST_FETCH_REFUSED'),
    });
  });

  it('MemoryManifestCache evicts the oldest entry beyond its cap', () => {
    const c = new MemoryManifestCache(2);
    c.set('a', new Uint8Array([1]));
    c.set('b', new Uint8Array([2]));
    c.set('c', new Uint8Array([3]));
    expect(c.get('a')).toBeUndefined();
    expect(c.get('c')).toEqual(new Uint8Array([3]));
  });
});

describe('boundedWebFetch (trusted sources over the platform fetch)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const limits = { maxBytes: 16, timeoutMs: 1_000 };

  it('returns the body within the bound', async () => {
    vi.stubGlobal('fetch', async () => new Response('0123456789'));
    expect(new TextDecoder().decode(await boundedWebFetch('https://m.example/x', limits))).toBe('0123456789');
  });

  it('rejects a declared Content-Length above the bound', async () => {
    vi.stubGlobal('fetch', async () => new Response('x', { headers: { 'content-length': '17' } }));
    await expect(boundedWebFetch('https://m.example/x', limits)).rejects.toMatchObject({ code: 'MANIFEST_TOO_LARGE' });
  });

  it('aborts once the bytes read exceed the bound', async () => {
    vi.stubGlobal('fetch', async () => new Response('x'.repeat(17)));
    await expect(boundedWebFetch('https://m.example/x', limits)).rejects.toMatchObject({ code: 'MANIFEST_TOO_LARGE' });
  });

  it('times out', async () => {
    vi.stubGlobal('fetch', (_u: string, init: { signal: AbortSignal }) =>
      new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    await expect(boundedWebFetch('https://m.example/x', { ...limits, timeoutMs: 50 })).rejects.toMatchObject({ code: 'MANIFEST_FETCH_TIMEOUT' });
  });

  it('reports non-2xx status', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    await expect(boundedWebFetch('https://m.example/x', limits)).rejects.toMatchObject({ code: 'MANIFEST_FETCH_HTTP_STATUS' });
  });
});
