import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { AuthInfo, SignDoc } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { Any } from 'cosmjs-types/google/protobuf/any';
import { BaseAccount } from 'cosmjs-types/cosmos/auth/v1beta1/auth';
import type { AccountData, DirectSignResponse, OfflineDirectSigner } from '@cosmjs/proto-signing';
import type { Account, AccountParser } from '@cosmjs/stargate';
import { accountFromAny } from '@cosmjs/stargate';
import { Bip39, EnglishMnemonic, Slip10, Slip10Curve, stringToPath } from '@cosmjs/crypto';
import { ethSecp256k1Address, TRUEOPEN_HD_PATH } from './eth-secp256k1';
import { TrueOpenError } from '../errors/errors';

/**
 * Direct ethsecp256k1 signing for on-chain transactions (the DIRECT path in
 * node's `app/account_ante.go`).
 *
 * CosmJS's built-in `DirectSecp256k1HdWallet` disagrees with node in three
 * places, and missing any one of them gets rejected by the ante handler:
 *
 *   | | CosmJS | node expects |
 *   |---|---|---|
 *   | address derivation | `ripemd160(sha256(compressed))` | `keccak256(XY)[12:]` |
 *   | DIRECT digest | `sha256(SignDoc)` | `keccak256(SignDoc)` |
 *   | pubkey type URL | `/cosmos.crypto.secp256k1.PubKey` | `/cosmos.evm.crypto.v1.ethsecp256k1.PubKey` |
 *
 * The first two are solved by swapping in a custom signer, but the third one
 * isn't: `SigningStargateClient.signDirect` hardcodes the pubkey to
 * `encodePubkey(encodeSecp256k1Pubkey(...))`. However, once it builds the
 * SignDoc it hands it off to the signer, and the final `TxRaw` takes the
 * **signer's returned** `signed.bodyBytes` / `signed.authInfoBytes` — so here
 * we rewrite the pubkey type URL inside AuthInfo before signing, then sign the
 * rewritten SignDoc, so the broadcast tx carries the rewritten version.
 *
 * Both PubKey proto shapes are identical (both are `bytes key = 1`, a 33-byte
 * compressed pubkey), so we only swap type_url and leave value untouched.
 */

/** cosmos/evm's pubkey type URL (`github.com/cosmos/evm/crypto/ethsecp256k1`). */
export const ETH_SECP256K1_PUBKEY_TYPE_URL = '/cosmos.evm.crypto.v1.ethsecp256k1.PubKey';

/** cosmos/evm's account type URL; it wraps a standard BaseAccount. */
export const ETH_ACCOUNT_TYPE_URL = '/cosmos.evm.types.v1.EthAccount';

/** The pubkey type URL CosmJS recognizes; same proto shape as above, only the type_url differs. */
export const COSMOS_SECP256K1_PUBKEY_TYPE_URL = '/cosmos.crypto.secp256k1.PubKey';

const BASE_ACCOUNT_TYPE_URL = '/cosmos.auth.v1beta1.BaseAccount';

function local(code: string, message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', code, message);
}

/** Swaps every signer's pubkey type URL in AuthInfo to ethsecp256k1, leaving value untouched. */
function retypePubkeys(authInfoBytes: Uint8Array): Uint8Array {
  const authInfo = AuthInfo.decode(authInfoBytes);
  let changed = false;
  for (const signerInfo of authInfo.signerInfos) {
    const pk = signerInfo.publicKey;
    if (pk === undefined || pk.typeUrl === ETH_SECP256K1_PUBKEY_TYPE_URL) continue;
    signerInfo.publicKey = Any.fromPartial({ typeUrl: ETH_SECP256K1_PUBKEY_TYPE_URL, value: pk.value });
    changed = true;
  }
  // No pubkey to rewrite means the upstream assembly logic changed; letting this
  // pass silently would surface as an ante-handler "wrong pubkey type" error far
  // away from here.
  if (!changed && authInfo.signerInfos.every((s) => s.publicKey === undefined)) {
    throw local('SDK_LOCAL_TX_NO_PUBKEY', 'AuthInfo carries no signer public key to retype');
  }
  return AuthInfo.encode(authInfo).finish();
}

/**
 * OfflineDirectSigner: address derived via keccak, digest computed as
 * keccak256(SignDoc), pubkey type rewritten to ethsecp256k1. The signature is
 * 64-byte R‖S, low-S (node's `ethcrypto.VerifySignature` only accepts 64 bytes
 * and rejects high-S).
 */
export class EthSecp256k1DirectSigner implements OfflineDirectSigner {
  private readonly pubKey: Uint8Array;
  private readonly address: string;

  constructor(
    private readonly privKey: Uint8Array,
    prefix: string,
  ) {
    if (privKey.length !== 32) {
      throw local('SDK_LOCAL_BAD_PRIVKEY_LEN', `private key must be 32 bytes, got ${privKey.length}`);
    }
    this.pubKey = secp256k1.getPublicKey(privKey, true);
    this.address = ethSecp256k1Address(this.pubKey, prefix);
  }

  async getAccounts(): Promise<readonly AccountData[]> {
    // algo only affects CosmJS's internal branching; the signDirect method
    // below is what actually determines the on-chain signature-verification format.
    return [{ address: this.address, algo: 'secp256k1', pubkey: this.pubKey }];
  }

