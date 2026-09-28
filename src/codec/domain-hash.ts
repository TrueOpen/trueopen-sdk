import { sha256 } from './hash';
import { toHex } from '../util/bytes';

const enc = new TextEncoder();

/**
 * Reimplements node x/shared CanonicalHash / x/task domainHash:
 *   sha256( for each part: 8-byte big-endian UTF-8 byte length || the part's UTF-8 bytes )
 * The first part is the domain. Returns the raw 32 bytes.
 */
export function domainHash(domain: string, ...fields: string[]): Uint8Array {
  return canonicalHashBytes(enc.encode(domain), ...fields.map((f) => enc.encode(f)));
}

/**
 * The framing primitive for H_FIELDS_V1 (node x/shared CanonicalFrameBytes):
 *   for each part: 8-byte big-endian length || the part's raw bytes
 * It is both the framing for the top-level preimage and the framing for a **nested
 * FieldFrameV1** -- the latter is just missing the domain field. Returns the unhashed
 * frame bytes, so a nested message (Amount / GenerationParams / DeadlinePolicy) can be
 * folded back in as a single field of the outer frame.
 */
export function canonicalFrameBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += 8 + p.length;

  const framed = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    const len = BigInt(p.length);
    for (let i = 0; i < 8; i++) {
      framed[off + i] = Number((len >> BigInt(8 * (7 - i))) & 0xffn);
    }
    off += 8;
    framed.set(p, off);
    off += p.length;
  }
  return framed;
}

/**
 * node x/shared CanonicalHashBytes: sha256(canonicalFrameBytes(parts...)).
 * A part is **raw bytes**, not UTF-8 text; a Hash32 (e.g. session_id's 32 bytes) and a
 * big-endian integer must go through here -- framing them as text would produce a
 * different preimage. Pass the domain in as the first part.
 */
export function canonicalHashBytes(...parts: Uint8Array[]): Uint8Array {
  return sha256(canonicalFrameBytes(...parts));
}

/**
 * OPTIONAL_V1: absent is the single byte 0x00; present is 0x01 || FRAME_V1(value). An absent
 * field and a present empty or zero value are different preimages.
 */
export function optionalV1(value: Uint8Array | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array([0x00]);
  const framed = canonicalFrameBytes(value);
  const out = new Uint8Array(1 + framed.length);
  out[0] = 0x01;
  out.set(framed, 1);
  return out;
}

/** node shared.Uint32BE: the 4-byte big-endian encoding of a uint32. */
export function uint32BE(value: number): Uint8Array {
  const out = new Uint8Array(4);
  const v = value >>> 0;
  out[0] = (v >>> 24) & 0xff;
  out[1] = (v >>> 16) & 0xff;
  out[2] = (v >>> 8) & 0xff;
  out[3] = v & 0xff;
  return out;
}

/**
 * node shared.Int32BE: reinterprets the value as a uint32 via two's complement, then
 * writes it big-endian.
 * A negative value (e.g. presence_penalty_milli = -500) must go through here, and must
 * never be converted to decimal text first.
 */
export function int32BE(value: number): Uint8Array {
  return uint32BE(value | 0);
}

/** node shared.Uint64BE: the 8-byte big-endian encoding of a uint64. */
export function uint64BE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = Number((value >> BigInt(8 * (7 - i))) & 0xffn);
  }
  return out;
}

/** node shared.BoolByte: 0x00 / 0x01. */
export function boolByte(value: boolean): Uint8Array {
  return new Uint8Array([value ? 1 : 0]);
}

/** node shared.EnumBE: an enum value is written as a big-endian uint32, not as its name text. */
export function enumBE(value: number): Uint8Array {
  return uint32BE(value);
}

export function domainHashHex(domain: string, ...fields: string[]): string {
  return toHex(domainHash(domain, ...fields));
}

const FRAME_V1_TAG = enc.encode('TRUEOPEN_FRAME_V1');

/**
 * The H_V1 preimage (wire registry/v1/framing.json):
 *   ascii("TRUEOPEN_FRAME_V1") || u32_be(len(domain)) || domain || u64_be(len(payload)) || payload
 * Distinct from H_FIELDS_V1: a single opaque payload (for example canonical JSON bytes)
 * rather than a list of fields.
 */
export function framedV1Preimage(domain: string, payload: Uint8Array): Uint8Array {
  const d = enc.encode(domain);
  const out = new Uint8Array(FRAME_V1_TAG.length + 4 + d.length + 8 + payload.length);
  let off = 0;
  out.set(FRAME_V1_TAG, off);
  off += FRAME_V1_TAG.length;
  out.set(uint32BE(d.length), off);
  off += 4;
  out.set(d, off);
  off += d.length;
  out.set(uint64BE(BigInt(payload.length)), off);
  off += 8;
  out.set(payload, off);
  return out;
}

/** H_V1(domain, payload) = sha256(framedV1Preimage(domain, payload)). Raw 32 bytes. */
export function framedHashV1(domain: string, payload: Uint8Array): Uint8Array {
  return sha256(framedV1Preimage(domain, payload));
}
