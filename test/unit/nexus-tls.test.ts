import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { createServer, request as httpsRequest } from 'node:https';
import type { Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { PinnedHttpsAgent, nexusIngressTransport, nexusTransportOptions, tlsPubkeyHashOfCertificate, isTLSPubkeyMismatch } from '../../src/transport/nexus-tls';
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
// Plaintext http server: an endpoint whose descriptor says https but which answers in plaintext,
// which is also what an attacker on the path can make a TLS handshake look like.
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

function get(agent: PinnedHttpsAgent, targetPort = port): Promise<{ status: number; body: string }> {
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

  it('https endpoint with no on-chain hash: defaults to CA verification with no agent, never a plaintext fallback', () => {
    const options = nexusTransportOptions(`https://127.0.0.1:${plainPort}`, '');
    expect(options.baseUrl).toBe(`https://127.0.0.1:${plainPort}`);
    expect(options.nodeOptions?.agent).toBeUndefined();
  });

  it('https endpoint with no on-chain hash: a handshake failure against a plaintext peer is an error, not a downgrade', async () => {
    const before = plainHits;
    const client = new IngressClient(nexusIngressTransport(`https://127.0.0.1:${plainPort}`, ''));
    await expect(client.getTaskStatus('sess', 'task')).rejects.toBeTruthy();
    // A second attempt must not have learnt to go plaintext either.
    await expect(client.getTaskStatus('sess', 'task')).rejects.toBeTruthy();
    expect(plainHits).toBe(before);
  });

  it('https endpoint with no on-chain hash, peer uses self-signed TLS: rejected by CA verification, no fallback', async () => {
    const before = hits;
    const client = new IngressClient(nexusIngressTransport(`https://127.0.0.1:${port}`, ''));
    await expect(client.getTaskStatus('sess', 'task')).rejects.toBeTruthy();
    expect(hits).toBe(before);
  });

  it('rejects the removed plaintext-fallback policy instead of silently honouring it', () => {
    expect(() =>
      nexusTransportOptions(`https://127.0.0.1:${port}`, '', { unpinnedHttps: 'plaintext-fallback' as never }),
    ).toThrow(expect.objectContaining({ code: 'NEXUS_TLS_POLICY_INVALID' }));
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

  it('http:// and grpc:// plaintext endpoints are refused by default', () => {
    for (const uri of ['http://127.0.0.1:8080', 'grpc://127.0.0.1:8080']) {
      expect(() => nexusTransportOptions(uri, EXPECTED_HASH)).toThrow(
        expect.objectContaining({ code: 'NEXUS_INSECURE_HTTP_REFUSED' }),
      );
    }
  });

  it('allowInsecureHttp opts a plaintext endpoint in, with a warning', () => {
    const warnings: string[] = [];
    const options = nexusTransportOptions('grpc://127.0.0.1:8080', EXPECTED_HASH, {
      allowInsecureHttp: true,
      warn: (m) => warnings.push(m),
    });
    expect(options.baseUrl).toBe('http://127.0.0.1:8080');
    expect(options.nodeOptions?.agent).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/plaintext http/);
  });

  it('TRUEOPEN_ALLOW_INSECURE_HTTP=1 opts a plaintext endpoint in, with a warning', () => {
    process.env.TRUEOPEN_ALLOW_INSECURE_HTTP = '1';
    try {
      const warnings: string[] = [];
      const options = nexusTransportOptions('http://127.0.0.1:8080', '', { warn: (m) => warnings.push(m) });
      expect(options.baseUrl).toBe('http://127.0.0.1:8080');
      expect(warnings).toHaveLength(1);
    } finally {
      delete process.env.TRUEOPEN_ALLOW_INSECURE_HTTP;
    }
  });

  /**
   * A transport is built per endpoint per openTask, so an unconditional warning is one line per
   * request forever -- the shape of warning people learn to filter out. An injected sink is the
   * caller's own and still sees every occurrence.
   */
  it('an injected warn sink fires every time; the default console sink speaks once per endpoint', () => {
    const warnings: string[] = [];
    const opts = { allowInsecureHttp: true, warn: (m: string) => warnings.push(m) };
    nexusTransportOptions('http://127.0.0.1:9100', '', opts);
    nexusTransportOptions('http://127.0.0.1:9100', '', opts);
    expect(warnings).toHaveLength(2);

    const console_ = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      nexusTransportOptions('http://127.0.0.1:9101', '', { allowInsecureHttp: true });
      nexusTransportOptions('http://127.0.0.1:9101', '', { allowInsecureHttp: true });
      expect(console_).toHaveBeenCalledTimes(1);
      // A different endpoint is still worth saying out loud.
      nexusTransportOptions('http://127.0.0.1:9102', '', { allowInsecureHttp: true });
      expect(console_).toHaveBeenCalledTimes(2);
    } finally {
      console_.mockRestore();
    }
  });

  it('allowInsecureHttp does not relax https: an https endpoint still never falls back', () => {
    const options = nexusTransportOptions('https://builder.example:8443', '', { allowInsecureHttp: true });
    expect(options.baseUrl).toBe('https://builder.example:8443');
    expect(options.nodeOptions?.agent).toBeUndefined();
  });

  it('an unknown scheme is refused', () => {
    expect(() => nexusTransportOptions('ftp://builder.example:21')).toThrow(
      expect.objectContaining({ code: 'NEXUS_ENDPOINT_SCHEME_UNSUPPORTED' }),
    );
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
    // The classified wrapper is a transport error; the mismatch itself is only in its cause chain.
    expect(caught instanceof TrueOpenError && caught.category).toBe('transport');
    expect((caught as TrueOpenError).code).not.toBe('NEXUS_TLS_PUBKEY_MISMATCH');
  });
});
