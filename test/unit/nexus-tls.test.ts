import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { createServer, request as httpsRequest } from 'node:https';
import type { Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { PinnedHttpsAgent, PlaintextFallbackAgent, nexusIngressTransport, nexusTransportOptions, tlsPubkeyHashOfCertificate, isPlaintextServerError, isTLSPubkeyMismatch } from '../../src/transport/nexus-tls';
import { IngressClient } from '../../src/transport/ingress-client';
import { explicitNexusTransport } from '../../src/cli/context';
import { TrueOpenError } from '../../src/errors/errors';
import { createServer as createHttpServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';

// The files under test/helpers/tls are disposable self-signed certs for testing only
// (not real keys from any environment); pubkey_sha256.txt is the certificate's public
// key sha256 computed independently with openssl, used to verify the SDK's algorithm.
const CERT = readFileSync(new URL('../helpers/tls/cert.pem', import.meta.url));
const KEY = readFileSync(new URL('../helpers/tls/key.pem', import.meta.url));
const EXPECTED_HASH = readFileSync(new URL('../helpers/tls/pubkey_sha256.txt', import.meta.url), 'utf8').trim();

let server: Server;
let port: number;
let hits = 0;
// Plaintext http server: simulates the transition period where "the descriptor says https but nexus hasn't enabled TLS yet".
let plainServer: HttpServer;
let plainPort: number;
let plainHits = 0;

beforeAll(async () => {
  server = createServer({ cert: CERT, key: KEY }, (_req, res) => {
    hits += 1;
    res.setHeader('content-type', 'application/json');
    res.end('{"status":"ok"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  plainServer = createHttpServer((_req, res) => {
    plainHits += 1;
    res.setHeader('content-type', 'application/json');
    res.end('{"status":"plain"}');
  });
  await new Promise<void>((resolve) => plainServer.listen(0, '127.0.0.1', resolve));
  plainPort = (plainServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => plainServer.close(() => resolve()));
});

function get(agent: PinnedHttpsAgent | PlaintextFallbackAgent, targetPort = port): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port: targetPort, path: '/healthz', method: 'GET', agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('verify the nexus certificate against the on-chain tls_pubkey_hash', () => {
  it('public key hash algorithm matches openssl: sha256(SubjectPublicKeyInfo DER)', () => {
    const x509 = new X509Certificate(CERT);
    expect(tlsPubkeyHashOfCertificate({ raw: x509.raw })).toBe(EXPECTED_HASH);
  });

  it('hash matches: connects successfully even with a self-signed cert, over HTTPS', async () => {
    const before = hits;
    const res = await get(new PinnedHttpsAgent(EXPECTED_HASH));
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"status":"ok"}');
    expect(hits).toBe(before + 1);
  });

  it('hash mismatch: disconnects immediately after the handshake, not sending a single byte of the request', async () => {
    const before = hits;
    const wrong = 'ab'.repeat(32);
    await expect(get(new PinnedHttpsAgent(wrong))).rejects.toMatchObject({ code: 'NEXUS_TLS_PUBKEY_MISMATCH' });
    expect(hits).toBe(before);
  });

  it('https endpoint with no on-chain hash: refuses to connect when NEXUS_TLS_PUBKEY_HASH_REQUIRED=1', () => {
    process.env.NEXUS_TLS_PUBKEY_HASH_REQUIRED = '1';
    try {
      expect(() => nexusTransportOptions(`https://127.0.0.1:${port}`, '')).toThrow(
        expect.objectContaining({ code: 'NEXUS_TLS_PUBKEY_HASH_REQUIRED' }),
      );
    } finally {
      delete process.env.NEXUS_TLS_PUBKEY_HASH_REQUIRED;
    }
  });

  it('https endpoint with no on-chain hash: default transition-period behavior, falls back to http and logs a WARN when the peer does not speak TLS', async () => {
    const options = nexusTransportOptions(`https://127.0.0.1:${plainPort}`, '');
    expect(options.nodeOptions?.agent).toBeInstanceOf(PlaintextFallbackAgent);
    const warnings: string[] = [];
    const agent = new PlaintextFallbackAgent({ warn: (m) => warnings.push(m) });
    const before = plainHits;
    const res = await get(agent, plainPort);
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"status":"plain"}');
    expect(plainHits).toBe(before + 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/does not speak TLS/);
    // Once a host:port is determined to be plaintext, it goes straight to plaintext without repeating the warning.
    await get(agent, plainPort);
    expect(warnings).toHaveLength(1);
    agent.destroy();
  });

  it('https endpoint with no on-chain hash, peer uses self-signed TLS: rejected per CA chain validation, no fallback', async () => {
    const agent = new PlaintextFallbackAgent({ warn: () => undefined });
    const before = hits;
    await expect(get(agent, port)).rejects.toBeTruthy();
    expect(hits).toBe(before);
    agent.destroy();
  });

  it('explicitly specified https endpoint can opt into CA chain validation; a self-signed cert is still rejected, no fallback', async () => {
    const options = nexusTransportOptions(`https://127.0.0.1:${port}`, '', { unpinnedHttps: 'certificate-authority' });
    expect(options.baseUrl).toBe(`https://127.0.0.1:${port}`);
    expect(options.nodeOptions?.agent).toBeUndefined();
    await expect(
      new Promise<void>((resolve, reject) => {
        const req = httpsRequest({ host: '127.0.0.1', port, path: '/healthz' }, () => resolve());
        req.on('error', reject);
        req.end();
      }),
    ).rejects.toBeTruthy();
  });
});

describe('nexusTransportOptions', () => {
  it('https + hash -> uses the verifying agent, no longer downgrades https to http', () => {
    const options = nexusTransportOptions('https://builder.example:8443', EXPECTED_HASH);
    expect(options.baseUrl).toBe('https://builder.example:8443');
    expect(options.httpVersion).toBe('1.1');
    expect(options.nodeOptions?.agent).toBeInstanceOf(PinnedHttpsAgent);
  });

  it('grpcs:// is normalized to https:// while keeping hash verification', () => {
    const options = nexusTransportOptions('grpcs://builder.example:8443', EXPECTED_HASH);
    expect(options.baseUrl).toBe('https://builder.example:8443');
    expect(options.nodeOptions?.agent).toBeInstanceOf(PinnedHttpsAgent);
  });

  it('http:// plaintext endpoint is used as-is, without an agent (for integration testing)', () => {
    const options = nexusTransportOptions('grpc://127.0.0.1:8080', EXPECTED_HASH);
    expect(options.baseUrl).toBe('http://127.0.0.1:8080');
    expect(options.nodeOptions?.agent).toBeUndefined();
  });

  it('hash must be 64-character lowercase hex', () => {
    expect(() => nexusTransportOptions('https://b:1', 'not-hex')).toThrow(/tls_pubkey_hash/);
  });
});

describe('manually specified --nexus-url', () => {
  it('when a fingerprint is given, verification uses it, same as the on-chain discovery path (the nexus cert is self-signed, so CA chain validation cannot work)', async () => {
    const wrong = new IngressClient(explicitNexusTransport(`https://127.0.0.1:${port}`, 'ab'.repeat(32)));
    let caught: unknown;
    try {
      await wrong.getTaskStatus('sess', 'task');
    } catch (err) {
      caught = err;
    }
    expect(isTLSPubkeyMismatch(caught)).toBe(true);

    // A correct fingerprint connects fine: the cert is self-signed so CA chain validation would necessarily fail, so success here means it went through PinnedHttpsAgent.
    const before = hits;
    const ok = new IngressClient(explicitNexusTransport(`https://127.0.0.1:${port}`, EXPECTED_HASH));
    await ok.getTaskStatus('sess', 'task').catch(() => undefined); // The response body is not a valid Connect frame; we only care whether the handshake goes through.
    expect(hits).toBe(before + 1);
  });
});

describe('error classification', () => {
  it('ECONNRESET does not count as a plaintext server: anyone can trigger an RST, including an overloaded TLS server', () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(isPlaintextServerError(reset)).toBe(false);
    const eproto = Object.assign(new Error('write EPROTO'), { code: 'EPROTO' });
    expect(isPlaintextServerError(eproto)).toBe(true);
    expect(isPlaintextServerError(new Error('ssl3_get_record:wrong version number'))).toBe(true);
  });

  it('plaintext detection has a TTL: after it expires, TLS is retried, so a Builder that enables TLS mid-flight does not need a process restart', async () => {
    // keepAlive: false -- otherwise the second request reuses the socket from the
    // connection pool, createConnection is never called again, and the detection-cache
    // path is never exercised. In real scenarios the pooled socket eventually closes,
    // at which point the TTL kicks in.
    const warnings: string[] = [];
    // memoTtlMs=0: the detection expires immediately, so every new connection retries TLS and re-detects.
    const agent = new PlaintextFallbackAgent({ warn: (m) => warnings.push(m), memoTtlMs: 0, keepAlive: false });
    await get(agent, plainPort);
    await get(agent, plainPort);
    expect(warnings).toHaveLength(2);

    // Control: within the default TTL, TLS is not retried and the warning is not repeated.
    const memo: string[] = [];
    const cached = new PlaintextFallbackAgent({ warn: (m) => memo.push(m), keepAlive: false });
    await get(cached, plainPort);
    await get(cached, plainPort);
    expect(memo).toHaveLength(1);
  });

  it('a fingerprint mismatch is identified only by the structured error in the cause chain, never by the server-controlled message text', async () => {
    const fake = new Error(`server said ${'NEXUS_TLS_PUBKEY_MISMATCH'} in its reason`);
    expect(isTLSPubkeyMismatch(fake)).toBe(false);
    // Real path: wrong fingerprint -> PinnedHttpsAgent disconnects after the handshake -> Connect wraps it as ConnectError.cause.
    const client = new IngressClient(nexusIngressTransport(`https://127.0.0.1:${port}`, 'ab'.repeat(32)));
    let caught: unknown;
    try {
      await client.getTaskStatus('sess', 'task');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(isTLSPubkeyMismatch(caught)).toBe(true);
    expect(caught instanceof TrueOpenError).toBe(false); // It's a Connect wrapper; identified via the cause chain.
  });
});
