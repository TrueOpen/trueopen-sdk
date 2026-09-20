import { mmrPrefixRoot, mmrRoot, MmrAccumulator } from '../codec/mmr';
import type { MmrAccumulatorCheckpoint } from '../codec/mmr';
import { canonicalHashBytes, uint32BE, uint64BE } from '../codec/domain-hash';
import { verifySecp256k1Digest } from '../signer/secp256k1';
import { TrueOpenError } from '../errors/errors';
import { bytesEqual, concatBytes, toHex } from '../util/bytes';

/**
 * Commitment and frame verification for streamed output (ADR-0017 / 04-Task/05-Verification
 * Algorithm §8.1).
 *
 * The protocol object for output is an **ordered list of text chunks** emitted by the Worker,
 * one chunk per leaf, and output_hash is the MMR root over those leaves. Non-streaming isn't a
 * special case -- it's the same object with a chunk list of length 1, and the root is just that
 * leaf's hash; the protocol doesn't distinguish modes or carry a mode flag, so the SDK takes the
 * same reconstruction path in both cases, and there is no streaming/non-streaming branch here.
 */

/** Domain for the output MMR. */
export const OUTPUT_MMR_DOMAIN = 'TRUEOPEN_OUTPUT_MMR_V1';

function malformed(what: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'OUTPUT_COMMITMENT_MALFORMED', `output commitment: ${what}`);
}

/**
 * Computes output_hash from the chunk list.
 *
 * n >= 1: an empty output is a single zero-length leaf, not an empty tree -- MmrEmptyV1 is
 * not a valid value for output_hash, so n=0 is rejected outright here rather than falling
 * back to the empty-tree root. If it silently fell back, "the model produced an empty
 * string" and "there was no output at all" would get the same on-chain commitment and
 * become indistinguishable.
 */
export function outputHash(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 0) {
    throw malformed('output must have at least one chunk (empty output is one zero-length leaf)');
  }
  return mmrRoot(OUTPUT_MMR_DOMAIN, chunks);
}

/** Domain for per-frame signatures. Appears only on the data plane, never in the receipt. */
export const OUTPUT_CHUNK_DOMAIN = 'TRUEOPEN_OUTPUT_CHUNK_V1';

const enc = new TextEncoder();

export interface OutputChunkSigningFields {
  readonly chainId: string;
  /** Raw 32 bytes. */
  readonly taskHash: Uint8Array;
  /** This chunk's MMR index, contiguous from 0. */
  readonly seq: bigint;
  /** The prefix root root_{seq+1} after appending this leaf, raw 32 bytes. */
  readonly mmrRoot: Uint8Array;
}

/**
 * Frame signing digest: H_FIELDS_V1("TRUEOPEN_OUTPUT_CHUNK_V1", chain_id, task_hash, seq, mmr_root).
 *
 * Exactly 4 top-level fields, in a fixed order. What's signed is the **cumulative commitment**,
 * not the single frame's content -- holding the signature for frame k means holding the Worker's
 * commitment to the first k leaves as a whole, which is exactly the basis for prefix-contradiction
 * accountability (06 §6.3).
 *
 * Note that everything fed into the frame is raw bytes: task_hash / mmr_root are the raw 32
 * bytes, not hex text, and seq is a big-endian uint64 (8 bytes), not decimal text. Encoding
 * either as text would produce a different digest.
 */
export function outputChunkSigningDigest(f: OutputChunkSigningFields): Uint8Array {
  if (f.chainId === '') throw malformed('chain_id must not be empty');
  if (f.taskHash.length !== 32) throw malformed(`task_hash must be 32 bytes, got ${f.taskHash.length}`);
  if (f.mmrRoot.length !== 32) throw malformed(`mmr_root must be 32 bytes, got ${f.mmrRoot.length}`);
  if (f.seq < 0n) throw malformed('seq must be non-negative');
  return canonicalHashBytes(
    enc.encode(OUTPUT_CHUNK_DOMAIN),
    enc.encode(f.chainId),
    f.taskHash,
    uint64BE(f.seq),
    f.mmrRoot,
  );
}

/**
 * Verifies the Worker's signature over a frame.
 *
 * Same convention as the order's inner signature: **ECDSA is applied directly to the 32-byte
 * digest, with no extra hashing**, so this uses verifySecp256k1Digest rather than
 * verifyCosmosSecp256k1 (the latter would sha256 first and everything would fail to verify).
 * The signature is raw64 R‖S. The pubkey is the Worker's current on-chain service key, which
 * the caller looks up and passes in.
 *
 * A wrong length returns false directly instead of throwing: a failed signature check is an
 * expected business-logic branch (switch endpoints and re-subscribe), and callers shouldn't
 * have to use try/catch to tell "bad signature" apart from "bad arguments".
 */
