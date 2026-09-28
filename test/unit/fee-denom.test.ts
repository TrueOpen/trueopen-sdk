import { describe, it, expect } from 'vitest';
import { resolveFeeDenom } from '../../src/order/fee-denom';

describe('resolveFeeDenom', () => {
  it('uses the chain business_denom, with or without a matching override', () => {
    expect(resolveFeeDenom('uchain', undefined)).toBe('uchain');
    expect(resolveFeeDenom('uchain', 'uchain')).toBe('uchain');
    expect(resolveFeeDenom('uchain', '  ')).toBe('uchain');
  });
  it('refuses an override that disagrees with the chain', () => {
    expect(() => resolveFeeDenom('uchain', 'uusdc')).toThrowError(expect.objectContaining({ code: 'SDK_LOCAL_FEE_DENOM_MISMATCH' }));
  });
  it('falls back to the override only when the chain value cannot be read', () => {
    expect(resolveFeeDenom(undefined, 'uusdc')).toBe('uusdc');
    expect(() => resolveFeeDenom(undefined, undefined)).toThrowError(expect.objectContaining({ code: 'SDK_LOCAL_FEE_DENOM_UNAVAILABLE' }));
  });
});
