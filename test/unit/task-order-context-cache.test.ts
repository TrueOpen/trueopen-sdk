import { describe, it, expect } from 'vitest';
import { TaskOrderContextCache } from '../../src/order/task-order-context-cache';
import type { TaskOrderContextCacheReader } from '../../src/order/task-order-context-cache';
import type { BuilderSetSnapshot, BeaconView, ParameterBucketView } from '../../src/types/hub';
import { hash32Text } from '../../src/codec/hash32';

const CHAIN = 'trueopen-localnet-1';
const hexOf = (b: number): string => hash32Text(new Uint8Array(32).fill(b));
const setA: BuilderSetSnapshot = { builderSetId: 'set-a', builderSetVersion: 1n, effectiveHeight: 1n, builders: 'trueopen1a', setHash: hexOf(0x0a) };
const setB: BuilderSetSnapshot = { builderSetId: 'set-b', builderSetVersion: 2n, effectiveHeight: 2_000n, builders: 'trueopen1b', setHash: hexOf(0x0b) };

/** A chain at `latest` whose set changes to setB at `rotateAt`; counts every read. */
function fakeHub(opts: { window?: bigint | undefined; rotateAt?: bigint } = {}) {
  const calls = { latest: 0, sets: [] as bigint[], beacons: [] as bigint[], buckets: 0, limits: 0, windows: 0 };
  const state = { latest: 1_000n, bucketVersion: 1n, prunedBelow: 0n };
  const hub: TaskOrderContextCacheReader = {
    getLatestHeight: async () => {
      calls.latest += 1;
      return state.latest;
    },
    getBuilderSetAtHeight: async (h) => {
      calls.sets.push(h);
      if (h < state.prunedBelow) throw new Error('active_builders array'); // a pruned body reads back empty
      return opts.rotateAt !== undefined && h >= opts.rotateAt ? setB : setA;
    },
    getBeacon: async (height): Promise<BeaconView> => {
      calls.beacons.push(height);
      return { height, blockHash: hash32Text(new Uint8Array(32).fill(Number(height % 251n))), randomnessHex: '00'.repeat(32), sourceTag: 't', verified: true };
    },
    getParameterBucket: async (kind): Promise<ParameterBucketView> => {
      calls.buckets += 1;
      return { bucketKind: String(kind), bucketKey: 'default', version: state.bucketVersion, currentVersion: state.bucketVersion, effectiveHeight: 0n };
    },
    getTaskGenerationLimits: async () => {
      calls.limits += 1;
      return { maxOutputTokens: 1n, topKMax: 1n, stopSequenceMaxItems: 1n, stopSequenceMaxBytesEach: 1n, stopSequenceMaxTotalBytes: 1n, stopTokenMaxItems: 1n };
    },
  };
  if (opts.window !== undefined) {
    hub.getAnchorFreshnessWindowBlocks = async () => {
      calls.windows += 1;
      return opts.window!;
    };
  }
  return { hub, calls, state };
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('TaskOrderContextCache', () => {
  it('reuses the anchor in one concurrent round, and still re-reads the latest height, the set and the bucket version', async () => {
    const { hub, calls, state } = fakeHub({ window: 10_000n });
    const cache = new TaskOrderContextCache(hub, CHAIN);
    const first = await cache.resolve();
    expect(first.context.sessionAnchorHeight).toBe(998n);
    expect(calls.beacons).toEqual([998n]);

    state.latest = 1_500n;
    state.bucketVersion = 2n;
    const second = await cache.resolve();
    expect(second.context.sessionAnchorHeight).toBe(998n);
    expect(second.context.sessionAnchorBlockHash).toBe(first.context.sessionAnchorBlockHash);
    expect(second.context.latestHeight).toBe(1_500n);
    expect(second.context.timeoutBucketVersion).toBe(2n);
    expect(second.builderSet).toEqual(setA);
    // No new beacon read; the set was re-read at the anchor height.
    expect(calls.beacons).toEqual([998n]);
    expect(calls.sets.slice(0, 2)).toEqual([998n, 998n]);
  });

  it('takes a fresh anchor once the anchor is older than the allowed share of the freshness window', async () => {
    const { hub, calls, state } = fakeHub({ window: 100n });
    const cache = new TaskOrderContextCache(hub, CHAIN); // 0.25 * 100 = 25 blocks
    await cache.resolve();
    state.latest = 1_000n + 23n; // anchor 998 is 25 old: still fine
    expect((await cache.resolve()).context.sessionAnchorHeight).toBe(998n);
    state.latest = 1_000n + 24n; // 26 old: too old
    expect((await cache.resolve()).context.sessionAnchorHeight).toBe(1_022n);
    expect(calls.beacons).toEqual([998n, 1_022n]);
  });

  it('follows a changed freshness window on the next order', async () => {
    const h = fakeHub({ window: 10_000n });
    const cache = new TaskOrderContextCache(h.hub, CHAIN);
    await cache.resolve();
    h.hub.getAnchorFreshnessWindowBlocks = async () => 8n; // governance shrank it to 8 -> 2 blocks
    h.state.latest = 1_001n;
    expect((await cache.resolve()).context.sessionAnchorHeight).toBe(999n);
  });

  it('never reuses without the freshness window, or with reuse turned off by the option range', async () => {
    const { hub, calls, state } = fakeHub({ window: undefined });
    const cache = new TaskOrderContextCache(hub, CHAIN);
    await cache.resolve();
    state.latest = 1_001n;
    expect((await cache.resolve()).context.sessionAnchorHeight).toBe(999n);
    expect(calls.beacons).toEqual([998n, 999n]);
    expect(() => new TaskOrderContextCache(hub, CHAIN, { maxAnchorAgeFraction: 1 })).toThrow(/maxAnchorAgeFraction/);
  });

  it('takes a fresh anchor when the set at the cached anchor no longer reads back (pruned)', async () => {
    const { hub, state } = fakeHub({ window: 10_000n });
    const cache = new TaskOrderContextCache(hub, CHAIN);
    await cache.resolve();
    state.latest = 1_010n;
    state.prunedBelow = 1_000n;
    expect((await cache.resolve()).context.sessionAnchorHeight).toBe(1_008n);
  });

  it('after a reuse notices a newer BuilderSet in the background and gives the next order a fresh anchor', async () => {
    const { hub, state } = fakeHub({ window: 10_000n, rotateAt: 2_000n });
    const cache = new TaskOrderContextCache(hub, CHAIN);
    await cache.resolve();
    state.latest = 2_100n;
    // Still valid (setA is ACTIVE at 998), so this order reuses it ...
    const reused = await cache.resolve();
    expect(reused.context.builderSetId).toBe('set-a');
    await tick(10);
    // ... but the next one follows the new set.
    const fresh = await cache.resolve();
    expect(fresh.context.sessionAnchorHeight).toBe(2_098n);
    expect(fresh.context.builderSetId).toBe('set-b');
  });

  it('a failed read on the reuse path falls back to a fresh resolution', async () => {
    const { hub, state } = fakeHub({ window: 10_000n });
    const cache = new TaskOrderContextCache(hub, CHAIN);
    await cache.resolve();
    let failOnce = true;
    const original = hub.getParameterBucket;
    hub.getParameterBucket = async (k, key) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('flaky');
      }
      return original(k, key);
    };
    state.latest = 1_005n;
    expect((await cache.resolve()).context.sessionAnchorHeight).toBe(1_003n);
  });
});