export function verifyOutputChunkSignature(
  f: OutputChunkSigningFields,
  signature: Uint8Array,
  workerServicePubKey: Uint8Array,
): boolean {
  if (signature.length !== 64) return false;
  return verifySecp256k1Digest(outputChunkSigningDigest(f), signature, workerServicePubKey);
}

/** Domain for the terminal frame's signature (wire v0.4.3 / wire#35). Also data-plane only, never in the receipt. */
export const OUTPUT_FIN_DOMAIN = 'TRUEOPEN_OUTPUT_FIN_V1';

/**
 * The **only four accepted successful-termination values** in FinishReasonV1.
 *
 * This is a closed set: UNSPECIFIED(0), unknown enum values, failure, and cancellation never
 * produce a valid Fin, and must be rejected **before** the digest is computed -- otherwise
 * that would amount to accepting a termination reason the protocol doesn't recognize, and
 * verifying its signature afterward would be meaningless. The wire registry's comment on
 * TRUEOPEN_OUTPUT_FIN_V1 explicitly requires failing closed.
 */
export const ACCEPTED_FINISH_REASONS: readonly number[] = [1, 2, 3, 4];

/** Whether this value is a protocol-accepted successful termination reason. */
export function isAcceptedFinishReason(value: number): boolean {
  return Number.isInteger(value) && ACCEPTED_FINISH_REASONS.includes(value);
}

export interface OutputFinSigningFields {
  readonly chainId: string;
  /** Raw 32 bytes. */
  readonly taskHash: Uint8Array;
  /** The seq of the final leaf (= leafCount - 1). */
  readonly finalSeq: bigint;
  /** The final MMR root over all leaves, raw 32 bytes. */
  readonly outputMmrRoot: Uint8Array;
  /** FinishReasonV1's enum value; only 1..4 are accepted. */
  readonly finishReason: number;
}

/**
 * Terminal frame digest:
 * H_FIELDS_V1("TRUEOPEN_OUTPUT_FIN_V1", chain_id, task_hash, final_seq, output_mmr_root, finish_reason).
 *
 * Exactly 5 top-level fields, in a fixed order. The difference from the chunk digest is more
 * than just one extra field -- it binds the **final root** and the **termination reason**
 * into the same statement, which makes "streamed one thing but claims a different way of
 * ending" provable.
 *
 * What's fed into the frame is still raw bytes: task_hash / output_mmr_root are the raw 32
 * bytes, final_seq is a big-endian uint64, and finish_reason is the enum value as a
 * **big-endian uint32** (not the name text, and not a uint64). worker_signature itself is not
 * part of the preimage.
 */
export function outputFinSigningDigest(f: OutputFinSigningFields): Uint8Array {
  if (f.chainId === '') throw malformed('chain_id must not be empty');
  if (f.taskHash.length !== 32) throw malformed(`task_hash must be 32 bytes, got ${f.taskHash.length}`);
  if (f.outputMmrRoot.length !== 32) {
    throw malformed(`output_mmr_root must be 32 bytes, got ${f.outputMmrRoot.length}`);
  }
  if (f.finalSeq < 0n) throw malformed('final_seq must be non-negative');
  // Reject an invalid reason before computing the digest: see the note on ACCEPTED_FINISH_REASONS.
  if (!isAcceptedFinishReason(f.finishReason)) {
    throw malformed(
      `finish_reason ${f.finishReason} is not an accepted successful termination (allowed: ${ACCEPTED_FINISH_REASONS.join(', ')})`,
    );
  }
  return canonicalHashBytes(
    enc.encode(OUTPUT_FIN_DOMAIN),
    enc.encode(f.chainId),
    f.taskHash,
    uint64BE(f.finalSeq),
    f.outputMmrRoot,
    uint32BE(f.finishReason),
  );
}

/**
 * Verifies the Worker's signature over the terminal frame. Same convention as chunk: raw64
 * R‖S, ECDSA applied directly to the 32-byte digest (no extra hashing).
 *
 * An invalid finish_reason returns false here instead of letting the digest throw -- from the
 * caller's point of view, "reason is invalid" and "signature is wrong" both lead to the same
 * conclusion: this frame cannot be trusted and must not be accepted.
 */
export function verifyOutputFinSignature(
  f: OutputFinSigningFields,
  signature: Uint8Array,
  workerServicePubKey: Uint8Array,
): boolean {
  if (signature.length !== 64) return false;
  if (!isAcceptedFinishReason(f.finishReason)) return false;
  return verifySecp256k1Digest(outputFinSigningDigest(f), signature, workerServicePubKey);
}

