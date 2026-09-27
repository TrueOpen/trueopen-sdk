import { TrueOpenError } from '../errors/errors';

/**
 * canonical_json_v1 (wire docs/CANONICAL_ENCODING_V1.md, "Canonical JSON").
 *
 * Values are UTF-8 strings, integers, booleans, arrays and objects. Integers are held
 * as bigint so uint64 values never lose precision. null, floats, exponents, leading
 * zeros and "-0" are rejected. Object keys ascend by UTF-8 bytes; there is no
 * whitespace and no trailing newline.
 *
 * String escaping escapes only `"`, `\` and U+0000..U+001F (short forms for \b \t \n
 * \f \r, lowercase \u00xx otherwise), plus U+2028 and U+2029. HTML escaping is
 * disabled: `<`, `>`, `&` and `/` are written as themselves. An encoder that
 * HTML-escapes (Go's encoding/json default) cannot reproduce wire digests over a
 * value containing `&`, such as a manifest_uri with a query string.
 */
export type CanonicalJsonValue =
  | string
  | bigint
  | boolean
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/** Nesting deeper than this is rejected, so hostile input cannot exhaust the stack. */
const MAX_DEPTH = 64;

const enc = new TextEncoder();

function invalid(message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'CANONICAL_JSON_INVALID', `canonical JSON: ${message}`);
}

/** Whether a string holds an unpaired UTF-16 surrogate (not representable as UTF-8). */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function compareUtf8(a: string, b: string): number {
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

function encodeString(s: string): string {
  if (hasLoneSurrogate(s)) throw invalid('string is not valid UTF-8 (lone surrogate)');
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    switch (c) {
      case 0x22: out += '\\"'; break;
      case 0x5c: out += '\\\\'; break;
      case 0x08: out += '\\b'; break;
      case 0x09: out += '\\t'; break;
      case 0x0a: out += '\\n'; break;
      case 0x0c: out += '\\f'; break;
      case 0x0d: out += '\\r'; break;
      case 0x2028: out += '\\u2028'; break;
      case 0x2029: out += '\\u2029'; break;
      default:
        out += c < 0x20 ? `\\u00${c.toString(16).padStart(2, '0')}` : ch;
    }
  }
  return `${out}"`;
}

function encodeValue(v: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw invalid('nesting too deep');
  if (typeof v === 'string') return encodeString(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    // Accepted for convenience, but only as an exact integer.
    if (!Number.isSafeInteger(v)) throw invalid(`number ${v} is not a safe integer`);
    return BigInt(v).toString();
  }
  if (Array.isArray(v)) return `[${v.map((x) => encodeValue(x, depth + 1)).join(',')}]`;
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) {
    const keys = Object.keys(v).sort(compareUtf8);
    const parts = keys.map((k) => `${encodeString(k)}:${encodeValue((v as Record<string, unknown>)[k], depth + 1)}`);
    return `{${parts.join(',')}}`;
  }
  throw invalid(`unsupported value ${v === null ? 'null' : typeof v}`);
}

/** Encodes a value as canonical_json_v1 bytes. */
export function canonicalJsonBytes(value: CanonicalJsonValue): Uint8Array {
  return enc.encode(encodeValue(value, 0));
}

/**
 * Strictly parses JSON bytes into canonical JSON values.
 *
 * Rejects invalid UTF-8 (including a BOM), duplicate object keys, null, floats,
 * exponents, leading zeros, "-0", lone surrogate escapes and trailing data. It does
 * not reject non-canonical whitespace or key order: callers that need canonical input
 * re-encode with canonicalJsonBytes and compare bytes, which catches both.
 */
export function parseStrictJson(bytes: Uint8Array): CanonicalJsonValue {
  let text: string;
  try {
    // ignoreBOM keeps a leading U+FEFF in the text so the parser rejects it.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (e) {
    throw new TrueOpenError('SDK_LOCAL', 'CANONICAL_JSON_INVALID', 'canonical JSON: input is not valid UTF-8', {
      cause: e,
    });
  }
  const p = new Parser(text);
  p.ws();
  const value = p.value(0);
  p.ws();
  if (p.pos !== text.length) throw invalid(`unexpected data at offset ${p.pos}`);
  return value;
}

