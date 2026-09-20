import { sha256 } from './hash';
import { uint32BE, uint64BE } from './domain-hash';
import { concatBytes } from '../util/bytes';
import { TrueOpenError } from '../errors/errors';

/**
 * MMR_ROOT_V1 (monorepo Canonical Encoding and Domain Hashing, section 9).
 *
 * Commits to an append-only ordered list of byte strings, and lets any prefix's root be
 * recomputed from the final root -- MERKLE_ROOT_V1 cannot do this, because a prefix
 * tree's shape is not a substructure of the final tree's shape. The only current
 * consumer is the streaming output's output_hash (04-Task/05-Verification Algorithm section 8.1).
 *
 * This is not the same **framing** as canonicalFrameBytes in codec/domain-hash.ts: here
 * the domain length is a u32, the leaf length is a u64, and none of the three framing
 * constants themselves carry a length prefix. Do not mix the two framings. The integer
 * encoders (uint32BE / uint64BE) are generic pure functions and are reused as-is.
 */

const enc = new TextEncoder();

const LEAF_TAG = enc.encode('TRUEOPEN_MMR_LEAF_V1');
const NODE_TAG = enc.encode('TRUEOPEN_MMR_NODE_V1');
const EMPTY_TAG = enc.encode('TRUEOPEN_MMR_EMPTY_V1');

/** Domain is capped at 128 bytes (§4.2), matching the framing constant used by MERKLE_ROOT_V1. */
const DOMAIN_MAX_BYTES = 128;

/** uint64 upper bound. */
const U64_MAX = 2n ** 64n - 1n;

/**
 * Range-check before writing a u64 field.
 *
 * uint64BE reduces byte-by-byte modulo 2^64, so an out-of-range value gets **silently
 * truncated**: index = 2^64 and index = 0 produce exactly the same 8 bytes, which would
 * conjure a hash collision surface out of thin air in a protocol primitive. This throws
 * instead. Same stance as transport/rest-chain-reader.ts takes on unsafe integers: never
 * truncate silently.
 */
function u64Field(value: bigint, what: string): Uint8Array {
  if (value < 0n || value > U64_MAX) throw malformed(`${what} out of uint64 range: ${value}`);
  return uint64BE(value);
}

function malformed(what: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'MMR_MALFORMED', `MMR_ROOT_V1: ${what}`);
}

function domainBytes(domain: string): Uint8Array {
  const bytes = enc.encode(domain);
  if (bytes.length === 0 || bytes.length > DOMAIN_MAX_BYTES) throw malformed(`domain length ${bytes.length}`);
  return bytes;
}

/** Leaf hash. index is part of the preimage, so the same content at a different position is a different leaf. */
export function mmrLeaf(domain: string, index: bigint, leafBytes: Uint8Array): Uint8Array {
  const d = domainBytes(domain);
  return sha256(
    concatBytes(LEAF_TAG, uint32BE(d.length), d, u64Field(index, 'index'), u64Field(BigInt(leafBytes.length), 'leaf length'), leafBytes),
  );
}

/** Internal node hash. Left and right are both 32 bytes, concatenated as-is with no length prefix, so the operation is not commutative. */
export function mmrNode(domain: string, left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length !== 32 || right.length !== 32) throw malformed('node children must be 32 bytes');
  const d = domainBytes(domain);
  return sha256(concatBytes(NODE_TAG, uint32BE(d.length), d, left, right));
}

/** Root of an empty list. The application protocol may separately exclude the empty list from valid values. */
export function mmrEmpty(domain: string): Uint8Array {
  const d = domainBytes(domain);
  return sha256(concatBytes(EMPTY_TAG, uint32BE(d.length), d));
}

/** A peak: height + hash. Height 0 is a leaf. */
interface Peak {
  readonly height: number;
  readonly hash: Uint8Array;
}

export interface MmrPeakCheckpoint {
  readonly height: number;
  readonly hash: Uint8Array;
}

