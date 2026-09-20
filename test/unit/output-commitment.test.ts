import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  outputHash,
  OUTPUT_MMR_DOMAIN,
  outputChunkSigningDigest,
  verifyOutputChunkSignature,
  OUTPUT_CHUNK_DOMAIN,
  OutputStreamVerifier,
} from '../../src/output/output-commitment';
import { mmrRoot, mmrEmpty, mmrPrefixRoot } from '../../src/codec/mmr';
import { canonicalHashBytes, uint64BE } from '../../src/codec/domain-hash';
import { privKeySecp256k1DigestSigner, secp256k1PublicKey } from '../../src/signer/secp256k1';
import { toHex, fromHex } from '../../src/util/bytes';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');

describe('output_hash', () => {
  it('the domain is TRUEOPEN_OUTPUT_MMR_V1, and the value equals the corresponding mmrRoot', () => {
    const chunks = [utf8('héllo'), utf8(', wörld')];
    expect(OUTPUT_MMR_DOMAIN).toBe('TRUEOPEN_OUTPUT_MMR_V1');
    expect(toHex(outputHash(chunks))).toBe(toHex(mmrRoot(OUTPUT_MMR_DOMAIN, chunks)));
  });

  it("non-streaming uses the same code path: a single chunk's root is just that leaf's hash", () => {
    const whole = utf8('füll öutput');
    expect(toHex(outputHash([whole]))).toBe(toHex(mmrRoot(OUTPUT_MMR_DOMAIN, [whole])));
  });

  it('an empty output is a single zero-length leaf, not an empty tree', () => {
    const empty = outputHash([new Uint8Array(0)]);
    expect(toHex(empty)).not.toBe(toHex(mmrEmpty(OUTPUT_MMR_DOMAIN)));
  });

  it('n=0 is rejected outright: MmrEmptyV1 is not a valid output_hash', () => {
    expect(() => outputHash([])).toThrow(/at least one chunk/);
  });

  it('different chunking with the same concatenated content -> different roots (the chunk list itself is part of the committed data)', () => {
    const a = [utf8('abcdef')];
    const b = [utf8('abc'), utf8('def')];
    expect(toHex(outputHash(a))).not.toBe(toHex(outputHash(b)));
  });
});

describe('frame signing', () => {
  const chainId = 'trueopen-localnet-1';
  const taskHash = new Uint8Array(32).fill(0x11);
  const mmr = new Uint8Array(32).fill(0x22);

  it('digest recomputed independently from the 4 H_FIELDS_V1 fields matches', () => {
    const expected = canonicalHashBytes(
      new TextEncoder().encode(OUTPUT_CHUNK_DOMAIN),
      new TextEncoder().encode(chainId),
      taskHash,
      uint64BE(5n),
      mmr,
    );
    expect(toHex(outputChunkSigningDigest({ chainId, taskHash, seq: 5n, mmrRoot: mmr }))).toBe(toHex(expected));
  });

  it('changing any one of the four fields changes the digest', () => {
    const base = { chainId, taskHash, seq: 5n, mmrRoot: mmr };
    const d = toHex(outputChunkSigningDigest(base));
    expect(toHex(outputChunkSigningDigest({ ...base, chainId: 'other' }))).not.toBe(d);
    expect(toHex(outputChunkSigningDigest({ ...base, taskHash: new Uint8Array(32).fill(0x12) }))).not.toBe(d);
    expect(toHex(outputChunkSigningDigest({ ...base, seq: 6n }))).not.toBe(d);
    expect(toHex(outputChunkSigningDigest({ ...base, mmrRoot: new Uint8Array(32).fill(0x23) }))).not.toBe(d);
  });

  it('a 64-byte signature made by signing the digest directly verifies; flipping one bit makes it fail', async () => {
    const sign = privKeySecp256k1DigestSigner(PRIV);
    const pub = secp256k1PublicKey(PRIV);
    const frame = { chainId, taskHash, seq: 0n, mmrRoot: mmr };
    const sig = (await sign(outputChunkSigningDigest(frame))).subarray(0, 64);
    expect(verifyOutputChunkSignature(frame, sig, pub)).toBe(true);
    const bad = Uint8Array.from(sig);
    // Under noUncheckedIndexedAccess, indexed reads come back as number | undefined, hence the ?? 0
    bad[0] = (bad[0] ?? 0) ^ 0x01;
    expect(verifyOutputChunkSignature(frame, bad, pub)).toBe(false);
  });

  it('a signature whose length is not 64 is rejected outright, without throwing', async () => {
    const sign = privKeySecp256k1DigestSigner(PRIV);
    const pub = secp256k1PublicKey(PRIV);
    const frame = { chainId, taskHash, seq: 0n, mmrRoot: mmr };
    const sig = await sign(outputChunkSigningDigest(frame));
    expect(verifyOutputChunkSignature(frame, sig.subarray(0, 63), pub)).toBe(false);
  });

  it('task_hash / mmr_root that are not 32 bytes throw an error', () => {
    expect(() =>
      outputChunkSigningDigest({ chainId, taskHash: new Uint8Array(31), seq: 0n, mmrRoot: mmr }),
    ).toThrow(/task_hash/);
    expect(() =>
      outputChunkSigningDigest({ chainId, taskHash, seq: 0n, mmrRoot: new Uint8Array(31) }),
    ).toThrow(/mmr_root/);
  });

  it('an empty chain_id or a negative seq throws an error', () => {
    expect(() => outputChunkSigningDigest({ chainId: '', taskHash, seq: 0n, mmrRoot: mmr })).toThrow(/chain_id/);
    expect(() => outputChunkSigningDigest({ chainId, taskHash, seq: -1n, mmrRoot: mmr })).toThrow(/seq/);
  });
});

