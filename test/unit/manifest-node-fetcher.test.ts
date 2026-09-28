import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import type { Server as TcpServer, AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { createNodeManifestFetcher } from '../../src/manifest/node-fetcher';
import type { NodeManifestFetcherOptions } from '../../src/manifest/node-fetcher';
import { MAX_MANIFEST_BYTES } from '../../src/manifest/model-manifest';

/**
 * Downloader obligations, exercised against a local HTTPS server whose certificate
 * names manifest.test, private.test and rebind.test (test/fixtures/tls, test-only).
 * Host names are resolved by an injected resolver; unless a test checks the default
 * policy, 127.0.0.1 stands in for a "public" address and 10.0.0.1 for a private one.
 */
const CA = readFileSync('test/fixtures/tls/manifest-test.cert.pem', 'utf8');
const KEY = readFileSync('test/fixtures/tls/manifest-test.key.pem', 'utf8');
const LIMITS = { maxBytes: MAX_MANIFEST_BYTES, timeoutMs: 5_000 };
const OVER = MAX_MANIFEST_BYTES + 1024;

/**
 * A smaller cap for the compressed-side bound, so the test trips it on a few hundred KiB
 * instead of pushing tens of MiB through a local TLS socket.
 */
const SMALL_LIMITS = { maxBytes: 64 * 1024, timeoutMs: 10_000 };
/** 64 KiB of concatenated empty gzip members: many members, almost no output. */
const NULL_GZIP_BLOCK = ((): Buffer => {
  const empty = gzipSync(Buffer.alloc(0));
  return Buffer.concat(new Array<Buffer>(Math.ceil((64 * 1024) / empty.length)).fill(empty));
})();

let server: Server;
let port = 0;
let connections = 0;
let flakyHits = 0;
const open: { destroy(): void }[] = [];

beforeAll(async () => {
  server = createServer({ key: KEY, cert: CA }, (req, res) => {
    open.push(res.socket!);
    const path = req.url ?? '/';
    const redirect = /^\/r\/(\d+)$/.exec(path);
    if (redirect !== null) {
      const n = Number(redirect[1]);
      res.writeHead(302, { location: n <= 1 ? '/ok' : `/r/${n - 1}` }).end();
      return;
    }
    switch (path) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      case '/gzip-ok':
        res.writeHead(200, { 'content-encoding': 'gzip' }).end(gzipSync('{"ok":true}'));
        return;
      case '/gzip-bomb':
        // About 5 KiB on the wire, above 4 MiB once decompressed.
        res.writeHead(200, { 'content-encoding': 'gzip' }).end(gzipSync(Buffer.alloc(OVER)));
        return;
      case '/compress':
        res.writeHead(200, { 'content-encoding': 'compress' }).end('x');
        return;
      case '/gzip-null': {
        // The inverse of a bomb: a gzip stream that decodes to almost nothing, so the
        // decompressed cap never trips and only a compressed-side bound stops the read.
        // Written in 64 KiB blocks -- a write per tiny member would starve the event loop
        // and time out whatever test runs next.
        res.writeHead(200, { 'content-encoding': 'gzip' });
        let sent = 0;
        const pump = (): void => {
          while (sent < SMALL_LIMITS.maxBytes * 64) {
            sent += NULL_GZIP_BLOCK.length;
            if (!res.write(NULL_GZIP_BLOCK)) {
              res.once('drain', pump);
              return;
            }
          }
          res.end();
        };
        pump();
        return;
      }
      case '/big-cl':
        res.writeHead(200, { 'content-length': String(OVER) });
        res.write('x'); // then stall: the client must abort on the header alone
        return;
      case '/big-chunked': {
        res.writeHead(200); // no Content-Length
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let sent = 0;
        const pump = (): void => {
          while (sent <= OVER) {
            sent += chunk.length;
            if (!res.write(chunk)) {
              res.once('drain', pump);
              return;
            }
          }
          res.end();
        };
        pump();
        return;
      }
      case '/to-http':
        res.writeHead(302, { location: `http://manifest.test:${port}/ok` }).end();
        return;
      case '/to-private':
        res.writeHead(302, { location: `https://private.test:${port}/ok` }).end();
        return;
      case '/stall':
        return; // never answers
      case '/flaky':
        flakyHits++;
        if (flakyHits === 1) res.writeHead(503).end();
        else res.writeHead(200).end('{"ok":true}');
        return;
      case '/always-503':
        res.writeHead(503).end();
        return;
      default:
        res.writeHead(404).end();
    }
  });
  server.on('secureConnection', () => connections++);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const s of open) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

const dec = new TextDecoder();

function resolverFrom(table: Record<string, string[] | string[][]>): { resolve: (h: string) => Promise<string[]>; calls: string[] } {
  const calls: string[] = [];
  const seen = new Map<string, number>();
  return {
    calls,
    resolve: async (h: string): Promise<string[]> => {
      calls.push(h);
      const entry = table[h];
      if (entry === undefined) throw new Error(`ENOTFOUND ${h}`);
      if (Array.isArray(entry[0])) {
        const i = seen.get(h) ?? 0;
        seen.set(h, i + 1);
        return (entry as string[][])[Math.min(i, entry.length - 1)]!;
      }
      return entry as string[];
    },
  };
}

function testFetcher(extra: Partial<NodeManifestFetcherOptions> = {}, table?: Record<string, string[] | string[][]>) {
  const r = resolverFrom(table ?? { 'manifest.test': ['127.0.0.1'], 'private.test': ['10.0.0.1'], 'wrong.test': ['127.0.0.1'] });
  const fetcher = createNodeManifestFetcher({
    resolve: r.resolve,
    allowAddress: (ip) => ip === '127.0.0.1',
    ca: CA,
    ...extra,
  });
  return { fetcher, calls: r.calls };
}

const url = (path: string, host = 'manifest.test'): string => `https://${host}:${port}${path}`;

describe('node manifest fetcher: happy paths', () => {
  it('fetches over TLS verified against the host name, through the pinned address', async () => {
    const { fetcher } = testFetcher();
    expect(dec.decode(await fetcher(url('/ok'), LIMITS))).toBe('{"ok":true}');
  });

  it('decodes a gzip body', async () => {
    const { fetcher } = testFetcher();
    expect(dec.decode(await fetcher(url('/gzip-ok'), LIMITS))).toBe('{"ok":true}');
  });

  it('follows exactly 3 redirects', async () => {
    const { fetcher } = testFetcher();
    expect(dec.decode(await fetcher(url('/r/3'), LIMITS))).toBe('{"ok":true}');
  });
});

describe('node manifest fetcher: address policy', () => {
  it.each(['127.0.0.1', '::1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1'])(
    'refuses a host resolving to %s without connecting (default policy)',
    async (ip) => {
      const before = connections;
      const fetcher = createNodeManifestFetcher({ resolve: async () => [ip], ca: CA });
      await expect(fetcher(url('/ok'), LIMITS)).rejects.toMatchObject({ code: 'MANIFEST_FETCH_REFUSED' });
      expect(connections).toBe(before);
    },
  );

  it('refuses an IP literal host that is not public (default policy)', async () => {
    const fetcher = createNodeManifestFetcher({ ca: CA });
    await expect(fetcher(`https://127.0.0.1:${port}/ok`, LIMITS)).rejects.toMatchObject({ code: 'MANIFEST_FETCH_REFUSED' });
    await expect(fetcher(`https://[::1]:${port}/ok`, LIMITS)).rejects.toMatchObject({ code: 'MANIFEST_FETCH_REFUSED' });
  });

  it('refuses when any resolved address is non-public', async () => {
    const { fetcher } = testFetcher({}, { 'manifest.test': ['127.0.0.1', '10.0.0.1'] });
    await expect(fetcher(url('/ok'), LIMITS)).rejects.toMatchObject({ code: 'MANIFEST_FETCH_REFUSED' });
  });

  it('DNS rebinding: a second lookup returning a private address is never used', async () => {
    // First lookup: "public"; any later lookup: private. The fetch must connect to the
    // checked address and must not resolve again for the connection itself.
    const { fetcher, calls } = testFetcher({}, { 'rebind.test': [['127.0.0.1'], ['10.0.0.1']] });
    expect(dec.decode(await fetcher(url('/ok', 'rebind.test'), LIMITS))).toBe('{"ok":true}');
    expect(calls).toEqual(['rebind.test']);
  });
});

describe('node manifest fetcher: TLS', () => {
  it('rejects a certificate that does not name the original host', async () => {
    const { fetcher } = testFetcher();
    await expect(fetcher(url('/ok', 'wrong.test'), LIMITS)).rejects.toMatchObject({ code: 'MANIFEST_FETCH_TLS' });
  });

  it('rejects an untrusted certificate', async () => {
    const r = resolverFrom({ 'manifest.test': ['127.0.0.1'] });
    const fetcher = createNodeManifestFetcher({ resolve: r.resolve, allowAddress: (ip) => ip === '127.0.0.1' });
    await expect(fetcher(url('/ok'), LIMITS)).rejects.toMatchObject({ code: 'MANIFEST_FETCH_TLS' });
  });
});

describe('node manifest fetcher: redirects', () => {
  it('refuses a fourth redirect', async () => {
    const { fetcher } = testFetcher();
    await expect(fetcher(url('/r/4'), LIMITS)).rejects.toThrow(/more than 3 redirects/);
  });

  it('refuses a redirect to http://, even when http is allowed', async () => {
    const { fetcher } = testFetcher({ allowHttp: true });
    await expect(fetcher(url('/to-http'), LIMITS)).rejects.toThrow(/https to http/);
    const strict = testFetcher();
    await expect(strict.fetcher(url('/to-http'), LIMITS)).rejects.toThrow(/scheme http: is not allowed/);
  });

  it('re-resolves and re-checks the redirect target', async () => {
    const { fetcher, calls } = testFetcher();
    await expect(fetcher(url('/to-private'), LIMITS)).rejects.toThrow(/non-public address 10\.0\.0\.1/);
    expect(calls).toEqual(['manifest.test', 'private.test']);
  });
});

describe('node manifest fetcher: size bounds', () => {
  it('aborts on a Content-Length above 4 MiB before reading the body', async () => {
    const { fetcher } = testFetcher();
    await expect(fetcher(url('/big-cl'), LIMITS)).rejects.toThrow(/Content-Length \d+ exceeds 4194304/);
  });

  it('aborts while reading a body above 4 MiB without Content-Length', async () => {
    const { fetcher } = testFetcher();
    await expect(fetcher(url('/big-chunked'), LIMITS)).rejects.toMatchObject({ code: 'MANIFEST_TOO_LARGE' });
  });

  it('aborts a small compressed response that decompresses above 4 MiB', async () => {
    const { fetcher } = testFetcher();
    await expect(fetcher(url('/gzip-bomb'), LIMITS)).rejects.toThrow(/after decompression/);
  });

  /**
   * A bomb is caught by the decompressed cap. Its inverse is not: a gzip stream of empty
   * deflate blocks decodes to nothing, so without a bound on the compressed side the
   * socket is read until the total timeout.
   */
  it('aborts a compressed body that decodes to nothing but never stops arriving', async () => {
    const { fetcher } = testFetcher();
    await expect(fetcher(url('/gzip-null'), SMALL_LIMITS)).rejects.toThrow(
      /compressed body exceeds \d+ bytes before decoding/,
    );
  });

  it('refuses a Content-Encoding other than gzip, deflate or br', async () => {
    const { fetcher } = testFetcher();
    await expect(fetcher(url('/compress'), LIMITS)).rejects.toThrow(/unsupported Content-Encoding/);
  });
});

describe('node manifest fetcher: timeouts and retries', () => {
  it('fires the total timeout on a server that stalls after connecting', async () => {
    const { fetcher } = testFetcher();
    const started = Date.now();
    await expect(fetcher(url('/stall'), { ...LIMITS, timeoutMs: 300 })).rejects.toMatchObject({ code: 'MANIFEST_FETCH_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('fires the connect timeout when the TLS handshake never completes', async () => {
    const silent: TcpServer = createTcpServer((s) => open.push(s));
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const silentPort = (silent.address() as AddressInfo).port;
    try {
      const { fetcher } = testFetcher({ connectTimeoutMs: 200, retries: 0 });
      await expect(fetcher(`https://manifest.test:${silentPort}/ok`, LIMITS)).rejects.toThrow(/connect timeout/);
    } finally {
      silent.close();
    }
  });

  it('retries a 5xx once, re-resolving the host for the new attempt', async () => {
    flakyHits = 0;
    const { fetcher, calls } = testFetcher();
    expect(dec.decode(await fetcher(url('/flaky'), LIMITS))).toBe('{"ok":true}');
    expect(calls).toEqual(['manifest.test', 'manifest.test']);
  });

  it('re-checks the address on retry', async () => {
    const { fetcher } = testFetcher({}, { 'manifest.test': [['127.0.0.1'], ['10.0.0.1']] });
    await expect(fetcher(url('/always-503'), LIMITS)).rejects.toMatchObject({ code: 'MANIFEST_FETCH_REFUSED' });
  });
});
