import { describe, it, expect } from 'vitest';
import { sha256 } from '../../src/codec/hash';
import { DOMAINS } from '../../src/codec/domains';
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

describe('DOMAINS', () => {
  it('fixed domain separator constants', () => {
    expect(DOMAINS.session).toBe('TRUEOPEN_SESSION_V1');
    expect(DOMAINS.sealedKey).toBe('TRUEOPEN_SEALED_KEY_V1');
    expect(DOMAINS.credential).toBe('TRUEOPEN_OBJECT_CREDENTIAL_V1');
  });
});