/**
 * Persistable incremental MMR state.
 *
 * This is a locally trusted checkpoint held by the caller, not protocol evidence; the next
 * frame received after restoring still has to pass Worker signature and cumulative-root
 * verification. All bytes are copied on import/export so external mutation cannot corrupt state.
 */
export interface MmrAccumulatorCheckpoint {
  readonly schemaVersion: 1;
  readonly domain: string;
  readonly leafCount: bigint;
  readonly peaks: readonly MmrPeakCheckpoint[];
}

/**
 * Append one leaf and merge peaks according to the rule, returning the new peak list (§9, item 2).
 *
 * The merge condition looks only at **whether the last two peaks have equal height**, which
 * uniquely determines the peak shape: each set bit in the binary representation of the leaf
 * count n corresponds to one peak, most significant bit on the left. Switching to any
 * "seemingly equivalent" shape (e.g. padding out to a complete tree, or merging a small peak
 * into a bigger one early) would make output_hash diverge across language implementations,
 * and the divergence would only surface for specific values of n -- so no discretionary
 * choices are made here.
 */
function pushLeaf(domain: string, peaks: Peak[], hash: Uint8Array): Peak[] {
  const next = [...peaks, { height: 0, hash }];
  for (;;) {
    const n = next.length;
    if (n < 2) return next;
    const right = next[n - 1]!;
    const left = next[n - 2]!;
    if (left.height !== right.height) return next;
    next.splice(n - 2, 2, { height: left.height + 1, hash: mmrNode(domain, left.hash, right.hash) });
  }
}

/**
 * Fold the peak list down into a root (§9, item 4): the direction is fixed as
 * **right to left**.
 *
 * acc starts as the rightmost peak; every other peak is folded right-to-left as
 * acc = MmrNodeV1(domain, peak, acc) -- the peak is always on the left, the accumulator
 * on the right. MmrNodeV1 is not commutative, so folding left-to-right instead would
 * produce a completely different root. With a single peak, that peak is returned directly
 * with no extra node wrapping it (this is the case for n=1, n=2, n=4, and other powers of two).
 */
function foldPeaks(domain: string, peaks: Peak[]): Uint8Array {
  if (peaks.length === 0) throw malformed('cannot fold empty peak list');
  let acc = peaks[peaks.length - 1]!.hash;
  for (let i = peaks.length - 2; i >= 0; i--) acc = mmrNode(domain, peaks[i]!.hash, acc);
  return acc;
}

/** MMR root over all leaves. An empty list returns MmrEmptyV1 (the application protocol may separately forbid an empty list). */
export function mmrRoot(domain: string, leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return mmrEmpty(domain);
  let peaks: Peak[] = [];
  for (let i = 0; i < leaves.length; i++) peaks = pushLeaf(domain, peaks, mmrLeaf(domain, BigInt(i), leaves[i]!));
  return foldPeaks(domain, peaks);
}

/**
 * Root over the first k leaves (§9, item 6). k=0 gives the empty-tree root.
 *
 * An out-of-range k throws directly instead of letting slice clamp it silently:
 * `leaves.slice(0, 99)` would silently return all leaves, so "give me the root of the
 * first 99 leaves" and "give me the root of all 3 leaves" would produce the same value,
 * hiding the caller's out-of-range bug inside a hash that looks perfectly valid.
 */
export function mmrPrefixRoot(domain: string, leaves: readonly Uint8Array[], k: number): Uint8Array {
  if (!Number.isInteger(k) || k < 0 || k > leaves.length) {
    throw malformed(`prefix length ${k} out of range 0..${leaves.length}`);
  }
  return mmrRoot(domain, leaves.slice(0, k));
}

