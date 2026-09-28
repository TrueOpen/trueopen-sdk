import { describe, it, expect } from 'vitest';
import { u64ToString, stringToU64, bytesToBase64, base64ToBytes, hash32ToHex } from '../../src/codec/wire';
import { fromHex } from '../../src/util/bytes';
import { TrueOpenError } from '../../src/errors/errors';

describe('u64 <-> string', () => {
  it('round-trip', () => {
    expect(u64ToString(0n)).toBe('0');
    expect(u64ToString(18446744073709551615n)).toBe('18446744073709551615'); // 2^64-1
    expect(stringToU64('42')).toBe(42n);
  });
  it('rejects out-of-range/invalid values', () => {
    expect(() => u64ToString(-1n)).toThrowError(TrueOpenError);
    expect(() => u64ToString(18446744073709551616n)).toThrowError(TrueOpenError); // 2^64
    expect(() => stringToU64('1.5')).toThrowError(TrueOpenError);
    expect(() => stringToU64('')).toThrowError(TrueOpenError);
  });
});

describe('base64 <-> bytes', () => {
  it('known vectors', () => {
    expect(bytesToBase64(new TextEncoder().encode('foobar'))).toBe('Zm9vYmFy');
    expect(bytesToBase64(new TextEncoder().encode('foo'))).toBe('Zm9v');
    expect(bytesToBase64(new TextEncoder().encode('fo'))).toBe('Zm8=');
    expect(bytesToBase64(new TextEncoder().encode('f'))).toBe('Zg==');
    expect(new TextDecoder().decode(base64ToBytes('Zm9vYmFy'))).toBe('foobar');
    expect(new TextDecoder().decode(base64ToBytes('Zg=='))).toBe('f');
  });
  it('empty', () => {
    expect(bytesToBase64(new Uint8Array())).toBe('');
    expect(base64ToBytes('')).toEqual(new Uint8Array());
  });
  it('rejects invalid characters', () => {
    expect(() => base64ToBytes('!!!!')).toThrowError(TrueOpenError);
  });
  it('rejects length % 4 === 1', () => {
    expect(() => base64ToBytes('ABCDE')).toThrowError(TrueOpenError); // 5 % 4 === 1
    expect(() => base64ToBytes('A')).toThrowError(TrueOpenError); // 1 % 4 === 1
  });
  it('rejects non-zero padding bits', () => {
    // 'AB' -> 1 byte + 4 padding bits, whose lowest bit is 1 (non-zero)
    expect(() => base64ToBytes('AB')).toThrowError(TrueOpenError);
    // 'Zm9' -> 2 bytes + 2 padding bits = 01 (non-zero)
    expect(() => base64ToBytes('Zm9')).toThrowError(TrueOpenError);
  });
  it('zero padding bits are still valid', () => {
    expect(base64ToBytes('AA')).toEqual(new Uint8Array([0])); // 4 padding bits, all zero
    expect(new TextDecoder().decode(base64ToBytes('Zm8='))).toBe('fo');
    expect(new TextDecoder().decode(base64ToBytes('Zm8'))).toBe('fo'); // unpadded variant
  });
});

/**
 * model_id became a Hash32 in TaskOrderV3 and is read from both hub.v1 and task.v1. Both
 * readers decode it through this one function, so ProfileInfo.modelId and
 * ChainTaskSnapshot.modelId cannot end up in different encodings.
 */
describe('hash32ToHex', () => {
  const hex = 'ad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b';
  const b64 = bytesToBase64(fromHex(hex));

  it('passes canonical lowercase 64-hex through untouched', () => {
    expect(hash32ToHex(hex)).toBe(hex);
  });

  it('decodes the protojson base64 form to the same hex', () => {
    expect(b64).not.toBe(hex);
    expect(hash32ToHex(b64)).toBe(hex);
  });

  it('never base64-decodes something that is already hex', () => {
    // '01'.repeat(32) is valid base64 text as well as valid hex; hex must win, otherwise
    // the decode silently produces a different 32 bytes.
    const ambiguous = '01'.repeat(32);
    expect(hash32ToHex(ambiguous)).toBe(ambiguous);
  });

  it('rejects a base64 value that is not 32 bytes', () => {
    expect(() => hash32ToHex(bytesToBase64(new Uint8Array(31)))).toThrowError(TrueOpenError);
    expect(() => hash32ToHex(bytesToBase64(new Uint8Array(33)))).toThrowError(TrueOpenError);
  });

  it('rejects uppercase hex rather than folding it', () => {
    expect(() => hash32ToHex(hex.toUpperCase())).toThrowError(TrueOpenError);
  });
});