  async signDirect(signerAddress: string, signDoc: SignDoc): Promise<DirectSignResponse> {
    if (signerAddress !== this.address) {
      throw local(
        'SDK_LOCAL_TX_SIGNER_MISMATCH',
        `signer address ${signerAddress} does not match this signer's ${this.address}`,
      );
    }
    const signed: SignDoc = {
      ...signDoc,
      authInfoBytes: retypePubkeys(signDoc.authInfoBytes),
    };
    const digest = keccak_256(SignDoc.encode(signed).finish());
    const signature = secp256k1.sign(digest, this.privKey).toCompactRawBytes();
    return {
      signed,
      signature: {
        // CosmJS only takes the signature field below into TxRaw; pub_key isn't
        // sent on-chain in DIRECT mode. The pubkey that actually goes on-chain
        // lives inside authInfoBytes (already rewritten to ethsecp256k1).
        pub_key: { type: 'tendermint/PubKeySecp256k1', value: toBase64(this.pubKey) },
        signature: toBase64(signature),
      },
    };
  }
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Derives a signer from a mnemonic using the protocol's HD path (coin_type 60). */
export async function ethSecp256k1SignerFromMnemonic(
  mnemonic: string,
  prefix: string,
  hdPath: string = TRUEOPEN_HD_PATH,
): Promise<EthSecp256k1DirectSigner> {
  const seed = await Bip39.mnemonicToSeed(new EnglishMnemonic(mnemonic));
  const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, stringToPath(hdPath));
  return new EthSecp256k1DirectSigner(privkey, prefix);
}

/**
 * Account parser. CosmJS's `accountFromAny` blows up in two places, and both
 * must be handled:
 *
 *  1. The account itself is cosmos/evm's `EthAccount` -> "Unsupported type".
 *     Its field 1 is a standard BaseAccount, so we just unwrap it. (The current
 *     devnet uses a plain BaseAccount, but we keep this path in case the chain
 *     switches over.)
 *  2. The account is a BaseAccount, but `pub_key` is
 *     `/cosmos.evm.crypto.v1.ethsecp256k1.PubKey` -> `decodePubkey` throws
 *     "Pubkey type URL not recognized". **This one will always happen**: once
 *     an account sends its first tx, the chain stores this pubkey type, and
 *     the second tx's sequence query blows up. Both PubKey proto shapes are
 *     identical (`bytes key = 1`), so rewriting the type_url back to cosmos's
 *     is enough for CosmJS to decode the same pubkey; the signer rewrites it
 *     back before broadcasting.
 */
export const ethAccountParser: AccountParser = (input: Any): Account => {
  const baseBytes =
    input.typeUrl === ETH_ACCOUNT_TYPE_URL ? ethAccountBaseAccount(input.value) : input.value;
  if (input.typeUrl !== ETH_ACCOUNT_TYPE_URL && input.typeUrl !== BASE_ACCOUNT_TYPE_URL) {
    // Hand ModuleAccount / Vesting etc. back to the original parser; we don't
    // replicate their semantics here.
    return accountFromAny(input);
  }
  const base = BaseAccount.decode(baseBytes);
  if (base.pubKey?.typeUrl === ETH_SECP256K1_PUBKEY_TYPE_URL) {
    base.pubKey = Any.fromPartial({ typeUrl: COSMOS_SECP256K1_PUBKEY_TYPE_URL, value: base.pubKey.value });
  }
  return accountFromAny(
    Any.fromPartial({ typeUrl: BASE_ACCOUNT_TYPE_URL, value: BaseAccount.encode(base).finish() }),
  );
};

/**
 * Extracts EthAccount's base_account (field 1, length-delimited) raw bytes.
 * We only read the one field we need here, without pulling in cosmos/evm's
 * generated types -- not worth a whole dependency for a single field.
 */
function ethAccountBaseAccount(value: Uint8Array): Uint8Array {
  let offset = 0;
  while (offset < value.length) {
    const [key, afterKey] = readVarint(value, offset);
    const fieldNumber = Number(key >> 3n);
    const wireType = Number(key & 7n);
    if (fieldNumber === 1 && wireType === 2) {
      const [len, afterLen] = readVarint(value, afterKey);
      const end = afterLen + Number(len);
      if (end > value.length) break;
      const bytes = value.subarray(afterLen, end);
      // Self-check: only decoding successfully as a BaseAccount confirms we
      // actually found the right field.
      BaseAccount.decode(bytes);
      return bytes;
    }
    offset = skipField(value, afterKey, wireType);
    if (offset < 0) break;
  }
  throw local('SDK_LOCAL_ETH_ACCOUNT_NO_BASE', 'EthAccount carries no base_account field');
}

function readVarint(buf: Uint8Array, start: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let i = start;
  for (; i < buf.length; i++) {
    const b = buf[i]!;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, i + 1];
    shift += 7n;
  }
  throw local('SDK_LOCAL_ETH_ACCOUNT_MALFORMED', 'truncated varint in EthAccount');
}

function skipField(buf: Uint8Array, start: number, wireType: number): number {
  switch (wireType) {
    case 0:
      return readVarint(buf, start)[1];
    case 1:
      return start + 8;
    case 2: {
      const [len, after] = readVarint(buf, start);
      return after + Number(len);
    }
    case 5:
      return start + 4;
    default:
      return -1;
  }
}