class Parser {
  pos = 0;
  constructor(private readonly s: string) {}

  ws(): void {
    while (this.pos < this.s.length) {
      const c = this.s[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.pos++;
      else break;
    }
  }

  private fail(what: string): never {
    throw invalid(`${what} at offset ${this.pos}`);
  }

  value(depth: number): CanonicalJsonValue {
    if (depth > MAX_DEPTH) this.fail('nesting too deep');
    const c = this.s[this.pos];
    if (c === '{') return this.object(depth);
    if (c === '[') return this.array(depth);
    if (c === '"') return this.string();
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return this.integer();
    if (this.s.startsWith('true', this.pos)) {
      this.pos += 4;
      return true;
    }
    if (this.s.startsWith('false', this.pos)) {
      this.pos += 5;
      return false;
    }
    if (this.s.startsWith('null', this.pos)) this.fail('null is not allowed');
    return this.fail('unexpected character');
  }

  private object(depth: number): CanonicalJsonValue {
    this.pos++;
    const out: Record<string, CanonicalJsonValue> = Object.create(null) as Record<string, CanonicalJsonValue>;
    const seen = new Set<string>();
    this.ws();
    if (this.s[this.pos] === '}') {
      this.pos++;
      return { ...out };
    }
    for (;;) {
      this.ws();
      if (this.s[this.pos] !== '"') this.fail('expected object key');
      const key = this.string();
      if (seen.has(key)) this.fail(`duplicate key ${JSON.stringify(key)}`);
      seen.add(key);
      this.ws();
      if (this.s[this.pos] !== ':') this.fail('expected ":"');
      this.pos++;
      this.ws();
      out[key] = this.value(depth + 1);
      this.ws();
      const c = this.s[this.pos];
      this.pos++;
      if (c === '}') break;
      if (c !== ',') this.fail('expected "," or "}"');
    }
    // Copy onto a normal object so callers can use it like any parsed JSON.
    return { ...out };
  }

  private array(depth: number): CanonicalJsonValue {
    this.pos++;
    const out: CanonicalJsonValue[] = [];
    this.ws();
    if (this.s[this.pos] === ']') {
      this.pos++;
      return out;
    }
    for (;;) {
      this.ws();
      out.push(this.value(depth + 1));
      this.ws();
      const c = this.s[this.pos];
      this.pos++;
      if (c === ']') break;
      if (c !== ',') this.fail('expected "," or "]"');
    }
    return out;
  }

  private integer(): bigint {
    const m = /^-?(0|[1-9][0-9]*)/.exec(this.s.slice(this.pos, this.pos + 32));
    if (m === null) this.fail('malformed number');
    const text = m[0];
    const next = this.s[this.pos + text.length];
    if (next === '.' || next === 'e' || next === 'E') this.fail('only integers are allowed');
    if (next !== undefined && next >= '0' && next <= '9') this.fail('integer too long or has a leading zero');
    if (text === '-0') this.fail('"-0" is not canonical');
    this.pos += text.length;
    return BigInt(text);
  }

  private string(): string {
    this.pos++;
    let out = '';
    for (;;) {
      const c = this.s[this.pos];
      if (c === undefined) this.fail('unterminated string');
      if (c === '"') {
        this.pos++;
        break;
      }
      if (c < ' ') this.fail('raw control character in string');
      if (c !== '\\') {
        out += c;
        this.pos++;
        continue;
      }
      const e = this.s[this.pos + 1];
      this.pos += 2;
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          const hex = this.s.slice(this.pos, this.pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('malformed \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += 4;
          break;
        }
        default:
          this.fail('unknown escape');
      }
    }
    if (hasLoneSurrogate(out)) this.fail('string escapes a lone surrogate');
    return out;
  }
}
