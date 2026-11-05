import { TrueOpenError } from '../errors/errors';

/**
 * The V1 protocol ceiling on an order's lifetime, `order_expire_height - earliest_submit_height`
 * (wire `dispatch.MaxOrderLifetimeBlocksV1`). A Session's frozen `max_order_lifetime_blocks` may be
 * lower; it is never higher.
 */
export const MAX_ORDER_LIFETIME_BLOCKS_V1 = 7200n;

const MAX_INT64 = (1n << 63n) - 1n;

/**
 * Checks a signed order's expiry against its Session's frozen lifetime, as wire's
 * `dispatch.ValidateOrderLifetime` does (vectors: `testdata/v1/task/order_lifetime_v1.json`):
 * `maximum` in 1..7200, both heights positive and within int64, and
 * `0 < expiry - earliest <= maximum`. Admission refuses an order outside it, so the SDK refuses to
 * sign one. Throws `SDK_LOCAL_ORDER_LIFETIME_INVALID`.
 */
export function validateOrderLifetime(earliestSubmitHeight: bigint, orderExpireHeight: bigint, maxOrderLifetimeBlocks: bigint): void {
  if (maxOrderLifetimeBlocks <= 0n || maxOrderLifetimeBlocks > MAX_ORDER_LIFETIME_BLOCKS_V1) {
    throw lifetimeError(`max_order_lifetime_blocks must be in 1..${MAX_ORDER_LIFETIME_BLOCKS_V1}, got ${maxOrderLifetimeBlocks}`);
  }
  if (earliestSubmitHeight <= 0n || earliestSubmitHeight > MAX_INT64 || orderExpireHeight > MAX_INT64 || orderExpireHeight <= earliestSubmitHeight) {
    throw lifetimeError(`order_expire_height ${orderExpireHeight} must be after earliest_submit_height ${earliestSubmitHeight}, both within int64`);
  }
  if (orderExpireHeight - earliestSubmitHeight > maxOrderLifetimeBlocks) {
    throw lifetimeError(
      `order lifetime ${orderExpireHeight - earliestSubmitHeight} blocks exceeds the Session's max_order_lifetime_blocks ${maxOrderLifetimeBlocks}`,
    );
  }
}

function lifetimeError(message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_ORDER_LIFETIME_INVALID', message, { category: 'invalid' });
}
