import { TrueOpenError } from './errors/errors';
import { manifestHash } from './manifest/hash';
import { validateManifestV4 } from './manifest/validate';
import type { ModelProfileManifestV4 } from './manifest/types';
import { toHex } from './util/bytes';
import type { ToolCallRegistry } from './toolcall/registry';
import type { ToolCallSupport } from './toolcall/types';

/** The chain's committed hash plus the document it anchors. The SDK re-derives the
 *  document's hash and compares (design S8); it does not trust the document. */
export interface ResolvedManifest {
  /** The raw manifest document, unvalidated. */
  readonly manifest: unknown;
  /** The chain's `manifest_hash`, hex, with or without a `0x` prefix. */
  readonly manifestHashHex: string;
}

/** Where a manifest comes from. Caller-supplied: the SDK cannot read `ProfileState.manifest_hash`
 *  or fetch the document itself yet (submodule pinned; no defined source — design §9). */
export type ManifestSource = () => Promise<ResolvedManifest>;

/**
 * Resolve whether tool calling is available, before any frame arrives (design S5.1).
 *
 * Fetches the manifest, validates it (rejecting unknown fields and malformed shapes per
 * rule 11/10/7/3), re-derives its hash, compares it to the chain's committed value, and
 * resolves `tool_calling.parser {name, version}` through the registry.
 *
 * A manifest that fails any of those steps is reported as an `UnsupportedReason`, never
 * thrown, so an application can degrade to `content`-only output (design S6).
 */
export async function resolveToolCalling(p: {
  readonly manifestSource: ManifestSource;
  readonly registry: ToolCallRegistry;
  readonly allowUnverified?: boolean;
}): Promise<ToolCallSupport> {
  let resolved: ResolvedManifest;
  try {
    resolved = await p.manifestSource();
  } catch {
    return { supported: false, reason: 'manifest-unavailable' };
  }

  let manifest: ModelProfileManifestV4;
  try {
    manifest = validateManifestV4(resolved.manifest);
  } catch {
    return { supported: false, reason: 'manifest-invalid' };
  }

  const want = resolved.manifestHashHex.toLowerCase().replace(/^0x/, '');
  if (toHex(manifestHash(manifest)) !== want) {
    return { supported: false, reason: 'manifest-hash-mismatch' };
  }

  const tc = manifest.tool_calling;
  // S7.2 rule 2: `tool_calling` is either `{}` (no tool calling) or fully populated, and
  // validateManifestV4 has already enforced that, so `parser === undefined` is `{}`.
  if (tc.parser === undefined) {
    return { supported: false, reason: 'parser-not-pinned' };
  }
  return p.registry.lookup(
    { name: tc.parser.name, version: tc.parser.version },
    p.allowUnverified === undefined ? undefined : { allowUnverified: p.allowUnverified },
  );
}
