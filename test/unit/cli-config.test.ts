import { describe, it, expect } from 'vitest';
import { resolveConfig, loadMnemonic } from '../../src/cli/config';
import { writeFileSync, rmSync } from 'node:fs';

describe('cli config', () => {
  it('flag overrides env, defaults as fallback', () => {
    const cfg = resolveConfig({ restUrl: 'http://flag' }, { TRUEOPEN_REST_URL: 'http://env', TRUEOPEN_ADDR_PREFIX: 'cosmos' });
    expect(cfg.restUrl).toBe('http://flag');
    expect(cfg.prefix).toBe('cosmos');
    expect(cfg.gasPrice).toBe('0.025uusdc');
    expect(cfg.auto).toBe(false);
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
