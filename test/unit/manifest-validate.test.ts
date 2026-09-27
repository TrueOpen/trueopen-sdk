import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateManifestV4 } from '../../src/manifest/validate';
import { TrueOpenError } from '../../src/errors/errors';

const VECTOR = JSON.parse(readFileSync('test/fixtures/wire/model_manifest_v4.json', 'utf8')) as {
  manifest: Record<string, unknown>;
};
const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(VECTOR.manifest)) as Record<string, unknown>;

describe('validateManifestV4', () => {
  it('accepts the published manifest', () => {
    expect(() => validateManifestV4(VECTOR.manifest)).not.toThrow();
  });

  it('rejects an unknown top-level field (S2.6 rule 11)', () => {
    // Rule 11 is reject, not ignore: a V3 parser meeting a V4 manifest must fail rather
    // than hash a subset of it.
    expect(() => validateManifestV4({ ...clone(), surprise: 1 })).toThrow(TrueOpenError);
  });

  it('rejects an unknown field inside a block', () => {
    const m = clone();
    (m['identity'] as Record<string, unknown>)['surprise'] = 1;
    expect(() => validateManifestV4(m)).toThrow(TrueOpenError);
  });

  it('rejects a manifest_version other than 4', () => {
    expect(() => validateManifestV4({ ...clone(), manifest_version: 3 })).toThrow(TrueOpenError);
  });

  it('rejects null and missing required fields (rule 10)', () => {
    const withNull = clone();
    (withNull['identity'] as Record<string, unknown>)['display_name'] = null;
    expect(() => validateManifestV4(withNull)).toThrow(TrueOpenError);

    const missing = clone();
    delete (missing['identity'] as Record<string, unknown>)['profile_version'];
    expect(() => validateManifestV4(missing)).toThrow(TrueOpenError);
  });

  it('rejects a Coin carrying anything beyond amount and denom (rule 8 via rule 11)', () => {
    const m = clone();
    (m['profile_spec'] as Record<string, unknown>)['min_stake'] = { amount: 1, denom: 'u', extra: 1 };
    expect(() => validateManifestV4(m)).toThrow(TrueOpenError);
  });

  it('rejects a bytes32 that is uppercase, short, or missing its prefix (rule 7 / rule 10)', () => {
    for (const bad of ['0xAAA' + 'a'.repeat(61), '0x' + 'a'.repeat(63), 'a'.repeat(64)]) {
      const m = clone();
      (m['identity'] as Record<string, unknown>)['model_id'] = bad;
      expect(() => validateManifestV4(m), bad).toThrow(TrueOpenError);
    }
  });

  it('rejects artifacts.files that are not sorted by path, rather than sorting them', () => {
    // Rule 3 says the array must be sorted by path; rule 10 says an array not sorted per its
    // field rule must be rejected. Repairing it here would let a document that the chain
    // would reject hash to something that looks valid locally.
    const m = clone();
    const files = (m['artifacts'] as Record<string, unknown>)['files'] as unknown[];
    (m['artifacts'] as Record<string, unknown>)['files'] = [...files].reverse();
    expect(() => validateManifestV4(m)).toThrow(TrueOpenError);
  });

  it('accepts an empty tool_calling, which is the only "unsupported" encoding (S7.2 rule 1)', () => {
    const m = clone();
    m['tool_calling'] = {};
    expect(() => validateManifestV4(m)).not.toThrow();
  });

  it('rejects a partially filled tool_calling (S7.2 rule 2)', () => {
    // name, version and call_id_format must all be present together.
    const m = clone();
    m['tool_calling'] = { parser: { name: 'hermes', version: 1 } };
    expect(() => validateManifestV4(m)).toThrow(TrueOpenError);
  });

  it('rejects a tool_calling parser version below 1 and an unknown call_id_format', () => {
    const zero = clone();
    zero['tool_calling'] = { parser: { name: 'hermes', version: 0 }, call_id_format: 'OPENAI_CALL_PREFIX' };
    expect(() => validateManifestV4(zero)).toThrow(TrueOpenError);

    const badFormat = clone();
    badFormat['tool_calling'] = { parser: { name: 'hermes', version: 1 }, call_id_format: 'NOPE' };
    expect(() => validateManifestV4(badFormat)).toThrow(TrueOpenError);
  });

  it('rejects an output_decoding whose V1-fixed values are wrong (S7.1 rule 1)', () => {
    const m = clone();
    (m['output_decoding'] as Record<string, unknown>)['strip_trailing_eos'] = false;
    expect(() => validateManifestV4(m)).toThrow(TrueOpenError);
  });

  it('rejects eos_token_ids that are empty, unsorted, or contain duplicates (S7.1 rule 2)', () => {
    for (const bad of [[], [2, 1], [1, 1]]) {
      const m = clone();
      (m['output_decoding'] as Record<string, unknown>)['eos_token_ids'] = bad;
      expect(() => validateManifestV4(m), JSON.stringify(bad)).toThrow(TrueOpenError);
    }
  });
});
