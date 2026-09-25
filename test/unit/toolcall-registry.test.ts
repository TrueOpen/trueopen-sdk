import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TOOL_CALL_PARSERS,
  createToolCallRegistry,
  resolveToolCalling,
} from '../../src/toolcall/registry';
import type { ToolCallParser } from '../../src/toolcall/types';
import { TrueOpenError } from '../../src/errors/errors';

const fakeParser = (name: string, version: string): ToolCallParser => ({
  name,
  version,
  parseComplete: (text) => ({ role: 'assistant', content: text, toolCalls: [] }),
  createStreamState: () => ({ push: () => [], finish: () => [] }),
});

describe('createToolCallRegistry', () => {
  it('does not offer an unverified parser by default', () => {
    const registry = createToolCallRegistry([{ parser: fakeParser('hermes', '1'), conformance: 'unverified' }]);
    expect(registry.lookup({ name: 'hermes', version: '1' })).toEqual({
      supported: false,
      reason: 'parser-unverified',
    });
  });

  it('offers an unverified parser only when the caller asks for it explicitly', () => {
    const parser = fakeParser('hermes', '1');
    const registry = createToolCallRegistry([{ parser, conformance: 'unverified' }]);
    expect(registry.lookup({ name: 'hermes', version: '1' }, { allowUnverified: true })).toEqual({
      supported: true,
      parser,
    });
  });

  it('offers a vector-verified parser without an opt-in', () => {
    const parser = fakeParser('hermes', '1');
    const registry = createToolCallRegistry([{ parser, conformance: 'vector-verified' }]);
    expect(registry.lookup({ name: 'hermes', version: '1' })).toEqual({ supported: true, parser });
  });

  it('treats a different version as a different parser', () => {
    const registry = createToolCallRegistry([{ parser: fakeParser('hermes', '1'), conformance: 'vector-verified' }]);
    expect(registry.lookup({ name: 'hermes', version: '2' })).toEqual({
      supported: false,
      reason: 'parser-unknown',
    });
  });

  it('reports an empty name as parser-not-pinned, which is not the same fact as unknown', () => {
    const registry = createToolCallRegistry([]);
    expect(registry.lookup({ name: '', version: '' })).toEqual({
      supported: false,
      reason: 'parser-not-pinned',
    });
  });

  it('refuses two registrations of the same (name, version) rather than silently overriding', () => {
    expect(() =>
      createToolCallRegistry([
        { parser: fakeParser('hermes', '1'), conformance: 'vector-verified' },
        { parser: fakeParser('hermes', '1'), conformance: 'unverified' },
      ]),
    ).toThrow(TrueOpenError);
  });

  it('does not conflate two refs whose name and version merely concatenate the same way', () => {
    const a = fakeParser('a', 'b c');
    const b = fakeParser('a b', 'c');
    const registry = createToolCallRegistry([
      { parser: a, conformance: 'vector-verified' },
      { parser: b, conformance: 'vector-verified' },
    ]);
    expect(registry.lookup({ name: 'a', version: 'b c' })).toEqual({ supported: true, parser: a });
    expect(registry.lookup({ name: 'a b', version: 'c' })).toEqual({ supported: true, parser: b });
  });

  it('ships no parsers, because none has vectors yet', () => {
    expect(BUILTIN_TOOL_CALL_PARSERS.lookup({ name: 'hermes', version: '1' })).toEqual({
      supported: false,
      reason: 'parser-unknown',
    });
  });
});

describe('resolveToolCalling', () => {
  it('resolves through the registry', async () => {
    const parser = fakeParser('hermes', '1');
    const registry = createToolCallRegistry([{ parser, conformance: 'vector-verified' }]);
    await expect(resolveToolCalling({ registry, ref: { name: 'hermes', version: '1' } })).resolves.toEqual({
      supported: true,
      parser,
    });
  });

  it('passes allowUnverified through', async () => {
    const parser = fakeParser('hermes', '1');
    const registry = createToolCallRegistry([{ parser, conformance: 'unverified' }]);
    await expect(
      resolveToolCalling({ registry, ref: { name: 'hermes', version: '1' }, allowUnverified: true }),
    ).resolves.toEqual({ supported: true, parser });
  });
});
