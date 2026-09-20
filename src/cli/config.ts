import { readFileSync } from 'node:fs';
import { TrueOpenError } from '../errors/errors';

/** Global options collected by commander (camelCase). */
export interface CliOptions {
  restUrl?: string;
  rpcUrl?: string;
  nexusUrl?: string;
  nexusTlsPubkeyHash?: string;
  auto?: boolean;
  chainId?: string;
  evmChainId?: string;
  feeDenom?: string;
  prefix?: string;
  gasPrice?: string;
  gas?: string;
  keyFile?: string;
  json?: boolean;
  verbose?: boolean;
}

export interface CliConfig {
  readonly restUrl?: string;
  readonly rpcUrl?: string;
  readonly nexusUrl?: string;
  /** The certificate public key sha256 (hex) to use when manually specifying --nexus-url; endpoints discovered on chain get it from the descriptor instead. */
  readonly nexusTlsPubkeyHash?: string;
  readonly auto: boolean;
  readonly chainId?: string;
  /**
   * The numeric EVM chain ID used in the EIP-712 domain. When not provided, it's read from
   * `params.phase0.evm_chain_id` on chain -- there is no hardcoded default, since wire test vectors use
   * 424242 while devnet is actually 31337, and getting it wrong just produces "invalid signature".
   */
  readonly evmChainId?: bigint;
  /** The feeDenom that goes into the order's EIP-712 signature. Amount only carries atomic_units; the denom is determined by chain parameters. */
  readonly feeDenom: string;
  readonly prefix: string;
  readonly gasPrice: string;
  /** The gas limit per tx. Cannot be 'auto' -- see the explanation in context.ts. */
  readonly gas: string;
  readonly json: boolean;
  readonly verbose: boolean;
  requireRest(): string;
  requireRpc(): string;
  requireChainId(): string;
}

function pick(flag: string | undefined, env: string | undefined): string | undefined {
  return flag ?? (env !== undefined && env !== '' ? env : undefined);
}
function req(name: string, v: string | undefined): string {
  if (!v) throw new TrueOpenError('SDK_LOCAL', 'CLI_MISSING_CONFIG', `missing config ${name} (provide it via flag or environment variable)`);
  return v;
}

export function resolveConfig(o: CliOptions, env: NodeJS.ProcessEnv): CliConfig {
  const restUrl = pick(o.restUrl, env['TRUEOPEN_REST_URL']);
  const rpcUrl = pick(o.rpcUrl, env['TRUEOPEN_RPC_URL']);
  const nexusUrl = pick(o.nexusUrl, env['TRUEOPEN_NEXUS_URL']);
  const nexusTlsPubkeyHash = pick(o.nexusTlsPubkeyHash, env['TRUEOPEN_NEXUS_TLS_PUBKEY_HASH']);
  const chainId = pick(o.chainId, env['TRUEOPEN_CHAIN_ID']);
  const evmChainIdRaw = pick(o.evmChainId, env['TRUEOPEN_EVM_CHAIN_ID']);
  const evmChainId = evmChainIdRaw === undefined ? undefined : BigInt(evmChainIdRaw);
  const feeDenom = pick(o.feeDenom, env['TRUEOPEN_FEE_DENOM']) ?? 'uusdc';
  const prefix = pick(o.prefix, env['TRUEOPEN_ADDR_PREFIX']) ?? 'trueopen';
  const gasPrice = pick(o.gasPrice, env['TRUEOPEN_GAS_PRICE']) ?? '0.025uusdc';
  const gas = pick(o.gas, env['TRUEOPEN_GAS']) ?? '300000';
  return {
    ...(restUrl !== undefined ? { restUrl } : {}),
    ...(rpcUrl !== undefined ? { rpcUrl } : {}),
    ...(nexusUrl !== undefined ? { nexusUrl } : {}),
    ...(nexusTlsPubkeyHash !== undefined ? { nexusTlsPubkeyHash } : {}),
    auto: o.auto === true,
    ...(chainId !== undefined ? { chainId } : {}),
    ...(evmChainId !== undefined ? { evmChainId } : {}),
    feeDenom,
    prefix,
    gasPrice,
    gas,
    json: o.json === true,
    verbose: o.verbose === true,
    requireRest() {
      return req('--rest-url / TRUEOPEN_REST_URL', restUrl);
    },
    requireRpc() {
      return req('--rpc-url / TRUEOPEN_RPC_URL', rpcUrl);
    },
    requireChainId() {
      return req('--chain-id / TRUEOPEN_CHAIN_ID', chainId);
    },
  };
}

/** Mnemonic: only --key-file (file contents) or TRUEOPEN_MNEMONIC; a plaintext command-line argument is never accepted. */
export function loadMnemonic(o: CliOptions, env: NodeJS.ProcessEnv): string {
  if (o.keyFile) return readFileSync(o.keyFile, 'utf8').trim();
  const envM = env['TRUEOPEN_MNEMONIC'];
  if (envM && envM.trim() !== '') return envM.trim();
  throw new TrueOpenError('SDK_AUTH', 'CLI_MISSING_KEY', 'mnemonic required: set --key-file <path> or TRUEOPEN_MNEMONIC');
}
