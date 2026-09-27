import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deriveModelId, MODEL_ID_DOMAIN } from '../../src/order/model-id';
import { fromHex, toHex } from '../../src/util/bytes';

/** Anchor: wire v0.3.0's testdata/v1/hub/model_id_v1.json, read directly from the submodule. */
const VECTORS = JSON.parse(
  readFileSync(new URL('../../third_party/wire/testdata/v1/hub/model_id_v1.json', import.meta.url), 'utf8'),
) as {
  domain?: string;
  vectors: {
    name: string;
    digest_hex: string;
    domain: string;
    fields: { name: string; utf8?: string; hex?: string }[];
  }[];
  negative: { name: string; input: Record<string, string | number> }[];
};

const field = (v: (typeof VECTORS.vectors)[number], name: string): { utf8?: string; hex?: string } =>
  v.fields.find((f) => f.name === name) ?? {};

describe('deriveModelId (anchored to wire model_id_v1.json)', () => {
  it('reproduces every positive vector byte-for-byte', () => {
    for (const v of VECTORS.vectors) {
      const chainId = field(v, 'chain_id').utf8!;
      const provider = field(v, 'provider').utf8!;
      const repoId = field(v, 'repo_id').utf8!;
      const proposer = fromHex(field(v, 'proposer_address').hex!);
      expect(v.domain).toBe(MODEL_ID_DOMAIN);
      expect(toHex(deriveModelId(chainId, provider, repoId, proposer))).toBe(v.digest_hex);
    }
  });

  it('rejects a non-canonical provider (lower case, alias, empty, unsupported)', () => {
    const base = {
      chainId: 'trueopen-golden-1',
      repoId: 'trueopen/golden-model',
      proposer: fromHex('1a642f0e3c3af545e7acbd38b07251b3990914f1'),
    };
    for (const provider of ['huggingface', 'HF', '', 'OCI']) {
      expect(() => deriveModelId(base.chainId, provider, base.repoId, base.proposer)).toThrow(/model_id/);
    }
  });

  it('rejects a non-canonical repo_id', () => {
    const base = {
      chainId: 'trueopen-golden-1',
      provider: 'HUGGINGFACE',
      proposer: fromHex('1a642f0e3c3af545e7acbd38b07251b3990914f1'),
    };
    for (const repoId of ['Qwen3-8B', 'Qwen/Qwen3/8B', 'Qwen/', 'Qwen/Qwen3 8B', ' Qwen/Qwen3-8B', 'Qwen/Café']) {
      expect(() => deriveModelId(base.chainId, base.provider, repoId, base.proposer), repoId).toThrow(/model_id/);
    }
    // 256 bytes, all canonical chars.
    expect(() =>
      deriveModelId(base.chainId, base.provider, 'a'.repeat(128) + '/' + 'b'.repeat(127), base.proposer),
    ).toThrow(/model_id/);
  });

  it('rejects an empty chain_id and a proposer address that is not 20 bytes', () => {
    const proposer = fromHex('1a642f0e3c3af545e7acbd38b07251b3990914f1');
    expect(() => deriveModelId('', 'HUGGINGFACE', 'trueopen/golden-model', proposer)).toThrow(/model_id/);
    expect(() => deriveModelId('trueopen-golden-1', 'HUGGINGFACE', 'trueopen/golden-model', new Uint8Array(19))).toThrow(
      /model_id/,
    );
  });
});
