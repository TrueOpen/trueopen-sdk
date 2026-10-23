import type { EncodeObject } from '@cosmjs/proto-signing';
import type { Account, IndexedTx, StdFee } from '@cosmjs/stargate';
import { ProtoWriter } from '../codec/protobuf';
import { cosmosWeb3TypedData } from '../codec/cosmos-web3';
import { canonicalAccountAddressBytes } from '../codec/address';
import { TrueOpenError } from '../errors/errors';
import { signatureChainIdBigInt } from '../signature-chain-id';
import { ETH_SECP256K1_PUBKEY_TYPE_URL } from '../signer/eth-direct-signer';
import { ethAddressBytes, recoverEip712PubKey } from '../signer/eth-secp256k1';
import { signTypedDataAs, typedDataDigest } from '../signer/typed-data-signer';
import type { TypedData, TypedDataSigner } from '../signer/typed-data-signer';
import { bytesEqual, toHex } from '../util/bytes';
import { aminoMsgFromEncodeObject, canonicalAminoSignDoc, web3Fee } from './amino-json';
import type { TxBroadcaster } from './cosmjs-chain-writer';
import { TYPE_URL, encodeMsgCancelOrder, encodeMsgCreateSession, encodeMsgUpdateSessionKey } from './task-msgs';
import type { MsgCancelOrder, MsgCreateSession, MsgUpdateSessionKey } from './task-msgs';

/**
 * The Web3 transaction path: a TxRaw the node accepts on its second signature envelope
 * (app/account_ante.go inspectSignatureEnvelope), signed by any EIP-712 wallet.
 *
 *  - TxBody: exactly one Msg, the memo, and exactly one **critical** extension option
 *    (`extension_options`, field 1023; the node refuses any non-critical option) holding
 *    `/cosmos.evm.eip712.v1.ExtensionOptionsWeb3Tx {typed_data_chain_id, fee_payer: "",
 *    fee_payer_sig: empty}`; no timeout, ordered.
 *  - AuthInfo: one SignerInfo with the eth_secp256k1 compressed public key, mode_info single
 *    SIGN_MODE_LEGACY_AMINO_JSON and the account sequence; the fee, with no payer or granter.
 *  - signatures: the 65-byte R||S||V (V 27/28, low S) EIP-712 signature over the Cosmos Web3
 *    typed data of the canonical Amino sign doc. The node recovers the key from it
 *    (RequireRecoverableSecp256k1Signature), unlike the DIRECT path's 64-byte form.
 */

export const WEB3_EXTENSION_TYPE_URL = '/cosmos.evm.eip712.v1.ExtensionOptionsWeb3Tx';

/** cosmos.tx.signing.v1beta1.SignMode.SIGN_MODE_LEGACY_AMINO_JSON. */
export const SIGN_MODE_LEGACY_AMINO_JSON = 127n;

function local(code: string, message: string, cause?: unknown): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', code, message, cause !== undefined ? { cause } : undefined);
}

/** google.protobuf.Any { string type_url = 1; bytes value = 2; }. */
function encodeAny(typeUrl: string, value: Uint8Array): Uint8Array {
  return new ProtoWriter().string(1, typeUrl).bytes(2, value).finish();
}

/**
 * cosmos.evm.eip712.v1.ExtensionOptionsWeb3Tx (cosmos-evm v0.6.3 web3.proto):
 *   uint64 typed_data_chain_id = 1; string fee_payer = 2; bytes fee_payer_sig = 3;
 * Fee delegation is refused by the node, so only field 1 is ever written.
 */
export function encodeExtensionOptionsWeb3Tx(typedDataChainId: bigint): Uint8Array {
  return new ProtoWriter().uint64(1, signatureChainIdBigInt(typedDataChainId)).finish();
}

/** The protobuf bytes of a task user Msg given in the writer's EncodeObject shape. */
export function encodeTaskMsg(msg: EncodeObject): Uint8Array {
  switch (msg.typeUrl) {
    case TYPE_URL.createSession:
      return encodeMsgCreateSession(msg.value as MsgCreateSession);
    case TYPE_URL.updateSessionKey:
      return encodeMsgUpdateSessionKey(msg.value as MsgUpdateSessionKey);
    case TYPE_URL.cancelOrder:
      return encodeMsgCancelOrder(msg.value as MsgCancelOrder);
    default:
      throw local('SDK_LOCAL_TX_MSG_UNSUPPORTED', `no protobuf encoder for ${msg.typeUrl} on the Web3 path`);
  }
}

export interface Web3TxRawInput {
  readonly msgTypeUrl: string;
  readonly msgBytes: Uint8Array;
  readonly memo: string;
  readonly typedDataChainId: bigint;
  /** 33-byte compressed eth_secp256k1 public key. */
  readonly pubKey: Uint8Array;
  readonly sequence: bigint;
  readonly fee: StdFee;
  /** 65-byte R||S||V. */
  readonly signature: Uint8Array;
}

