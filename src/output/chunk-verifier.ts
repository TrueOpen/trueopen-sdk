import { sha256 } from '../codec/hash';
import { bytesEqual } from '../util/bytes';
import { dataError } from '../errors/errors';
import type { RawChunk, VerifiedChunk, ChunkBoundary, OutputRef } from '../types/dataplane';

const EMPTY = new Uint8Array();

/**
 * Verifies continuity and the commitment chunk by chunk (Implementation Design §5.7).
 * - chunkIndex increases monotonically by 1 starting from 0;
 * - prevChunkHash must equal the previous chunk's chunkDigest (empty for the first chunk);
 * - chunkDigest must equal sha256(bytes).
 * finalize compares the concatenated canonical output bytes against the outputHash commitment (§5.1).
 */
export class ChunkVerifier {
  private nextIndex = 0n;
  private prevHash: Uint8Array = EMPTY;

  verify(chunk: RawChunk): VerifiedChunk {
    if (chunk.chunkIndex !== this.nextIndex) {
      throw dataError('DATA_CHUNK_OUT_OF_ORDER', `expected index ${this.nextIndex}, got ${chunk.chunkIndex}`);
    }
    if (!bytesEqual(chunk.prevChunkHash, this.prevHash)) {
      throw dataError('DATA_CHUNK_CHAIN_BROKEN', `prevChunkHash mismatch at index ${chunk.chunkIndex}`);
    }
    if (!bytesEqual(sha256(chunk.bytes), chunk.chunkDigest)) {
      throw dataError('DATA_CHUNK_DIGEST_MISMATCH', `chunkDigest mismatch at index ${chunk.chunkIndex}`);
    }
    this.prevHash = chunk.chunkDigest;
    this.nextIndex += 1n;
    return { ...chunk, verified: true };
  }

  /** Verifies the final output commitment once everything has been received (§5.1: output_hash == hash of the canonical output bytes). */
  finalize(assembled: Uint8Array, ref: OutputRef): void {
    if (!bytesEqual(sha256(assembled), ref.outputHash)) {
      throw dataError('DATA_OUTPUT_HASH_MISMATCH', `assembled output hash != ref.outputHash for task ${ref.taskId}`);
    }
  }

  /** Exposes the resume boundary (crash recovery / RangeGet continues from here, §5.4). */
  boundary(): ChunkBoundary {
    return { nextIndex: this.nextIndex, prevChunkHash: this.prevHash };
  }
}
