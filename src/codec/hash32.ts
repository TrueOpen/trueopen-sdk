import { fromHex, toHex } from '../util/bytes';
import { TrueOpenError } from '../errors/errors';

/**
 * The one client-facing text form of a Hash32 (ADR-0034): `0x` followed by exactly 64 lowercase
 * hex characters, 66 in all. Every Hash32 the SDK returns is written in it and every Hash32 it
 * accepts must already be in it; a bare 64-hex string, uppercase hex, `0X` or another length is
 * not a Hash32.
 */
export const HASH32_TEXT_RE = /^0x[0-9a-f]{64}$/;

/** True when `value` is a Hash32 in its canonical text form (`0x` + 64 lowercase hex). */
export function isHash32Text(value: unknown): value is string {
  return typeof value === 'string' && HASH32_TEXT_RE.test(value);
}

/** Writes a raw 32-byte digest/ID as its canonical text form, `0x` + 64 lowercase hex. */
export function hash32Text(bytes: Uint8Array): string {
  if (bytes.length !== 32) {
    throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_NOT_HASH32', `a Hash32 is 32 bytes, got ${bytes.length}`);
  }
  return `0x${toHex(bytes)}`;
}

/**
 * The one strict Hash32 decode: exactly `0x` followed by 64 lowercase hex characters, decoded to
 * raw32. Any other spelling (bare hex, uppercase, `0X`, another length) is not projectable and is
 * refused before a digest is built, as the Builder does.
 */
export function strictHash32(field: string, text: string): Uint8Array {
  if (!isHash32Text(text)) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'SDK_LOCAL_NOT_HASH32',
      `${field} must be 0x followed by 64 lowercase hex characters, got ${JSON.stringify(text)}`,
    );
  }
  return fromHex(text.slice(2));
}
