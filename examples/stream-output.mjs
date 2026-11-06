// Stream-before-record example: place a CHAT order, then stream its output with
// `streamOutput({ beforeRecord })` and print how long each step took.
//
// With `beforeRecord` the SDK does not wait for the chain to record the dispatch. It verifies the
// Builder-signed DispatchResultHeaderV1 (winner ticket, Worker accept, both signatures, the
// Builder is one the order went to) and delivers verified chunks at once with `recorded: false`.
// Once the chain records the same attempt, chunks carry `recorded: true`; `fin` only comes after
// that. Text shown while `recorded` is false is provisional: a `reset` replaces it.
//
// Run (after `npm run build`):
//   TRUEOPEN_REST_URL=... TRUEOPEN_CHAIN_ID=... TRUEOPEN_MNEMONIC="..." \
//   TRUEOPEN_SESSION_ID=<session id> TRUEOPEN_MODEL_ID=<0x + 64-hex model id> \
//   TRUEOPEN_PROMPT="Say hello" node examples/stream-output.mjs
import { chatInferInputBytes, defaultGenerationParams, TASK_TYPE, DEADLINE_LATENCY_CLASS } from '../dist/index.js';
import { setup, env, show } from './_shared.mjs';

const { hub, client, clientFor, disconnect } = await setup();
const sessionId = env('TRUEOPEN_SESSION_ID');
const ms = (t0) => `${(performance.now() - t0).toFixed(0)} ms`;

try {
  const orderSequence = await client.nextOrderSequence(sessionId);
  const height = await hub.getLatestHeight();
  const payload = chatInferInputBytes({ messages: [{ role: 'user', content: env('TRUEOPEN_PROMPT', 'Say hello in one sentence.') }] });

  const t0 = performance.now();
  const res = await client.openTask({
    sessionId,
    orderSequence,
    idempotencyKey: `${sessionId}:${orderSequence}`,
    order: {
      modelId: env('TRUEOPEN_MODEL_ID'),
      profileVersion: Number(env('TRUEOPEN_PROFILE_VERSION', '1')),
      taskType: TASK_TYPE.CHAT,
      payload,
      inputBucket: 1,
      outputBudgetBucket: 1,
      generationParams: defaultGenerationParams(256n, 60_000n),
      amounts: {
        priceBid: { atomicUnits: env('TRUEOPEN_PRICE_BID', '4000000') },
        maxFee: { atomicUnits: env('TRUEOPEN_MAX_FEE', '4000') },
        assignmentPriorityFee: { atomicUnits: '0' },
        txFeeReserve: { atomicUnits: '0' },
      },
      earliestSubmitHeight: height,
      orderExpireHeight: height + 1_000n,
      latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
    },
  });
  if (!res.accepted) throw new Error('the order was not accepted');
  console.log(`openTask acked after ${ms(t0)}: task ${res.taskId}`);

  // The Builder that took the order serves its output.
  const builder = res.builders.find((b) => b.ack?.accepted) ?? res.builders[0];
  const builderClient = clientFor(builder.serviceEndpoint, builder.tlsPubkeyHash);

  let firstChunk;
  let firstRecorded;
  let text = '';
  for await (const event of builderClient.streamOutput({
    sessionId,
    taskId: res.taskId,
    // The openTask result carries the signed task_hash, the Builders and the order height.
    beforeRecord: res,
    idleTimeoutMs: 120_000,
  })) {
    if (event.kind === 'reset') {
      console.log('\n(the chain recorded another dispatch attempt; starting over)');
      text = '';
    } else if (event.kind === 'chunk') {
      if (firstChunk === undefined) {
        firstChunk = ms(t0);
        console.log(`first chunk after ${firstChunk} (recorded: ${event.recorded})`);
      }
      if (event.recorded && firstRecorded === undefined) {
        firstRecorded = ms(t0);
        console.log(`\nrecord confirmed on chain by ${firstRecorded}`);
      }
      text += event.text;
      process.stdout.write(event.text);
    } else {
      console.log(`\nfin after ${ms(t0)} (attested: ${event.attested})`);
    }
  }
  show('timing', { firstChunk, firstRecordedChunk: firstRecorded ?? '(no chunk after the confirmation)', textLength: text.length });
} catch (e) {
  console.log('\nstream-output failed:', e?.code ?? '', '|', e?.message ?? String(e));
  process.exitCode = 1;
} finally {
  disconnect();
}
