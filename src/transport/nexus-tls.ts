/**
 * HTTPS connections to the nexus IngressAPI: verify the server certificate against
 * the tls_pubkey_hash recorded in the on-chain descriptor.
 *
 * The Builder's nexus terminates TLS itself with a self-signed certificate; the
 * on-chain ServiceEndpointV1.tls_pubkey_hash is the sha256 of the certificate
 * public key (SubjectPublicKeyInfo DER), registered by the Builder operator
 * alongside the descriptor (monorepo ADR-0015).
 * The client trusts only this public key -- who issued the certificate doesn't
 * matter -- so instead of CA chain validation we compare the public key hash
 * right after the TLS handshake completes and before any request bytes go out,
 * disconnecting immediately on a mismatch.
 *
 * Only available under the Node runtime (depends on node:https / node:tls).
 */
import { Agent as HttpsAgent } from 'node:https';
import type { AgentOptions } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import type { ConnectionOptions, TLSSocket } from 'node:tls';
import { connect as netConnect, isIP } from 'node:net';
import { createHash, X509Certificate } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { createConnectTransport } from '@connectrpc/connect-node';
import type { Transport } from '@connectrpc/connect';
import { nexusHttpBaseUri } from '../types/hub';
import { TrueOpenError } from '../errors/errors';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Certificate public key hash: sha256(SubjectPublicKeyInfo DER), lowercase hex,
 * matching the algorithm used on the nexus side.
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
  return createHash('sha256').update(spki).digest('hex');
}

function requireHash(hash: string): string {
  const trimmed = hash.trim().toLowerCase();
  if (!HEX64.test(trimmed)) {
    throw new TrueOpenError('SDK_LOCAL', 'NEXUS_TLS_PUBKEY_HASH_MALFORMED', `tls_pubkey_hash must be 64 lowercase hex, got ${JSON.stringify(hash)}`);
  }
  return trimmed;
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
  readonly nodeOptions?: { readonly agent: PinnedHttpsAgent | PlaintextFallbackAgent };
}

export interface NexusTransportPolicy {
  /**
   * What to do when an https endpoint has no tls_pubkey_hash on chain
   * (ADR-0015 decision 6):
   * - `plaintext-fallback` (default): transitional behavior. First attempt
   *   https via the standard CA chain; if the peer doesn't speak TLS at all
   *   (nexus hasn't enabled TLS yet, but the descriptor says https), fall back
   *   to http and log a WARN. Once a fingerprint is registered on chain, this
   *   path is never taken and the check automatically becomes strict.
   * - `reject`: the nexus endpoint must register a fingerprint; a missing one
   *   is treated as an incomplete descriptor and the connection is refused.
   *   The env var `NEXUS_TLS_PUBKEY_HASH_REQUIRED=1` changes the default to
   *   this mode.
   * - `certificate-authority`: verify via the standard CA chain, no fallback.
   *   Used for an operator-supplied `--nexus-url` (where there's no on-chain
   *   descriptor to look up).
   */
  readonly unpinnedHttps?: 'reject' | 'certificate-authority' | 'plaintext-fallback';
}

/** When the NEXUS_TLS_PUBKEY_HASH_REQUIRED env var is 1/true/yes, any https endpoint without a registered fingerprint is rejected. */
export function tlsPubkeyHashRequiredByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.NEXUS_TLS_PUBKEY_HASH_REQUIRED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * Whether `err` indicates the peer is a plaintext server: it replied to the TLS
 * ClientHello with non-TLS bytes, which OpenSSL reports as EPROTO or a "wrong
 * version number" style error.
 *
 * ECONNRESET is deliberately excluded: anything on the network path that can
 * send an RST can produce it, and so can an overloaded TLS server; treating it
 * as proof would let a single RST permanently pin this host:port to plaintext.
 * A genuine plaintext server responds to a ClientHello with EPROTO, not a
 * clean RST.
 */
export function isPlaintextServerError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code ?? '';
  if (code === 'EPROTO') return true;
  return /wrong version number|packet length too long|unknown protocol|unexpected message/i.test(err.message);
}

/**
 * How long (ms) the "this host:port is a plaintext server" determination is
 * cached for.
 *
 * The determination has to be cached: otherwise every connection pays for a
 * failed TLS handshake first. But it can't be cached forever either -- if the
 * Builder enables TLS while the client process is running, a long-lived
 * process would keep using plaintext until restarted. After the TTL expires
 * we retry TLS once, at the cost of one failed handshake every 5 minutes.
 */
const PLAINTEXT_MEMO_TTL_MS = 5 * 60 * 1000;

/**
 * A transitional https Agent: attempt the handshake via the standard CA chain
 * first, then fall back to a plaintext connection with a WARN log if the peer
 * doesn't speak TLS.
 *
 * Only the "peer is a plaintext server" failure is handled this way; other
 * TLS-layer errors, such as an untrusted certificate, are returned as-is with
 * no fallback. Once a host:port is determined to be plaintext, it goes
 * straight to plaintext within the TTL instead of trying TLS first every
 * time; after the TTL expires, TLS is retried once, so a Builder that enables
 * TLS mid-flight doesn't require the client process to be restarted.
 */
