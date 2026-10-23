import { SigningStargateClient, StargateClient } from '@cosmjs/stargate';
import type { GasPrice, StdFee } from '@cosmjs/stargate';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import { TrueOpenError } from '../errors/errors';
import { RestChainReader } from './rest-chain-reader';
import type { FetchLike, FetchResponse } from './rest-chain-reader';
import { CosmjsChainWriter, composeChainClient } from './cosmjs-chain-writer';
import type { TxBroadcaster, TxInclusionPolicy } from './cosmjs-chain-writer';
import { taskRegistry } from './cosmjs-registry';
import { ethAccountParser } from '../signer/eth-direct-signer';
import { toAccountAddress } from '../codec/address';
import { signatureChainIdBigInt } from '../signature-chain-id';
import type { ChainClient } from './chain-client';
import { Web3TxBroadcaster } from './web3-tx';
import type { Web3ChainRpc } from './web3-tx';
import type { TypedDataSigner } from '../signer/typed-data-signer';
import { web3Fee } from './amino-json';

/**
 * Synchronously composes a full ChainClient: REST reads + CosmJS writes.
 * The broadcaster is supplied by the caller (SigningStargateClient satisfies
 * TxBroadcaster), so this factory can be unit tested with a fake broadcaster
 * and a stub fetch, with no real node required.
 */
export interface CreateTrueOpenChainClientConfig {
  readonly restUrl: string;
  readonly signerAddress: string;
  readonly fee: StdFee | 'auto';
  readonly broadcaster: TxBroadcaster;
  readonly fetch?: FetchLike;
  readonly memo?: string;
  /** How long to wait for inclusion after a broadcast; defaults to DEFAULT_TX_INCLUSION. */
  readonly inclusion?: TxInclusionPolicy;
}

export function createTrueOpenChainClient(cfg: CreateTrueOpenChainClientConfig): ChainClient {
  const reader = new RestChainReader({ baseUrl: cfg.restUrl, fetch: resolveFetch(cfg.fetch) });
  const writer = new CosmjsChainWriter({
    broadcaster: cfg.broadcaster,
    signerAddress: cfg.signerAddress,
    fee: cfg.fee,
    ...(cfg.memo !== undefined ? { memo: cfg.memo } : {}),
    ...(cfg.inclusion !== undefined ? { inclusion: cfg.inclusion } : {}),
  });
  return composeChainClient(reader, writer);
}

/**
 * Asynchronously connects: builds a SigningStargateClient (with the task
 * registry + EthAccount parser), then composes a full ChainClient. Requires a
 * real RPC/REST node, so this is an integration-test path (can't be unit
 * tested without a node).
 *
 * signer must be an EthSecp256k1DirectSigner (see signer/eth-direct-signer):
 * node's DIRECT path verifies keccak256(SignDoc) and requires an ethsecp256k1
 * public key, none of which CosmJS's built-in DirectSecp256k1HdWallet
 * satisfies.
 * Returns signingClient so the caller can disconnect() when done.
 */
export interface ConnectTrueOpenChainClientOptions {
  readonly rpcUrl: string;
  readonly restUrl: string;
  readonly signer: OfflineSigner;
  readonly signerAddress: string;
  readonly fee: StdFee | 'auto';
  readonly gasPrice?: GasPrice;
  readonly memo?: string;
  readonly fetch?: FetchLike;
}

export async function connectTrueOpenChainClient(
  opts: ConnectTrueOpenChainClientOptions,
): Promise<{ client: ChainClient; signingClient: SigningStargateClient }> {
  const signingClient = await SigningStargateClient.connectWithSigner(opts.rpcUrl, opts.signer, {
    registry: taskRegistry(),
    // node uses cosmos/evm's EthAccount, which CosmJS's built-in accountFromAny
    // doesn't recognize -- it can't even read account_number / sequence off it.
    accountParser: ethAccountParser,
    ...(opts.gasPrice !== undefined ? { gasPrice: opts.gasPrice } : {}),
  });
  const client = createTrueOpenChainClient({
    restUrl: opts.restUrl,
    signerAddress: opts.signerAddress,
    fee: opts.fee,
    broadcaster: signingClient,
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    ...(opts.memo !== undefined ? { memo: opts.memo } : {}),
  });
  return { client, signingClient };
}

