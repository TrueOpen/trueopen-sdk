import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Transform } from 'node:stream';
import { TrueOpenError } from '../errors/errors';
import { isPublicAddress } from './address-policy';
import type { ManifestFetcher, ManifestFetchLimits } from './manifest-source';

/** Resolves a host name to its addresses. Injectable for tests. */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export interface NodeManifestFetcherOptions {
  /** Defaults to the system resolver (dns.lookup with all addresses). */
  readonly resolve?: HostResolver;
  /**
   * Which resolved addresses may be connected to. Defaults to isPublicAddress. Only
   * relax this for a trusted, operator-configured source (for example a local IPFS
   * gateway); never for the chain-provided manifest_uri.
   */
  readonly allowAddress?: (ip: string) => boolean;
  /** Allow plain http. Off by default; https is never followed by a redirect to http. */
  readonly allowHttp?: boolean;
  /** Maximum redirects to follow; defaults to 3. */
  readonly maxRedirects?: number;
  /** Extra attempts after a retriable failure (network error, 5xx); defaults to 1. */
  readonly retries?: number;
  /** Time allowed until the TLS (or TCP, for http) connection is established; defaults to 5 s. */
  readonly connectTimeoutMs?: number;
  /** Additional trusted CA certificates (PEM), for example a private PKI. */
  readonly ca?: string | readonly string[];
}

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_RETRIES = 1;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

class FetchFailure extends TrueOpenError {
  constructor(code: string, message: string, retriable: boolean) {
    super('DATA', code, `manifest fetch: ${message}`, { retriable });
  }
}

const refused = (message: string): FetchFailure => new FetchFailure('MANIFEST_FETCH_REFUSED', message, false);
const tooLarge = (message: string): FetchFailure => new FetchFailure('MANIFEST_TOO_LARGE', message, false);

const systemResolve: HostResolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/**
 * The default Node downloader for an untrusted manifest_uri. For every attempt and
 * every redirect hop it:
 *   - resolves the host and refuses unless every address passes the address policy;
 *   - connects to the address it checked, through a pinned lookup, so the HTTP client
 *     never resolves the name a second time (DNS rebinding);
 *   - verifies TLS against the original host name;
 *   - follows at most 3 redirects, never from https to http;
 *   - enforces a connect timeout and one total timeout across hops and retries;
 *   - rejects a Content-Length above the cap before reading, and aborts once the
 *     bytes read, after gzip/deflate/br decompression, exceed it. Any other
 *     Content-Encoding is refused.
 */
export function createNodeManifestFetcher(opts: NodeManifestFetcherOptions = {}): ManifestFetcher {
  const resolve = opts.resolve ?? systemResolve;
  const allowAddress = opts.allowAddress ?? isPublicAddress;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  return async (url: string, limits: ManifestFetchLimits): Promise<Uint8Array> => {
    const deadline = Date.now() + limits.timeoutMs;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fetchFollowingRedirects(url, limits.maxBytes, deadline);
      } catch (e) {
        lastError = e;
        const retriable = e instanceof TrueOpenError && e.retriable;
        if (!retriable || Date.now() >= deadline) break;
      }
    }
    throw lastError;
  };

  async function fetchFollowingRedirects(startUrl: string, maxBytes: number, deadline: number): Promise<Uint8Array> {
    let current = new URL(startUrl);
    let sawHttps = false;
    for (let hop = 0; ; hop++) {
      if (current.protocol === 'https:') sawHttps = true;
      else if (current.protocol !== 'http:' || !opts.allowHttp) throw refused(`scheme ${current.protocol} is not allowed`);
      else if (sawHttps) throw refused('redirect from https to http');
      if (current.username !== '' || current.password !== '') throw refused('userinfo is not allowed');

      const res = await requestOnce(current, maxBytes, deadline);
      if (res.kind === 'body') return res.body;
      if (hop >= maxRedirects) throw refused(`more than ${maxRedirects} redirects`);
      current = new URL(res.location, current);
    }
  }

  async function requestOnce(
    url: URL,
    maxBytes: number,
    deadline: number,
  ): Promise<{ kind: 'body'; body: Uint8Array } | { kind: 'redirect'; location: string }> {
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
    const addresses = isIP(host) !== 0 ? [host] : await withDeadline(resolve(host), deadline);
    if (addresses.length === 0) throw new FetchFailure('MANIFEST_FETCH_DNS', `${host} has no addresses`, true);
    const bad = addresses.find((a) => !allowAddress(a));
    if (bad !== undefined) throw refused(`${host} resolves to a non-public address ${bad}`);
    const pinned = addresses[0]!;
    const family = isIP(pinned);

    // Every lookup the HTTP client makes returns the address checked above.
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if ((options as { all?: boolean }).all === true) {
        (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: pinned, family }]);
      } else {
        callback(null, pinned, family);
      }
    };

    const isHttps = url.protocol === 'https:';
    const reqOpts: RequestOptions & { servername?: string; ca?: string | string[] } = {
      protocol: url.protocol,
      host,
      port: url.port === '' ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { accept: 'application/json', 'accept-encoding': 'gzip, deflate, br' },
      lookup: pinnedLookup,
      // No pooled sockets: a reused connection could point at a different address.
      agent: false,
    };
    if (isHttps) {
      // TLS is verified against the URL's host name, not the pinned address.
      if (isIP(host) === 0) reqOpts.servername = host;
      if (opts.ca !== undefined) reqOpts.ca = typeof opts.ca === 'string' ? opts.ca : [...opts.ca];
    }

    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      let req: ClientRequest | undefined;
      const finish = (err: unknown, value?: { kind: 'body'; body: Uint8Array } | { kind: 'redirect'; location: string }): void => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        if (err !== undefined) {
          req?.destroy();
          rejectPromise(err);
        } else {
          resolvePromise(value!);
        }
      };

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        finish(new FetchFailure('MANIFEST_FETCH_TIMEOUT', 'total timeout exceeded', false));
        return;
      }
      timers.push(setTimeout(() => finish(new FetchFailure('MANIFEST_FETCH_TIMEOUT', 'total timeout exceeded', false)), remaining));
      const connectTimer = setTimeout(
        () => finish(new FetchFailure('MANIFEST_FETCH_TIMEOUT', `connect timeout after ${connectTimeoutMs} ms`, true)),
        Math.min(connectTimeoutMs, remaining),
      );
      timers.push(connectTimer);

      req = (isHttps ? httpsRequest : httpRequest)(reqOpts, (res) => {
        handleResponse(res, maxBytes, finish);
      });
      req.on('socket', (socket) => {
        socket.once(isHttps ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
      });
      req.on('error', (e) => {
        const tls = /CERT|SSL|TLS|ALTNAME/i.test((e as { code?: string }).code ?? '');
        finish(tls ? new FetchFailure('MANIFEST_FETCH_TLS', e.message, false) : new FetchFailure('MANIFEST_FETCH_NETWORK', e.message, true));
      });
      req.end();
    });
  }
}

