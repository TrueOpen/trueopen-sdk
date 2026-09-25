import { TrueOpenError } from '../errors/errors';
import type { ParserRef, ToolCallParser, ToolCallSupport } from './types';

/**
 * Whether this implementation has passed the cross-language shared vectors for its
 * `(name, version)`.
 *
 * ADR-0022 decision four requires a language-independent behaviour spec plus shared vectors
 * published with wire's testdata for every `(name, version)`. Those vectors do not exist
 * (monorepo#11), so every parser written today is `'unverified'`.
 *
 * This is not test hygiene. Two SDKs that disagree about the same committed text hand their
 * agents different tool calls, and the agent executes them. So an unverified parser is not
 * offered by default; a caller has to ask for it.
 */
export type ParserConformance = 'unverified' | 'vector-verified';

export interface RegistryEntry {
  readonly parser: ToolCallParser;
  readonly conformance: ParserConformance;
}

export interface ToolCallRegistry {
  lookup(ref: ParserRef, opts?: { readonly allowUnverified?: boolean }): ToolCallSupport;
}

// The key must be injective (no collisions) because two different (name, version) pairs
// must never map to the same key. A collision would either throw a confusing duplicate
// error for two genuinely different parsers, or (if only one is registered) make
// lookup silently return the wrong parser for a ref that merely looks similar.
const key = (ref: ParserRef): string => JSON.stringify([ref.name, ref.version]);

export function createToolCallRegistry(entries: readonly RegistryEntry[]): ToolCallRegistry {
  const byKey = new Map<string, RegistryEntry>();
  for (const entry of entries) {
    const k = key(entry.parser);
    if (byKey.has(k)) {
      // Last-one-wins would make the parse depend on registration order, which is the same
      // class of silent divergence the shared vectors exist to prevent.
      throw new TrueOpenError(
        'SDK_LOCAL',
        'TOOLCALL_PARSER_DUPLICATE',
        `two parsers registered for ${entry.parser.name}@${entry.parser.version}`,
      );
    }
    byKey.set(k, entry);
  }
  return {
    lookup(ref, opts) {
      // An empty name is the manifest's `tool_calling = {}`: an ordinary profile that simply
      // does not offer tool calling. Distinct from a profile that pins a parser this build does
      // not have, which is a deployment problem.
      if (ref.name === '') return { supported: false, reason: 'parser-not-pinned' };
      const entry = byKey.get(key(ref));
      if (entry === undefined) return { supported: false, reason: 'parser-unknown' };
      if (entry.conformance === 'unverified' && opts?.allowUnverified !== true) {
        return { supported: false, reason: 'parser-unverified' };
      }
      return { supported: true, parser: entry.parser };
    },
  };
}

/**
 * The parsers this SDK build ships: none.
 *
 * Phase 1 builds the framework, and no concrete parser can be registered before its vectors
 * exist (monorepo#11). Callers inject their own with `createToolCallRegistry`.
 */
export const BUILTIN_TOOL_CALL_PARSERS: ToolCallRegistry = createToolCallRegistry([]);

/**
 * Resolve whether tool calling is available, before any frame arrives (design S5.1).
 *
 * Asynchronous although phase 1 never awaits: phase 3 resolves `(name, version)` by fetching the
 * profile manifest and re-deriving its hash, and the signature should not change then.
 */
export async function resolveToolCalling(p: {
  readonly registry: ToolCallRegistry;
  readonly ref: ParserRef;
  readonly allowUnverified?: boolean;
}): Promise<ToolCallSupport> {
  return p.registry.lookup(
    p.ref,
    p.allowUnverified === undefined ? undefined : { allowUnverified: p.allowUnverified },
  );
}