/**
 * Incremental accumulator: while streaming frames in, each frame only does O(log n)
 * merges instead of recomputing every leaf.
 *
 * Used for ADR-0017's verify-as-you-receive flow: the mmr_root carried in each frame is
 * the **prefix root after appending this leaf**, so on receiving frame k it's enough to
 * compare append's return value against the root in the frame. Rerunning mmrRoot on every
 * frame is O(n), making the whole stream O(n^2); keeping only the peak list here amortizes
 * to O(log n) per frame.
 *
 * Correctness relies on "the incrementally maintained peak list == the peak list built in
 * one shot": pushLeaf's merge only looks at the height of the last two peaks, independent
 * of how the list got there, so the two are necessarily identical. That's also why this
 * **must** reuse pushLeaf / foldPeaks rather than a separate merge implementation --
 * two diverging implementations would only surface for specific values of n.
 */
export class MmrAccumulator {
  private peaks: Peak[] = [];
  private count = 0n;

  constructor(private readonly domain: string, checkpoint?: MmrAccumulatorCheckpoint) {
    domainBytes(domain); // validate up front instead of blowing up on the first frame
    if (checkpoint !== undefined) this.restore(checkpoint);
  }

  get leafCount(): bigint {
    return this.count;
  }

  /** Append one leaf, returning the prefix root after the append. */
  append(leafBytes: Uint8Array): Uint8Array {
    this.peaks = pushLeaf(this.domain, this.peaks, mmrLeaf(this.domain, this.count, leafBytes));
    this.count += 1n;
    return foldPeaks(this.domain, this.peaks);
  }

  /** Current prefix root; the empty-tree root if no leaf has been appended yet. */
  root(): Uint8Array {
    return this.peaks.length === 0 ? mmrEmpty(this.domain) : foldPeaks(this.domain, this.peaks);
  }

  /** Defensive copy of the current state, usable for switching endpoints in-process or restoring after persistence. */
  checkpoint(): MmrAccumulatorCheckpoint {
    return {
      schemaVersion: 1,
      domain: this.domain,
      leafCount: this.count,
      peaks: this.peaks.map((p) => ({ height: p.height, hash: Uint8Array.from(p.hash) })),
    };
  }

  /** O(log n) clone; if a frame-by-frame dry run fails, the original accumulator is left completely unchanged. */
  clone(): MmrAccumulator {
    return new MmrAccumulator(this.domain, this.checkpoint());
  }

  private restore(checkpoint: MmrAccumulatorCheckpoint): void {
    if (checkpoint.schemaVersion !== 1) throw malformed(`unsupported checkpoint schema ${checkpoint.schemaVersion}`);
    if (checkpoint.domain !== this.domain) {
      throw malformed(`checkpoint domain ${checkpoint.domain} does not match ${this.domain}`);
    }
    if (checkpoint.leafCount < 0n || checkpoint.leafCount > U64_MAX) {
      throw malformed(`checkpoint leaf_count out of uint64 range: ${checkpoint.leafCount}`);
    }

    const expectedHeights: number[] = [];
    let remaining = checkpoint.leafCount;
    let height = 0;
    while (remaining > 0n) {
      if ((remaining & 1n) === 1n) expectedHeights.unshift(height);
      remaining >>= 1n;
      height += 1;
    }
    if (checkpoint.peaks.length !== expectedHeights.length) {
      throw malformed(`checkpoint has ${checkpoint.peaks.length} peaks; leaf_count ${checkpoint.leafCount} requires ${expectedHeights.length}`);
    }

    this.peaks = checkpoint.peaks.map((peak, i) => {
      const expected = expectedHeights[i]!;
      if (!Number.isInteger(peak.height) || peak.height !== expected) {
        throw malformed(`checkpoint peak ${i} height ${peak.height}; expected ${expected}`);
      }
      if (peak.hash.length !== 32) throw malformed(`checkpoint peak ${i} hash must be 32 bytes`);
      return { height: peak.height, hash: Uint8Array.from(peak.hash) };
    });
    this.count = checkpoint.leafCount;
  }
}
