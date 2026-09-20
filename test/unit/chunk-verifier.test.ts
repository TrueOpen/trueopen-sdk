import { describe, it, expect } from 'vitest';
import { ChunkVerifier } from '../../src/output/chunk-verifier';
import { sha256 } from '../../src/codec/hash';
import { concatBytes } from '../../src/util/bytes';
import type { RawChunk, OutputRef } from '../../src/types/dataplane';
import { TrueOpenError } from '../../src/errors/errors';

function mkChunk(index: bigint, prev: Uint8Array, bytes: Uint8Array): RawChunk {
  return { chunkIndex: index, prevChunkHash: prev, chunkDigest: sha256(bytes), bytes };
}

describe('ChunkVerifier', () => {
  const b0 = new Uint8Array([1, 2, 3]);
  const b1 = new Uint8Array([4, 5]);
  const c0 = mkChunk(0n, new Uint8Array(), b0);
  const c1 = mkChunk(1n, c0.chunkDigest, b1);

  it('passes when order, continuity, and digest are all correct', () => {
    const v = new ChunkVerifier();
    expect(v.verify(c0).verified).toBe(true);
    expect(v.verify(c1).verified).toBe(true);
  });

  it('an out-of-order index triggers DATA_CHUNK_OUT_OF_ORDER', () => {
    const v = new ChunkVerifier();
    expect(() => v.verify(c1)).toThrowError(TrueOpenError);
    try {
      new ChunkVerifier().verify(c1);
    } catch (e) {
      expect((e as TrueOpenError).code).toBe('DATA_CHUNK_OUT_OF_ORDER');
    }
  });

  it('a broken prevChunkHash link triggers DATA_CHUNK_CHAIN_BROKEN', () => {
    const v = new ChunkVerifier();
    v.verify(c0);
    const bad = mkChunk(1n, new Uint8Array([9, 9]), b1);
    try {
      v.verify(bad);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as TrueOpenError).code).toBe('DATA_CHUNK_CHAIN_BROKEN');
    }
  });

  it('chunkDigest not matching bytes triggers DATA_CHUNK_DIGEST_MISMATCH', () => {
    const v = new ChunkVerifier();
    const bad: RawChunk = { chunkIndex: 0n, prevChunkHash: new Uint8Array(), chunkDigest: new Uint8Array([0]), bytes: b0 };
    try {
      v.verify(bad);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as TrueOpenError).code).toBe('DATA_CHUNK_DIGEST_MISMATCH');
    }
  });

  it('finalize: passes when the hash of the concatenated bytes equals outputHash, throws otherwise', () => {
    const v = new ChunkVerifier();
    v.verify(c0);
    v.verify(c1);
    const assembled = concatBytes(b0, b1);
    const ref: OutputRef = {
      taskId: 't', sessionId: 's', outputCid: 'cid',
      outputHash: sha256(assembled),
      canonicalOutputPackageHash: new Uint8Array([0]),
    };
    expect(() => v.finalize(assembled, ref)).not.toThrow();

    const badRef: OutputRef = { ...ref, outputHash: new Uint8Array([1, 2]) };
    try {
      v.finalize(assembled, badRef);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as TrueOpenError).code).toBe('DATA_OUTPUT_HASH_MISMATCH');
    }
  });

  it('boundary(): exposes the resume boundary', () => {
    const v = new ChunkVerifier();
    v.verify(c0);
    const bd = v.boundary();
    expect(bd.nextIndex).toBe(1n);
    expect(bd.prevChunkHash).toEqual(c0.chunkDigest);
  });
});
