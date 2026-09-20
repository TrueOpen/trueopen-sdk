// Read-only example (costs nothing): chain reads plus Builder / nexus endpoint discovery.
// Run: TRUEOPEN_REST_URL=http://<rest-host>:1317 node examples/read.mjs
//   Optional: TRUEOPEN_QUERY_ADDR=<address>  TRUEOPEN_SESSION_ID=<session id>
import { RestChainReader, HubReader, resolveBuilderEndpoints } from '../dist/index.js';
import { env, fetchLike, fetchDescriptorBytes, show } from './_shared.mjs';

const REST = env('TRUEOPEN_REST_URL');
const reader = new RestChainReader({ baseUrl: REST, fetch: fetchLike });
const hub = new HubReader({ baseUrl: REST, fetch: fetchLike });

const tryShow = async (label, fn) => {
  try { show(label, await fn()); } catch (e) { console.log(`\n=== ${label} ===\n(skipped: ${e?.code ?? ''} ${e?.message ?? e})`); }
};

const addr = env('TRUEOPEN_QUERY_ADDR', '');
if (addr) await tryShow('querySessionNonce', () => reader.querySessionNonce(addr));

const sid = env('TRUEOPEN_SESSION_ID', '');
if (sid) await tryShow('querySession', () => reader.querySession(sid));

const builders = await hub.listBuilders();
show('listBuilders', builders.map((b) => ({ address: b.address, status: b.status, descriptorVersion: b.currentDescriptorVersion })));

// Discover nexus endpoints on chain: builders -> serviceDescriptor -> fetch the document, check its hash -> service_endpoint
const { endpoints, errors } = await resolveBuilderEndpoints(hub, fetchDescriptorBytes, { statuses: ['ACTIVE'] });
show('resolved nexus endpoints', endpoints);
if (errors.length) {
  show('resolve errors', errors.map((e) => ({ builder: e.builderAddress, error: String(e.error?.message ?? e.error) })));
}
console.log('\nDone. Everything above is read-only and costs nothing.');
