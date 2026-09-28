import { describe, it, expect } from 'vitest';
import { canonicalJsonBytes, parseStrictJson } from '../../src/codec/canonical-json';

const dec = new TextDecoder();
const enc = new TextEncoder();
const encode = (v: Parameters<typeof canonicalJsonBytes>[0]): string => dec.decode(canonicalJsonBytes(v));

describe('canonical_json_v1 encoding', () => {
  it('does not HTML-escape: < > & / are literal', () => {
    expect(encode({ u: 'https://a.example/m?x=1&y=<2>' })).toBe('{"u":"https://a.example/m?x=1&y=<2>"}');
  });

  it('escapes only " \\ and control characters, with short forms and lowercase \\u00xx', () => {
    expect(encode('"\\\b\t\n\f\r\u0001\u001f\u007f')).toBe('"\\"\\\\\\b\\t\\n\\f\\r\\u0001\\u001f\u007f"');
  });

  it('escapes U+2028 and U+2029, and writes other non-ASCII as UTF-8', () => {
    expect(encode('  é✓😀')).toBe('"\\u2028\\u2029é✓😀"');
  });

  it('orders keys by UTF-8 bytes, not UTF-16 code units', () => {
    // UTF-16 puts U+1F600 (0xD83D...) before U+FF61; UTF-8 puts U+FF61 (EF BD A1) first.
    const keys = encode({ '\uff61': true, '\u{1f600}': true, b: true, a: true, B: true });
    expect(keys).toBe('{"B":true,"a":true,"b":true,"\uff61":true,"\u{1f600}":true}');
  });

  it('writes integers in shortest decimal form, including uint64', () => {
    expect(encode({ a: 18446744073709551615n, b: 0n, c: 7 } as never)).toBe('{"a":18446744073709551615,"b":0,"c":7}');
  });

  it('rejects null, floats and lone surrogates', () => {
    expect(() => canonicalJsonBytes({ a: null } as never)).toThrow(/null/);
    expect(() => canonicalJsonBytes({ a: 1.5 } as never)).toThrow(/safe integer/);
    expect(() => canonicalJsonBytes('\ud800')).toThrow(/lone surrogate/);
  });
});

describe('strict JSON parsing', () => {
  it('round-trips canonical input byte for byte', () => {
    const text = '{"a":[1,true,"x&<"],"b":{"c":18446744073709551615}}';
    expect(dec.decode(canonicalJsonBytes(parseStrictJson(enc.encode(text))))).toBe(text);
  });

  it.each([
    ['duplicate key', '{"a":1,"a":2}'],
    ['null', '{"a":null}'],
    ['float', '{"a":1.0}'],
    ['exponent', '{"a":1e3}'],
    ['leading zero', '{"a":01}'],
    ['negative zero', '{"a":-0}'],
    ['lone surrogate escape', '"\\ud800"'],
    ['trailing data', '{} {}'],
    ['trailing comma', '[1,]'],
    ['raw control character', '"a\u0001"'],
    ['unknown escape', '"\\x"'],
    ['BOM', '\ufeff{}'],
  ])('rejects %s', (_name, text) => {
    expect(() => parseStrictJson(enc.encode(text))).toThrow(/canonical JSON/);
  });

  it('rejects invalid UTF-8', () => {
    expect(() => parseStrictJson(new Uint8Array([0x22, 0xff, 0x22]))).toThrow(/UTF-8/);
  });

  it('rejects nesting deeper than the limit', () => {
    expect(() => parseStrictJson(enc.encode('['.repeat(100) + ']'.repeat(100)))).toThrow(/too deep/);
  });

  it('accepts escaped forms, which then re-encode differently (so canonical checks catch them)', () => {
    const v = parseStrictJson(enc.encode('"\\u0041\\/"'));
    expect(v).toBe('A/');
    expect(dec.decode(canonicalJsonBytes(v))).toBe('"A/"');
  });
});
