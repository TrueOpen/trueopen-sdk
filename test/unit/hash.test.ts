import { describe, it, expect } from 'vitest';
import { sha256 } from '../../src/codec/hash';
import { SIGN_DOMAINS } from '../../src/codec/domains';
import { toHex } from '../../src/util/bytes';

describe('sha256', () => {
  it('known vector for empty input', () => {
    expect(toHex(sha256(new Uint8Array([])))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  it('known vector for "abc"', () => {
    expect(toHex(sha256(new TextEncoder().encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('SIGN_DOMAINS', () => {
  it('fixed domain separator constants', () => {
    expect(SIGN_DOMAINS).toEqual({ order: 'TRUEOPEN_ORDER_V1', taskId: 'TRUEOPEN_TASK_ID_V1' });
  });
});
