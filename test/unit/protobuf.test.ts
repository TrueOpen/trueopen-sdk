import { describe, it, expect } from 'vitest';
import { ProtoWriter, ProtoReader } from '../../src/codec/protobuf';
import { toHex } from '../../src/util/bytes';

describe('ProtoWriter', () => {
  it('string field 1 = "abc" -> 0a 03 616263', () => {
    expect(toHex(new ProtoWriter().string(1, 'abc').finish())).toBe('0a03616263');
  });
  it('an empty string is omitted (proto3)', () => {
    expect(new ProtoWriter().string(1, '').finish()).toEqual(new Uint8Array());
  });
  it('uint64 field 3 = 5 -> 18 05', () => {
    expect(toHex(new ProtoWriter().uint64(3, 5n).finish())).toBe('1805');
  });
  it('uint64 = 0 is omitted', () => {
    expect(new ProtoWriter().uint64(3, 0n).finish()).toEqual(new Uint8Array());
  });
  it('large varint: field 7 = 300 -> 38 ac02', () => {
    expect(toHex(new ProtoWriter().uint64(7, 300n).finish())).toBe('38ac02');
  });
  it('multiple fields concatenated in ascending order', () => {
    const b = new ProtoWriter().string(2, 's').uint64(3, 5n).finish();
    expect(toHex(b)).toBe('12017318' + '05');
  });
  it('repeatedString field 8 = [a,b] (tag=0x42 for each)', () => {
    const b = new ProtoWriter().repeatedString(8, ['a', 'b']).finish();
    expect(toHex(b)).toBe('420161420162');
  });
});

describe('ProtoReader', () => {
  it('reads back the fields written by the writer', () => {
    const bytes = new ProtoWriter().string(1, 'hello').uint64(2, 42n).finish();
    const r = new ProtoReader(bytes);
    const t1 = r.tag();
    expect(t1).toEqual({ field: 1, wire: 2 });
    expect(r.string()).toBe('hello');
    const t2 = r.tag();
    expect(t2).toEqual({ field: 2, wire: 0 });
    expect(r.uint64()).toBe(42n);
    expect(r.eof).toBe(true);
  });
  it('skips an unknown field', () => {
    const bytes = new ProtoWriter().string(1, 'x').uint64(2, 9n).finish();
    const r = new ProtoReader(bytes);
    const t1 = r.tag();
    r.skip(t1.wire); // skip string field 1
    const t2 = r.tag();
    expect(t2.field).toBe(2);
    expect(r.uint64()).toBe(9n);
  });
  it('reading a string out of bounds (a truncated length-delimited value) throws', () => {
    // tag=0x0a (field1, wire2), len=5, but only 2 bytes of content
    const r = new ProtoReader(new Uint8Array([0x0a, 0x05, 0x61, 0x62]));
    r.tag();
    expect(() => r.string()).toThrowError(/exceeds buffer/);
  });
  it('skipping wire=2 out of bounds throws', () => {
    const r = new ProtoReader(new Uint8Array([0x0a, 0x05, 0x61, 0x62]));
    const t = r.tag();
    expect(() => r.skip(t.wire)).toThrowError(/exceeds buffer/);
  });
});
