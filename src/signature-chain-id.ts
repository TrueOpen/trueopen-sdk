import { TrueOpenError } from './errors/errors';

/**
 * The default EIP-712 domain chainId for signatures this SDK makes on behalf of a session key or
 * a server-side key, where there is no wallet network to ask (ADR-0033 decision 1). A browser
 * wallet supplies its own active network instead; a caller overrides this with
 * `TrueOpenClientConfig.signatureChainId`. Value 1 is Ethereum mainnet, pending Keplr
 * `signEthereum` testing.
 */
export const DEFAULT_SIGNATURE_CHAIN_ID = 1n;

/** signature_chain_id is uint64 on the wire but restricted to 1..MaxInt64 (0 is CORTEX_SERVICE only). */
const SIGNATURE_CHAIN_ID_MAX = (1n << 63n) - 1n;

/**
 * Normalizes a signer-chosen `signature_chain_id` to a bigint, refusing 0, negatives and
 * overflow. The USER branch (every signature this SDK makes) must carry a value in 1..MaxInt64;
 * a CORTEX_SERVICE request's 0 is never produced here.
 */
export function signatureChainIdBigInt(value: bigint | number | string): bigint {
  const v = BigInt(value);
  if (v < 1n || v > SIGNATURE_CHAIN_ID_MAX) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'SDK_LOCAL_SIGNATURE_CHAIN_ID_INVALID',
      `signature_chain_id ${value} is outside (0, 2^63-1]`,
    );
  }
  return v;
}
