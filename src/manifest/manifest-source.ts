import { TrueOpenError } from '../errors/errors';
import { parseManifestUri, DEFAULT_MAX_MANIFEST_URI_BYTES } from './manifest-uri';
import { MAX_MANIFEST_BYTES, verifyManifestBytes } from './model-manifest';
import type { ProfileManifestState, RegistrationCheck, VerifiedManifest } from './model-manifest';

/** Bounds every fetcher must enforce. maxBytes counts decompressed bytes. */
export interface ManifestFetchLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

/**
 * Fetches one URL and returns the body, or throws. The fetcher used for the
 * chain-provided manifest_uri talks to an address chosen by whoever registered the
 * profile, so it must enforce the downloader obligations (address policy, pinned
 * connection, redirect and size limits); see createNodeManifestFetcher in
 * "trueopen-sdk/node".
 */
export type ManifestFetcher = (url: string, limits: ManifestFetchLimits) => Promise<Uint8Array>;

/** A cache of verified manifest bodies keyed by manifest_hash (lowercase 64-hex). */
export interface ManifestCache {
  get(manifestHash: string): Uint8Array | undefined | Promise<Uint8Array | undefined>;
  set(manifestHash: string, bytes: Uint8Array): void | Promise<void>;
}

/** In-memory ManifestCache with a simple entry cap (oldest entry evicted first). */
export class MemoryManifestCache implements ManifestCache {
  private readonly entries = new Map<string, Uint8Array>();
  constructor(private readonly maxEntries = 64) {}

  get(manifestHash: string): Uint8Array | undefined {
    return this.entries.get(manifestHash);
  }

  set(manifestHash: string, bytes: Uint8Array): void {
    this.entries.delete(manifestHash);
    this.entries.set(manifestHash, bytes);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }
}

/** Reads the on-chain state a manifest is verified against (HubReader implements it). */
export interface ProfileManifestReader {
  getProfileManifestState(modelId: string, profileVersion: bigint): Promise<ProfileManifestState>;
}

export interface ManifestSourceOptions {
  readonly reader: ProfileManifestReader;
  /**
   * Fetcher for the chain-provided https manifest_uri. Must be SSRF-safe. Without it
   * the manifest_uri step is skipped, which is the expected setup in a browser.
   */
  readonly fetcher?: ManifestFetcher;
  /**
   * Operator-configured mirrors that serve the same bytes by manifest_hash, as URL
   * templates containing "{manifest_hash}" (lowercase 64-hex), for example
   * "https://mirror.example/manifests/{manifest_hash}.json". Tried in order after
   * manifest_uri. Every body is verified the same way, so a mirror is trusted for
   * availability only.
   */
  readonly mirrors?: readonly string[];
  /**
   * Base URL of a local or trusted IPFS gateway, for example "http://127.0.0.1:8080".
   * ipfs:// manifest URIs are fetched only through it, as `${gateway}/ipfs/${cid}${path}`.
   */
  readonly ipfsGateway?: string;
  /**
   * Fetcher for mirrors and the IPFS gateway (operator-configured, so no address policy).
   * Defaults to boundedWebFetch over globalThis.fetch.
   */
  readonly trustedFetcher?: ManifestFetcher;
  /** Defaults to a MemoryManifestCache. Cached bodies are re-verified on every read. */
  readonly cache?: ManifestCache;
  /** ModelParamsV1.max_manifest_uri_bytes; defaults to 2048. */
  readonly maxManifestUriBytes?: number;
  /** Total time budget per source fetch; defaults to 20 s. */
  readonly timeoutMs?: number;
  /** Optional full-projection check through ProfileState.registration_digest. */
  readonly registration?: RegistrationCheck;
}

export type ManifestSourceKind = 'cache' | 'manifest_uri' | 'mirror';

/** One source that was tried and did not produce a verified manifest. */
export interface ManifestAttempt {
  readonly source: ManifestSourceKind;
  readonly url?: string;
  readonly code: string;
  readonly message: string;
}

