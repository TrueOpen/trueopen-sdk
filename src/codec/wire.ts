import { TrueOpenError } from '../errors/errors';

const U64_MAX = (1n << 64n) - 1n;

export function u64ToString(v: bigint): string {
  if (v < 0n || v > U64_MAX) {
    throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_U64_RANGE', `value out of u64 range: ${v}`);
  }
  return v.toString();
}

export function stringToU64(s: string): bigint {
  if (!/^[0-9]+$/.test(s)) {
    throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_U64_PARSE', `not a u64 decimal string: ${JSON.stringify(s)}`);
  }
  const v = BigInt(s);
  if (v > U64_MAX) {
    throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_U64_RANGE', `value out of u64 range: ${s}`);
  }
  return v;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += hasB1 ? B64[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += hasB2 ? B64[b2 & 0x3f] : '=';
  }
  return out;
}

export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  if (clean.length % 4 === 1) {
    throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_BASE64_INVALID', `invalid base64 length: ${clean.length}`);
  }
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const idx = B64.indexOf(ch);
    if (idx === -1) {
      throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_BASE64_INVALID', `invalid base64 char: ${JSON.stringify(ch)}`);
    }
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  // The trailing padding bits of valid base64 must all be zero (otherwise it's corrupted or non-canonical encoding).
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) {
    throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_BASE64_INVALID', 'base64 has non-zero padding bits');
  }
  return new Uint8Array(out);
}
