import { TrueOpenError } from '../errors/errors';
import type { BuilderSetSnapshot, ParameterBucketView, ProfileInfo, ServiceDescriptorRef, TaskGenerationLimits } from '../types/hub';
import type { BUCKET_KIND } from '../types/hub';

/** The longest a successful chain query result may be reused. */
export const MAX_CHAIN_READ_CACHE_TTL_MS = 60_000;

export interface ChainReadCacheOptions {
  /** How long a successful read is reused, in milliseconds; default and maximum MAX_CHAIN_READ_CACHE_TTL_MS. */
  readonly ttlMs?: number;
  /** Clock, for tests; defaults to Date.now. */
  readonly now?: () => number;
}

interface Entry {
  readonly value: unknown;
  readonly at: number;
}

/**
 * A bounded, in-memory cache of successful chain reads that change only with governance or a
 * BuilderSet replacement: params, the timeout bucket, model profiles, service descriptors and
 * the BuilderSet. Each result is reused for at most `ttlMs`; `invalidate` drops everything at
 * once, and a read already in flight when it is called does not repopulate the cache.
 * Concurrent reads of one key share one request. Failures are never cached.
 */
export class ChainReadCache {
  readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private gen = 0;

  constructor(opts: ChainReadCacheOptions = {}) {
    const ttl = opts.ttlMs ?? MAX_CHAIN_READ_CACHE_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_CHAIN_READ_CACHE_TTL_MS) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_CONFIG_INVALID',
        `chainReadCache.ttlMs must be in (0, ${MAX_CHAIN_READ_CACHE_TTL_MS}], got ${String(ttl)}`,
      );
    }
    this.ttlMs = ttl;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Drops every cached result. */
  invalidate(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.gen += 1;
  }

  /**
   * Counts invalidations: a read that started under one generation stores its result only if it
   * is still the current one when the read finishes.
   */
  get generation(): number {
    return this.gen;
  }

  /** The cached value of `key` if it is younger than the TTL. */
  peek<T>(key: string): T | undefined {
    const e = this.entries.get(key);
    if (e === undefined || this.now() - e.at > this.ttlMs) return undefined;
    return e.value as T;
  }

  /** The last value stored under `key`, however old (to compare a fresh read against). */
  last<T>(key: string): T | undefined {
    return this.entries.get(key)?.value as T | undefined;
  }

  /**
   * The cached result of `key`, else the result of `read`, cached when it succeeds. `onFresh`
   * sees each fresh result with the value it replaces (possibly expired) before it is stored.
   */
  memo<T>(key: string, read: () => Promise<T>, onFresh?: (fresh: T, previous: T | undefined) => void): Promise<T> {
    const hit = this.peek<T>(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending as Promise<T>;
    const generation = this.gen;
    const previous = this.last<T>(key);
    const p = read().then(
      (value) => {
        if (generation === this.gen) {
          this.inFlight.delete(key);
          onFresh?.(value, previous);
          // onFresh may have invalidated the cache; the value itself is fresh either way.
          this.entries.set(key, { value, at: this.now() });
        }
        return value;
      },
      (error: unknown) => {
        if (generation === this.gen) this.inFlight.delete(key);
        throw error;
      },
    );
    this.inFlight.set(key, p);
    return p;
  }

  /** Stores a value read elsewhere. */
  put(key: string, value: unknown): void {
    this.entries.set(key, { value, at: this.now() });
  }
}

/** The hub reads an order makes; the cached reader keeps exactly this shape. */
export interface CacheableHubReads {
  getLatestHeight(): Promise<bigint>;
  getBuilderSetAtHeight(height: bigint): Promise<BuilderSetSnapshot>;
  getParameterBucket(kind: typeof BUCKET_KIND[keyof typeof BUCKET_KIND], bucketKey?: string): Promise<ParameterBucketView>;
  getTaskGenerationLimits(): Promise<TaskGenerationLimits>;
  getServiceDescriptor(operatorAddress: string, participantType?: string): Promise<ServiceDescriptorRef>;
  getBusinessDenom?(): Promise<string>;
  getProfile?(modelId: string, profileVersion: bigint): Promise<ProfileInfo>;
}

const BUILDER_SET_KEY = 'builderSet';

interface CachedBuilderSet {
  readonly snapshot: BuilderSetSnapshot;
  /** The height it was read at: the set is known to be in effect from its effectiveHeight up to here. */
  readonly readHeight: bigint;
}