/** Assembles the TxRaw bytes (fields in ascending order, defaults omitted: ADR-027). */
export function assembleWeb3TxRaw(input: Web3TxRawInput): Uint8Array {
  if (input.pubKey.length !== 33 || (input.pubKey[0] !== 0x02 && input.pubKey[0] !== 0x03)) {
    throw local('SDK_LOCAL_BAD_PUBKEY', 'the Web3 signer public key must be a 33-byte compressed point');
  }
  if (input.signature.length !== 65) throw local('SDK_LOCAL_BAD_SIGNATURE_LEN', `Web3 signature must be 65 bytes, got ${input.signature.length}`);
  const fee = web3Fee(input.fee);
  // cosmos.tx.v1beta1.TxBody: messages = 1, memo = 2, timeout_height = 3, unordered = 4,
  // timeout_timestamp = 5, extension_options = 1023, non_critical_extension_options = 2047.
  const body = new ProtoWriter()
    .message(1, encodeAny(input.msgTypeUrl, input.msgBytes))
    .string(2, input.memo)
    .message(1023, encodeAny(WEB3_EXTENSION_TYPE_URL, encodeExtensionOptionsWeb3Tx(input.typedDataChainId)))
    .finish();
  // ethsecp256k1.PubKey { bytes key = 1; }.
  const pubKeyAny = encodeAny(ETH_SECP256K1_PUBKEY_TYPE_URL, new ProtoWriter().bytes(1, input.pubKey).finish());
  // ModeInfo { Single single = 1; }, Single { SignMode mode = 1; }.
  const modeInfo = new ProtoWriter().message(1, new ProtoWriter().uint64(1, SIGN_MODE_LEGACY_AMINO_JSON).finish()).finish();
  // SignerInfo { Any public_key = 1; ModeInfo mode_info = 2; uint64 sequence = 3; }.
  const signerInfo = new ProtoWriter().message(1, pubKeyAny).message(2, modeInfo).uint64(3, input.sequence).finish();
  // Fee { repeated Coin amount = 1; uint64 gas_limit = 2; string payer = 3; string granter = 4; },
  // Coin { string denom = 1; string amount = 2; }.
  const feeWriter = new ProtoWriter();
  for (const coin of fee.amount) feeWriter.message(1, new ProtoWriter().string(1, coin.denom).string(2, coin.amount).finish());
  feeWriter.uint64(2, BigInt(fee.gas));
  // AuthInfo { repeated SignerInfo signer_infos = 1; Fee fee = 2; }.
  const authInfo = new ProtoWriter().message(1, signerInfo).message(2, feeWriter.finish()).finish();
  // TxRaw { bytes body_bytes = 1; bytes auth_info_bytes = 2; repeated bytes signatures = 3; }.
  return new ProtoWriter().bytes(1, body).bytes(2, authInfo).bytes(3, input.signature).finish();
}

export interface SignWeb3TxInput {
  readonly wallet: TypedDataSigner;
  /** Canonical Bech32 account address of the signer (the Msg's signer_address). */
  readonly signerAddress: string;
  /** The Cosmos chain-id string, signed inside the document. */
  readonly chainId: string;
  readonly accountNumber: bigint;
  readonly sequence: bigint;
  /**
   * The account's stored public key (33 bytes compressed), or undefined when the chain has none
   * yet (the account has never sent a transaction): it is then recovered from the signature.
   */
  readonly accountPubKey?: Uint8Array;
  readonly fee: StdFee;
  readonly memo?: string;
  /** The EIP-712 domain chainId, the wallet's network (1..MaxInt64). */
  readonly typedDataChainId: bigint | number | string;
  readonly msg: EncodeObject;
}

export interface SignedWeb3Tx {
  readonly txBytes: Uint8Array;
  /** The canonical Amino sign doc the signature commits to. */
  readonly signDoc: string;
  readonly typedData: TypedData;
  readonly signature: Uint8Array;
  /** The public key carried in the SignerInfo. */
  readonly pubKey: Uint8Array;
}