/**
 * The Web3 path: the same ChainClient, signed by an EIP-712 wallet (MetaMask or any EIP-1193
 * provider through eip1193TypedDataSigner, Keplr through keplrTypedDataSigner, or
 * privateKeyTypedDataSigner) instead of a DIRECT signer. Each transaction carries the
 * ExtensionOptionsWeb3Tx option and a SIGN_MODE_LEGACY_AMINO_JSON signature over the Cosmos
 * Web3 typed data of its Amino sign doc (see transport/web3-tx).
 *
 * One Msg per transaction, no fee payer or granter, and an explicit fee: the node only
 * simulates DIRECT transactions, so 'auto' is refused. The account must exist on chain (it
 * pays the fee); when it has no public key yet, the key is recovered from the wallet signature.
 * Returns the StargateClient so the caller can disconnect() when done.
 */
export interface ConnectTrueOpenWeb3ChainClientOptions {
  readonly rpcUrl: string;
  readonly restUrl: string;
  readonly wallet: TypedDataSigner;
  /** Bech32 account address of the wallet account (a 0x address is converted). */
  readonly signerAddress: string;
  /**
   * The EIP-712 domain chainId the wallet signs under: its active network, i.e. the client's
   * signatureChainId (1..MaxInt64).
   */
  readonly typedDataChainId: bigint | number | string;
  readonly fee: StdFee;
  readonly memo?: string;
  readonly fetch?: FetchLike;
  /** How long to wait for inclusion after a broadcast; defaults to DEFAULT_TX_INCLUSION. */
  readonly inclusion?: TxInclusionPolicy;
}

export async function connectTrueOpenWeb3ChainClient(
  opts: ConnectTrueOpenWeb3ChainClientOptions,
): Promise<{ client: ChainClient; queryClient: StargateClient }> {
  // Everything checkable locally is checked before a connection is opened.
  web3Fee(opts.fee as StdFee | 'auto');
  toAccountAddress(opts.signerAddress);
  signatureChainIdBigInt(opts.typedDataChainId);
  const queryClient = await StargateClient.connect(opts.rpcUrl, { accountParser: ethAccountParser });
  return { client: createTrueOpenWeb3ChainClient({ ...opts, rpc: queryClient }), queryClient };
}

/**
 * Synchronous form of connectTrueOpenWeb3ChainClient with the chain RPC injected (a
 * StargateClient connected with ethAccountParser satisfies Web3ChainRpc), for tests and for
 * callers that manage the connection themselves.
 */
export interface CreateTrueOpenWeb3ChainClientConfig extends Omit<ConnectTrueOpenWeb3ChainClientOptions, 'rpcUrl'> {
  readonly rpc: Web3ChainRpc;
}

export function createTrueOpenWeb3ChainClient(cfg: CreateTrueOpenWeb3ChainClientConfig): ChainClient {
  return createTrueOpenChainClient({
    restUrl: cfg.restUrl,
    signerAddress: toAccountAddress(cfg.signerAddress),
    fee: web3Fee(cfg.fee as StdFee | 'auto'),
    broadcaster: new Web3TxBroadcaster({ rpc: cfg.rpc, wallet: cfg.wallet, typedDataChainId: cfg.typedDataChainId }),
    ...(cfg.fetch !== undefined ? { fetch: cfg.fetch } : {}),
    ...(cfg.memo !== undefined ? { memo: cfg.memo } : {}),
    ...(cfg.inclusion !== undefined ? { inclusion: cfg.inclusion } : {}),
  });
}

/** Defaults to the runtime's global fetch (Node 18+ / browser); it structurally satisfies FetchLike. */
function resolveFetch(f?: FetchLike): FetchLike {
  if (f) return f;
  const g = (globalThis as { fetch?: (url: string) => Promise<FetchResponse> }).fetch;
  if (!g) {
    throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_NO_FETCH', 'no global fetch available; pass config.fetch');
  }
  return (url) => g(url);
}
