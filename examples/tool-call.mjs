// Multi-turn tool call example: the model calls a tool, the example runs it locally, and the
// result goes back to the model in the next turn, until the model answers in text.
//
// Every turn is one CHAT order with the whole conversation as its input (chatInferInputBytes).
// assistantTurn streams the turn, verifies every frame, waits for the receipt and yields the
// confirmed message: its tool calls are parsed with the parsers the model profile pins on chain,
// and only confirmed calls are executed. The next turn replays them as an assistant message with
// `tool_calls`, followed by one `tool` message per result.
//
// The example offers one tool, `list_files`, which lists TRUEOPEN_TOOL_DIR (default: the current
// directory); paths that leave that directory are refused.
//
// Run:
//   TRUEOPEN_REST_URL=... TRUEOPEN_CHAIN_ID=trueopen-localnet-1 TRUEOPEN_MNEMONIC="..." \
//   TRUEOPEN_SESSION_ID=<session id> TRUEOPEN_MODEL_ID=<0x + 64-hex model id> \
//   TRUEOPEN_PROMPT="List the files in the current directory" \
//   TRUEOPEN_ALLOW_INSECURE_HTTP=1 \      # localnet only: its nexus endpoints are plain http
//   node examples/tool-call.mjs
import { readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { chatInferInputBytes, defaultGenerationParams, nexusGrpcEndpoint, TASK_TYPE, DEADLINE_LATENCY_CLASS } from '../dist/index.js';
import { setup, env, show } from './_shared.mjs';

const MAX_TURNS = Number(env('TRUEOPEN_MAX_TURNS', '3'));
// A thinking model can spend the whole budget reasoning; the answer then has no content.
const MAX_OUTPUT_TOKENS = BigInt(env('TRUEOPEN_MAX_OUTPUT_TOKENS', '512'));
const TOOL_DIR = resolve(env('TRUEOPEN_TOOL_DIR', process.cwd()));

/** @type {import('../dist/index.js').ChatTool[]} */
const tools = [{
  type: 'function',
  function: {
    name: 'list_files',
    description: 'List the files in a directory',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path, e.g. "." for the current directory' } },
      required: ['path'],
    },
  },
}];

/**
 * Runs one confirmed call. The arguments are the JSON text the model wrote: parse and check them
 * like any untrusted input.
 * @param {{ name: string, arguments: string }} call
 */
function runTool(call) {
  if (call.name !== 'list_files') return `error: unknown tool ${call.name}`;
  let path;
  try {
    path = String(JSON.parse(call.arguments).path ?? '.');
  } catch {
    return 'error: arguments are not a JSON object';
  }
  const dir = resolve(TOOL_DIR, path);
  const rel = relative(TOOL_DIR, dir);
  if (rel.startsWith('..') || resolve(TOOL_DIR, rel) !== dir) return `error: ${path} is outside the allowed directory`;
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.'))
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
      .join('\n');
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const { hub, client, clientFor, disconnect } = await setup();
const sessionId = env('TRUEOPEN_SESSION_ID');
const modelId = env('TRUEOPEN_MODEL_ID');

/** @type {import('../dist/index.js').ChatMessage[]} */
const messages = [{ role: 'user', content: env('TRUEOPEN_PROMPT', 'List the files in the current directory') }];

try {
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const session = await client.getSession(sessionId);
    const orderSequence = session.nextExpectedSequence;
    const height = await hub.getLatestHeight();
    // Encode once per order and keep the bytes: a retry must resend exactly these.
    const payload = chatInferInputBytes({ messages, tools, tool_choice: 'auto' });

    // openTaskWithRecovery re-routes the order when the bound Builder has no capacity.
    const res = await client.openTaskWithRecovery({
      sessionId,
      orderSequence,
      idempotencyKey: `${sessionId}:${orderSequence}`,
      order: {
        modelId,
        profileVersion: Number(env('TRUEOPEN_PROFILE_VERSION', '1')),
        taskType: TASK_TYPE.CHAT,
        payload,
        inputBucket: 1,
        outputBudgetBucket: 1,
        generationParams: defaultGenerationParams(MAX_OUTPUT_TOKENS, 60_000n),
        // order_value = floor(max_output_tokens x price_bid / 1e6) plus the verifier share; max_fee
        // covers it (raise TRUEOPEN_MAX_FEE with TRUEOPEN_MAX_OUTPUT_TOKENS).
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
    }, { maxAttempts: 5, maxPolls: 30, pollIntervalMs: 1_000 });
    if (!('taskId' in res) || !res.accepted) throw new Error(`turn ${turn}: the order was not accepted`);
    console.log(`\n=== turn ${turn}: task ${res.taskId} (sequence ${orderSequence}, ${messages.length} messages)`);

    // The output is served by the Session's bound Builder (recovery may have moved the binding).
    const bound = (await client.getSession(sessionId)).boundBuilder;
    const ep = nexusGrpcEndpoint(await hub.getServiceDescriptor(bound));
    const builderClient = clientFor(ep.uri, ep.tlsPubkeyHash ?? '');
    // Wait until the chain names the Worker and the dispatch ticket the output is verified against.
    await builderClient.waitForOutputTrustAnchors(res.taskId, { sessionId, timeoutMs: 120_000 });

    let message;
    for await (const event of builderClient.assistantTurn({ sessionId, taskId: res.taskId, idleTimeoutMs: 120_000 })) {
      // reasoning / content arrive as frames verify (provisional); `reset` drops a voided attempt.
      if (event.kind === 'reset') console.log('(the dispatch attempt was replaced; starting over)');
      if (event.kind === 'confirmed') message = event.message;
    }
    show(`turn ${turn}: confirmed`, {
      reasoning: message.reasoningContent,
      content: message.content,
      toolCalls: message.toolCalls,
      finishReason: message.finishReason,
    });

    if (message.toolCalls.length === 0) {
      console.log(`\nAnswer:\n${message.content}`);
      break;
    }
    // Replay the confirmed calls and their results. The ids only pair a result with its call;
    // a model whose chat template checks the id format needs client.toolCallIdFormat's format.
    const calls = message.toolCalls.map((c, i) => ({
      id: `call_${turn}_${i}`,
      type: /** @type {const} */ ('function'),
      function: { name: c.name, arguments: c.arguments },
    }));
    messages.push({ role: 'assistant', ...(message.content !== '' ? { content: message.content } : {}), tool_calls: calls });
    for (const call of calls) {
      const output = runTool(call.function);
      console.log(`tool ${call.function.name}(${call.function.arguments}) -> ${output.split('\n').length} line(s)`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
    if (turn === MAX_TURNS) console.log(`\nStopped after ${MAX_TURNS} turns without a text answer.`);
  }
} finally {
  disconnect();
}
