// Same-origin manifest proxy for browser apps (the recommended browser deployment).
//
// A browser cannot pin DNS or vet the address it connects to, so it must not fetch an
// on-chain manifest_uri directly. Serve this endpoint from the same origin as your app;
// it fetches the URI server-side with the SDK's SSRF-safe Node downloader and returns
// the bytes unchanged. The browser SDK still verifies manifest_hash, strict parsing,
// canonical bytes and the projection, so the proxy is trusted for safety, not integrity.
//
//   npm run build && PORT=8787 node examples/manifest-proxy.mjs
//   curl 'http://127.0.0.1:8787/manifest-proxy?url=https%3A%2F%2Fmodels.example%2Fm.json'
import { createServer } from 'node:http';
import { parseManifestUri, MAX_MANIFEST_BYTES, TrueOpenError } from '../dist/index.js';
import { createNodeManifestFetcher } from '../dist/node.js';
import { env } from './_shared.mjs';

const port = Number(env('PORT', '8787'));
// Default policy: public addresses only, pinned connection, TLS checked against the
// host name, re-checks on retry and redirect (max 3, never https -> http), connect and
// total timeouts, 4 MiB cap after decompression.
const fetchManifest = createNodeManifestFetcher();
const limits = { maxBytes: MAX_MANIFEST_BYTES, timeoutMs: 20_000 };

createServer(async (req, res) => {
  const reqUrl = new URL(req.url ?? '/', 'http://localhost');
  if (req.method !== 'GET' || reqUrl.pathname !== '/manifest-proxy') {
    res.writeHead(404).end();
    return;
  }
  const target = reqUrl.searchParams.get('url') ?? '';
  try {
    // Only proxy what could be an on-chain manifest_uri: strict syntax, https only.
    // This keeps the endpoint from being an open proxy for arbitrary URLs.
    if (parseManifestUri(target).scheme !== 'https') throw new Error('only https manifest_uri is proxied');
    const body = await fetchManifest(target, limits);
    // Return the exact bytes: no re-encoding, no compression, no caching of failures.
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
    res.end(body);
  } catch (e) {
    const code = e instanceof TrueOpenError ? e.code : 'MANIFEST_PROXY_BAD_REQUEST';
    res.writeHead(code === 'MANIFEST_FETCH_REFUSED' || code === 'MANIFEST_PROXY_BAD_REQUEST' || code === 'MANIFEST_URI_INVALID' ? 400 : 502, {
      'content-type': 'application/json',
    });
    res.end(JSON.stringify({ code }));
  }
}).listen(port, '127.0.0.1', () => console.log(`manifest proxy on http://127.0.0.1:${port}/manifest-proxy`));

// Browser side (same origin), for reference:
//
//   import { ManifestSource, HubReader, boundedWebFetch } from 'trueopen-sdk';
//   const proxyFetcher = (url, limits) =>
//     boundedWebFetch(`/manifest-proxy?url=${encodeURIComponent(url)}`, limits);
//   const source = new ManifestSource({
//     reader: new HubReader({ baseUrl: 'https://node.example:1317', fetch: globalThis.fetch.bind(globalThis) }),
//     fetcher: proxyFetcher,
//     mirrors: ['https://mirror.example/manifests/{manifest_hash}.json'], // optional fallback
//   });
//   const { manifest } = await source.fetchManifest(modelIdHex, 1n);