function handleResponse(
  res: IncomingMessage,
  maxBytes: number,
  finish: (err: unknown, value?: { kind: 'body'; body: Uint8Array } | { kind: 'redirect'; location: string }) => void,
): void {
  const status = res.statusCode ?? 0;
  if ([301, 302, 303, 307, 308].includes(status)) {
    const location = res.headers.location;
    res.destroy();
    if (location === undefined || location === '') finish(refused(`redirect ${status} without Location`));
    else finish(undefined, { kind: 'redirect', location });
    return;
  }
  if (status < 200 || status > 299) {
    res.destroy();
    finish(new FetchFailure('MANIFEST_FETCH_HTTP_STATUS', `HTTP ${status}`, status >= 500));
    return;
  }

  const declared = res.headers['content-length'];
  if (declared !== undefined && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes) {
    res.destroy();
    finish(tooLarge(`Content-Length ${declared} exceeds ${maxBytes}`));
    return;
  }

  let decoder: Transform | undefined;
  const encoding = (res.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (encoding === 'gzip' || encoding === 'x-gzip') decoder = createGunzip();
  else if (encoding === 'deflate') decoder = createInflate();
  else if (encoding === 'br') decoder = createBrotliDecompress();
  else if (encoding !== '' && encoding !== 'identity') {
    res.destroy();
    finish(refused(`unsupported Content-Encoding ${JSON.stringify(encoding)}`));
    return;
  }

  const chunks: Buffer[] = [];
  let decoded = 0;
  const fail = (e: unknown): void => {
    // Settle first: destroying the response emits 'aborted', which must not win.
    finish(e);
    decoder?.destroy();
    res.destroy();
  };
  const onDecoded = (chunk: Buffer): void => {
    decoded += chunk.length;
    if (decoded > maxBytes) {
      fail(tooLarge(`body exceeds ${maxBytes} bytes${decoder !== undefined ? ' after decompression' : ''}`));
      return;
    }
    chunks.push(chunk);
  };
  const onEnd = (): void => finish(undefined, { kind: 'body', body: new Uint8Array(Buffer.concat(chunks)) });

  // Counting decoded bytes also bounds an uncompressed body; a compressed one can only
  // grow when decoded.
  res.on('data', (chunk: Buffer) => {
    if (decoder !== undefined) decoder.write(chunk);
    else onDecoded(chunk);
  });
  res.on('error', (e) => fail(new FetchFailure('MANIFEST_FETCH_NETWORK', e.message, true)));
  res.on('aborted', () => fail(new FetchFailure('MANIFEST_FETCH_NETWORK', 'response aborted', true)));
  if (decoder !== undefined) {
    decoder.on('data', onDecoded);
    decoder.on('error', (e) => fail(refused(`invalid ${encoding} body: ${e.message}`)));
    decoder.on('end', onEnd);
    res.on('end', () => decoder!.end());
  } else {
    res.on('end', onEnd);
  }
}

async function withDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new FetchFailure('MANIFEST_FETCH_TIMEOUT', 'total timeout exceeded', false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.catch((e: unknown) => {
        throw new FetchFailure('MANIFEST_FETCH_DNS', e instanceof Error ? e.message : String(e), true);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FetchFailure('MANIFEST_FETCH_TIMEOUT', 'total timeout exceeded', false)), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
