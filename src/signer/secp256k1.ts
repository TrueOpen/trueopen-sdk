import { secp256k1 } from '@noble/curves/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bech32 } from '@scure/base';
import { sha256 } from '../codec/hash';
import { TrueOpenError } from '../errors/errors';

/**
 * Cosmos-style secp256k1 signer: sha256 the message, then ECDSA-sign it,
 * returning 64-byte r‖s (low-S, RFC6979-deterministic). Equivalent to
 * priv.Sign(message) on-chain.
 */
export type CosmosSecp256k1Signer = (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/**
 * Builds a signer from a raw private key.
 * For tests/examples only; production should inject a wallet/HSM-backed
 * signer instead, so the SDK never holds the private key directly.
 */
export function privKeySecp256k1Signer(privKey: Uint8Array): CosmosSecp256k1Signer {
  return (message) => secp256k1.sign(sha256(message), privKey).toCompactRawBytes();
}

/** 33-byte compressed pubkey (matches on-chain secp256k1.PubKey.Bytes()). */
export function secp256k1PublicKey(privKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privKey, true);
}

/** Verifies a Cosmos-style signature (sha256 the message first). sig may be 64 or 65 bytes. */
export function verifyCosmosSecp256k1(message: Uint8Array, sig: Uint8Array, pubKey: Uint8Array): boolean {
  const raw = sig.length === 65 ? sig.subarray(0, 64) : sig;
  return secp256k1.verify(raw, sha256(message), pubKey);
}

/**
 * Cosmos address derivation: bech32(prefix, ripemd160(sha256(compressedPubKey))).
 * nexus's SDKRequestEnvelope requires signer_address to equal this derived
 * address, otherwise it rejects the signature (SDK_AUTH_INVALID_SIGNATURE).
 * pubKey must be a 33-byte compressed pubkey.
 */
export function secp256k1Address(pubKey: Uint8Array, prefix: string): string {
  if (pubKey.length !== 33) {
    throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_BAD_PUBKEY_LEN', `expected 33-byte compressed secp256k1 pubkey, got ${pubKey.length}`);
  }
  return bech32.encode(prefix, bech32.toWords(ripemd160(sha256(pubKey))));
}

/**
 * A signer that ECDSA-signs an **already-derived 32-byte digest** directly
 * (no internal sha256).
 *
 * The difference from CosmosSecp256k1Signer is critical: the latter sha256s
 * its input before signing, so using it to sign task_hash would produce a
 * signature over sha256(task_hash), which will never verify on-chain. node's
 * contract for this "sign SIGN_DIGEST" style goes through
 * VerifyStrictSecp256k1Digest (x/shared/types/signature.go), whose comment
 * states:
 *   "verifies ECDSA directly over an already-derived Hash32. Cosmos SDK's
 *    PubKey.VerifySignature hashes its input again, so it must not be used for
 *    contracts that explicitly say 'sign SIGN_DIGEST'."
 * SignedOrderV1.user_signature is exactly this case (the keeper's
 * msg_server_worker_handraises.go:386 verifies against taskHash[:] using
 * VerifyDigestSignature).
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

/** Whether signer_address matches the address derived from this compressed pubkey under prefix. */
export function secp256k1AddressMatches(address: string, pubKey: Uint8Array, prefix: string): boolean {
  try {
    return secp256k1Address(pubKey, prefix) === address;
  } catch {
    return false;
  }
}
