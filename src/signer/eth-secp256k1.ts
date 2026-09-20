import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bech32 } from '@scure/base';
import { concatBytes, toHex } from '../util/bytes';
import { TrueOpenError } from '../errors/errors';

/**
 * EVM-style secp256k1 identity (on-chain accounts switched to this scheme as
 * of wire v0.4.1).
 *
 * This is **a different address scheme** from the Cosmos style in
 * signer/secp256k1.ts -- the same private key produces different results:
 *   old (cosmos): bech32(prefix, ripemd160(sha256(compressed_pubkey)))
 *   new (evm):    bech32(prefix, keccak256(uncompressed_XY)[12:32])
 * Upstream is github.com/cosmos/evm v0.6.3, pubkey type URL
 * /cosmos.evm.crypto.v1.ethsecp256k1.PubKey.
 *
 * Cross-language anchor: the account block in wire
 * testdata/v1/shared/account_signing_v1.json (private key 0x01 repeated 32
 * times -> trueopen1rfjz7r3u8t65teavh5utquj3kwvsj983p3jclz).
 */

/**
 * The HD path is frozen by the protocol: coin_type = **60** (Account and
 * Signing Protocol doc §2.2), not the usual Cosmos 118.
 *
 * This isn't a harmless "swap a prefix" difference: deriving from the same
 * mnemonic with 118 versus 60 yields **two different private keys**, with no
 * overlap in pubkey or address. The chain funds the address derived with 60
 * (node's `noded keys add` defaults to eth_secp256k1 / 60); deriving with 118
 * just gets you an empty account -- and "address mismatch" looks a lot like
 * "account has no funds" in the error output, so once this path is wrong it's
 * hard to work backwards from the symptom.
 *
 * This only matters when deriving from a mnemonic; it's irrelevant if you
 * already hold the raw private key bytes.
 */
export const TRUEOPEN_HD_PATH = "m/44'/60'/0'/0/0";

function badKey(what: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_BAD_PUBKEY', `eth secp256k1: ${what}`);
}

/**
 * Extracts the 64-byte uncompressed XY of a pubkey (without the 0x04 prefix).
 * Accepts a 33-byte compressed key, a 65-byte uncompressed key (with 0x04), or
 * an already 64-byte XY.
 */
export function uncompressedXY(pubKey: Uint8Array): Uint8Array {
  if (pubKey.length === 64) return pubKey;
  if (pubKey.length === 65) {
    if (pubKey[0] !== 0x04) throw badKey('65-byte pubkey must start with 0x04');
    return pubKey.subarray(1);
  }
  if (pubKey.length === 33) {
    return secp256k1.ProjectivePoint.fromHex(pubKey).toRawBytes(false).subarray(1);
  }
  throw badKey(`expected 33/64/65-byte pubkey, got ${pubKey.length}`);
}

/** 20-byte account address: the last 20 bytes of keccak256(uncompressed_XY). */
export function ethAddressBytes(pubKey: Uint8Array): Uint8Array {
  return keccak_256(uncompressedXY(pubKey)).subarray(12);
}

/**
 * bech32 account address. Pass prefix "trueopen" for the account address, or
 * "trueopenvaloper" for the operator address -- both encode the same 20 bytes
 * with a different prefix.
 */
export function ethSecp256k1Address(pubKey: Uint8Array, prefix: string): string {
  return bech32.encode(prefix, bech32.toWords(ethAddressBytes(pubKey)));
}

/** EIP-55 mixed-case 0x address (address_0x in the test vectors). */
export function ethAddress0x(pubKey: Uint8Array): string {
  const hex = toHex(ethAddressBytes(pubKey));
  const marks = toHex(keccak_256(new TextEncoder().encode(hex)));
  let out = '0x';
  for (let i = 0; i < hex.length; i++) {
    const c = hex[i]!;
    out += parseInt(marks[i]!, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/** Whether the address matches the one derived from this pubkey under prefix. */
export function ethSecp256k1AddressMatches(address: string, pubKey: Uint8Array, prefix: string): boolean {
  try {
    return ethSecp256k1Address(pubKey, prefix) === address;
  } catch {
    return false;
  }
}

/**
 * A signer that signs an EIP-712 digest: returns **65-byte R‖S‖V**, V in
 * {27,28}, low-S.
 *
 * The contract explicitly rejects these shapes: high-S, DER, raw64, out-of-range
 * V, personal_sign, and double-hashed digests. That's why this neither hashes
 * the input again (it's already the final digest) nor returns 64 bytes.
 */
export type Eip712Signer = (digest: Uint8Array) => Uint8Array | Promise<Uint8Array>;

export function privKeyEip712Signer(privKey: Uint8Array): Eip712Signer {
  return (digest) => {
    if (digest.length !== 32) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_BAD_DIGEST_LEN',
        `EIP-712 signing digest must be exactly 32 bytes, got ${digest.length}`,
      );
    }
    // @noble outputs low-S with a recovery bit by default.
    const sig = secp256k1.sign(digest, privKey);
    if (sig.recovery === undefined) throw badKey('signature is missing its recovery bit');
    return concatBytes(sig.toCompactRawBytes(), new Uint8Array([27 + sig.recovery]));
  };
}

function splitSig65(sig: Uint8Array): { compact: Uint8Array; recovery: number } {
  if (sig.length !== 65) throw badKey(`signature must be exactly 65 bytes, got ${sig.length}`);
  const v = sig[64]!;
  if (v !== 27 && v !== 28) throw badKey(`signature V must be 27 or 28, got ${v}`);
  return { compact: sig.subarray(0, 64), recovery: v - 27 };
}

/** Recovers the compressed pubkey from a 65-byte signature; rejects any non-low-S shape. */
export function recoverEip712PubKey(digest: Uint8Array, sig: Uint8Array): Uint8Array {
  const { compact, recovery } = splitSig65(sig);
  const parsed = secp256k1.Signature.fromCompact(compact);
  if (parsed.hasHighS()) throw badKey('signature must be low-S');
  return parsed.addRecoveryBit(recovery).recoverPublicKey(digest).toRawBytes(true);
}

/** Recovers the signer's address from a 65-byte signature. */
export function recoverEip712Address(digest: Uint8Array, sig: Uint8Array, prefix: string): string {
  return ethSecp256k1Address(recoverEip712PubKey(digest, sig), prefix);
}

/** Verifies the signature was actually produced by the given address. */
export function verifyEip712(digest: Uint8Array, sig: Uint8Array, address: string, prefix: string): boolean {
  try {
    return recoverEip712Address(digest, sig, prefix) === address;
  } catch {
    return false;
  }
}
