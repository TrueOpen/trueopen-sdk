import { fromHex } from '../util/bytes';
import { TrueOpenError } from '../errors/errors';

/**
 * The one strict Hash32 decode for request projections: exactly 64 lowercase hex characters,
 * no 0x prefix. Any other spelling (uppercase, 0x, another length) is not projectable and is
 * refused before a digest is built, as the Builder does.
 */
export function strictHash32(field: string, hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'SDK_LOCAL_NOT_HASH32',
      `${field} must be 64-character lowercase hex without 0x, got ${JSON.stringify(hex)}`,
    );
  }
  return fromHex(hex);
}
