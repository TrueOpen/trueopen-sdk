import { SigningStargateClient } from '@cosmjs/stargate';
import type { GasPrice, StdFee } from '@cosmjs/stargate';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import { TrueOpenError } from '../errors/errors';
import { RestChainReader } from './rest-chain-reader';
import type { FetchLike, FetchResponse } from './rest-chain-reader';
import { CosmjsChainWriter, composeChainClient } from './cosmjs-chain-writer';
import type { TxBroadcaster } from './cosmjs-chain-writer';
import { taskRegistry } from './cosmjs-registry';
import { ethAccountParser } from '../signer/eth-direct-signer';
import type { ChainClient } from './chain-client';

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
}

export function createTrueOpenChainClient(cfg: CreateTrueOpenChainClientConfig): ChainClient {
  const reader = new RestChainReader({ baseUrl: cfg.restUrl, fetch: resolveFetch(cfg.fetch) });
  const writer = new CosmjsChainWriter({
    broadcaster: cfg.broadcaster,
    signerAddress: cfg.signerAddress,
    fee: cfg.fee,
    ...(cfg.memo !== undefined ? { memo: cfg.memo } : {}),
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

/** Defaults to the runtime's global fetch (Node 18+ / browser); it structurally satisfies FetchLike. */
function resolveFetch(f?: FetchLike): FetchLike {
  if (f) return f;
  const g = (globalThis as { fetch?: (url: string) => Promise<FetchResponse> }).fetch;
  if (!g) {
    throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_NO_FETCH', 'no global fetch available; pass config.fetch');
  }
  return (url) => g(url);
}