describe('OutputStreamVerifier', () => {
  const chainId = 'trueopen-localnet-1';
  const taskHash = new Uint8Array(32).fill(0x11);
  const pub = secp256k1PublicKey(PRIV);
  const sign = privKeySecp256k1DigestSigner(PRIV);

  /** Build a frame: compute the correct mmr_root from the current accumulated state, then sign it. */
  async function frameFor(chunks: Uint8Array[], seq: number) {
    const mmrRoot = outputHash(chunks.slice(0, seq + 1));
    const sig = (await sign(outputChunkSigningDigest({ chainId, taskHash, seq: BigInt(seq), mmrRoot }))).subarray(0, 64);
    return { seq: BigInt(seq), text: chunks[seq]!, mmrRoot, signature: sig };
  }

  it('accepting frames in order all pass, and the final root equals outputHash(all chunks)', async () => {
    const chunks = [utf8('á'), utf8('é'), utf8('í')];
    const v = new OutputStreamVerifier({ chainId, taskHash, workerServicePubKey: pub });
    for (let i = 0; i < chunks.length; i++) v.accept(await frameFor(chunks, i));
    expect(v.leafCount).toBe(3n);
    expect(toHex(v.root())).toBe(toHex(outputHash(chunks)));
    expect(v.text()).toBe('áéí');
  });

  it('a skipped seq number is rejected (the first frame must be seq 0)', async () => {
    const chunks = [utf8('á'), utf8('é')];
    const v = new OutputStreamVerifier({ chainId, taskHash, workerServicePubKey: pub });
    expect(() => v.accept({ seq: 1n, text: chunks[1]!, mmrRoot: new Uint8Array(32), signature: new Uint8Array(64) }))
      .toThrow(/seq/);
  });

  it("a frame whose mmr_root does not match the locally recomputed value is rejected", async () => {
    const chunks = [utf8('á')];
    const v = new OutputStreamVerifier({ chainId, taskHash, workerServicePubKey: pub });
    const f = await frameFor(chunks, 0);
    expect(() => v.accept({ ...f, mmrRoot: new Uint8Array(32).fill(0x99) })).toThrow(/mmr_root/);
  });

  it('a frame with an invalid signature is rejected without changing the accumulated state (so streaming can resume via a different endpoint)', async () => {
    const chunks = [utf8('á'), utf8('é')];
    const v = new OutputStreamVerifier({ chainId, taskHash, workerServicePubKey: pub });
    v.accept(await frameFor(chunks, 0));
    const f1 = await frameFor(chunks, 1);
    const bad = Uint8Array.from(f1.signature);
    // Under noUncheckedIndexedAccess, indexed reads come back as number | undefined, hence the ?? 0
    bad[0] = (bad[0] ?? 0) ^ 0x01;
    expect(() => v.accept({ ...f1, signature: bad })).toThrow(/signature/);
    expect(v.leafCount).toBe(1n);
    expect(v.resumeAfterSeq).toBe(0n);
    v.accept(f1);
    expect(v.leafCount).toBe(2n);
    expect(v.text()).toBe('áé');
  });

  it('after a bad frame is rejected the local tree is not corrupted: later frames can still continue on to the correct final root', async () => {
    const chunks = [utf8('a'), utf8('b'), utf8('c')];
    const v = new OutputStreamVerifier({ chainId, taskHash, workerServicePubKey: pub });
    v.accept(await frameFor(chunks, 0));
    const f1 = await frameFor(chunks, 1);
    expect(() => v.accept({ ...f1, mmrRoot: new Uint8Array(32).fill(0x77) })).toThrow(/mmr_root/);
    v.accept(f1);
    v.accept(await frameFor(chunks, 2));
    expect(toHex(v.root())).toBe(toHex(outputHash(chunks)));
  });

  it("finish: only confirmed when it matches the receipt's output_hash", async () => {
    const chunks = [utf8('á'), utf8('é')];
    const v = new OutputStreamVerifier({ chainId, taskHash, workerServicePubKey: pub });
    for (let i = 0; i < 2; i++) v.accept(await frameFor(chunks, i));
    expect(v.matchesReceipt(outputHash(chunks))).toBe(true);
    expect(v.matchesReceipt(new Uint8Array(32).fill(0x77))).toBe(false);
  });

  it('when no frames have been received, root() throws and matchesReceipt returns false', () => {
    const v = new OutputStreamVerifier({ chainId, taskHash, workerServicePubKey: pub });
    expect(v.leafCount).toBe(0n);
    expect(v.resumeAfterSeq).toBe(-1n);
    expect(() => v.root()).toThrow(/no frame/);
    expect(v.matchesReceipt(new Uint8Array(32))).toBe(false);
  });

  it('constructing with a task_hash that is not 32 bytes throws immediately', () => {
    expect(() => new OutputStreamVerifier({ chainId, taskHash: new Uint8Array(31), workerServicePubKey: pub }))
      .toThrow(/task_hash/);
  });

  it('after restoring from a checkpoint, verification resumes from the next frame, preserving the full text and the final root', async () => {
    const chunks = [utf8('á'), utf8('é'), utf8('í')];
    const first = new OutputStreamVerifier({ chainId, taskHash, workerServicePubKey: pub });
    first.accept(await frameFor(chunks, 0));
    first.accept(await frameFor(chunks, 1));

    const restored = new OutputStreamVerifier(
      { chainId, taskHash, workerServicePubKey: pub },
      first.checkpoint(),
    );
    expect(restored.resumeAfterSeq).toBe(1n);
    restored.accept(await frameFor(chunks, 2));
    expect(restored.text()).toBe('áéí');
    expect(toHex(restored.root())).toBe(toHex(outputHash(chunks)));
  });

  it('when an old Wire client replays an already-verified frame, it is strictly re-verified and deduplicated, without advancing the state again', async () => {
    const chunks = [utf8('á'), utf8('é')];
    const verifier = new OutputStreamVerifier({ chainId, taskHash, workerServicePubKey: pub });
    const f0 = await frameFor(chunks, 0);
    verifier.accept(f0);
    expect(verifier.acceptOrDeduplicate(f0)).toBe('duplicate');
    expect(verifier.leafCount).toBe(1n);

    const changed = { ...f0, text: utf8('ø') };
    expect(() => verifier.acceptOrDeduplicate(changed)).toThrow(/duplicate.*text/);
    expect(verifier.leafCount).toBe(1n);
    expect(verifier.text()).toBe('á');
  });

  it('a checkpoint is rejected if the chain, task, or Worker key does not match', async () => {
    const chunks = [utf8('á')];
    const verifier = new OutputStreamVerifier({ chainId, taskHash, workerServicePubKey: pub });
    verifier.accept(await frameFor(chunks, 0));
    const checkpoint = verifier.checkpoint();

    expect(() => new OutputStreamVerifier(
      { chainId: 'other', taskHash, workerServicePubKey: pub }, checkpoint,
    )).toThrow(/chain_id/);
    expect(() => new OutputStreamVerifier(
      { chainId, taskHash: new Uint8Array(32).fill(0x12), workerServicePubKey: pub }, checkpoint,
    )).toThrow(/task_hash/);
    expect(() => new OutputStreamVerifier(
      { chainId, taskHash, workerServicePubKey: secp256k1PublicKey(fromHex('0202030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20')) },
      checkpoint,
    )).toThrow(/worker_service_pubkey/);
  });
});

