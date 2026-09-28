import { bech32 } from '@scure/base';
import { TrueOpenError } from '../errors/errors';
import { fromHex } from '../util/bytes';

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

/** The chain's account address prefix (Bech32 HRP). */
export const ACCOUNT_ADDRESS_PREFIX = 'trueopen';

/**
 * A user account address as the contract requires it wherever an account is signed or framed
 * (OpenTaskHeader.user_address and its body field, SDKRequestEnvelopeV2.signer_address):
 * canonical lowercase Bech32 with the account prefix `trueopen`, decoding to exactly 20 bytes.
 * Returns the 20 address bytes.
 */
export function canonicalAccountAddressBytes(field: string, value: string): Uint8Array {
  const raw = canonicalOperatorAddressBytes(field, value);
  if (!value.startsWith(`${ACCOUNT_ADDRESS_PREFIX}1`) || value.lastIndexOf('1') !== ACCOUNT_ADDRESS_PREFIX.length) {
    throw malformed(field, `must use the account prefix ${ACCOUNT_ADDRESS_PREFIX}`);
  }
  if (raw.length !== 20) throw malformed(field, `decodes to ${raw.length} address bytes, not 20`);
  return raw;
}

/**
 * The canonical Bech32 account address for what a caller or a wallet supplies: a 0x-prefixed
 * 20-byte EVM address (as an EIP-1193 wallet reports it) is converted; a Bech32 address must
 * already be canonical with the account prefix.
 */
export function toAccountAddress(value: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return bech32.encode(ACCOUNT_ADDRESS_PREFIX, bech32.toWords(fromHex(value.slice(2))));
  }
  canonicalAccountAddressBytes('address', value);
  return value;
}

function malformed(field: string, why: string, cause?: unknown): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_ADDRESS_NOT_CANONICAL', `${field} ${why}`, {
    ...(cause !== undefined ? { cause } : {}),
  });
}
