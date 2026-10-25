/**
 * HTTPS connections to the nexus IngressAPI: verify the server certificate against
 * the tls_pubkey_hash recorded in the on-chain descriptor.
 *
 * The Builder's nexus terminates TLS itself with a self-signed certificate; the
 * on-chain ServiceEndpointV1.tls_pubkey_hash is the sha256 of the certificate
 * public key (SubjectPublicKeyInfo DER), registered by the Builder operator
 * alongside the descriptor.
 * The client trusts only this public key -- who issued the certificate doesn't
 * matter -- so instead of CA chain validation we compare the public key hash
 * right after the TLS handshake completes and before any request bytes go out,
 * disconnecting immediately on a mismatch.
 *
 * Only available under the Node runtime (depends on node:https / node:tls).
 */
import { Agent as HttpsAgent, globalAgent as httpsGlobalAgent, request as httpsRequest } from 'node:https';
import type { AgentOptions } from 'node:https';
import { globalAgent as httpGlobalAgent, request as httpRequest } from 'node:http';
import type { Agent as HttpAgent, IncomingMessage } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import type { ConnectionOptions, TLSSocket } from 'node:tls';
import { isIP } from 'node:net';
import { createHash, X509Certificate } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { createConnectTransport } from '@connectrpc/connect-node';
import type { Transport } from '@connectrpc/connect';
import { nexusHttpBaseUri } from '../types/hub';
import { TrueOpenError } from '../errors/errors';
import { isHash32Text } from '../codec/hash32';

/**
 * Certificate public key hash: sha256(SubjectPublicKeyInfo DER) as a Hash32 in its text
 * form (`0x` + 64 lowercase hex, the spelling the REST tls_pubkey_hash carries), matching
 * the algorithm used on the nexus side.
 *
 * The argument is a tls.PeerCertificate-like object; we take its `raw` (the
 * whole certificate DER), re-parse it, and export the SPKI. We don't use the
 * `pubkey` field -- for EC certificates it gives the raw public key point, not
 * the SPKI.
 */
export function tlsPubkeyHashOfCertificate(cert: { readonly raw?: Buffer | Uint8Array }): string {
  if (!cert.raw || cert.raw.length === 0) {
    throw new TrueOpenError('NEXUS_INGRESS', 'NEXUS_TLS_NO_CERTIFICATE', 'nexus TLS peer presented no certificate');
  }
  const spki = new X509Certificate(Buffer.from(cert.raw)).publicKey.export({ type: 'spki', format: 'der' });
  return `0x${createHash('sha256').update(spki).digest('hex')}`;
}

function requireHash(hash: string): string {
  if (!isHash32Text(hash)) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'NEXUS_TLS_PUBKEY_HASH_MALFORMED',
      `tls_pubkey_hash must be 0x followed by 64 lowercase hex characters, got ${JSON.stringify(hash)}`,
    );
  }
  return hash;
}

type CreateConnectionCallback = (err: Error | null, stream: Duplex) => void;

/**
 * An https Agent that trusts only the on-chain public key hash.
 *
 * CA chain validation is disabled during the handshake (a self-signed
 * certificate wouldn't pass it anyway); the public key hash is compared after
 * secureConnect and before the socket is handed to the http layer. On a
 * mismatch the connection is destroyed and NEXUS_TLS_PUBKEY_MISMATCH is
 * thrown -- not a single byte of the request is sent. Reused keep-alive
 * connections have already been checked.
 */
export class PinnedHttpsAgent extends HttpsAgent {
  readonly expectedHash: string;

  constructor(expectedHash: string, options?: AgentOptions) {
    super({ keepAlive: true, ...options });
    this.expectedHash = requireHash(expectedHash);
  }