/**
 * The order reads of `hub`, bound to it, with the static ones served from `cache` when one is
 * given (without it every call reads `hub`). getLatestHeight is never cached.
 *
 * The BuilderSet is kept as the one read at the highest height so far: a request for a height
 * at or after its effective height is answered from it while it is younger than the TTL. Up to
 * the height it was read at this is exact; after it, a replacement taking effect in between is
 * only noticed when the entry expires or the cache is invalidated (the Builder refuses such an
 * order with NEXUS_INGRESS_BUILDER_SET_STALE, and openTask then invalidates and retries once).
 *
 * A fresh BuilderSet or timeout bucket read that differs from the value it replaces is a
 * BuilderSet replacement or a params change: every other cached entry is dropped as well. As
 * with every entry, a BuilderSet read still in flight when the cache is invalidated is returned
 * but not stored.
 */
export function hubOrderReads(hub: CacheableHubReads, cache?: ChainReadCache): CacheableHubReads {
  if (cache === undefined) {
    const { getBusinessDenom, getProfile } = hub;
    return {
      getLatestHeight: () => hub.getLatestHeight(),
      getBuilderSetAtHeight: (height) => hub.getBuilderSetAtHeight(height),
      getParameterBucket: (kind, bucketKey) => (bucketKey === undefined ? hub.getParameterBucket(kind) : hub.getParameterBucket(kind, bucketKey)),
      getTaskGenerationLimits: () => hub.getTaskGenerationLimits(),
      getServiceDescriptor: (operatorAddress, participantType) =>
        participantType === undefined ? hub.getServiceDescriptor(operatorAddress) : hub.getServiceDescriptor(operatorAddress, participantType),
      ...(getBusinessDenom !== undefined ? { getBusinessDenom: () => getBusinessDenom.call(hub) } : {}),
      ...(getProfile !== undefined ? { getProfile: (modelId: string, version: bigint) => getProfile.call(hub, modelId, version) } : {}),
    };
  }
  const dropOthersOnChange =
    <T>(same: (a: T, b: T) => boolean) =>
    (fresh: T, previous: T | undefined): void => {
      if (previous !== undefined && !same(fresh, previous)) cache.invalidate();
    };
  const getBusinessDenom = hub.getBusinessDenom;
  const getProfile = hub.getProfile;
  return {
    getLatestHeight: () => hub.getLatestHeight(),
    getBuilderSetAtHeight: async (height) => {
      const cached = cache.peek<CachedBuilderSet>(BUILDER_SET_KEY);
      if (cached !== undefined && height >= cached.snapshot.effectiveHeight) return cached.snapshot;
      const generation = cache.generation;
      const snapshot = await hub.getBuilderSetAtHeight(height);
      if (generation !== cache.generation) return snapshot;
      const last = cache.last<CachedBuilderSet>(BUILDER_SET_KEY);
      const later = last === undefined || height >= last.readHeight;
      if (later && last !== undefined && last.snapshot.setHash !== snapshot.setHash) cache.invalidate();
      // An older set (read for an earlier height) does not replace a fresh later one.
      if (later || cache.peek(BUILDER_SET_KEY) === undefined) {
        cache.put(BUILDER_SET_KEY, { snapshot, readHeight: height } satisfies CachedBuilderSet);
      }
      return snapshot;
    },
    getParameterBucket: (kind, bucketKey) =>
      cache.memo(
        `bucket:${String(kind)}:${bucketKey ?? ''}`,
        () => (bucketKey === undefined ? hub.getParameterBucket(kind) : hub.getParameterBucket(kind, bucketKey)),
        dropOthersOnChange<ParameterBucketView>((a, b) => a.currentVersion === b.currentVersion),
      ),
    getTaskGenerationLimits: () => cache.memo('generationLimits', () => hub.getTaskGenerationLimits()),
    getServiceDescriptor: (operatorAddress, participantType) =>
      cache.memo(`descriptor:${participantType ?? ''}:${operatorAddress}`, () =>
        participantType === undefined ? hub.getServiceDescriptor(operatorAddress) : hub.getServiceDescriptor(operatorAddress, participantType),
      ),
    ...(getBusinessDenom !== undefined ? { getBusinessDenom: () => cache.memo('businessDenom', () => getBusinessDenom.call(hub)) } : {}),
    ...(getProfile !== undefined
      ? { getProfile: (modelId: string, version: bigint) => cache.memo(`profile:${modelId}:${version}`, () => getProfile.call(hub, modelId, version)) }
      : {}),
  };
}
