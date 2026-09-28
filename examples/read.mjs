// Read-only example (costs nothing): chain params, sessions and nexus endpoint discovery.
// Run: TRUEOPEN_REST_URL=http://<rest-host>:1317 node examples/read.mjs
//   Optional: TRUEOPEN_QUERY_ADDR=<address>  TRUEOPEN_SESSION_ID=<session id>  TRUEOPEN_TASK_ID=<task id>
import { RestChainReader, HubReader, resolveBuilderEndpoints } from '../dist/index.js';
import { env, fetchLike, show } from './_shared.mjs';

const REST = env('TRUEOPEN_REST_URL');
const reader = new RestChainReader({ baseUrl: REST, fetch: fetchLike });
const hub = new HubReader({ baseUrl: REST, fetch: fetchLike });

/**
 * @param {string} label
 * @param {() => Promise<unknown>} fn
 */
const tryShow = async (label, fn) => {
  try { show(label, await fn()); } catch (e) { console.log(`\n=== ${label} ===\n(skipped: ${e?.code ?? ''} ${e?.message ?? e})`); }
};

// Both go into signatures; the SDK reads them, never assumes them.
await tryShow('chain params', async () => ({ evmChainId: await hub.getEvmChainId(), businessDenom: await hub.getBusinessDenom() }));

const addr = env('TRUEOPEN_QUERY_ADDR', '');
if (addr) await tryShow('querySessionNonce', () => reader.querySessionNonce(addr));
const sid = env('TRUEOPEN_SESSION_ID', '');
if (sid) await tryShow('querySession', () => reader.querySession(sid));
const tid = env('TRUEOPEN_TASK_ID', '');
if (tid) {
  await tryShow('queryTask', () => reader.queryTask(tid));
  await tryShow('queryInferReceipt', () => reader.queryInferReceipt(tid));
}

// nexus endpoints come inline in each Builder's on-chain service descriptor.
const { endpoints, errors } = await resolveBuilderEndpoints(hub);
show('nexus endpoints', endpoints);
if (errors.length) {
  show('resolve errors', errors.map((e) => ({ builder: e.builderAddress, error: e.error instanceof Error ? e.error.message : String(e.error) })));
}
console.log('\nDone. Everything above is read-only and costs nothing.');
