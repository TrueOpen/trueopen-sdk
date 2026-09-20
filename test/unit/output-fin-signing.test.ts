import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  OUTPUT_FIN_DOMAIN,
  ACCEPTED_FINISH_REASONS,
  isAcceptedFinishReason,
  outputFinSigningDigest,
  verifyOutputFinSignature,
} from '../../src/output/output-commitment';
import { fromHex, toHex } from '../../src/util/bytes';

/**
 * TRUEOPEN_OUTPUT_FIN_V1 is anchored to the official wire vectors (wire v0.4.3 / wire#35).
 *
 * All expected values come from the fin_signing section of
 * third_party/wire/testdata/v1/task/output_mmr_v1.json, never made up locally:
 * the digests for the four accepted reasons, the full preimage and raw64 signature for the
 * EOS branch, the per-field mutation digests, and the rejected enum values. A self-made vector
 * can only prove the implementation is consistent with itself.
 */
const VECTORS = JSON.parse(
  readFileSync(new URL('../../third_party/wire/testdata/v1/task/output_mmr_v1.json', import.meta.url), 'utf8'),
) as {
  fin_signing: {
    domain: string;
    framing: string;
    fields: string[];
    chain_id: string;
    task_hash_hex: string;
    final_seq: number;
    output_mmr_root_hex: string;
    accepted_finish_reasons: { value: number; enum: string; digest_hex: string }[];
    rejected_finish_reason_values: { value: number; reason: string }[];
    eos_token_preimage_hex: string;
    eos_token_signature_hex: string;
    mutation_digests: { field: string; value?: string | number; value_hex?: string; digest_hex: string }[];
  };
  chunk_signing: { test_private_key_hex: string; test_public_key_compressed_hex: string };
};

const FIN = VECTORS.fin_signing;
const BASE = {
  chainId: FIN.chain_id,
  taskHash: fromHex(FIN.task_hash_hex),
  finalSeq: BigInt(FIN.final_seq),
  outputMmrRoot: fromHex(FIN.output_mmr_root_hex),
};

describe('TRUEOPEN_OUTPUT_FIN_V1 (anchored to official wire vectors)', () => {
  it('domain name and field order match the registry', () => {
    expect(OUTPUT_FIN_DOMAIN).toBe(FIN.domain);
    expect(FIN.framing).toBe('H_FIELDS_V1');
    expect(FIN.fields).toEqual(['chain_id', 'task_hash', 'final_seq', 'output_mmr_root', 'finish_reason']);
  });

  it('each of the four accepted finish_reason values matches the official digest', () => {
    expect(FIN.accepted_finish_reasons).toHaveLength(4);
    for (const c of FIN.accepted_finish_reasons) {
      expect(toHex(outputFinSigningDigest({ ...BASE, finishReason: c.value }))).toBe(c.digest_hex);
    }
  });

  it('the accepted set is exactly 1..4, and everything else fails closed', () => {
    expect([...ACCEPTED_FINISH_REASONS]).toEqual([1, 2, 3, 4]);
    for (const c of FIN.rejected_finish_reason_values) {
      expect(isAcceptedFinishReason(c.value)).toBe(false);
      // An invalid reason must be rejected before the digest is even computed, not after producing a digest that merely looks verifiable.
      expect(() => outputFinSigningDigest({ ...BASE, finishReason: c.value })).toThrow(/finish_reason/);
    }
  });

  it('EOS branch: preimage length matches the official value, and digest = sha256(preimage)', async () => {
    const preimage = fromHex(FIN.eos_token_preimage_hex);
    const eos = FIN.accepted_finish_reasons.find((c) => c.value === 1)!;
    const { sha256 } = await import('@noble/hashes/sha256');
    // Taking sha256 of the official preimage directly must equal the official digest -- this verifies the
    // H_FIELDS_V1 frame layout itself, a path independent of our own field assembly; both matching
    // confirms neither side is just accommodating the other.
    expect(toHex(sha256(preimage))).toBe(eos.digest_hex);
    expect(toHex(outputFinSigningDigest({ ...BASE, finishReason: 1 }))).toBe(eos.digest_hex);
  });

  it('EOS branch: the official raw64 signature verifies, and corresponds to the official test public key', () => {
    const pub = fromHex(VECTORS.chunk_signing.test_public_key_compressed_hex);
    const sig = fromHex(FIN.eos_token_signature_hex);
    expect(sig.length).toBe(64);
    expect(verifyOutputFinSignature({ ...BASE, finishReason: 1 }, sig, pub)).toBe(true);
    // This signature was indeed produced by the official test private key.
    const derived = secp256k1.getPublicKey(fromHex(VECTORS.chunk_signing.test_private_key_hex), true);
    expect(toHex(derived)).toBe(VECTORS.chunk_signing.test_public_key_compressed_hex);
  });

  it('tampering with any single field changes the digest (official mutation vectors)', () => {
    for (const m of FIN.mutation_digests) {
      const mutated = { ...BASE, finishReason: 1 } as Parameters<typeof outputFinSigningDigest>[0];
      const next =
        m.field === 'chain_id'
          ? { ...mutated, chainId: String(m.value) }
          : m.field === 'task_hash'
            ? { ...mutated, taskHash: fromHex(m.value_hex!) }
            : m.field === 'final_seq'
              ? { ...mutated, finalSeq: BigInt(m.value as number) }
              : m.field === 'output_mmr_root'
                ? { ...mutated, outputMmrRoot: fromHex(m.value_hex!) }
                : { ...mutated, finishReason: m.value as number };
      expect(toHex(outputFinSigningDigest(next))).toBe(m.digest_hex);
    }
  });

  it('after tampering with any field, the official EOS signature no longer verifies', () => {
    const pub = fromHex(VECTORS.chunk_signing.test_public_key_compressed_hex);
    const sig = fromHex(FIN.eos_token_signature_hex);
    const tampered: Parameters<typeof outputFinSigningDigest>[0][] = [
      { ...BASE, finishReason: 1, chainId: 'trueopen-localnet-2' },
      { ...BASE, finishReason: 1, finalSeq: BASE.finalSeq + 1n },
      { ...BASE, finishReason: 2 }, // swapped for another equally valid reason
    ];
    for (const f of tampered) {
      expect(verifyOutputFinSignature(f, sig, pub)).toBe(false);
    }
  });

  it('returns false, not a thrown error, when the signature length is wrong or the reason is invalid', () => {
    const pub = fromHex(VECTORS.chunk_signing.test_public_key_compressed_hex);
    const sig = fromHex(FIN.eos_token_signature_hex);
    expect(verifyOutputFinSignature({ ...BASE, finishReason: 1 }, sig.slice(0, 63), pub)).toBe(false);
    expect(verifyOutputFinSignature({ ...BASE, finishReason: 0 }, sig, pub)).toBe(false);
    expect(verifyOutputFinSignature({ ...BASE, finishReason: 5 }, sig, pub)).toBe(false);
  });

  it('structural parameter errors still throw (kept distinct from a signature-verification failure)', () => {
    expect(() => outputFinSigningDigest({ ...BASE, finishReason: 1, chainId: '' })).toThrow(/chain_id/);
    expect(() =>
      outputFinSigningDigest({ ...BASE, finishReason: 1, taskHash: new Uint8Array(31) }),
    ).toThrow(/task_hash/);
    expect(() =>
      outputFinSigningDigest({ ...BASE, finishReason: 1, outputMmrRoot: new Uint8Array(33) }),
    ).toThrow(/output_mmr_root/);
  });
});
