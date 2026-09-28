import { buildContext } from '../context';
import { fromHex } from '../../util/bytes';
import { TrueOpenError } from '../../errors/errors';
import { FinishReasonV1 } from '../../gen/task/v1/evidence_pb.js';
import type { CliConfig } from '../config';

/**
 * Retrieve the output body over the task data plane.
 *
 * Queries each candidate Task Builder in turn: the object only exists on the ones that received this
 * order, and nexus compares the builder_operator_address in the request byte-for-byte against its own
 * configuration, so each endpoint must use its own address.
 *
 * The trust anchors -- the accepted task_hash and the accepted InferReceipt's output_hash, size and
 * leaf count -- are read from chain once (resolveOutputTrustAnchors); the optional positional
 * arguments override the two hashes. The request expiry is latest height + 10 blocks, read fresh for
 * every request, which stays inside nexus's 20-block window with margin.
 */
export async function cmdOutputGet(
  cfg: CliConfig,
  mnemonic: string,
  session: string,
  task: string,
  taskHash?: string,
  outputHash?: string,
): Promise<unknown> {
  const ctx = await buildContext(cfg, mnemonic, { nexus: true, key: true });
  try {
    const explicit = taskHash !== undefined && outputHash !== undefined;
    const anchors = explicit ? undefined : await ctx.client.resolveOutputTrustAnchors(task);
    const failures: string[] = [];
    for (const ep of ctx.nexusEndpoints) {
      if (ep.builderAddress === '') {
        // A manually specified --nexus-url has no on-chain descriptor, so there's no way to look up which Builder it represents, and nexus will always reject it.
        throw new TrueOpenError(
          'SDK_LOCAL',
          'CLI_OUTPUT_NEEDS_AUTO',
          'output get requires --auto: nexus needs to verify the builder_address in the request, and a manually specified --nexus-url has no way of knowing which Builder that endpoint belongs to',
        );
      }
      try {
        const got = await ctx.clientFor(ep.serviceEndpoint).fetchTaskOutput({
          sessionId: session,
          taskId: task,
          ...(taskHash !== undefined ? { taskHash } : {}),
          ...(outputHash !== undefined ? { outputHash } : {}),
          ...(anchors !== undefined ? { anchors } : {}),
          builderAddress: ep.builderAddress,
        });
        return {
          endpoint: ep.serviceEndpoint,
          builderAddress: ep.builderAddress,
          taskHash: got.taskHash,
          sizeBytes: got.sizeBytes.toString(),
          mediaType: got.mediaType,
          outputHash: got.outputHash,
          chunkCount: got.chunks.length,
          text: got.text,
        };
      } catch (e) {
        const err = e as { rawMessage?: string; message?: string };
        failures.push(`${ep.serviceEndpoint}: ${err.rawMessage ?? err.message ?? String(e)}`);
      }
    }
    throw new TrueOpenError(
      'NEXUS_INGRESS',
      'CLI_NO_NEXUS_HAS_OUTPUT',
      `all ${ctx.nexusEndpoints.length} candidate nexus endpoints failed to return output:\n  ${failures.join('\n  ')}`,
      { retriable: true },
    );
  } finally {
    await ctx.dispose();
  }
}

/**
 * Stream-subscribe to output. Verifies each frame's signature and the
 * MMR root locally, emitting frames as they arrive.
 *
 * The frame signatures are checked against the winner Worker's current service key, read from chain
 * (`task/{id}` winner_worker -> `current_service_key/PARTICIPANT_TYPE_CORTEX/{winner}`) together with
 * the accepted task_hash. Both exist once the winner is confirmed, one generation cycle before the
 * InferReceipt, so streaming does not wait for the receipt. The optional positional arguments override
 * them; there is no switch to skip verification.
 */
export async function cmdOutputStream(
  cfg: CliConfig,
  mnemonic: string,
  session: string,
  task: string,
  taskHash: string | undefined,
  workerPubKeyHex: string | undefined,
  ack: boolean,
): Promise<unknown> {
  const ctx = await buildContext(cfg, mnemonic, { nexus: true, key: true });
  try {
    const clients = ctx.nexusEndpoints.map((ep) => ({ ep, client: ctx.clientFor(ep.serviceEndpoint) }));
    const first = clients[0];
    if (!first) throw new TrueOpenError('SDK_LOCAL', 'CLI_NO_NEXUS', 'no nexus endpoint available for output stream');
    const sources = clients.map(({ ep, client }) => ({ id: ep.serviceEndpoint, ingress: client.ingress }));
    const frames: { seq: string; text: string }[] = [];
    let text = '';
    // From the Worker-signed Fin (streamOutput requires one by default). It never says
    // "tool_calls" -- see OutputStreamEvent.
    let finishReason: FinishReasonV1 | undefined;
    for await (const e of first.client.streamOutput({
      sessionId: session,
      taskId: task,
      ...(taskHash !== undefined ? { taskHash } : {}),
      ...(workerPubKeyHex !== undefined ? { workerServicePubKey: fromHex(workerPubKeyHex) } : {}),
      sources,
      maxAttempts: Math.max(3, sources.length * 3),
      idleTimeoutMs: 20_000,
      ack,
    })) {
      if (e.kind === 'chunk') {
        frames.push({ seq: e.seq.toString(), text: e.text });
        text += e.text;
        continue;
      }
      finishReason = e.finishReason;
    }
    return {
      frameCount: frames.length,
      frames,
      text,
      finishReason: finishReason === undefined ? null : FinishReasonV1[finishReason],
    };
  } finally {
    await ctx.dispose();
  }
}