export interface ManifestFetchResult extends VerifiedManifest {
  readonly state: ProfileManifestState;
  readonly source: ManifestSourceKind;
  readonly url?: string;
  /** Sources tried before the one that succeeded. */
  readonly attempts: readonly ManifestAttempt[];
}

const DEFAULT_TIMEOUT_MS = 20_000;
const HASH_PLACEHOLDER = '{manifest_hash}';

function configError(message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'MANIFEST_SOURCE_MISCONFIGURED', `manifest source: ${message}`);
}

function httpBaseUrl(what: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value.replace(HASH_PLACEHOLDER, '0'));
  } catch {
    throw configError(`${what} ${JSON.stringify(value)} is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw configError(`${what} must be http(s)`);
  return url;
}

/**
 * Turns the chain's manifest_hash into verified manifest bytes.
 *
 * Fetch order: local cache, then ProfileState.manifest_uri, then mirrors. Every source
 * is verified the same way (hash, strict parse, canonical bytes, projection); a failure
 * moves on to the next source. manifest_uri is a hint, never a trust source.
 */
export class ManifestSource {
  private readonly opts: ManifestSourceOptions;
  private readonly cache: ManifestCache;
  private readonly trustedFetcher: ManifestFetcher;
  private readonly limits: ManifestFetchLimits;

  constructor(opts: ManifestSourceOptions) {
    const mirrors = opts.mirrors ?? [];
    if (opts.fetcher === undefined && mirrors.length === 0 && opts.ipfsGateway === undefined) {
      throw configError(
        'no network source: pass an SSRF-safe fetcher (Node: createNodeManifestSource from "trueopen-sdk/node"), ' +
          'or configure at least one mirror or IPFS gateway',
      );
    }
    for (const m of mirrors) {
      if (!m.includes(HASH_PLACEHOLDER)) throw configError(`mirror ${JSON.stringify(m)} must contain ${HASH_PLACEHOLDER}`);
      httpBaseUrl('mirror', m);
    }
    if (opts.ipfsGateway !== undefined) httpBaseUrl('ipfsGateway', opts.ipfsGateway);
    this.opts = opts;
    this.cache = opts.cache ?? new MemoryManifestCache();
    this.trustedFetcher = opts.trustedFetcher ?? boundedWebFetch;
    this.limits = { maxBytes: MAX_MANIFEST_BYTES, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS };
  }

  /** Reads ProfileState (manifest_hash, manifest_uri, projection fields) and fetches the verified manifest. */
  async fetchManifest(modelId: string, profileVersion: bigint): Promise<ManifestFetchResult> {
    const state = await this.opts.reader.getProfileManifestState(modelId, profileVersion);
    return this.fetchForState(state);
  }

  /** Same as fetchManifest, for a ProfileState the caller already holds. */
  async fetchForState(state: ProfileManifestState): Promise<ManifestFetchResult> {
    if (!/^[0-9a-f]{64}$/.test(state.manifestHash)) {
      throw new TrueOpenError('DATA', 'MANIFEST_NOT_REGISTERED', 'profile has no canonical manifest_hash');
    }
    const attempts: ManifestAttempt[] = [];
    const verify = (bytes: Uint8Array): VerifiedManifest => verifyManifestBytes(bytes, state, this.opts.registration);

    // 1. Local cache, keyed by manifest_hash. Re-verified like any other source.
    const cached = await this.cache.get(state.manifestHash);
    if (cached !== undefined) {
      try {
        return { ...verify(cached), state, source: 'cache', attempts };
      } catch (e) {
        attempts.push(attempt('cache', undefined, e));
      }
    }

    // 2. manifest_uri, then 3. mirrors.
    for (const candidate of this.networkCandidates(state, attempts)) {
      try {
        const bytes = await candidate.fetch(candidate.url, this.limits);
        const verified = verify(bytes);
        await this.cache.set(state.manifestHash, verified.bytes);
        return { ...verified, state, source: candidate.source, url: candidate.url, attempts };
      } catch (e) {
        attempts.push(attempt(candidate.source, candidate.url, e));
      }
    }

    throw new TrueOpenError(
      'DATA',
      'MANIFEST_UNAVAILABLE',
      `no source produced a manifest matching ${state.manifestHash}: ` +
        attempts.map((a) => `${a.source}${a.url !== undefined ? ` ${a.url}` : ''}: ${a.code}`).join('; '),
      { retriable: true, cause: attempts },
    );
  }

  private networkCandidates(
    state: ProfileManifestState,
    attempts: ManifestAttempt[],
  ): { source: ManifestSourceKind; url: string; fetch: ManifestFetcher }[] {
    const out: { source: ManifestSourceKind; url: string; fetch: ManifestFetcher }[] = [];
    if (state.manifestUri !== '') {
      try {
        const uri = parseManifestUri(state.manifestUri, this.opts.maxManifestUriBytes ?? DEFAULT_MAX_MANIFEST_URI_BYTES);
        if (uri.scheme === 'https') {
          if (this.opts.fetcher !== undefined) out.push({ source: 'manifest_uri', url: uri.uri, fetch: this.opts.fetcher });
          else attempts.push(skipped(uri.uri, 'no SSRF-safe fetcher configured for manifest_uri'));
        } else if (this.opts.ipfsGateway !== undefined) {
          const base = this.opts.ipfsGateway.replace(/\/+$/, '');
          out.push({ source: 'manifest_uri', url: `${base}/ipfs/${uri.cid}${uri.path}`, fetch: this.trustedFetcher });
        } else {
          attempts.push(skipped(uri.uri, 'ipfs:// manifest_uri needs a configured IPFS gateway'));
        }
      } catch (e) {
        attempts.push(attempt('manifest_uri', state.manifestUri, e));
      }
    }
    for (const m of this.opts.mirrors ?? []) {
      out.push({ source: 'mirror', url: m.split(HASH_PLACEHOLDER).join(state.manifestHash), fetch: this.trustedFetcher });
    }
    return out;
  }
}

function attempt(source: ManifestSourceKind, url: string | undefined, e: unknown): ManifestAttempt {
  const code = e instanceof TrueOpenError ? e.code : 'MANIFEST_FETCH_FAILED';
  const message = e instanceof Error ? e.message : String(e);
  return url !== undefined ? { source, url, code, message } : { source, code, message };
}

function skipped(url: string, message: string): ManifestAttempt {
  return { source: 'manifest_uri', url, code: 'MANIFEST_URI_SKIPPED', message };
}

function fetchError(code: string, message: string, retriable = true): TrueOpenError {
  return new TrueOpenError('DATA', code, `manifest fetch: ${message}`, { retriable });
}

/**
 * A ManifestFetcher over the platform fetch (browsers, Deno, Node 18+), for
 * operator-configured sources only: it cannot pin or vet the connected address.
 * Enforces the time budget, rejects a declared Content-Length above the cap before
 * reading, and aborts once the bytes read (already decompressed by the platform)
 * exceed it.
 */
export async function boundedWebFetch(url: string, limits: ManifestFetchLimits): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  try {
    const res = await globalThis.fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw fetchError('MANIFEST_FETCH_HTTP_STATUS', `HTTP ${res.status}`, res.status >= 500);
    const declared = res.headers.get('content-length');
    if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > limits.maxBytes) {
      throw fetchError('MANIFEST_TOO_LARGE', `Content-Length ${declared} exceeds ${limits.maxBytes}`, false);
    }
    if (res.body === null) return new Uint8Array(0);
    return await readBounded(res.body.getReader(), limits.maxBytes);
  } catch (e) {
    if (controller.signal.aborted) throw fetchError('MANIFEST_FETCH_TIMEOUT', `exceeded ${limits.timeoutMs} ms`);
    throw e;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function readBounded(reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw fetchError('MANIFEST_TOO_LARGE', `body exceeds ${maxBytes} bytes`, false);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
