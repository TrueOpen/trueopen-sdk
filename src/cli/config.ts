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
  /**
   * Optional override for the order's EIP-712 feeDenom. The chain's
   * `params.phase0.business_denom` is authoritative; an override that disagrees with it is
   * refused before anything is signed. There is no default.
   */
  readonly feeDenom?: string;
  readonly prefix: string;
  /**
   * Gas price as given: `<amount>` (the denom is then the chain business_denom, the only fee
   * denom the chain accepts) or `<amount><denom>`. Undefined means the default amount.
   */
  readonly gasPrice?: string;
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

/** Default gas price amount; the denom always comes from the chain. */
export const DEFAULT_GAS_PRICE_AMOUNT = '0.025';

/**
 * The gas price to sign tx fees with. The chain accepts fees only in its business_denom, so
 * a bare amount gets that denom, and an explicit denom must match it.
 */
export function resolveGasPrice(gasPrice: string | undefined, businessDenom: string): string {
  const raw = (gasPrice ?? DEFAULT_GAS_PRICE_AMOUNT).trim();
  const m = /^([0-9]+(?:\.[0-9]+)?)([a-zA-Z][a-zA-Z0-9/:._-]*)?$/.exec(raw);
  if (!m) throw new TrueOpenError('SDK_LOCAL', 'CLI_GAS_PRICE_INVALID', `gas price ${JSON.stringify(raw)} is not <amount> or <amount><denom>`);
  const [, amount, denom] = m;
  if (denom !== undefined && denom !== businessDenom) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'CLI_GAS_PRICE_DENOM_MISMATCH',
      `gas price denom ${denom} is not the chain business_denom ${businessDenom}, the only fee denom the chain accepts`,
    );
  }
  return `${amount}${businessDenom}`;
}

export function resolveConfig(o: CliOptions, env: NodeJS.ProcessEnv): CliConfig {
  const restUrl = pick(o.restUrl, env['TRUEOPEN_REST_URL']);
  const rpcUrl = pick(o.rpcUrl, env['TRUEOPEN_RPC_URL']);
  const nexusUrl = pick(o.nexusUrl, env['TRUEOPEN_NEXUS_URL']);
  const nexusTlsPubkeyHash = pick(o.nexusTlsPubkeyHash, env['TRUEOPEN_NEXUS_TLS_PUBKEY_HASH']);
  const chainId = pick(o.chainId, env['TRUEOPEN_CHAIN_ID']);
  const evmChainIdRaw = pick(o.evmChainId, env['TRUEOPEN_EVM_CHAIN_ID']);
  const evmChainId = evmChainIdRaw === undefined ? undefined : BigInt(evmChainIdRaw);
  const feeDenom = pick(o.feeDenom, env['TRUEOPEN_FEE_DENOM']);
  const prefix = pick(o.prefix, env['TRUEOPEN_ADDR_PREFIX']) ?? 'trueopen';
  const gasPrice = pick(o.gasPrice, env['TRUEOPEN_GAS_PRICE']);
  const gas = pick(o.gas, env['TRUEOPEN_GAS']) ?? '300000';
  return {
    ...(restUrl !== undefined ? { restUrl } : {}),
    ...(rpcUrl !== undefined ? { rpcUrl } : {}),
    ...(nexusUrl !== undefined ? { nexusUrl } : {}),
    ...(nexusTlsPubkeyHash !== undefined ? { nexusTlsPubkeyHash } : {}),
    auto: o.auto === true,
    ...(chainId !== undefined ? { chainId } : {}),
    ...(evmChainId !== undefined ? { evmChainId } : {}),
    ...(feeDenom !== undefined ? { feeDenom } : {}),
    prefix,
    ...(gasPrice !== undefined ? { gasPrice } : {}),
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
