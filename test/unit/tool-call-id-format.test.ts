import { describe, expect, it } from 'vitest';
import { parseModelManifestV4, toolCallIdFormatOf, type ModelManifestV4 } from '../../src/manifest/model-manifest';
import type { ManifestSource } from '../../src/manifest/manifest-source';
import { TrueOpenClient } from '../../src/client';
import { GOLDEN_MANIFEST_BYTES } from '../helpers/manifest-fixture';

const golden = parseModelManifestV4(GOLDEN_MANIFEST_BYTES);
const withToolCalling = (block: Record<string, unknown>): ModelManifestV4 =>
  ({ ...golden, raw: { ...golden.raw, tool_calling: block } }) as ModelManifestV4;

describe('toolCallIdFormatOf (Manifest §7.2)', () => {
  it('is undefined for tool_calling {}, the profile offering no tool calling (the wire vector)', () => {
    expect(golden.raw['tool_calling']).toEqual({});
    expect(toolCallIdFormatOf(golden)).toBeUndefined();
  });

  it('reads a closed-set call_id_format', () => {
    for (const f of ['OPENAI_CALL_PREFIX', 'MISTRAL_ALNUM_9'] as const) {
      expect(toolCallIdFormatOf(withToolCalling({ parser: { name: 'hermes', version: 1n }, call_id_format: f }))).toBe(f);
    }
  });

  it('refuses a non-empty block without a closed-set format', () => {
    for (const block of [{ parser: { name: 'hermes', version: 1n } }, { parser: { name: 'hermes', version: 1n }, call_id_format: 'UUID' }]) {
      expect(() => toolCallIdFormatOf(withToolCalling(block))).toThrow(expect.objectContaining({ code: 'MANIFEST_SCHEMA_INVALID' }));
    }
  });
});

describe('TrueOpenClient.toolCallIdFormat', () => {
  const base = {
    chainId: 'trueopen-localnet-1', userAddress: 'trueopen1jah6xx0ve056wgl3cxlxhe393ywwwyuamfl037',
    wallet: { signTypedData: async () => new Uint8Array(65) }, chain: {} as never, ingressTransport: {} as never,
  };

  it('reads the format from the verified manifest of the profile', async () => {
    const asked: unknown[] = [];
    const manifestSource = {
      fetchManifest: async (modelId: string, version: bigint) => {
        asked.push([modelId, version]);
        return { manifest: withToolCalling({ parser: { name: 'hermes', version: 1n }, call_id_format: 'MISTRAL_ALNUM_9' }) };
      },
    } as unknown as ManifestSource;
    const client = new TrueOpenClient({ ...base, manifestSource });
    await expect(client.toolCallIdFormat('ab'.repeat(32), 1n)).resolves.toBe('MISTRAL_ALNUM_9');
    expect(asked).toEqual([['ab'.repeat(32), 1n]]);
  });

  it('says what it needs without a manifest source, and lets a manifest that fails verification fail', async () => {
    await expect(new TrueOpenClient(base).toolCallIdFormat('ab'.repeat(32), 1n))
      .rejects.toMatchObject({ code: 'SDK_LOCAL_MANIFEST_SOURCE_UNCONFIGURED' });
    const failing = { fetchManifest: async () => { throw Object.assign(new Error('mismatch'), { code: 'MANIFEST_PROJECTION_MISMATCH' }); } } as unknown as ManifestSource;
    await expect(new TrueOpenClient({ ...base, manifestSource: failing }).toolCallIdFormat('ab'.repeat(32), 1n))
      .rejects.toMatchObject({ code: 'MANIFEST_PROJECTION_MISMATCH' });
  });
});
