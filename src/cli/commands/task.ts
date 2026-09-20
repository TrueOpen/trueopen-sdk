import { buildContext, queryAcrossNexus } from '../context';
import type { CliConfig } from '../config';
import type { GetTaskEventsResponse } from '../../gen/nexus/v1/ingress_pb.js';

/**
 * A snapshot of task status.
 *
 * A task only exists on the Task Builder that received the order (selection is determined by the anchor
 * signed into the order, which cannot be worked out backwards when checking status), so under --auto we
 * search across all candidate endpoints instead of gambling on the first one.
 */
export async function cmdTaskStatus(cfg: CliConfig, session: string, task: string): Promise<unknown> {
  const ctx = await buildContext(cfg, undefined, { nexus: true });
  try {
    return await queryAcrossNexus(ctx, (client) => client.taskStatus(session, task));
  } finally {
    await ctx.dispose();
  }
}

/**
 * watch is streaming: it returns {stream, dispose}, which the index layer for-awaits and prints line by
 * line, calling dispose when done.
 *
 * Also locates the endpoint across candidates: it gets the stream before returning, and moves on to the
 * next endpoint if it can't.
 */
export async function cmdTaskWatch(
  cfg: CliConfig,
  mnemonic: string,
  session: string,
  task: string,
  fromCursor?: string,
): Promise<{ stream: AsyncIterable<GetTaskEventsResponse>; dispose(): Promise<void> }> {
  const ctx = await buildContext(cfg, mnemonic, { nexus: true, key: true });
  const stream = await queryAcrossNexus(ctx, async (client) => {
    const s = fromCursor !== undefined ? client.watchTask(session, task, fromCursor) : client.watchTask(session, task);
    // Fetch the first frame to confirm this endpoint actually has the task; otherwise NOT_FOUND would only surface once the stream is consumed.
    const it = s[Symbol.asyncIterator]();
    const head = await it.next();
    async function* replay(): AsyncGenerator<GetTaskEventsResponse> {
      if (!head.done) yield head.value;
      for (;;) {
        const n = await it.next();
        if (n.done) return;
        yield n.value;
      }
    }
    return replay();
  });
  return { stream, dispose: ctx.dispose };
}
