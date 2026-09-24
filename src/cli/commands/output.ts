import { buildContext, queryAcrossNexus, fetchLike } from '../context';
import { HubReader } from '../../transport/hub-reader';
import { fromHex } from '../../util/bytes';
import { TrueOpenError } from '../../errors/errors';
import { FinishReasonV1 } from '../../gen/task/v1/evidence_pb.js';
import type { CliConfig } from '../config';
import type { AccessLevelName } from '../../transport/sdk-request-envelope';

export async function cmdOutputRef(
  cfg: CliConfig,
  mnemonic: string,
  session: string,
  task: string,
  accessLevel?: string,
  usage?: string,
): Promise<unknown> {
  const ctx = await buildContext(cfg, mnemonic, { nexus: true, key: true });
  try {
    const opts: { accessLevel?: AccessLevelName; usage?: string } = {};
    if (accessLevel) opts.accessLevel = accessLevel.toUpperCase() === 'PACKAGE' ? 'PACKAGE' : 'SEALED_KEY';
    if (usage) opts.usage = usage;
    // A task only has state on the Task Builder that received the order, so we locate it across candidate endpoints.
    return await queryAcrossNexus(ctx, (client) => client.fetchOutputRef(session, task, opts));
  } finally {
    await ctx.dispose();
  }
}

/**
 * Retrieve the output body (the data plane from contract sections 3.5/3.6).
 *
 * Queries each candidate Task Builder in turn: the object only exists on the ones that received this
 * order, and nexus compares the builder_operator_address in the request byte-for-byte against its own
 * configuration, so each endpoint must use its own address. The expiry is a **chain height**, fetched
 * fresh here each time -- a stale height cannot be reused.
 *
 * Since v0.4.1, retrieval is content-addressed: both the on-chain task_hash and the InferReceipt's
 * output_hash must be supplied -- the latter is both object_ref.content_hash (used to locate the object)
 * and the verification target for the MMR root. Both values only exist on chain; the CLI does not guess
 * them or fetch them back from nexus.
 */
export async function cmdOutputGet(
  cfg: CliConfig,
  mnemonic: string,
  session: string,
  task: string,
  taskHash: string,
  outputHash: string,
): Promise<unknown> {
  const ctx = await buildContext(cfg, mnemonic, { nexus: true, key: true });
  try {
    const hub = new HubReader({ baseUrl: cfg.requireRest(), fetch: fetchLike });
    const height = await hub.getLatestHeight();
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
          taskHash,
          outputHash,
          builderAddress: ep.builderAddress,
          expiresAtHeight: height + 20n,
        });
        return {
          endpoint: ep.serviceEndpoint,
          builderAddress: ep.builderAddress,
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
 * Stream-subscribe to output (ADR-0017 / contract section 3.5). Verifies each frame's signature and the
 * MMR root locally, emitting frames as they arrive.
 *
 * workerPubKeyHex must be supplied by the caller: it is the service public key of the selected Worker for
 * this Task. Without it there's no way to verify frame signatures, and "accept without verifying" would
 * mean giving up all of ADR-0017's guarantees, so no switch to skip verification is provided here.
 *
 * How to obtain it: on-chain `assignment.winner_worker` -> `HubReader.getCurrentServiceKey`
 * (the participant type is CORTEX -- that's the name used for the Worker-side software). Both become
 * available together at the winner_confirm stage, one generation cycle before the InferReceipt, so
 * streaming retrieval doesn't need to wait for the receipt.
 */
export async function cmdOutputStream(
  cfg: CliConfig,
  mnemonic: string,
  session: string,
  task: string,
  taskHash: string,
  workerPubKeyHex: string,
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
    // undefined when the peer sent an unsigned Fin: reported as such rather than guessed,
    // and it never says "tool_calls" -- see OutputStreamEvent.
    let finishReason: FinishReasonV1 | undefined;
    for await (const e of first.client.streamOutput({
      sessionId: session,
      taskId: task,
      taskHash,
      workerServicePubKey: fromHex(workerPubKeyHex),
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
