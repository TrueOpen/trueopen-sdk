import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveToolCalling, type ManifestSource } from '../../src/manifest-resolution';
import { createToolCallRegistry } from '../../src/toolcall/registry';
import type { ToolCallParser } from '../../src/toolcall/types';
import { validateManifestV4 } from '../../src/manifest/validate';
import { manifestHash } from '../../src/manifest/hash';
import { toHex } from '../../src/util/bytes';

const VECTOR = JSON.parse(readFileSync('test/fixtures/wire/model_manifest_v4.json', 'utf8')) as {
  manifest: Record<string, unknown>;
  vectors: { digest_hex: string }[];
};

const fakeParser = (name: string, version: number): ToolCallParser => ({
  name,
  version,
  parseComplete: (text) => ({ role: 'assistant', content: text, toolCalls: [] }),
  createStreamState: () => ({ push: () => [], finish: () => [] }),
});

const sourceOf = (manifest: unknown, manifestHashHex: string): ManifestSource => async () => ({
  manifest,
  manifestHashHex,
});

/** A manifest whose `tool_calling` pins `name@version`, plus the hash of exactly that document.
 *  The vector's own `digest_hex` hashes `tool_calling: {}`, so it cannot be reused here. */
const pinnedManifest = (
  name: string,
  version: number,
): { manifest: Record<string, unknown>; hashHex: string } => {
  const manifest: Record<string, unknown> = {
    ...VECTOR.manifest,
    tool_calling: { parser: { name, version }, call_id_format: 'OPENAI_CALL_PREFIX' },
  };
  return { manifest, hashHex: toHex(manifestHash(validateManifestV4(manifest))) };
};

describe('resolveToolCalling', () => {
  it('resolves supported: true when the manifest pins a vector-verified parser and the hash matches', async () => {
    const parser = fakeParser('hermes', 1);
    const registry = createToolCallRegistry([{ parser, conformance: 'vector-verified' }]);
    const { manifest, hashHex } = pinnedManifest('hermes', 1);
    await expect(
      resolveToolCalling({ manifestSource: sourceOf(manifest, hashHex), registry }),
    ).resolves.toEqual({ supported: true, parser });
  });

  it('reports manifest-unavailable when the manifest source rejects', async () => {
    const registry = createToolCallRegistry([
      { parser: fakeParser('hermes', 1), conformance: 'vector-verified' },
    ]);
    const manifestSource: ManifestSource = async () => {
      throw new Error('unavailable');
    };
    await expect(resolveToolCalling({ manifestSource, registry })).resolves.toEqual({
      supported: false,
      reason: 'manifest-unavailable',
    });
  });

  it('reports manifest-hash-mismatch when the re-derived hash differs from the chain value', async () => {
    const registry = createToolCallRegistry([
      { parser: fakeParser('hermes', 1), conformance: 'vector-verified' },
    ]);
    await expect(
      resolveToolCalling({
        manifestSource: sourceOf(VECTOR.manifest, 'dd'.repeat(32)),
        registry,
      }),
    ).resolves.toEqual({ supported: false, reason: 'manifest-hash-mismatch' });
  });

  it('reports manifest-invalid when the document fails validation', async () => {
    const registry = createToolCallRegistry([
      { parser: fakeParser('hermes', 1), conformance: 'vector-verified' },
    ]);
    await expect(
      resolveToolCalling({
        manifestSource: sourceOf({ ...VECTOR.manifest, surprise: 1 }, VECTOR.vectors[0]!.digest_hex),
        registry,
      }),
    ).resolves.toEqual({ supported: false, reason: 'manifest-invalid' });
  });

  it('reports parser-not-pinned when tool_calling is empty', async () => {
    const registry = createToolCallRegistry([
      { parser: fakeParser('hermes', 1), conformance: 'vector-verified' },
    ]);
    await expect(
      resolveToolCalling({
        manifestSource: sourceOf(VECTOR.manifest, VECTOR.vectors[0]!.digest_hex),
        registry,
      }),
    ).resolves.toEqual({ supported: false, reason: 'parser-not-pinned' });
  });

  it('reports parser-unknown when the manifest pins a parser the registry lacks', async () => {
    const registry = createToolCallRegistry([
      { parser: fakeParser('hermes', 1), conformance: 'vector-verified' },
    ]);
    const { manifest, hashHex } = pinnedManifest('hermes', 2);
    await expect(
      resolveToolCalling({ manifestSource: sourceOf(manifest, hashHex), registry }),
    ).resolves.toEqual({ supported: false, reason: 'parser-unknown' });
  });

  it('reports parser-unverified by default, and supported: true when allowUnverified is set', async () => {
    const parser = fakeParser('hermes', 1);
    const registry = createToolCallRegistry([{ parser, conformance: 'unverified' }]);
    const { manifest, hashHex } = pinnedManifest('hermes', 1);
    await expect(
      resolveToolCalling({ manifestSource: sourceOf(manifest, hashHex), registry }),
    ).resolves.toEqual({ supported: false, reason: 'parser-unverified' });
    await expect(
      resolveToolCalling({ manifestSource: sourceOf(manifest, hashHex), registry, allowUnverified: true }),
    ).resolves.toEqual({ supported: true, parser });
  });
});
