import { describe, it, expect } from 'vitest';
import { DEFAULT_SIGNATURE_CHAIN_ID, signatureChainIdBigInt } from '../../src/signature-chain-id';

const MAX_INT64 = (1n << 63n) - 1n;

describe('signatureChainIdBigInt (ADR-0033: signer-chosen domain chainId in 1..MaxInt64)', () => {
  it('normalizes bigint, number and string inputs', () => {
    expect(signatureChainIdBigInt(1n)).toBe(1n);
    expect(signatureChainIdBigInt(424242)).toBe(424242n);
    expect(signatureChainIdBigInt('31337')).toBe(31337n);
    expect(signatureChainIdBigInt(MAX_INT64)).toBe(MAX_INT64);
  });

  it('refuses 0, negatives and overflow (0 is CORTEX_SERVICE only; the SDK is always USER)', () => {
    expect(() => signatureChainIdBigInt(0n)).toThrow(/signature_chain_id/);
    expect(() => signatureChainIdBigInt(-1n)).toThrow(/signature_chain_id/);
    expect(() => signatureChainIdBigInt(MAX_INT64 + 1n)).toThrow(/signature_chain_id/);
  });

  it('the default is 1 (Ethereum mainnet), valid for session keys and servers', () => {
    expect(DEFAULT_SIGNATURE_CHAIN_ID).toBe(1n);
    expect(() => signatureChainIdBigInt(DEFAULT_SIGNATURE_CHAIN_ID)).not.toThrow();
  });
});
