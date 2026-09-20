/**
 * Minimal protobuf codec (proto3 deterministic semantics: default values omitted,
 * fields in ascending order).
 * Covers only the wire types the SDK needs: 0=varint, 2=length-delimited.
 * Used for hand-written task Msg encoding, to avoid pulling in a codegen toolchain.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export class ProtoWriter {
  private buf: number[] = [];

  private varint(n: bigint): void {
    let v = n;
    while (v > 0x7fn) {
      this.buf.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    this.buf.push(Number(v));
  }

  private tag(field: number, wire: number): void {
    this.varint(BigInt((field << 3) | wire));
  }

  /** proto3: an empty string is omitted. */
  string(field: number, value: string): this {
    if (value.length > 0) {
      const bytes = enc.encode(value);
      this.tag(field, 2);
      this.varint(BigInt(bytes.length));
      for (const b of bytes) this.buf.push(b);
    }
    return this;
  }

  /**
   * proto `bytes`: raw bytes, empty is omitted (proto3).
   * Hash32-style fields (session_id / task_id) are `bytes` in the node proto and must go
   * through here, not string() -- that would write the hex text out as UTF-8.
   */
  bytes(field: number, value: Uint8Array): this {
    if (value.length > 0) {
      this.tag(field, 2);
      this.varint(BigInt(value.length));
      for (const b of value) this.buf.push(b);
    }
    return this;
  }

  /** proto3: 0 is omitted. */
  uint64(field: number, value: bigint): this {
    if (value < 0n) throw new Error('proto uint64 must be non-negative');
    if (value !== 0n) {
      this.tag(field, 0);
      this.varint(value);
    }
    return this;
  }

  /** repeated string: encoded one at a time; an empty array produces no bytes. */
  repeatedString(field: number, values: readonly string[]): this {
    for (const v of values) {
      const bytes = enc.encode(v);
      this.tag(field, 2);
      this.varint(BigInt(bytes.length));
      for (const b of bytes) this.buf.push(b);
    }
    return this;
  }

  finish(): Uint8Array {
    return new Uint8Array(this.buf);
  }
}

export interface ProtoTag {
  readonly field: number;
  readonly wire: number;
}

export class ProtoReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  private varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.buf[this.pos++];
      if (b === undefined) throw new Error('proto: unexpected eof reading varint');
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  }

  tag(): ProtoTag {
    const t = this.varint();
    return { field: Number(t >> 3n), wire: Number(t & 7n) };
  }

  uint64(): bigint {
    return this.varint();
  }

  /** Verify a length-delimited field does not run past the end of the buffer. */
  private lenDelim(len: number): number {
    if (this.pos + len > this.buf.length) {
      throw new Error('proto: length-delimited field exceeds buffer');
    }
    return len;
  }

  string(): string {
    const len = this.lenDelim(Number(this.varint()));
    const slice = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return dec.decode(slice);
  }

  /**
   * length-delimited raw bytes (proto `bytes`). Returns a copy, not an alias of the
   * underlying buffer. Used for Hash32-style fields: they are 32 raw bytes, and decoding
   * as UTF-8 would produce garbage.
   */
  bytes(): Uint8Array {
    const len = this.lenDelim(Number(this.varint()));
    const slice = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  /** Skip an unknown field. */
  skip(wire: number): void {
    if (wire === 0) {
      this.varint();
    } else if (wire === 2) {
      const len = this.lenDelim(Number(this.varint()));
      this.pos += len;
    } else {
      throw new Error(`proto: unsupported wire type ${wire}`);
    }
  }
}