export interface OutputFrame {
  readonly seq: bigint;
  /** The UTF-8 bytes of this segment's TEXT component, i.e. one leaf of the MMR. */
  readonly text: Uint8Array;
  /** The cumulative MMR root after appending this leaf. */
  readonly mmrRoot: Uint8Array;
  /** The Worker service key's raw64 signature. */
  readonly signature: Uint8Array;
}

export interface OutputStreamVerifierConfig {
  readonly chainId: string;
  readonly taskHash: Uint8Array;
  /** This Worker's current on-chain service key (33-byte compressed pubkey). */
  readonly workerServicePubKey: Uint8Array;
}

/**
 * A local recovery point for a verified stream.
 *
 * A checkpoint is bound to the chain, the task, and the Worker key, and cannot be reused
 * across tasks. `chunks` is used to verify and dedupe a seq=0 replay on the old Wire, and
 * also lets `text()` still return the full text after recovery. It should only ever be
 * obtained from `OutputStreamVerifier.checkpoint()`; the Worker's signature on the next frame
 * remains the trust anchor for the recovered state.
 */
export interface OutputStreamVerifierCheckpoint {
  readonly schemaVersion: 1;
  readonly chainId: string;
  readonly taskHash: Uint8Array;
  readonly workerServicePubKey: Uint8Array;
  readonly mmr: MmrAccumulatorCheckpoint;
  readonly chunks: readonly Uint8Array[];
}

export type OutputFrameAcceptance = 'accepted' | 'duplicate';

/**
 * Verifies and accumulates streamed output frame by frame (ADR-0017, SDK Detailed Design §5.2).
 *
 * A failed verification **never changes the accumulated state**: the caller can hand the full
 * checkpoint (not a bare seq) to another Task Builder to re-subscribe and continue from the
 * next frame -- the three parties (Worker / Builder / User) each maintain the same tree. If a
 * bad frame had already advanced the local tree, the local state would diverge from the
 * Worker's, every subsequent frame would fail verification, and there would be no way back.
 */
export class OutputStreamVerifier {
  private readonly cfg: OutputStreamVerifierConfig;
  private acc: MmrAccumulator;
  private readonly chunks: Uint8Array[];
  private lastRoot: Uint8Array | undefined;

  constructor(cfg: OutputStreamVerifierConfig, checkpoint?: OutputStreamVerifierCheckpoint) {
    if (cfg.taskHash.length !== 32) throw malformed(`task_hash must be 32 bytes, got ${cfg.taskHash.length}`);
    if (cfg.workerServicePubKey.length !== 33) {
      throw malformed(`worker_service_pubkey must be 33 bytes, got ${cfg.workerServicePubKey.length}`);
    }
    this.cfg = {
      chainId: cfg.chainId,
      taskHash: Uint8Array.from(cfg.taskHash),
      workerServicePubKey: Uint8Array.from(cfg.workerServicePubKey),
    };
    if (checkpoint === undefined) {
      this.acc = new MmrAccumulator(OUTPUT_MMR_DOMAIN);
      this.chunks = [];
      return;
    }

    this.assertCheckpointContext(checkpoint);
    this.acc = new MmrAccumulator(OUTPUT_MMR_DOMAIN, checkpoint.mmr);
    if (this.acc.leafCount !== BigInt(checkpoint.chunks.length)) {
      throw malformed(
        `checkpoint leaf_count ${this.acc.leafCount} does not match ${checkpoint.chunks.length} retained chunks`,
      );
    }
    this.chunks = checkpoint.chunks.map((chunk) => Uint8Array.from(chunk));
    if (this.acc.leafCount > 0n) this.lastRoot = this.acc.root();
  }

  get leafCount(): bigint {
    return this.acc.leafCount;
  }

  /**
   * The sequence number of the last successfully verified segment, used directly as
   * SubscribeOutput's resume_after_seq. It's -1n when no frame has been received yet: the
   * proto semantics are "only replay frames with seq greater than this value", and -1 is what
   * lets replay start from 0.
   */
  get resumeAfterSeq(): bigint {
    return this.acc.leafCount - 1n;
  }

