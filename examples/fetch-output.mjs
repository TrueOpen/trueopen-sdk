// FetchOutput example: fetch a finished task's output and verify it against the chain.
//
// Nothing is pasted in: resolveOutputTrustAnchors reads the accepted task_hash, the winner
// Worker's service key and the accepted InferReceipt (output hash, size, leaf count) from chain.
// fetchTaskOutput then fetches the object in ranges from a Builder and checks its MMR root
// against the receipt. The example waits while the receipt is not on chain yet.
//
// Run:
//   TRUEOPEN_REST_URL=... TRUEOPEN_CHAIN_ID=trueopen-localnet-1 TRUEOPEN_MNEMONIC="..." \
//   TRUEOPEN_SESSION_ID=<session id> TRUEOPEN_TASK_ID=<task id> \
//   TRUEOPEN_ALLOW_INSECURE_HTTP=1 \      # localnet only: its nexus endpoints are plain http
//   node examples/fetch-output.mjs
import { resolveBuilderEndpoints } from '../dist/index.js';
import { setup, env, poll, show } from './_shared.mjs';

const { hub, client, clientFor } = await setup();
const sessionId = env('TRUEOPEN_SESSION_ID');
const taskId = env('TRUEOPEN_TASK_ID');

const anchors = await poll(() => client.resolveOutputTrustAnchors(taskId), { label: 'waiting for the receipt' });
show('trust anchors (from chain)', {
  taskHash: anchors.taskHash,
  winnerWorker: anchors.winnerWorker,
  outputHash: anchors.outputHash,
  outputSizeBytes: anchors.receipt?.outputSizeBytes,
});

// The output lives on the Task Builders that took the order. openTask returns them; here we only
// have the task id, so ask every active Builder until one has it.
const { endpoints } = await resolveBuilderEndpoints(hub);
const failures = [];
for (const ep of endpoints) {
  // A client bound to this Builder's endpoint; https is checked against its on-chain fingerprint.
  const builderClient = clientFor(ep.serviceEndpoint, ep.tlsPubkeyHash ?? '');
  try {
    const out = await builderClient.fetchTaskOutput({ sessionId, taskId, anchors, builderAddress: ep.builderAddress });
    show('fetchTaskOutput (verified against the receipt)', {
      builder: ep.builderAddress,
      sizeBytes: out.sizeBytes,
      chunks: out.chunks.length,
      outputHash: out.outputHash,
      text: out.text,
    });
    process.exit(0);
  } catch (e) {
    failures.push(`${ep.builderAddress}: ${e?.code ?? ''} ${e?.message ?? String(e)}`);
  }
}
console.log('\nno Builder returned the output:\n  ' + failures.join('\n  '));
process.exitCode = 1;
