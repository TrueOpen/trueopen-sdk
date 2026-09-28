import { bech32 } from '@scure/base';
import { TrueOpenError } from '../errors/errors';

/**
 * Converts a bech32 operator address into the address codec bytes actually used by the
 * H_FIELDS_V1 preimage framing (mirrors nexus internal/nodecontract/hfields.go:CanonicalOperatorAddressBytes).
 *
 * The bech32 text itself **never goes into the preimage**: the human-readable prefix belongs to the
 * display layer, and cross-chain isolation is handled by the chain_id field. So this returns the
 * decoded raw address bytes (20 bytes for a Cosmos account).
 *
 * A pure function with no dependency on a global prefix: it decodes and then re-encodes to check
 * round-trip equality, rejecting an empty string, leading/trailing whitespace, a non-canonical
 * encoding (including uppercase), and an out-of-range length.
 */
export function canonicalOperatorAddressBytes(field: string, value: string): Uint8Array {
  if (value === '') {
    throw malformed(field, 'must be a non-empty canonical Bech32 address');
  }
  if (value.trim() !== value) {
    throw malformed(field, 'must not carry leading or trailing whitespace');
  }
  let prefix: string;
  let raw: Uint8Array;
  try {
    const decoded = bech32.decode(value as `${string}1${string}`);
    prefix = decoded.prefix;
    raw = bech32.fromWords(decoded.words);
  } catch (e) {
    throw malformed(field, 'is not a decodable Bech32 address', e);
  }
  // Matches cosmos-sdk's address length ceiling; the H_FIELDS_V1 framing operates on codec bytes,
  // so the only structural upper bound a derived function can enforce is the codec's own.
  if (raw.length === 0 || raw.length > 255) {
    throw malformed(field, `decodes to ${raw.length} address bytes, outside 1..255`);
  }
  if (bech32.encode(prefix, bech32.toWords(raw)) !== value) {
    throw malformed(field, 'must be the canonical Bech32 encoding of its address bytes');
  }
  return raw;
}

/**
 * A user account address: canonical Bech32 that decodes to exactly 20 bytes (the EVM-style
 * keccak256(pubkey)[12:] address). Used where the contract frames an account as its 20 address
 * bytes, such as the OpenTask body user_address. When `prefix` is given the HRP must equal it.
 */
export function canonicalAccountAddressBytes(field: string, value: string, prefix?: string): Uint8Array {
  const raw = canonicalOperatorAddressBytes(field, value);
  if (raw.length !== 20) throw malformed(field, `decodes to ${raw.length} address bytes, not 20`);
  if (prefix !== undefined && !value.startsWith(`${prefix}1`)) throw malformed(field, `must use the account prefix ${prefix}`);
  return raw;
}

function malformed(field: string, why: string, cause?: unknown): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_ADDRESS_NOT_CANONICAL', `${field} ${why}`, {
    ...(cause !== undefined ? { cause } : {}),
  });
}