  createConnection(options: ConnectionOptions & { readonly host?: string }, callback?: CreateConnectionCallback): Duplex | null | undefined {
    if (!callback) {
      // Node's Agent always passes a callback; without one we can't verify after the handshake and before handing off the socket.
      throw new TrueOpenError('SDK_LOCAL', 'NEXUS_TLS_AGENT_MISUSE', 'PinnedHttpsAgent.createConnection requires a callback');
    }
    const host = options.host ?? '';
    const socket: TLSSocket = tlsConnect({
      ...options,
      rejectUnauthorized: false,
      // SNI only accepts a hostname; leave it unset for a direct IP connection, or Node will reject it.
      ...(options.servername === undefined && host !== '' && isIP(host) === 0 ? { servername: host } : {}),
    });
    const fail = (err: Error): void => {
      socket.destroy();
      callback(err, socket);
    };
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      socket.removeListener('error', fail);
      let got: string;
      try {
        got = tlsPubkeyHashOfCertificate(socket.getPeerCertificate());
      } catch (err) {
        fail(err as Error);
        return;
      }
      if (got !== this.expectedHash) {
        fail(
          new TrueOpenError(
            'NEXUS_INGRESS',
            NEXUS_TLS_PUBKEY_MISMATCH,
            `${NEXUS_TLS_PUBKEY_MISMATCH}: nexus ${host} presented certificate pubkey sha256 ${got}, chain descriptor commits ${this.expectedHash}`,
          ),
        );
        return;
      }
      callback(null, socket);
    });
    return undefined;
  }
}

export interface NexusTransportOptions {
  readonly baseUrl: string;
  readonly httpVersion: '1.1';
  readonly nodeOptions?: { readonly agent: PinnedHttpsAgent };
}

export interface NexusTransportPolicy {
  /**
   * What to do when an https endpoint has no tls_pubkey_hash on chain:
   * - `certificate-authority` (default): verify the certificate through the standard CA chain.
   *   A handshake failure is an error; the SDK never falls back to plaintext.
   * - `reject`: the nexus endpoint must register a fingerprint; a missing one is treated as an
   *   incomplete descriptor and the connection is refused. The env var
   *   `NEXUS_TLS_PUBKEY_HASH_REQUIRED=1` changes the default to this mode.
   */
  readonly unpinnedHttps?: 'reject' | 'certificate-authority';
  /**
   * Allow plaintext `http://` (and `grpc://`) endpoints. Off by default: plaintext gives no
   * confidentiality or integrity, so anyone on the network path can read or rewrite requests
   * and responses. Meant for a localnet only. The env var `TRUEOPEN_ALLOW_INSECURE_HTTP=1` turns
   * it on too. Every endpoint allowed this way logs a warning.
   */
  readonly allowInsecureHttp?: boolean;
  /** Where the insecure-http warning goes; defaults to console.warn. */
  readonly warn?: (message: string) => void;
  /**
   * Share keep-alive connections with every other transport for the same pinned certificate
   * key (default true). A transport is typically built per Builder per call (openTask's
   * ingressTransportFactory, an output source, a prewarm), and without sharing each one opens
   * its own TCP + TLS connection. With sharing, an idle connection that OpenTask, a prewarm
   * or an earlier stream left in the pool is reused. Requests on a shared connection are
   * still signed one by one; a connection only carries one request at a time (HTTP/1.1), and
   * aborting a stream closes only the connection that stream was on. Pass false for a
   * private agent per transport (the old behaviour).
   */
  readonly shareConnections?: boolean;
}

/**
 * Upper bound on the shared pinned agents kept. Past it the oldest is evicted and destroyed,
 * closing its connections; a transport still holding it fails over like on any dropped
 * connection. 64 distinct Builder certificates in one process is far beyond normal use.
 */
const SHARED_AGENT_LIMIT = 64;
const sharedPinnedAgents = new Map<string, PinnedHttpsAgent>();

/**
 * The process-wide keep-alive agent for one pinned certificate key. Every transport built for
 * that key (with shareConnections, the default) uses it, so connections are pooled per
 * Builder rather than per transport.
 */
export function sharedPinnedHttpsAgent(tlsPubkeyHash: string): PinnedHttpsAgent {
  const hash = requireHash(tlsPubkeyHash);
  let agent = sharedPinnedAgents.get(hash);
  if (agent === undefined) {
    agent = new PinnedHttpsAgent(hash);
    sharedPinnedAgents.set(hash, agent);
    while (sharedPinnedAgents.size > SHARED_AGENT_LIMIT) {
      const oldest = sharedPinnedAgents.keys().next().value as string;
      sharedPinnedAgents.get(oldest)?.destroy();
      sharedPinnedAgents.delete(oldest);
    }
  }
  return agent;
}

/** When the NEXUS_TLS_PUBKEY_HASH_REQUIRED env var is 1/true/yes, any https endpoint without a registered fingerprint is rejected. */
export function tlsPubkeyHashRequiredByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env.NEXUS_TLS_PUBKEY_HASH_REQUIRED);
}

