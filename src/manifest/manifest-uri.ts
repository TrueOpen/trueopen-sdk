import { base32nopad, base58 } from '@scure/base';
import { TrueOpenError } from '../errors/errors';

/** Default ModelParamsV1.max_manifest_uri_bytes; the chain parameter can differ. */
export const DEFAULT_MAX_MANIFEST_URI_BYTES = 2048;

/**
 * A syntactically valid ProfileState.manifest_uri, split into the parts a fetcher needs.
 * The original string is kept as is: it is hashed into the projection, so it must never
 * be normalized.
 */
export type ManifestUri =
  | { readonly scheme: 'https'; readonly uri: string; readonly host: string; readonly port?: number; readonly pathAndQuery: string }
  | { readonly scheme: 'ipfs'; readonly uri: string; readonly cid: string; readonly path: string };

function invalid(message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'MANIFEST_URI_INVALID', `manifest_uri: ${message}`);
}

/**
 * Validates manifest_uri with the strictest reading of its syntax
 * (wire testdata/v1/hub/manifest_uri_v1.json is the reference):
 *
 *   https:// host [":" port] [path] ["?" query]   no userinfo, no fragment
 *   ipfs://  CID [path]                           CIDv0 base58btc or CIDv1 lowercase base32
 *
 * Printable ASCII only, length 1..maxBytes. Any form two implementations could
 * normalize differently is rejected. Syntax says nothing about reachability: a
 * downloader must still refuse private and loopback addresses at connection time.
 */
export function parseManifestUri(uri: string, maxBytes = DEFAULT_MAX_MANIFEST_URI_BYTES): ManifestUri {
  if (uri.length === 0 || uri.length > maxBytes) throw invalid(`length ${uri.length} outside 1..${maxBytes}`);
  for (let i = 0; i < uri.length; i++) {
    const c = uri.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) throw invalid(`character 0x${c.toString(16)} at ${i} is not printable ASCII`);
  }
  if (uri.includes('#')) throw invalid('fragment is not allowed');
  if (uri.startsWith('https://')) return parseHttps(uri, uri.slice('https://'.length));
  if (uri.startsWith('ipfs://')) return parseIpfs(uri, uri.slice('ipfs://'.length));
  throw invalid('scheme must be exactly https:// or ipfs://');
}

/** Boolean form of parseManifestUri. */
export function isValidManifestUri(uri: string, maxBytes = DEFAULT_MAX_MANIFEST_URI_BYTES): boolean {
  try {
    parseManifestUri(uri, maxBytes);
    return true;
  } catch {
    return false;
  }
}

function parseHttps(uri: string, rest: string): ManifestUri {
  const end = rest.search(/[/?]/);
  const authority = end >= 0 ? rest.slice(0, end) : rest;
  const tail = end >= 0 ? rest.slice(end) : '';
  if (authority.includes('@')) throw invalid('userinfo is not allowed');

  let host: string;
  let port = '';
  if (authority.startsWith('[')) {
    const closing = authority.indexOf(']');
    if (closing < 0) throw invalid('unterminated IPv6 literal');
    host = authority.slice(0, closing + 1);
    port = authority.slice(closing + 1);
    validateIpv6Literal(host);
    // Only ":port" may follow the bracket; anything else is glued onto the literal.
    if (port !== '' && port[0] !== ':') throw invalid(`${JSON.stringify(port)} after the IPv6 literal is not a :port`);
  } else {
    const colon = authority.lastIndexOf(':');
    host = colon >= 0 ? authority.slice(0, colon) : authority;
    port = colon >= 0 ? authority.slice(colon) : '';
    validateHost(host);
  }
  const portNumber = port === '' ? undefined : validatePort(port);

  const q = tail.indexOf('?');
  const path = q >= 0 ? tail.slice(0, q) : tail;
  const query = q >= 0 ? tail.slice(q + 1) : '';
  if (path !== '' && !path.startsWith('/')) throw invalid('path must start with /');
  validateUriChars('path', path, '/');
  validateUriChars('query', query, '/?');
  return {
    scheme: 'https',
    uri,
    host,
    ...(portNumber !== undefined ? { port: portNumber } : {}),
    pathAndQuery: tail === '' ? '/' : tail,
  };
}

function validateHost(host: string): void {
  if (host === '') throw invalid('missing host');
  if (/^[0-9][0-9.]*$/.test(host)) {
    validateIpv4(host);
    return;
  }
  if (host.length > 253 || host.endsWith('.')) throw invalid(`host ${JSON.stringify(host)} is too long or ends in a dot`);
  const labels = host.split('.');
  if (labels.length < 2) throw invalid(`host ${JSON.stringify(host)} is not a fully qualified name`);
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      throw invalid(`host label ${JSON.stringify(label)} must be 1-63 lowercase letters, digits or inner hyphens`);
    }
  }
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) throw invalid('top-level label is all digits');
}

function validateIpv4(host: string): void {
  const octets = host.split('.');
  if (octets.length !== 4) throw invalid(`IPv4 literal ${JSON.stringify(host)} needs four octets`);
  for (const o of octets) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(o) || Number(o) > 255) {
      throw invalid(`IPv4 octet ${JSON.stringify(o)} is not canonical decimal 0..255`);
    }
  }
}

/**
 * Accepts only the RFC 5952 canonical text of an IPv6 address: lowercase, no leading
 * zeros, the longest run (first on a tie) of two or more zero groups compressed. No
 * zone, and no dotted-quad tail (the canonical text of an IPv4-mapped address is its
 * IPv4 form, so a bracketed one can never be canonical).
 */
