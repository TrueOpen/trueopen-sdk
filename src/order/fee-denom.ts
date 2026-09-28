import { TrueOpenError } from '../errors/errors';

/**
 * Picks the denom that goes into the order's EIP-712 `feeDenom`.
 *
 * The chain value (`params.phase0.business_denom`) is authoritative: the Keeper rebuilds the
 * order digest with it, so a different denom is accepted by nexus and then rejected on chain,
 * and the task silently disappears. An explicit override is still accepted, but only as an
 * assertion -- if it disagrees with the chain value the order is refused locally, before
 * anything is signed.
 */
export function resolveFeeDenom(chainDenom: string | undefined, override: string | undefined): string {
  const wanted = override?.trim() === '' ? undefined : override?.trim();
  if (chainDenom === undefined || chainDenom === '') {
    if (wanted === undefined) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_FEE_DENOM_UNAVAILABLE',
        'fee denom is unknown: configure a hub reader that can read params.phase0.business_denom, or pass feeDenom explicitly',
      );
    }
    return wanted;
  }
  if (wanted !== undefined && wanted !== chainDenom) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'SDK_LOCAL_FEE_DENOM_MISMATCH',
      `feeDenom override ${JSON.stringify(wanted)} does not match the chain business_denom ${JSON.stringify(chainDenom)}; ` +
        'the chain would reject the order after nexus accepted it',
    );
  }
  return chainDenom;
}
