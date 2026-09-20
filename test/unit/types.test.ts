import { describe, it, expect } from 'vitest';
import type { TaskState, TaskPhase, TaskVerdict } from '../../src/types/task';
import type { OutputRef, RawChunk } from '../../src/types/dataplane';
import type { OptimisticFinalityStatus } from '../../src/types/challenge';

describe('types compile & shape', () => {
  it('TaskState/Phase/Verdict values are assignable', () => {
    const s: TaskState = 'VERIFYING';
    const p: TaskPhase = 'SAMPLE_READY';
    const v: TaskVerdict = 'PASS';
    const f: OptimisticFinalityStatus = 'CHALLENGED';
    expect([s, p, v, f]).toEqual(['VERIFYING', 'SAMPLE_READY', 'PASS', 'CHALLENGED']);
  });
  it('OutputRef / RawChunk shapes are constructible', () => {
    const chunk: RawChunk = {
      chunkIndex: 0n,
      prevChunkHash: new Uint8Array(),
      chunkDigest: new Uint8Array([1]),
      bytes: new Uint8Array([1]),
    };
    const ref: OutputRef = {
      taskId: 't1',
      sessionId: 's1',
      outputHash: new Uint8Array([9]),
      canonicalOutputPackageHash: new Uint8Array([8]),
      outputCid: 'cid',
    };
    expect(chunk.chunkIndex).toBe(0n);
    expect(ref.taskId).toBe('t1');
  });
});
