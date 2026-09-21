import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  uncompressedXY,
  ethAddressBytes,
  ethAddress0x,
  ethSecp256k1Address,
  ethSecp256k1AddressMatches,
  privKeyEip712Signer,
  recoverEip712Address,
  recoverEip712PubKey,
  verifyEip712,
} from '../../src/signer/eth-secp256k1';
import { secp256k1Address } from '../../src/signer/secp256k1';
import { toHex, fromHex } from '../../src/util/bytes';
import { bech32 } from '@scure/base';

/** Same anchor as eip712.test.ts: wire v0.4.1's account_signing_v1.json, read directly from the submodule. */
const v = JSON.parse(readFileSync('third_party/wire/testdata/v1/shared/account_signing_v1.json', 'utf8'));
const a = v.account;
const priv = fromHex(a.private_key);

describe('EVM-style address derivation', () => {
  it('compressed public key', () => {
    expect(toHex(secp256k1.getPublicKey(priv, true))).toBe(a.pub_compressed);
  });

  it('uncompressed XY (decompressed from the compressed public key)', () => {
    expect(toHex(uncompressedXY(fromHex(a.pub_compressed)))).toBe(a.pub_uncompressed_xy);
    // The uncompressed form produced directly from the private key should match the decompressed result.
    expect(toHex(uncompressedXY(secp256k1.getPublicKey(priv, false)))).toBe(a.pub_uncompressed_xy);
  });

  it('keccak256(uncompressed XY)', () => {
    expect(toHex(keccak_256(fromHex(a.pub_uncompressed_xy)))).toBe(a.keccak256_pub_uncompressed_xy);
  });

  it('the address is the last 20 bytes of that digest', () => {
    expect(toHex(ethAddressBytes(fromHex(a.pub_compressed)))).toBe(a.address_bytes);
    expect(a.keccak256_pub_uncompressed_xy.slice(24)).toBe(a.address_bytes);
  });

  it('EIP-55 mixed-case checksum', () => {
    expect(ethAddress0x(fromHex(a.pub_compressed))).toBe(a.address_0x);
  });

  it('account bech32', () => {
    expect(ethSecp256k1Address(fromHex(a.pub_compressed), 'trueopen')).toBe(a.account_bech32);
  });

  it('operator bech32 is the same bytes with a different prefix', () => {
    // wire v0.2.0 (TrueOpen/wire#7) re-encoded the vector from the authoritative
    // address_bytes, fixing the broken checksum that v0.1.1 carried (wire#8).
    expect(ethSecp256k1Address(fromHex(a.pub_compressed), 'trueopenvaloper')).toBe(a.operator_bech32);
    // The operator form and the account form carry the same 20 payload bytes.
    expect(bech32.encode('trueopenvaloper', bech32.toWords(fromHex(a.address_bytes)))).toBe(a.operator_bech32);
  });

  it('all three public key forms derive the same address', () => {
    const compressed = fromHex(a.pub_compressed);
    const xy = fromHex(a.pub_uncompressed_xy);
    const full = secp256k1.getPublicKey(priv, false);
    const want = a.account_bech32;
    expect(ethSecp256k1Address(compressed, 'trueopen')).toBe(want);
    expect(ethSecp256k1Address(xy, 'trueopen')).toBe(want);
    expect(ethSecp256k1Address(full, 'trueopen')).toBe(want);
  });

  it('differs from the cosmos-style address (not the same identity)', () => {
    // Sanity check: the same public key must produce different addresses under the two derivation schemes. If they were equal, one side would be wrong.
    const compressed = fromHex(a.pub_compressed);
    expect(secp256k1Address(compressed, 'trueopen')).not.toBe(a.account_bech32);
    expect(ethSecp256k1AddressMatches(a.account_bech32, compressed, 'trueopen')).toBe(true);
    expect(ethSecp256k1AddressMatches(a.operator_bech32, compressed, 'trueopen')).toBe(false);
  });

  it('rejects an invalid public key length outright', () => {
    expect(() => uncompressedXY(new Uint8Array(32))).toThrow(/expected 33\/64\/65-byte/);
    expect(() => uncompressedXY(new Uint8Array(65))).toThrow(/must start with 0x04/);
  });
});

describe('65-byte recoverable signature', () => {
  const sign = privKeyEip712Signer(priv);
  const cases: { name: string; digest: string; sig: string }[] = [
    { name: 'task order', digest: v.task_order.signing_digest, sig: v.task_order.signature_65 },
    { name: 'task data request', digest: v.task_data_request.signing_digest, sig: v.task_data_request.signature_65 },
    {
      name: 'MsgCreateSession tx',
      digest: v.msg_create_session_transaction.signing_digest,
      sig: v.msg_create_session_transaction.signature_65,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: the signed 65 bytes match the vector byte-for-byte`, async () => {
      expect(toHex(await sign(fromHex(c.digest)))).toBe(c.sig);
    });
    it(`${c.name}: the signer address can be recovered from the signature`, () => {
      expect(recoverEip712Address(fromHex(c.digest), fromHex(c.sig), 'trueopen')).toBe(a.account_bech32);
      expect(verifyEip712(fromHex(c.digest), fromHex(c.sig), a.account_bech32, 'trueopen')).toBe(true);
    });
  }

  it('the recovered public key is the account public key', () => {
    const d = fromHex(v.task_order.signing_digest);
    expect(toHex(recoverEip712PubKey(d, fromHex(v.task_order.signature_65)))).toBe(a.pub_compressed);
  });

  it('V must be 27/28', () => {
    const sig = fromHex(v.task_order.signature_65);
    const bad = Uint8Array.from(sig);
    bad[64] = 0;
    expect(() => recoverEip712PubKey(fromHex(v.task_order.signing_digest), bad)).toThrow(/V must be 27 or 28/);
  });

  it('rejects raw64 (contract negative test case)', () => {
    const sig64 = fromHex(v.task_order.signature_65).subarray(0, 64);
    expect(() => recoverEip712PubKey(fromHex(v.task_order.signing_digest), sig64)).toThrow(/exactly 65 bytes/);
  });

  it('the digest must be exactly 32 bytes', () => {
    expect(() => sign(new Uint8Array(31))).toThrow(/exactly 32 bytes/);
  });

  it('a different digest recovers a different address', () => {
    const other = fromHex(v.task_data_request.signing_digest);
    expect(recoverEip712Address(other, fromHex(v.task_order.signature_65), 'trueopen')).not.toBe(a.account_bech32);
  });
});
