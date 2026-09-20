import { describe, it, expect } from 'vitest';
import { secp256k1Address, secp256k1AddressMatches, secp256k1PublicKey } from '../../src/signer/secp256k1';
import { fromHex } from '../../src/util/bytes';

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const pub = secp256k1PublicKey(PRIV);
// Authoritative value derived from @cosmjs (toBech32 + ripemd160(sha256(pub))), used as a cross-implementation golden value.
const GOLDEN_ADDR = 'trueopen1tp7fhly84qm6q4hhzmp0nh5frtdugmys78jv8m';

describe('secp256k1Address (bech32 = ripemd160(sha256(pubkey)))', () => {
  it('derives an address matching the cosmjs golden value', () => {
    expect(secp256k1Address(pub, 'trueopen')).toBe(GOLDEN_ADDR);
  });

  it('prefix affects the output', () => {
    expect(secp256k1Address(pub, 'cosmos').startsWith('cosmos1')).toBe(true);
    expect(secp256k1Address(pub, 'cosmos')).not.toBe(GOLDEN_ADDR);
  });

  it('matches: true when matching, false when not', () => {
    expect(secp256k1AddressMatches(GOLDEN_ADDR, pub, 'trueopen')).toBe(true);
    expect(secp256k1AddressMatches('trueopen1wrong', pub, 'trueopen')).toBe(false);
    expect(secp256k1AddressMatches(GOLDEN_ADDR, pub, 'cosmos')).toBe(false);
  });

  it('throws for a compressed public key that is not 33 bytes', () => {
    expect(() => secp256k1Address(pub.subarray(0, 32), 'trueopen')).toThrowError(/PUBKEY_LEN|33/);
  });
});