  /**
   * Verifies and accepts a frame. Order: seq is contiguous -> leaf is recomputed and appended
   * -> root is compared -> signature is verified.
   *
   * Verification happens on a **copy** of the accumulator, and only lands on the real state
   * once everything passes. The root is computed before the signature is verified because the
   * signature covers exactly the root; if the root doesn't match, the signature necessarily
   * won't either, but reporting them separately makes it easier to pinpoint the problem.
   */
  accept(frame: OutputFrame): void {
    if (frame.seq !== this.acc.leafCount) {
      throw malformed(`seq must be ${this.acc.leafCount}, got ${frame.seq} (the first frame must be 0, incrementing by 1 thereafter)`);
    }
    const text = Uint8Array.from(frame.text);
    const candidate = this.acc.clone();
    const root = candidate.append(text);
    if (!bytesEqual(root, frame.mmrRoot)) {
      throw malformed(`frame ${frame.seq} mmr_root mismatch: computed ${toHex(root)}, frame carries ${toHex(frame.mmrRoot)}`);
    }
    const ok = verifyOutputChunkSignature(
      { chainId: this.cfg.chainId, taskHash: this.cfg.taskHash, seq: frame.seq, mmrRoot: frame.mmrRoot },
      frame.signature,
      this.cfg.workerServicePubKey,
    );
    if (!ok) throw malformed(`frame ${frame.seq} worker signature invalid`);

    this.acc = candidate;
    this.chunks.push(text);
    this.lastRoot = Uint8Array.from(root);
  }

  /**
   * Entry point for automatic re-subscription: a new frame advances normally, an already
   * verified frame is deduplicated only after being fully re-verified, and a skipped
   * sequence number still fails closed.
   *
   * The old Wire's bare uint64 can't distinguish absent from present(0), so re-subscribing
   * after seq=0 may receive frame 0 again. It can't just be silently dropped by sequence
   * number alone: a malicious Builder could smuggle in a conflicting frame that way, so a
   * duplicate frame's text, prefix root, and Worker signature must all be fully re-verified.
   */
  acceptOrDeduplicate(frame: OutputFrame): OutputFrameAcceptance {
    if (frame.seq === this.acc.leafCount) {
      this.accept(frame);
      return 'accepted';
    }
    if (frame.seq < 0n || frame.seq > this.acc.leafCount) {
      throw malformed(`seq must be <= ${this.acc.leafCount}, got ${frame.seq}`);
    }

    const index = Number(frame.seq);
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.chunks.length) {
      throw malformed(`duplicate seq ${frame.seq} is outside retained checkpoint`);
    }
    const expectedText = this.chunks[index]!;
    if (!bytesEqual(frame.text, expectedText)) throw malformed(`duplicate frame ${frame.seq} text mismatch`);
    const expectedRoot = mmrPrefixRoot(OUTPUT_MMR_DOMAIN, this.chunks, index + 1);
    if (!bytesEqual(frame.mmrRoot, expectedRoot)) {
      throw malformed(`duplicate frame ${frame.seq} mmr_root mismatch`);
    }
    const ok = verifyOutputChunkSignature(
      { chainId: this.cfg.chainId, taskHash: this.cfg.taskHash, seq: frame.seq, mmrRoot: frame.mmrRoot },
      frame.signature,
      this.cfg.workerServicePubKey,
    );
    if (!ok) throw malformed(`duplicate frame ${frame.seq} worker signature invalid`);
    return 'duplicate';
  }

  /** The current prefix root. Throws when no frame has been received yet -- an empty tree is not a valid output_hash. */
  root(): Uint8Array {
    if (this.lastRoot === undefined) throw malformed('no frame accepted yet');
    return this.lastRoot;
  }

  /** Concatenates the received chunk list into text. Becomes the official text once Fin arrives and matches the receipt. */
  text(): string {
    return new TextDecoder().decode(concatBytes(...this.chunks));
  }

  /** Compares against the on-chain receipt's output_hash; only a match may be converted to confirmed. */
  matchesReceipt(receiptOutputHash: Uint8Array): boolean {
    return this.lastRoot !== undefined && bytesEqual(this.lastRoot, receiptOutputHash);
  }

  /** Exports an immutable recovery point; every byte array in the return value is a defensive copy. */
  checkpoint(): OutputStreamVerifierCheckpoint {
    return {
      schemaVersion: 1,
      chainId: this.cfg.chainId,
      taskHash: Uint8Array.from(this.cfg.taskHash),
      workerServicePubKey: Uint8Array.from(this.cfg.workerServicePubKey),
      mmr: this.acc.checkpoint(),
      chunks: this.chunks.map((chunk) => Uint8Array.from(chunk)),
    };
  }

  private assertCheckpointContext(checkpoint: OutputStreamVerifierCheckpoint): void {
    if (checkpoint.schemaVersion !== 1) throw malformed(`unsupported checkpoint schema ${checkpoint.schemaVersion}`);
    if (checkpoint.chainId !== this.cfg.chainId) throw malformed('checkpoint chain_id mismatch');
    if (!bytesEqual(checkpoint.taskHash, this.cfg.taskHash)) throw malformed('checkpoint task_hash mismatch');
    if (!bytesEqual(checkpoint.workerServicePubKey, this.cfg.workerServicePubKey)) {
      throw malformed('checkpoint worker_service_pubkey mismatch');
    }
  }
}
