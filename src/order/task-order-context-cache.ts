import { BUCKET_KIND } from '../types/hub';
import { TrueOpenError } from '../errors/errors';
import { assembleTaskOrderContext, resolveTaskOrderContextWithBuilderSet } from './task-order-input';
import type { ResolvedTaskOrderContext, TaskOrderContextReader } from './task-order-input';

/** What TaskOrderContextCache reads: the order context reads plus the anchor freshness window. */
export type TaskOrderContextCacheReader = TaskOrderContextReader & {
  /**
   * Task params `session.anchor_freshness_window_blocks` (HubReader provides it). Without it
   * the cache never reuses an anchor: every resolve is a fresh resolveTaskOrderContext.
   */
  getAnchorFreshnessWindowBlocks?(): Promise<bigint>;
};

export interface TaskOrderContextCacheOptions {
  /**
   * Reuse an anchor while it is at most this fraction of the chain's anchor freshness window
   * old (default DEFAULT_ANCHOR_REUSE_FRACTION). Must be in (0, 1).
   */
  readonly maxAnchorAgeFraction?: number;
  /** Anchor lag behind the latest height for a fresh anchor (resolveTaskOrderContext's anchorLag). */
  readonly anchorLag?: bigint;
}

/**
 * Default share of anchor_freshness_window_blocks an anchor may age before it is replaced:
 * one quarter, which leaves three quarters of the window for the order to reach the chain.
 */
export const DEFAULT_ANCHOR_REUSE_FRACTION = 0.25;

interface CachedAnchor {
  readonly height: bigint;
  readonly blockHash: string;
  readonly builderSetHash: string;
}

/**
 * Resolves order contexts, reusing the session anchor across orders while the chain still
 * accepts it.
 *
 * A fresh context costs two sequential round trips: the latest height, then the BuilderSet
 * and beacon at `latest - anchorLag`. Only the anchor itself (height and beacon block hash,
 * both immutable once written) is kept. On reuse, everything that depends on the current
 * chain is read again, all in one concurrent round: the latest height, the BuilderSet at the
 * anchor height, the current timeout bucket version, the generation limits and the freshness
 * window. The anchor is reused only when
 *
 *  - `latest - anchor <= floor(anchor_freshness_window_blocks * maxAnchorAgeFraction)`: the
 *    chain refuses an anchor more than the window below the admitting height, and the margin
 *    covers the time until the order lands;
 *  - the BuilderSet at the anchor height still reads back with its members (the chain needs
 *    that set ACTIVE; a pruned body has no members and the read fails) and took effect at or
 *    before the anchor.
 *
 * Otherwise, or when any of those reads fails, a fresh anchor is resolved. After a reuse the
 * cache also checks, in the background, whether the BuilderSet in effect at the latest height
 * has moved on; if it has, the next order gets a fresh anchor so new orders follow the new set
 * (an order on the older set is still valid while that set is ACTIVE).
 */
export class TaskOrderContextCache {
  private readonly fraction: number;
  private anchor: CachedAnchor | undefined;

  constructor(
    private readonly hub: TaskOrderContextCacheReader,
    private readonly chainId: string,
    private readonly opts: TaskOrderContextCacheOptions = {},
  ) {
    const f = opts.maxAnchorAgeFraction ?? DEFAULT_ANCHOR_REUSE_FRACTION;
    if (!Number.isFinite(f) || f <= 0 || f >= 1) {
      throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_ANCHOR_REUSE_INVALID', 'maxAnchorAgeFraction must be in (0, 1)');
    }
    this.fraction = f;
  }

  /** A context for a new order, with the BuilderSet it was checked against. */
  async resolve(): Promise<ResolvedTaskOrderContext> {
    const reused = await this.tryReuse();
    if (reused !== undefined) return reused;
    const readWindow = this.hub.getAnchorFreshnessWindowBlocks;
    const [fresh, window] = await Promise.all([
      resolveTaskOrderContextWithBuilderSet(
        this.hub,
        this.chainId,
        this.opts.anchorLag !== undefined ? { anchorLag: this.opts.anchorLag } : undefined,
      ),
      // Unknown window -> no reuse; a failed read only costs the reuse, not the order.
      readWindow !== undefined ? readWindow.call(this.hub).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    this.anchor =
      window !== undefined && window > 0n
        ? {
            height: fresh.context.sessionAnchorHeight,
            blockHash: fresh.context.sessionAnchorBlockHash,
            builderSetHash: fresh.context.builderSetHash,
          }
        : undefined;
    return fresh;
  }

  /** Forgets the anchor, so the next resolve reads a fresh one. */
  invalidate(): void {
    this.anchor = undefined;
  }

  private async tryReuse(): Promise<ResolvedTaskOrderContext | undefined> {
    const anchor = this.anchor;
    const readWindow = this.hub.getAnchorFreshnessWindowBlocks;
    if (anchor === undefined || readWindow === undefined) return undefined;
    try {
      const [latest, set, timeout, limits, window] = await Promise.all([
        this.hub.getLatestHeight(),
        this.hub.getBuilderSetAtHeight(anchor.height),
        this.hub.getParameterBucket(BUCKET_KIND.TIMEOUT),
        this.hub.getTaskGenerationLimits(),
        readWindow.call(this.hub),
      ]);
      const maxAge = BigInt(Math.floor(Number(window) * this.fraction));
      if (latest <= anchor.height || latest - anchor.height > maxAge || set.setHash !== anchor.builderSetHash) {
        this.invalidateIf(anchor);
        return undefined;
      }
      const resolved = assembleTaskOrderContext(this.chainId, anchor, set, timeout, limits, latest);
      this.watchBuilderSet(anchor, latest);
      return resolved;
    } catch {
      this.invalidateIf(anchor);
      return undefined;
    }
  }

  /** Drops the anchor at the next order once the set in effect at `latest` is a different one. */
  private watchBuilderSet(anchor: CachedAnchor, latest: bigint): void {
    void this.hub.getBuilderSetAtHeight(latest).then(
      (current) => {
        if (current.setHash !== anchor.builderSetHash) this.invalidateIf(anchor);
      },
      () => undefined,
    );
  }

  private invalidateIf(anchor: CachedAnchor): void {
    if (this.anchor === anchor) this.anchor = undefined;
  }
}
