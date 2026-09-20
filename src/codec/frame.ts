/**
 * The frame format used by nexus SDKRequestEnvelope / body_digest: each segment gets a
 * 4-byte big-endian length prefix followed by the segment's bytes.
 * Note this differs from node's domainHash (an 8-byte length prefix plus sha256) -- this
 * is a separate convention on the nexus side (internal/sdkauth SignBytes / BodyDigest).
 */
export function frame4(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += 4 + p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    const n = p.length;
    out[off] = (n >>> 24) & 0xff;
    out[off + 1] = (n >>> 16) & 0xff;
    out[off + 2] = (n >>> 8) & 0xff;
    out[off + 3] = n & 0xff;
    off += 4;
    out.set(p, off);
    off += n;
  }
  return out;
}

/** int64 as 8 big-endian bytes (two's complement). */
export function i64be(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let x = BigInt.asUintN(64, v);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** uint64 as 8 big-endian bytes. */
export function u64be(v: bigint): Uint8Array {
  if (v < 0n) throw new Error('u64be requires non-negative');
  return i64be(BigInt.asIntN(64, v));
}
