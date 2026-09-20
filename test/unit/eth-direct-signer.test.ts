import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { AuthInfo, SignDoc, TxBody } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { Any } from 'cosmjs-types/google/protobuf/any';
import { BaseAccount } from 'cosmjs-types/cosmos/auth/v1beta1/auth';
import { Coin } from 'cosmjs-types/cosmos/base/v1beta1/coin';
import {
  EthSecp256k1DirectSigner,
  ethSecp256k1SignerFromMnemonic,
  ethAccountParser,
  ETH_SECP256K1_PUBKEY_TYPE_URL,
  ETH_ACCOUNT_TYPE_URL,
} from '../../src/signer/eth-direct-signer';
import { ethSecp256k1Address, TRUEOPEN_HD_PATH } from '../../src/signer/eth-secp256k1';
import { fromHex, toHex } from '../../src/util/bytes';

/** Same key as eth-secp256k1.test.ts: the account block from wire v0.4.1 account_signing_v1.json. */
const account = JSON.parse(
  readFileSync('third_party/wire/testdata/v1/shared/account_signing_v1.json', 'utf8'),
).account;
const PRIV = fromHex(account.private_key);
const PUB = secp256k1.getPublicKey(PRIV, true);

/** Builds a realistically shaped SignDoc: this is how CosmJS assembles one (the public key is initially filled in with the cosmos type). */
function makeSignDoc(pubkeyTypeUrl = '/cosmos.crypto.secp256k1.PubKey'): SignDoc {
  const bodyBytes = TxBody.encode(
    TxBody.fromPartial({ messages: [], memo: 'trueopen-test', timeoutHeight: 0n }),
  ).finish();
  const authInfoBytes = AuthInfo.encode(
    AuthInfo.fromPartial({
      signerInfos: [
        {
          // The cosmos and evm PubKey proto shapes are identical (bytes key = 1); only the type_url differs.
          publicKey: Any.fromPartial({
            typeUrl: pubkeyTypeUrl,
            value: Uint8Array.from([0x0a, PUB.length, ...PUB]),
          }),
          modeInfo: { single: { mode: 1 } },
          sequence: 9n,
        },
      ],
      fee: { amount: [Coin.fromPartial({ denom: 'uusdc', amount: '12345' })], gasLimit: 200000n },
    }),
  ).finish();
  return SignDoc.fromPartial({ bodyBytes, authInfoBytes, chainId: 'trueopen-localnet-1', accountNumber: 7n });
}

