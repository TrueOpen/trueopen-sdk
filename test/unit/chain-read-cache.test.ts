import { describe, expect, it } from 'vitest';
import { ChainReadCache, MAX_CHAIN_READ_CACHE_TTL_MS, hubOrderReads } from '../../src/transport/chain-read-cache';
import type { CacheableHubReads } from '../../src/transport/chain-read-cache';
import type { BuilderSetSnapshot } from '../../src/types/hub';
import { hash32Text } from '../../src/codec/hash32';

const clock = () => {
  let t = 0;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};

describe('ChainReadCache', () => {
  it('shares one read between concurrent callers and reuses it within the TTL', async () => {
    const c = clock();
    const cache = new ChainReadCache({ now: c.now });
    let reads = 0;
    const read = async () => ++reads;
    expect(await Promise.all([cache.memo('k', read), cache.memo('k', read)])).toEqual([1, 1]);
    c.advance(MAX_CHAIN_READ_CACHE_TTL_MS);
    expect(await cache.memo('k', read)).toBe(1);
    c.advance(1);
    expect(await cache.memo('k', read)).toBe(2);
  });

  it('does not cache a failure', async () => {
    const cache = new ChainReadCache();
    let reads = 0;
    await expect(cache.memo('k', async () => { reads++; throw new Error('down'); })).rejects.toThrow('down');
    expect(await cache.memo('k', async () => ++reads)).toBe(2);
  });

  it('a read in flight when the cache is invalidated does not repopulate it', async () => {
    const cache = new ChainReadCache();
    let release!: (v: string) => void;
    const pending = cache.memo('k', () => new Promise<string>((r) => { release = r; }));
    cache.invalidate();
    release('old');
    expect(await pending).toBe('old');
    expect(cache.peek('k')).toBeUndefined();
  });

  it('caps the TTL at 60 s', () => {
    expect(() => new ChainReadCache({ ttlMs: 60_001 })).toThrow(/SDK_LOCAL_CONFIG_INVALID|chainReadCache/);
    expect(new ChainReadCache({ ttlMs: 5_000 }).ttlMs).toBe(5_000);
  });
});

describe('hubOrderReads', () => {
  const set = (id: string, effectiveHeight: bigint, b: number): BuilderSetSnapshot => ({
    builderSetId: id, builderSetVersion: 1n, effectiveHeight, builders: 'a', setHash: hash32Text(new Uint8Array(32).fill(b)),
  });

  function hub(sets: (h: bigint) => BuilderSetSnapshot) {
    const calls: string[] = [];
    const h: CacheableHubReads = {
      getLatestHeight: async () => { calls.push('height'); return 1n; },
      getBuilderSetAtHeight: async (height) => { calls.push(`set@${height}`); return sets(height); },
      getParameterBucket: async () => { calls.push('bucket'); return { bucketKind: 'TIMEOUT', bucketKey: 'default', version: 1n, currentVersion: 1n, effectiveHeight: 0n }; },
      getTaskGenerationLimits: async () => { throw new Error('unused'); },
      getServiceDescriptor: async () => { throw new Error('unused'); },
    };
    return { h, calls };
  }

  it('never caches the latest height', async () => {
    const { h, calls } = hub(() => set('s', 1n, 1));
    const r = hubOrderReads(h, new ChainReadCache());
    await r.getLatestHeight();
    await r.getLatestHeight();
    expect(calls).toEqual(['height', 'height']);
  });

  it('answers later heights from the set read at the highest height, and reads a height before its effective height', async () => {
    const { h, calls } = hub((height) => (height >= 100n ? set('new', 100n, 2) : set('old', 1n, 1)));
    const r = hubOrderReads(h, new ChainReadCache());
    expect((await r.getBuilderSetAtHeight(150n)).builderSetId).toBe('new');
    expect((await r.getBuilderSetAtHeight(160n)).builderSetId).toBe('new');
    expect((await r.getBuilderSetAtHeight(120n)).builderSetId).toBe('new');
    expect((await r.getBuilderSetAtHeight(50n)).builderSetId).toBe('old');
    // The older set did not replace the later one.
    expect((await r.getBuilderSetAtHeight(170n)).builderSetId).toBe('new');
    expect(calls).toEqual(['set@150', 'set@50']);
  });

  it('a fresh BuilderSet with another hash drops the other entries', async () => {
    const c = clock();
    const cache = new ChainReadCache({ now: c.now });
    let current = set('a', 1n, 1);
    const { h, calls } = hub(() => current);
    const r = hubOrderReads(h, cache);
    await r.getBuilderSetAtHeight(10n);
    c.advance(30_000);
    await r.getParameterBucket(1 as never);
    c.advance(30_001); // the set expired, the bucket did not
    current = set('b', 20n, 2);
    await r.getBuilderSetAtHeight(40n);
    await r.getParameterBucket(1 as never);
    expect(calls).toEqual(['set@10', 'bucket', 'set@40', 'bucket']);
  });

  it('passes every read through without a cache', async () => {
    const { h, calls } = hub(() => set('s', 1n, 1));
    const r = hubOrderReads(h);
    await r.getBuilderSetAtHeight(5n);
    await r.getBuilderSetAtHeight(5n);
    expect(calls).toEqual(['set@5', 'set@5']);
  });
});