/** When the TRUEOPEN_ALLOW_INSECURE_HTTP env var is 1/true/yes, plaintext http:// nexus endpoints are allowed (localnet only). */
export function insecureHttpAllowedByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env.TRUEOPEN_ALLOW_INSECURE_HTTP);
}

function envFlag(value: string | undefined): boolean {
  const raw = (value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** Endpoints already warned about through the default sink, so the console is told once each. */
const warnedInsecureHttp = new Set<string>();

/**
 * Warns that an endpoint is plaintext.
 *
 * A transport is constructed per endpoint per openTask, so warning unconditionally means one
 * message per endpoint per request -- which is how a warning becomes noise people filter out.
 * The default console sink therefore speaks once per endpoint per process. An injected `warn` is
 * the caller's own sink and always fires, so tests and structured loggers see every occurrence.
 */
function warnInsecureHttp(baseUrl: string, warn: ((message: string) => void) | undefined): void {
  const message =
    `WARNING: nexus endpoint ${baseUrl} uses plaintext http (insecure http explicitly allowed); ` +
    'requests and responses can be read and modified on the network path. Use this on a localnet only.';
  if (warn !== undefined) {
    warn(message);
    return;
  }
  if (warnedInsecureHttp.has(baseUrl)) return;
  warnedInsecureHttp.add(baseUrl);
  console.warn(message);
}

/** Error code for a handshake verification failure; callers use it to decide whether to re-read the descriptor and retry once. */
export const NEXUS_TLS_PUBKEY_MISMATCH = 'NEXUS_TLS_PUBKEY_MISMATCH';

/**
 * Whether `err` means "the certificate public key doesn't match the on-chain
 * fingerprint". The verification failure happens at the socket connection
 * stage, and gets wrapped layer by layer by Connect / IngressClient
 * (ConnectError.cause, TrueOpenError.cause), so we only walk the cause chain
 * looking for a structured TrueOpenError. We don't inspect the message text:
 * the reason string returned by the server is attacker-controlled and can't
 * be used to drive a "re-read the descriptor and resend" decision.
 */
export function isTLSPubkeyMismatch(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof TrueOpenError && current.code === NEXUS_TLS_PUBKEY_MISMATCH) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Derive Connect transport options from the on-chain endpoint uri and
 * tls_pubkey_hash.
 *
 * - `grpc://` / `grpcs://` are normalized to http(s).
 * - https with an on-chain hash: use PinnedHttpsAgent to verify the
 *   certificate public key during the handshake.
 * - https without an on-chain hash: standard CA verification by default, or
 *   refused under `unpinnedHttps: 'reject'` / `NEXUS_TLS_PUBKEY_HASH_REQUIRED=1`.
 * - http: refused unless `allowInsecureHttp` or `TRUEOPEN_ALLOW_INSECURE_HTTP=1`
 *   opts in, and then logged as a warning.
 *
 * https is never downgraded to http, whatever the handshake does.
 */
export function nexusTransportOptions(uri: string, tlsPubkeyHash = '', policy: NexusTransportPolicy = {}): NexusTransportOptions {
  const baseUrl = nexusHttpBaseUri(uri);
  const hash = tlsPubkeyHash.trim() === '' ? '' : requireHash(tlsPubkeyHash);
  if (baseUrl.startsWith('https://')) {
    if (hash !== '') {
      const agent = policy.shareConnections === false ? new PinnedHttpsAgent(hash) : sharedPinnedHttpsAgent(hash);
      return { baseUrl, httpVersion: '1.1', nodeOptions: { agent } };
    }
    const unpinned = policy.unpinnedHttps ?? (tlsPubkeyHashRequiredByEnv() ? 'reject' : 'certificate-authority');
    switch (unpinned) {
      case 'certificate-authority':
        return { baseUrl, httpVersion: '1.1' };
      case 'reject':
        throw new TrueOpenError(
          'CHAIN_REJECT',
          'NEXUS_TLS_PUBKEY_HASH_REQUIRED',
          `nexus endpoint ${baseUrl} is https but its descriptor carries no tls_pubkey_hash; the Builder must register its certificate fingerprint`,
        );
      default:
        throw new TrueOpenError('SDK_LOCAL', 'NEXUS_TLS_POLICY_INVALID', `unknown unpinnedHttps policy ${JSON.stringify(unpinned)}`);
    }
  }
  if (baseUrl.startsWith('http://')) {
    if (policy.allowInsecureHttp !== true && !insecureHttpAllowedByEnv()) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'NEXUS_INSECURE_HTTP_REFUSED',
        `nexus endpoint ${baseUrl} is plaintext http; refusing to connect. ` +
          'For a localnet only, opt in with allowInsecureHttp: true or TRUEOPEN_ALLOW_INSECURE_HTTP=1',
      );
    }
    warnInsecureHttp(baseUrl, policy.warn);
    return { baseUrl, httpVersion: '1.1' };
  }
  throw new TrueOpenError('SDK_LOCAL', 'NEXUS_ENDPOINT_SCHEME_UNSUPPORTED', `nexus endpoint ${JSON.stringify(uri)} is not an http(s) or grpc(s) uri`);
}