describe('official cross-language vectors (wire v0.4.1 testdata/v1/task/output_mmr_v1.json)', () => {
  const v = JSON.parse(readFileSync('third_party/wire/testdata/v1/task/output_mmr_v1.json', 'utf8'));
  const m = v.mmr;
  const chunks: Uint8Array[] = (m.chunks_utf8 as string[]).map((t) => new TextEncoder().encode(t));
  const taskHash = fromHex(m.task_hash_hex);

  it('the domain matches the contract', () => expect(OUTPUT_MMR_DOMAIN).toBe(m.domain));

  (m.prefix_roots_hex as string[]).forEach((root, i) => {
    it(`prefix root for the first ${i + 1} chunk(s)`, () => {
      expect(toHex(mmrPrefixRoot(OUTPUT_MMR_DOMAIN, chunks, i + 1))).toBe(root);
    });
  });

  it('output_hash is the root of all four chunks', () => {
    expect(toHex(outputHash(chunks))).toBe(m.output_hash_hex);
    expect(m.output_hash_hex).toBe((m.prefix_roots_hex as string[])[3]);
  });

  it('an empty output is a single zero-length leaf, not an empty tree', () => {
    expect(toHex(outputHash([new Uint8Array(0)]))).toBe(m.empty_output.output_hash_hex);
    expect(m.empty_output.output_hash_hex).not.toBe(m.empty_output.empty_tree_root_hex);
  });

  for (const c of v.chunk_signing.cases as { seq: number; mmr_root_hex: string; digest_hex: string }[]) {
    it(`frame signing digest for seq=${c.seq}`, () => {
      expect(
        toHex(
          outputChunkSigningDigest({
            chainId: m.chain_id,
            taskHash,
            seq: BigInt(c.seq),
            mmrRoot: fromHex(c.mmr_root_hex),
          }),
        ),
      ).toBe(c.digest_hex);
    });
  }

  it('negative cases: re-chunking / reordering / mismatched seq and root / different chain / modified task_hash', () => {
    const neg = v.negative as Record<string, unknown>[];
    const byName = (n: string): Record<string, unknown> => neg.find((x) => x['name'] === n)!;

    const merged = byName('chunks_merged');
    expect(toHex(outputHash((merged['chunks_utf8'] as string[]).map((t) => new TextEncoder().encode(t))))).toBe(
      merged['output_hash_hex'],
    );
    expect(merged['output_hash_hex']).not.toBe(m.output_hash_hex);

    const reordered = byName('chunks_reordered');
    expect(toHex(outputHash((reordered['chunks_utf8'] as string[]).map((t) => new TextEncoder().encode(t))))).toBe(
      reordered['output_hash_hex'],
    );

    const unpaired = byName('seq_and_root_unpaired');
    expect(
      toHex(
        outputChunkSigningDigest({
          chainId: m.chain_id,
          taskHash,
          seq: BigInt(unpaired['seq'] as number),
          mmrRoot: fromHex(unpaired['mmr_root_hex'] as string),
        }),
      ),
    ).toBe(unpaired['digest_hex']);

    const otherChain = byName('other_chain_id');
    expect(
      toHex(
        outputChunkSigningDigest({
          chainId: otherChain['chain_id'] as string,
          taskHash,
          seq: BigInt(otherChain['seq'] as number),
          mmrRoot: fromHex((m.prefix_roots_hex as string[])[1]!),
        }),
      ),
    ).toBe(otherChain['digest_hex']);

    const flipped = byName('task_hash_one_bit_flipped');
    expect(
      toHex(
        outputChunkSigningDigest({
          chainId: m.chain_id,
          taskHash: fromHex(flipped['task_hash_hex'] as string),
          seq: BigInt(flipped['seq'] as number),
          mmrRoot: fromHex((m.prefix_roots_hex as string[])[1]!),
        }),
      ),
    ).toBe(flipped['digest_hex']);
  });
});