function validateIpv6Literal(bracketed: string): void {
  const inner = bracketed.slice(1, -1);
  if (inner.includes('%')) throw invalid('IPv6 zone is not allowed');
  const groups = parseIpv6Groups(inner);
  if (groups === undefined) throw invalid(`${JSON.stringify(inner)} is not an IPv6 literal`);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    throw invalid(`IPv4-mapped literal ${JSON.stringify(inner)} is not canonical IPv6`);
  }
  const canonical = formatIpv6(groups);
  if (canonical !== inner) throw invalid(`IPv6 literal ${JSON.stringify(inner)} is not in canonical form ${canonical}`);
}

function parseIpv6Groups(s: string): number[] | undefined {
  if (!/^[0-9a-fA-F:]+$/.test(s)) return undefined;
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  if (head === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const tail = parse(halves[1]!);
  if (tail === undefined || head.length + tail.length > 7) return undefined;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

function formatIpv6(groups: number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

function validatePort(port: string): number {
  const digits = port.slice(1);
  if (!/^[1-9][0-9]{0,4}$/.test(digits)) throw invalid(`port ${JSON.stringify(port)} is not canonical decimal`);
  const value = Number(digits);
  if (value > 65535) throw invalid(`port ${JSON.stringify(port)} is outside 1..65535`);
  return value;
}

const PCHAR = /^[A-Za-z0-9\-._~!$&'()*+,;=:@]$/;

/** RFC 3986 pchar plus the given extra characters, and %XX with uppercase hex only. */
function validateUriChars(part: string, s: string, extra: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '%') {
      if (!/^[0-9A-F]{2}$/.test(s.slice(i + 1, i + 3))) {
        throw invalid(`${part}: percent-encoding at ${i} is not %XX with uppercase hex`);
      }
      i += 2;
      continue;
    }
    if (!PCHAR.test(c) && !extra.includes(c)) throw invalid(`${part}: character ${JSON.stringify(c)} is not allowed`);
  }
}

/**
 * Refuses "." and ".." path segments. An ipfs path is appended to an operator-configured
 * gateway base, and a URL parser resolves dot segments before the request is sent, so a
 * traversal would let the chain-provided URI escape `/ipfs/<cid>/` and address an
 * arbitrary path on that gateway. `%2E` counts as a dot: validateUriChars already forces
 * uppercase hex, so that is the only encoded form to fold.
 */
function rejectDotSegments(path: string): void {
  for (const segment of path.split('/')) {
    const folded = segment.split('%2E').join('.');
    if (folded === '.' || folded === '..') {
      throw invalid(`path segment ${JSON.stringify(segment)} is a dot segment`);
    }
  }
}

function parseIpfs(uri: string, rest: string): ManifestUri {
  const slash = rest.indexOf('/');
  const cid = slash >= 0 ? rest.slice(0, slash) : rest;
  const path = slash >= 0 ? rest.slice(slash) : '';
  if (cid.includes('?')) throw invalid('ipfs URI does not take a query');
  validateCid(cid);
  validateUriChars('path', path, '/');
  rejectDotSegments(path);
  return { scheme: 'ipfs', uri, cid, path };
}

function validateCid(cid: string): void {
  if (cid.startsWith('Qm')) {
    if (cid.length !== 46) throw invalid('CIDv0 must be 46 characters');
    let raw: Uint8Array;
    try {
      raw = base58.decode(cid);
    } catch {
      throw invalid('CIDv0 is not base58btc');
    }
    if (raw.length !== 34 || raw[0] !== 0x12 || raw[1] !== 0x20) throw invalid('CIDv0 is not a sha2-256 multihash');
    return;
  }
  if (cid.startsWith('b')) {
    const body = cid.slice(1);
    if (!/^[a-z2-7]+$/.test(body)) throw invalid('CIDv1 must be lowercase unpadded base32');
    let raw: Uint8Array;
    try {
      raw = base32nopad.decode(body.toUpperCase());
    } catch {
      throw invalid('CIDv1 base32 does not decode');
    }
    if (base32nopad.encode(raw) !== body.toUpperCase()) throw invalid('CIDv1 base32 is not canonical');
    let off = 0;
    const next = (what: string): bigint => {
      const r = minimalUvarint(raw, off);
      if (r === undefined) throw invalid(`${what} is not a minimal varint of at most 9 bytes`);
      off += r.size;
      return r.value;
    };
    if (next('CID version') !== 1n) throw invalid('CID version must be 1');
    next('CIDv1 codec');
    next('multihash code');
    const length = next('multihash length');
    if (length === 0n || BigInt(raw.length - off) !== length) throw invalid('multihash length does not match its digest');
    return;
  }
  throw invalid('CID must be CIDv0 (Qm...) or CIDv1 base32 (b...)');
}

/**
 * Decodes a multiformats unsigned varint that must be minimally encoded and at most
 * 9 bytes. A padded form such as 0x81 0x00 for 1 would let two byte strings name the
 * same CID, so it is rejected.
 */
function minimalUvarint(raw: Uint8Array, off: number): { value: bigint; size: number } | undefined {
  let value = 0n;
  for (let i = 0; i < 9; i++) {
    const b = raw[off + i];
    if (b === undefined) return undefined;
    value |= BigInt(b & 0x7f) << BigInt(7 * i);
    if ((b & 0x80) === 0) {
      // A final zero byte after the first means the value had a shorter encoding.
      if (i > 0 && b === 0) return undefined;
      return { value, size: i + 1 };
    }
  }
  return undefined;
}
