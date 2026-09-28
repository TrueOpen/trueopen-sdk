import { secp256k1 } from '@noble/curves/secp256k1';
import { TrueOpenError } from '../errors/errors';

/** 33-byte compressed pubkey (matches on-chain secp256k1.PubKey.Bytes()). */
export function secp256k1PublicKey(privKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privKey, true);
}

/**
 * A signer that ECDSA-signs an **already-derived 32-byte digest** directly
 * (no internal sha256).
 *
 * It never hashes its input again: signing sha256(digest) instead would never
 * verify. node's contract for this "sign SIGN_DIGEST" style goes through
 * VerifyStrictSecp256k1Digest (x/shared/types/signature.go), whose comment
 * states:
 *   "verifies ECDSA directly over an already-derived Hash32. Cosmos SDK's
 *    PubKey.VerifySignature hashes its input again, so it must not be used for
 *    contracts that explicitly say 'sign SIGN_DIGEST'."
 * Signing an already-derived digest (for example an EIP-712 signing digest) is
 * exactly this case.
 *
 * Note: most hardware wallets / browser wallets only expose a "hash then
 * sign" interface and can't sign an arbitrary digest directly, so this
 * requires access to the raw private key or a backend that supports
 * raw-digest signing.
 */
export type Secp256k1DigestSigner = (digest: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/**
 * Builds a raw-digest signer from a raw private key (low-S, RFC6979-deterministic,
 * 64-byte r‖s).
 * For tests/examples only; production should inject a wallet/HSM-backed signer.
 */
export function privKeySecp256k1DigestSigner(privKey: Uint8Array): Secp256k1DigestSigner {
  return (digest) => {
    if (digest.length !== 32) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_BAD_DIGEST_LEN',
        `secp256k1 signing digest must be exactly 32 bytes, got ${digest.length}`,
      );
    }
    return secp256k1.sign(digest, privKey).toCompactRawBytes();
  };
}

/** Verifies a signature made directly over a 32-byte digest (matches node's VerifyStrictSecp256k1Digest). */
export function verifySecp256k1Digest(digest: Uint8Array, sig: Uint8Array, pubKey: Uint8Array): boolean {
  if (digest.length !== 32) return false;
  const raw = sig.length === 65 ? sig.subarray(0, 64) : sig;
  return secp256k1.verify(raw, digest, pubKey);
}

