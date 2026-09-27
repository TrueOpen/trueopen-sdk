import { TrueOpenError } from '../errors/errors';

const enc = new TextEncoder();

/**
 * Checks if a string contains a lone surrogate (an unpaired surrogate code unit).
 * A high surrogate (0xD800-0xDBFF) must be followed by a low surrogate (0xDC00-0xDFFF),
 * and a low surrogate must be preceded by a high surrogate. Anything else is a lone surrogate,
 * which has no valid UTF-8 encoding.
 */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i)!;
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: must be followed by a low surrogate
      if (i + 1 >= s.length || !isLowSurrogate(s.charCodeAt(i + 1)!)) {
        return true;
      }
      i += 1; // Skip the low surrogate
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Low surrogate without a preceding high surrogate
      return true;
    }
  }
  return false;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Compares two strings by their UTF-8 bytes, which is what Manifest S2.6 rule 2 specifies
 * for object key ordering.
 *
 * JavaScript's `<` and `Array.prototype.sort` compare UTF-16 code units instead, and the two
 * orders are not merely different -- they are opposite above the BMP. A character at U+10000
 * is the surrogate pair 0xD800 0xDC00 in UTF-16 and so sorts below U+FFFF; in UTF-8 it is
 * `F0 90 80 80` and sorts above U+FFFF's `EF BF BF`. Every key in the V4 manifest is ASCII
 * today, where the two agree, which is exactly why this would go unnoticed.
 *
 * Rejects strings containing lone surrogates (unpaired surrogate code units), which have no
 * valid UTF-8 encoding. Such strings cannot appear in a canonical manifest, so failing loudly
 * on them is correct.
 */
export function compareUtf8(a: string, b: string): number {
  if (a === b) return 0;

  // Detect and reject lone surrogates before encoding
  if (hasLoneSurrogate(a)) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'MANIFEST_CANONICAL_LONE_SURROGATE',
      `String contains a lone surrogate which has no UTF-8 encoding and cannot appear in a canonical manifest: ${JSON.stringify(a)}`
    );
  }
  if (hasLoneSurrogate(b)) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'MANIFEST_CANONICAL_LONE_SURROGATE',
      `String contains a lone surrogate which has no UTF-8 encoding and cannot appear in a canonical manifest: ${JSON.stringify(b)}`
    );
  }

  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const d = x[i]! - y[i]!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function invalid(code: string, message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', code, message);
}

/**
 * Canonical JSON V1 (Manifest S2.6 rules 1-9): sorted object keys, no whitespace, integers
 * only, no Unicode normalisation, shortest valid escapes.
 *
 * It refuses more than `JSON.stringify` does, and the refusals are the point. `JSON.stringify`
 * silently drops an `undefined` property, emits `null`, and prints `1e21` for a large number
 * -- each of which produces bytes that hash to something the chain will not match, with no
 * indication anything went wrong. Here each is an error at the point it occurs.
 */
export function canonicalJsonV1(value: unknown): string {
  return encode(value, '$');
}

/** The UTF-8 bytes of `canonicalJsonV1`, which is what gets hashed. */
export function canonicalJsonV1Bytes(value: unknown): Uint8Array {
  return enc.encode(canonicalJsonV1(value));
}

function encode(value: unknown, path: string): string {
  if (value === null) throw invalid('MANIFEST_CANONICAL_NULL', `null at ${path}; S2.6 rule 10 rejects null, and rule 9 fixes the empty value per type instead`);
  if (value === undefined) throw invalid('MANIFEST_CANONICAL_UNDEFINED', `undefined at ${path}; JSON.stringify would drop this property silently`);

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return value.toString(10);
    case 'number':
      if (!Number.isInteger(value)) {
        throw invalid('MANIFEST_CANONICAL_NOT_INTEGER', `${value} at ${path} is not an integer; S2.6 rule 5 allows only decimal integers`);
      }
      if (!Number.isSafeInteger(value)) {
        // Above 2^53 the value has already lost precision; emitting it would encode a
        // different number than the document meant. Callers must use bigint for u64.
        throw invalid('MANIFEST_CANONICAL_UNSAFE_INTEGER', `${value} at ${path} exceeds Number.MAX_SAFE_INTEGER; pass a bigint so no precision is lost`);
      }
      return value.toString(10);
    case 'string':
      // Check for lone surrogates before delegating to JSON.stringify. JSON.stringify would emit
      // an escape like \ud800 instead of rejecting it, producing canonical bytes the reference
      // implementation may refuse -- a difference that looks like success.
      if (hasLoneSurrogate(value)) {
        throw invalid('MANIFEST_CANONICAL_LONE_SURROGATE', `String contains a lone surrogate which has no UTF-8 encoding and cannot appear in a canonical manifest at ${path}: ${JSON.stringify(value)}`);
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw invalid('MANIFEST_CANONICAL_UNSUPPORTED', `${typeof value} at ${path} cannot appear in a canonical manifest`);
  }

  if (Array.isArray(value)) {
    // Rule 3: arrays keep their semantic order. Sorting one here would silently repair a
    // document that rule 10 requires be rejected; see validate.ts.
    return `[${value.map((v, i) => encode(v, `${path}[${i}]`)).join(',')}]`;
  }

  // Reject non-plain objects. Date, Map, Set, etc. have Object.keys([]) and would silently
  // encode as {} with no indication anything went wrong. The caller would get a wrong hash.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw invalid('MANIFEST_CANONICAL_NOT_PLAIN_OBJECT', `Object at ${path} is not a plain object (prototype is ${proto.constructor?.name || 'unknown'}); only plain objects and objects with null prototype are allowed`);
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);

  // Check every key for lone surrogates before sorting. Array.prototype.sort does not invoke
  // the comparator for arrays of length 0 or 1, so relying on compareUtf8 to catch a bad key
  // would leave singleton and empty objects unguarded.
  for (const k of keys) {
    if (hasLoneSurrogate(k)) {
      throw invalid('MANIFEST_CANONICAL_LONE_SURROGATE', `Object key contains a lone surrogate which has no UTF-8 encoding and cannot appear in a canonical manifest at ${path}: ${JSON.stringify(k)}`);
    }
  }

  const sortedKeys = keys.sort(compareUtf8);
  return `{${sortedKeys.map((k) => `${JSON.stringify(k)}:${encode(obj[k], `${path}.${k}`)}`).join(',')}}`;
}
