// OpenTask example: read the on-chain context, assemble the frozen TaskOrderV3, sign it in three
// layers, pick the Task Builders by task_builder_seed and submit to each of them.
//
// What the SDK reads from chain rather than taking on trust: the EVM chain ID and the fee denom
// (params.phase0), the anchor, Builder set and timeout bucket, the generation limits, the profile
// pricing (an order the chain would reject is refused before signing), and the next order
// sequence (0 for a new session).
//
// Run:
//   TRUEOPEN_REST_URL=... TRUEOPEN_CHAIN_ID=trueopen-localnet-1 TRUEOPEN_MNEMONIC="..." \
//   TRUEOPEN_SESSION_ID=<session id> TRUEOPEN_MODEL_ID=<64-hex model id> \
//   TRUEOPEN_ALLOW_INSECURE_HTTP=1 \      # localnet only: its nexus endpoints are plain http
//   node examples/open-task.mjs
//
// Without TRUEOPEN_SESSION_ID the example first creates a session on chain, which needs
// TRUEOPEN_RPC_URL and spends gas.
import { readFileSync } from 'node:fs';
import { defaultGenerationParams, TASK_TYPE, DEADLINE_LATENCY_CLASS } from '../dist/index.js';
import { setup, env, show } from './_shared.mjs';

const needsSession = process.env.TRUEOPEN_SESSION_ID === undefined || process.env.TRUEOPEN_SESSION_ID === '';
const { id, hub, client, businessDenom, disconnect } = await setup({ write: needsSession });

const payloadFile = process.env.TRUEOPEN_PAYLOAD_FILE;
// The V1 data plane sends the input in the clear; the SDK derives input_hash / size from it.
// nexus dedupes inputs by content, so add a timestamp to the default one.
const payload = payloadFile
  ? new Uint8Array(readFileSync(payloadFile))
  : new TextEncoder().encode(`trueopen example input ${new Date().toISOString()}`);

try {
  console.log('user address:', id.address, '| fee denom (chain):', businessDenom);
  const sessionId = needsSession ? (await client.createSession('example-open-task')).sessionId : env('TRUEOPEN_SESSION_ID');
  // The chain is the only source of the next sequence; a new session starts at 0.
  const orderSequence = process.env.TRUEOPEN_ORDER_SEQUENCE !== undefined
    ? BigInt(process.env.TRUEOPEN_ORDER_SEQUENCE)
    : await client.nextOrderSequence(sessionId);
  const height = await hub.getLatestHeight();

  const res = await client.openTask({
    sessionId,
    orderSequence,
    // Must stay the same when retrying this order.
    idempotencyKey: `${sessionId}:${orderSequence}`,
    order: {
      modelId: env('TRUEOPEN_MODEL_ID'), // raw Hash32, lowercase 64-hex
      profileVersion: Number(env('TRUEOPEN_PROFILE_VERSION', '1')),
      taskType: TASK_TYPE.TEXT_GENERATION,
      payload,
      inputBucket: 1,
      outputBudgetBucket: 1,
      // Enters task_hash: max output tokens and max duration are explicit, no hidden defaults.
      generationParams: defaultGenerationParams(256n, 60_000n),
      // Amounts are decimal atomic units. price_bid is per million output tokens:
      // order_value = floor(256 x 100000 / 1e6) = 25, plus the verifier share.
      amounts: {
        priceBid: { atomicUnits: env('TRUEOPEN_PRICE_BID', '100000') },
        maxFee: { atomicUnits: env('TRUEOPEN_MAX_FEE', '1000') }, // covers order_value + txFeeReserve
        assignmentPriorityFee: { atomicUnits: '0' }, // must be 0
        txFeeReserve: { atomicUnits: '0' },
      },
      earliestSubmitHeight: height,
      orderExpireHeight: height + 50_000n,
      latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
    },
  });

  show('openTask', {
    accepted: res.accepted,
    taskId: res.taskId,
    taskHash: res.taskHash,
    orderSequence,
    feeDenom: res.feeDenom,
    // Every selected Builder: fetch-output asks these for the output.
    builders: res.builders.map((b) => ({
      address: b.address,
      endpoint: b.serviceEndpoint,
      accepted: b.ack?.accepted ?? false,
      error: b.error === undefined ? undefined : b.error instanceof Error ? b.error.message : String(b.error),
    })),
  });
  // An ack is local acceptance only; the chain decides whether the task exists.
  console.log(`\nexport TRUEOPEN_SESSION_ID=${sessionId} TRUEOPEN_TASK_ID=${res.taskId}`);
} catch (e) {
  console.log('\nopenTask failed:', e?.code ?? '', '|', e?.message ?? String(e));
  process.exitCode = 1;
} finally {
  disconnect();
}