/** Builds, signs and assembles one Web3 transaction. */
export async function signWeb3Tx(input: SignWeb3TxInput): Promise<SignedWeb3Tx> {
  const typedDataChainId = signatureChainIdBigInt(input.typedDataChainId);
  const fee = web3Fee(input.fee);
  const memo = input.memo ?? '';
  const signerBytes = canonicalAccountAddressBytes('signerAddress', input.signerAddress);
  const signer = (input.msg.value as { signer?: unknown }).signer;
  if (signer !== input.signerAddress) {
    throw local('SDK_LOCAL_TX_SIGNER_MISMATCH', `the Msg signer ${String(signer)} is not the Web3 signer ${input.signerAddress}`);
  }
  if (input.accountPubKey !== undefined) {
    if (input.accountPubKey.length !== 33) {
      throw local('SDK_LOCAL_TX_PUBKEY_MISMATCH', `the account public key on chain is ${input.accountPubKey.length} bytes, not a 33-byte compressed key`);
    }
    let stored: Uint8Array;
    try {
      stored = ethAddressBytes(input.accountPubKey);
    } catch (cause) {
      throw local('SDK_LOCAL_TX_PUBKEY_MISMATCH', 'the account public key on chain is not a secp256k1 point', cause);
    }
    if (!bytesEqual(stored, signerBytes)) {
      // The node verifies against the stored key; a different one can never pass.
      throw local(
        'SDK_LOCAL_TX_PUBKEY_MISMATCH',
        `the account public key on chain derives 0x${toHex(stored)}, not the signer 0x${toHex(signerBytes)}`,
      );
    }
  }
  const msgBytes = encodeTaskMsg(input.msg);
  const signDoc = canonicalAminoSignDoc({
    chainId: input.chainId,
    accountNumber: input.accountNumber,
    sequence: input.sequence,
    fee,
    memo,
    msgs: [aminoMsgFromEncodeObject(input.msg)],
  });
  const typedData = cosmosWeb3TypedData(typedDataChainId, signDoc);
  // 65 bytes, V 27/28, low S, recovering to the signer: checked before anything is sent.
  const signature = await signTypedDataAs(input.wallet, typedData, signerBytes);
  const recovered = recoverEip712PubKey(typedDataDigest(typedData), signature);
  if (input.accountPubKey !== undefined && !bytesEqual(recovered, input.accountPubKey)) {
    throw local('SDK_LOCAL_TX_PUBKEY_MISMATCH', 'the Web3 signature does not recover to the account public key on chain');
  }
  const txBytes = assembleWeb3TxRaw({
    msgTypeUrl: input.msg.typeUrl,
    msgBytes,
    memo,
    typedDataChainId,
    pubKey: recovered,
    sequence: input.sequence,
    fee,
    signature,
  });
  return { txBytes, signDoc, typedData, signature, pubKey: recovered };
}

/**
 * The chain access the Web3 broadcaster needs. A CosmJS `StargateClient` connected with
 * `ethAccountParser` satisfies it structurally.
 */
export interface Web3ChainRpc {
  getChainId(): Promise<string>;
  getAccount(address: string): Promise<Account | null>;
  /** Broadcasts signed TxRaw bytes without waiting and returns the hash; throws on a CheckTx failure. */
  broadcastTxSync(tx: Uint8Array): Promise<string>;
  getTx(id: string): Promise<IndexedTx | null>;
}

export interface Web3TxBroadcasterOptions {
  readonly rpc: Web3ChainRpc;
  readonly wallet: TypedDataSigner;
  /** The EIP-712 domain chainId (the wallet's network; the client's signatureChainId). */
  readonly typedDataChainId: bigint | number | string;
}

/**
 * A TxBroadcaster that signs through an EIP-712 wallet: plugs into CosmjsChainWriter, so the
 * Web3 path shares its broadcast-once-then-poll handling and its error classification.
 */
export class Web3TxBroadcaster implements TxBroadcaster {
  private chainId: Promise<string> | undefined;
  private readonly typedDataChainId: bigint;

  constructor(private readonly opts: Web3TxBroadcasterOptions) {
    this.typedDataChainId = signatureChainIdBigInt(opts.typedDataChainId);
  }

  async signAndBroadcastSync(
    signerAddress: string,
    messages: readonly EncodeObject[],
    fee: StdFee | 'auto',
    memo?: string,
  ): Promise<string> {
    const explicitFee = web3Fee(fee);
    if (messages.length !== 1) {
      throw local('SDK_LOCAL_TX_MSG_UNSUPPORTED', `the Web3 path carries exactly one Msg, got ${messages.length}`);
    }
    this.chainId ??= this.opts.rpc.getChainId().catch((e: unknown) => {
      this.chainId = undefined;
      throw e;
    });
    const [chainId, account] = await Promise.all([this.chainId, this.opts.rpc.getAccount(signerAddress)]);
    if (account === null) {
      throw new TrueOpenError(
        'CHAIN_REJECT',
        'CHAIN_ACCOUNT_NOT_FOUND',
        `account ${signerAddress} does not exist on chain; fund it before sending a transaction`,
        { category: 'not-found' },
      );
    }
    const signed = await signWeb3Tx({
      wallet: this.opts.wallet,
      signerAddress,
      chainId,
      accountNumber: BigInt(account.accountNumber),
      sequence: BigInt(account.sequence),
      ...(account.pubkey !== null ? { accountPubKey: storedPubKey(account.pubkey) } : {}),
      fee: explicitFee,
      ...(memo !== undefined ? { memo } : {}),
      typedDataChainId: this.typedDataChainId,
      msg: messages[0]!,
    });
    return this.opts.rpc.broadcastTxSync(signed.txBytes);
  }

  getTx(id: string): Promise<IndexedTx | null> {
    return this.opts.rpc.getTx(id);
  }
}

/**
 * The account key as CosmJS reports it. ethAccountParser presents the stored eth_secp256k1 key
 * as a `tendermint/PubKeySecp256k1` of the same 33 bytes.
 */
function storedPubKey(pubkey: { readonly type: string; readonly value: unknown }): Uint8Array {
  if (pubkey.type !== 'tendermint/PubKeySecp256k1' || typeof pubkey.value !== 'string') {
    throw local('SDK_LOCAL_TX_PUBKEY_MISMATCH', `the account public key on chain has type ${pubkey.type}, not eth_secp256k1`);
  }
  const raw = atob(pubkey.value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