export class PlaintextFallbackAgent extends HttpsAgent {
  /** host:port -> the time it was determined to be plaintext (Date.now()); expired after PLAINTEXT_MEMO_TTL_MS. */
  private readonly plaintextHosts = new Map<string, number>();
  private readonly warn: (message: string) => void;
  private readonly memoTtlMs: number;

  constructor(options?: AgentOptions & { readonly warn?: (message: string) => void; readonly memoTtlMs?: number }) {
    const { warn, memoTtlMs, ...agentOptions } = options ?? {};
    super({ keepAlive: true, ...agentOptions });
    this.warn = warn ?? ((message) => console.warn(message));
    this.memoTtlMs = memoTtlMs ?? PLAINTEXT_MEMO_TTL_MS;
  }

  /** Whether this host:port was determined to be plaintext within the TTL; expired entries are removed along the way. */
  private memoizedPlaintext(key: string): boolean {
    const at = this.plaintextHosts.get(key);
    if (at === undefined) return false;
    if (Date.now() - at < this.memoTtlMs) return true;
    this.plaintextHosts.delete(key);
    return false;
  }

  createConnection(options: ConnectionOptions & { readonly host?: string; readonly port?: number | string }, callback?: CreateConnectionCallback): Duplex | null | undefined {
    if (!callback) {
      throw new TrueOpenError('SDK_LOCAL', 'NEXUS_TLS_AGENT_MISUSE', 'PlaintextFallbackAgent.createConnection requires a callback');
    }
    const host = options.host ?? '';
    const port = Number(options.port ?? 443);
    const key = `${host}:${port}`;
    const plain = (): void => {
      const socket = netConnect({ host, port });
      socket.once('error', (err) => callback(err, socket));
      socket.once('connect', () => callback(null, socket));
    };
    if (this.memoizedPlaintext(key)) {
      plain();
      return undefined;
    }
    const socket: TLSSocket = tlsConnect({
      ...options,
      ...(options.servername === undefined && host !== '' && isIP(host) === 0 ? { servername: host } : {}),
    });
    const onError = (err: Error): void => {
      socket.destroy();
      if (!isPlaintextServerError(err)) {
        callback(err, socket);
        return;
      }
      this.plaintextHosts.set(key, Date.now());
      this.warn(
        `nexus ${key} does not speak TLS although its descriptor says https; falling back to plaintext http. ` +
          'The Builder should enable ingress TLS and register its certificate fingerprint (ADR-0015). ' +
          'Set NEXUS_TLS_PUBKEY_HASH_REQUIRED=1 to refuse instead.',
      );
      plain();
    };
    socket.once('error', onError);
    socket.once('secureConnect', () => {
      socket.removeListener('error', onError);
      callback(null, socket);
    });
    return undefined;
  }
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
 *   certificate public key during the handshake, with no fallback.
 * - https without an on-chain hash: follow NexusTransportPolicy; the default
 *   transitional behavior falls back to http only if the peer doesn't speak
 *   TLS, and rejects when `NEXUS_TLS_PUBKEY_HASH_REQUIRED=1`.
 * - http: plaintext, for local integration testing only.
 */
export function nexusTransportOptions(uri: string, tlsPubkeyHash = '', policy: NexusTransportPolicy = {}): NexusTransportOptions {
  const baseUrl = nexusHttpBaseUri(uri);
  const hash = tlsPubkeyHash.trim() === '' ? '' : requireHash(tlsPubkeyHash);
  if (baseUrl.startsWith('https://')) {
    if (hash !== '') {
      return { baseUrl, httpVersion: '1.1', nodeOptions: { agent: new PinnedHttpsAgent(hash) } };
    }
    const unpinned = policy.unpinnedHttps ?? (tlsPubkeyHashRequiredByEnv() ? 'reject' : 'plaintext-fallback');
    switch (unpinned) {
      case 'certificate-authority':
        return { baseUrl, httpVersion: '1.1' };
      case 'plaintext-fallback':
        return { baseUrl, httpVersion: '1.1', nodeOptions: { agent: new PlaintextFallbackAgent() } };
      default:
        throw new TrueOpenError(
          'CHAIN_REJECT',
          'NEXUS_TLS_PUBKEY_HASH_REQUIRED',
          `nexus endpoint ${baseUrl} is https but its descriptor carries no tls_pubkey_hash; the Builder must register its certificate fingerprint`,
        );
    }
  }
  return { baseUrl, httpVersion: '1.1' };
}

/** Connect transport for the nexus IngressAPI; usable directly as TrueOpenClient.ingressTransportFactory. */
export function nexusIngressTransport(uri: string, tlsPubkeyHash = '', policy: NexusTransportPolicy = {}): Transport {
  return createConnectTransport(nexusTransportOptions(uri, tlsPubkeyHash, policy));
}
