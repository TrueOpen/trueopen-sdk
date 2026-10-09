import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOL_CALL_PARSERS, createToolCallRegistry } from '../../src/toolcall/registry';
import type { ToolCallParser } from '../../src/toolcall/types';
import { TrueOpenError } from '../../src/errors/errors';

const fakeParser = (name: string, version: number): ToolCallParser => ({
  name,
  version,
  parseComplete: (text) => ({ role: 'assistant', content: text, toolCalls: [] }),
  createStreamState: () => ({ push: () => [], finish: () => [] }),
});

describe('createToolCallRegistry', () => {
  it('does not offer an unverified parser by default', () => {
    const registry = createToolCallRegistry([{ parser: fakeParser('hermes', 1), conformance: 'unverified' }]);
    expect(registry.lookup({ name: 'hermes', version: 1 })).toEqual({
      supported: false,
      reason: 'parser-unverified',
    });
  });

  it('offers an unverified parser only when the caller asks for it explicitly', () => {
    const parser = fakeParser('hermes', 1);
    const registry = createToolCallRegistry([{ parser, conformance: 'unverified' }]);
    expect(registry.lookup({ name: 'hermes', version: 1 }, { allowUnverified: true })).toEqual({
      supported: true,
      parser,
    });
  });

  it('offers a vector-verified parser without an opt-in', () => {
    const parser = fakeParser('hermes', 1);
    const registry = createToolCallRegistry([{ parser, conformance: 'vector-verified' }]);
    expect(registry.lookup({ name: 'hermes', version: 1 })).toEqual({ supported: true, parser });
  });

  it('treats a different version as a different parser', () => {
    const registry = createToolCallRegistry([{ parser: fakeParser('hermes', 1), conformance: 'vector-verified' }]);
    expect(registry.lookup({ name: 'hermes', version: 2 })).toEqual({
      supported: false,
      reason: 'parser-unknown',
    });
  });

  it('reports an empty name as parser-not-pinned, which is not the same fact as unknown', () => {
    const registry = createToolCallRegistry([]);
    expect(registry.lookup({ name: '', version: 0 })).toEqual({
      supported: false,
      reason: 'parser-not-pinned',
    });
  });

  it('refuses two registrations of the same (name, version) rather than silently overriding', () => {
    expect(() =>
      createToolCallRegistry([
        { parser: fakeParser('hermes', 1), conformance: 'vector-verified' },
        { parser: fakeParser('hermes', 1), conformance: 'unverified' },
      ]),
    ).toThrow(TrueOpenError);
  });

  it('keeps refs distinct when one name is the other plus the separator', () => {
    // This started as a regression test for a space-joined key, where {a, 'b c'} and
    // {'a b', c} both produced "a b c". A numeric version killed that particular collision
    // -- a number cannot contain the separator, so `${name} ${version}` would in fact be
    // injective now. The encoding stays JSON.stringify because `name` is still an
    // unbounded governance-supplied string and injectivity should not rest on a property
    // of the *other* field.
    const a = fakeParser('a', 1);
    const b = fakeParser('a 1', 1);
    const registry = createToolCallRegistry([
      { parser: a, conformance: 'vector-verified' },
      { parser: b, conformance: 'vector-verified' },
    ]);
    expect(registry.lookup({ name: 'a', version: 1 })).toEqual({ supported: true, parser: a });
    expect(registry.lookup({ name: 'a 1', version: 1 })).toEqual({ supported: true, parser: b });
  });

  it('refuses a parser whose version is below 1, which the manifest spec rejects at registration', () => {
    expect(() =>
      createToolCallRegistry([{ parser: fakeParser('hermes', 0), conformance: 'vector-verified' }]),
    ).toThrow(TrueOpenError);
  });

  it('ships no parsers, because none has vectors yet', () => {
    expect(BUILTIN_TOOL_CALL_PARSERS.lookup({ name: 'hermes', version: 1 })).toEqual({
      supported: false,
      reason: 'parser-unknown',
    });
  });
});