/** Connect transport for the nexus IngressAPI; usable directly as TrueOpenClient.ingressTransportFactory. */
export function nexusIngressTransport(uri: string, tlsPubkeyHash = '', policy: NexusTransportPolicy = {}): Transport {
  return createConnectTransport(nexusTransportOptions(uri, tlsPubkeyHash, policy));
}

/** Options for prewarmNexusConnections. */
export interface PrewarmNexusOptions extends NexusTransportPolicy {
  /**
   * How many idle connections to leave in the pool (default DEFAULT_PREWARM_CONNECTIONS, at
   * most MAX_PREWARM_CONNECTIONS). An order uses up to three at once on one Builder: OpenTask,
   * then the task event stream and SubscribeOutput side by side (HTTP/1.1 runs one request
   * per connection), so two leaves one spare after OpenTask returns its own.
   */
  readonly connections?: number;
  /** Per-connection time limit in milliseconds (default 5000). */
  readonly timeoutMs?: number;
}

/** Default idle connections a prewarm leaves per Builder. */
export const DEFAULT_PREWARM_CONNECTIONS = 2;
/** Upper bound on prewarmed connections per call. */
export const MAX_PREWARM_CONNECTIONS = 8;

/**
 * Opens connections to a nexus ahead of use, so that a later OpenTask or stream on the same
 * endpoint skips the TCP + TLS handshake.
 *
 * Sends `connections` concurrent `GET /healthz` requests through the agent that
 * nexusIngressTransport uses for this endpoint (the shared pinned agent, or Node's global agent
 * for an unpinned endpoint), reads each answer to the end, and leaves the keep-alive
 * connections in that agent's idle pool. The same TLS rules apply as for the transport: a
 * pinned certificate is checked before any byte is sent, and https is never downgraded.
 * Node's global agent keeps connections alive only on Node 19 and later, so an unpinned
 * endpoint gains nothing on Node 18. Idle pooled connections do not keep the process alive.
 *
 * Best effort: resolves with how many connections completed and never rejects for a network
 * failure (the real request will fail and report it). It does reject when the endpoint itself
 * is refused by policy (plaintext http without opt-in, a malformed fingerprint).
 */
export async function prewarmNexusConnections(uri: string, tlsPubkeyHash = '', opts: PrewarmNexusOptions = {}): Promise<number> {
  const options = nexusTransportOptions(uri, tlsPubkeyHash, opts);
  const n = Math.min(MAX_PREWARM_CONNECTIONS, Math.max(1, Math.floor(opts.connections ?? DEFAULT_PREWARM_CONNECTIONS)));
  const timeoutMs = opts.timeoutMs ?? 5000;
  const url = new URL('/healthz', options.baseUrl);
  const https = url.protocol === 'https:';
  const agent: HttpAgent = options.nodeOptions?.agent ?? (https ? httpsGlobalAgent : httpGlobalAgent);
  const once = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      // The promise settles once: whichever of these comes first decides.
      let ended = false;
      const onResponse = (res: IncomingMessage): void => {
        // Reading the body to the end is what returns the connection to the idle pool.
        res.on('end', () => {
          ended = true;
          resolve(true);
        });
        res.on('error', () => resolve(false));
        res.on('close', () => resolve(ended));
        res.resume();
      };
      const req = (https ? httpsRequest : httpRequest)(url, { method: 'GET', agent }, onResponse);
      req.setTimeout(timeoutMs, () => req.destroy());
      req.on('error', () => resolve(false));
      // A destroyed request does not always emit 'error' (older Node, headers already in), but
      // it always closes: without this a timed-out prewarm could hang.
      req.on('close', () => resolve(ended));
      req.end();
    });
  const done = await Promise.all(Array.from({ length: n }, once));
  return done.filter(Boolean).length;
}