describe('EthSecp256k1DirectSigner', () => {
  const signer = new EthSecp256k1DirectSigner(PRIV, 'trueopen');

  it('address is derived via keccak, matching the account vector', async () => {
    const [acc] = await signer.getAccounts();
    expect(acc?.address).toBe(account.account_bech32);
    expect(acc?.address).toBe(ethSecp256k1Address(PUB, 'trueopen'));
    expect(toHex(acc?.pubkey ?? new Uint8Array())).toBe(account.pub_compressed);
  });

  it('rewrites the public key type_url in AuthInfo to ethsecp256k1, keeping value unchanged', async () => {
    const doc = makeSignDoc();
    const before = AuthInfo.decode(doc.authInfoBytes).signerInfos[0]?.publicKey;
    const { signed } = await signer.signDirect(account.account_bech32, doc);
    const after = AuthInfo.decode(signed.authInfoBytes).signerInfos[0]?.publicKey;

    expect(before?.typeUrl).toBe('/cosmos.crypto.secp256k1.PubKey');
    expect(after?.typeUrl).toBe(ETH_SECP256K1_PUBKEY_TYPE_URL);
    expect(toHex(after?.value ?? new Uint8Array())).toBe(toHex(before?.value ?? new Uint8Array()));
    // body and the remaining fields are untouched - CosmJS puts signed.bodyBytes into TxRaw as-is.
    expect(toHex(signed.bodyBytes)).toBe(toHex(doc.bodyBytes));
    expect(signed.chainId).toBe(doc.chainId);
    expect(signed.accountNumber).toBe(doc.accountNumber);
  });

  it('signs keccak256(the rewritten SignDoc), not sha256, and not the pre-rewrite version', async () => {
    const doc = makeSignDoc();
    const { signed, signature } = await signer.signDirect(account.account_bech32, doc);
    const sig = Uint8Array.from(Buffer.from(signature.signature, 'base64'));
    expect(sig).toHaveLength(64);

    // Positive: taking keccak of the rewritten SignDoc verifies successfully.
    const digest = keccak_256(SignDoc.encode(signed).finish());
    expect(secp256k1.verify(sig, digest, PUB)).toBe(true);

    // Negative: taking keccak of the **pre-rewrite** version fails verification - confirming the signature really covers the bytes about to go on-chain.
    const beforeDigest = keccak_256(SignDoc.encode(doc).finish());
    expect(toHex(beforeDigest)).not.toBe(toHex(digest));
    expect(secp256k1.verify(sig, beforeDigest, PUB)).toBe(false);
  });

  it('low-S: node\'s ethcrypto.VerifySignature does not accept high-S', async () => {
    const { signature } = await signer.signDirect(account.account_bech32, makeSignDoc());
    const sig = Uint8Array.from(Buffer.from(signature.signature, 'base64'));
    expect(secp256k1.Signature.fromCompact(sig).hasHighS()).toBe(false);
  });

  it('does not rewrite a public key that is already ethsecp256k1 (idempotent)', async () => {
    const doc = makeSignDoc(ETH_SECP256K1_PUBKEY_TYPE_URL);
    const { signed } = await signer.signDirect(account.account_bech32, doc);
    expect(toHex(signed.authInfoBytes)).toBe(toHex(doc.authInfoBytes));
  });

  it('refuses to sign when the address does not match, instead of producing a signature no one wants', async () => {
    await expect(signer.signDirect('trueopen1wrong', makeSignDoc())).rejects.toThrow(/does not match/);
  });

  it('rejects an invalid private key length outright', () => {
    expect(() => new EthSecp256k1DirectSigner(new Uint8Array(31), 'trueopen')).toThrow(/32 bytes/);
  });

  it('deriving from a mnemonic uses the protocol HD path', async () => {
    const MN =
      'flee cover glad finish category story alpha envelope twelve tube glory athlete ugly road roof milk idle ketchup utility park source jewel head shift';
    const s = await ethSecp256k1SignerFromMnemonic(MN, 'trueopen');
    const [acc] = await s.getAccounts();
    expect(TRUEOPEN_HD_PATH).toBe("m/44'/60'/0'/0/0");
    expect(acc?.address).toBe('trueopen1jah6xx0ve056wgl3cxlxhe393ywwwyuamfl037');
  });
});

describe('ethAccountParser', () => {
  const base = BaseAccount.fromPartial({
    address: account.account_bech32,
    accountNumber: 7n,
    sequence: 9n,
  });

  it('can unpack EthAccount\'s base_account', () => {
    // EthAccount { BaseAccount base_account = 1; string code_hash = 2; }
    const baseBytes = BaseAccount.encode(base).finish();
    const ethAccount = new Uint8Array([
      0x0a,
      baseBytes.length,
      ...baseBytes,
      0x12,
      2,
      0x30,
      0x78, // code_hash = "0x"
    ]);
    const parsed = ethAccountParser(Any.fromPartial({ typeUrl: ETH_ACCOUNT_TYPE_URL, value: ethAccount }));
    expect(parsed.address).toBe(account.account_bech32);
    expect(parsed.accountNumber).toBe(7);
    expect(parsed.sequence).toBe(9);
  });

  it('passes a non-EthAccount through to CosmJS\'s parser unchanged', () => {
    const any = Any.fromPartial({
      typeUrl: '/cosmos.auth.v1beta1.BaseAccount',
      value: BaseAccount.encode(base).finish(),
    });
    expect(ethAccountParser(any).address).toBe(account.account_bech32);
  });

  it('errors when EthAccount has no base_account, instead of silently returning an empty account', () => {
    const any = Any.fromPartial({ typeUrl: ETH_ACCOUNT_TYPE_URL, value: new Uint8Array([0x12, 0]) });
    expect(() => ethAccountParser(any)).toThrow(/no base_account/);
  });
});
