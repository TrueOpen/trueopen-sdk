import { sha256 } from './hash';
import { TrueOpenError } from '../errors/errors';

const enc = new TextEncoder();

/**
 * The literal that opens every H_V1 preimage. It is part of the hashed bytes, not a comment:
 * two framings that hashed the same payload under the same domain would otherwise collide.
 */
export const H_V1_FRAME_PREFIX = 'TRUEOPEN_FRAME_V1';

/**
 * Builds the H_V1 preimage: `TRUEOPEN_FRAME_V1` then a **u32** big-endian domain length,
 * the domain, a **u64** big-endian payload length, and the payload.
 *
 * The width asymmetry is deliberate on wire's side and was read off a published preimage,
 * not inferred. Do not "fix" it to match `canonicalFrameBytes`, which is a different
 * framing (`H_FIELDS_V1`: 8-byte lengths throughout, domain as the first part). This SDK now
 * carries three framings -- `frame4`, `canonicalFrameBytes` and this one -- and they are not
 * interchangeable; wire's registry names the framing for every domain, and only seven of its
 * registered domains use this one.
 */
export function hV1Preimage(domain: string, payload: Uint8Array): Uint8Array {
  const domainBytes = enc.encode(domain);
  if (domainBytes.length !== domain.length) {
    // The length prefix counts bytes. Every registered domain is ASCII, so rather than
    // leave a byte-versus-character ambiguity for a future non-ASCII domain, refuse it.
    throw new TrueOpenError(
      'SDK_LOCAL',
      'H_V1_DOMAIN_NOT_ASCII',
      `H_V1 domain must be ASCII, got ${JSON.stringify(domain)}`,
    );
  }
  const prefix = enc.encode(H_V1_FRAME_PREFIX);
  const out = new Uint8Array(prefix.length + 4 + domainBytes.length + 8 + payload.length);
  let off = 0;

  out.set(prefix, off);
  off += prefix.length;

  const dLen = domainBytes.length;
  out[off] = (dLen >>> 24) & 0xff;
  out[off + 1] = (dLen >>> 16) & 0xff;
  out[off + 2] = (dLen >>> 8) & 0xff;
  out[off + 3] = dLen & 0xff;
  off += 4;

  out.set(domainBytes, off);
  off += domainBytes.length;

  const pLen = BigInt(payload.length);
  for (let i = 0; i < 8; i += 1) {
    out[off + i] = Number((pLen >> BigInt(8 * (7 - i))) & 0xffn);
  }
  off += 8;

  out.set(payload, off);
  return out;
}

/** sha256 of the H_V1 preimage. Returns the raw 32 bytes. */
export function hV1(domain: string, payload: Uint8Array): Uint8Array {
  return sha256(hV1Preimage(domain, payload));
}
