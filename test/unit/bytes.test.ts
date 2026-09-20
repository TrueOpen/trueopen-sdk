import { describe, it, expect } from 'vitest';
import { bytesEqual, concatBytes, toHex, fromHex } from '../../src/util/bytes';

describe('bytes util', () => {
  it('bytesEqual: true for identical content, false for differing length/content', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 9, 3]))).toBe(false);
  });
  it('concatBytes concatenates', () => {
    expect(concatBytes(new Uint8Array([1]), new Uint8Array([2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('toHex/fromHex round-trip', () => {
    const b = new Uint8Array([0x00, 0x0f, 0xff]);
    expect(toHex(b)).toBe('000fff');
    expect(fromHex('000fff')).toEqual(b);
  });
  it('fromHex supports uppercase', () => {
    expect(fromHex('00FF')).toEqual(new Uint8Array([0x00, 0xff]));
    expect(fromHex('AbCd')).toEqual(new Uint8Array([0xab, 0xcd]));
  });
  it('fromHex rejects invalid characters', () => {
    expect(() => fromHex('zz')).toThrowError(/hex/);
    expect(() => fromHex('0g')).toThrowError(/hex/);
    expect(() => fromHex('  ')).toThrowError(/hex/);
  });
  it('fromHex still rejects odd length', () => {
    expect(() => fromHex('abc')).toThrowError(/hex/);
  });
});
