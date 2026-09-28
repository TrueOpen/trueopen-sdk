import { describe, it, expect } from 'vitest';
import { resolveConfig, loadMnemonic, resolveGasPrice } from '../../src/cli/config';
import { writeFileSync, rmSync } from 'node:fs';

describe('cli config', () => {
  it('flag overrides env, defaults as fallback', () => {
    const cfg = resolveConfig({ restUrl: 'http://flag' }, { TRUEOPEN_REST_URL: 'http://env', TRUEOPEN_ADDR_PREFIX: 'cosmos' });
    expect(cfg.restUrl).toBe('http://flag');
    expect(cfg.prefix).toBe('cosmos');
    // No hard-coded denom: both the fee denom and the gas price denom come from the chain.
    expect(cfg.gasPrice).toBeUndefined();
    expect(cfg.feeDenom).toBeUndefined();
    expect(cfg.auto).toBe(false);
  });
  it('gas price takes the chain business_denom and refuses any other denom', () => {
    expect(resolveGasPrice(undefined, 'uchain')).toBe('0.025uchain');
    expect(resolveGasPrice('0.5', 'uchain')).toBe('0.5uchain');
    expect(resolveGasPrice('0.5uchain', 'uchain')).toBe('0.5uchain');
    expect(() => resolveGasPrice('0.025uusdc', 'uchain')).toThrowError(/business_denom/);
    expect(() => resolveGasPrice('cheap', 'uchain')).toThrowError(/amount/);
  });
  it('--fee-denom / TRUEOPEN_FEE_DENOM is an optional override', () => {
    expect(resolveConfig({ feeDenom: 'ua' }, { TRUEOPEN_FEE_DENOM: 'ub' }).feeDenom).toBe('ua');
    expect(resolveConfig({}, { TRUEOPEN_FEE_DENOM: 'ub' }).feeDenom).toBe('ub');
  });
  it('falls back to env + default prefix', () => {
    const cfg = resolveConfig({}, { TRUEOPEN_REST_URL: 'http://env' });
    expect(cfg.restUrl).toBe('http://env');
    expect(cfg.prefix).toBe('trueopen');
  });
  it('--nexus-tls-pubkey-hash prefers flag over env, defaults to undefined', () => {
    expect(resolveConfig({ nexusTlsPubkeyHash: 'aa'.repeat(32) }, { TRUEOPEN_NEXUS_TLS_PUBKEY_HASH: 'bb'.repeat(32) }).nexusTlsPubkeyHash)
      .toBe('aa'.repeat(32));
    expect(resolveConfig({}, { TRUEOPEN_NEXUS_TLS_PUBKEY_HASH: 'bb'.repeat(32) }).nexusTlsPubkeyHash).toBe('bb'.repeat(32));
    expect(resolveConfig({}, {}).nexusTlsPubkeyHash).toBeUndefined();
  });

  it('requireRest throws when REST is missing', () => {
    const cfg = resolveConfig({}, {});
    expect(() => cfg.requireRest()).toThrowError(/rest/i);
  });
  it('loadMnemonic reads from --key-file and trims', () => {
    const p = '/tmp/trueopen-test-key.txt';
    writeFileSync(p, '  word1 word2  \n');
    try {
      expect(loadMnemonic({ keyFile: p }, {})).toBe('word1 word2');
    } finally {
      rmSync(p);
    }
  });
  it('loadMnemonic reads from env', () => {
    expect(loadMnemonic({}, { TRUEOPEN_MNEMONIC: ' a b ' })).toBe('a b');
  });
  it('loadMnemonic throws when there is no source', () => {
    expect(() => loadMnemonic({}, {})).toThrowError(/mnemonic|key/i);
  });
});
