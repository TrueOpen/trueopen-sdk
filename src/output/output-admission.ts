import { TrueOpenError } from '../errors/errors';

export interface OutputAdmissionWaitOptions {
  /** Defaults to 1000ms. Events may trigger an earlier read. */
  readonly pollIntervalMs?: number;
  /** Total wait budget, default 30000ms. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** An event is a hint to query authority, never proof that admission succeeded. */
const ADMISSION_HINT_EVENTS = new Set(['DISPATCH_RECORDED']);

export async function waitForOutputAdmission<T>(
  read: () => Promise<T>,
  events: (signal: AbortSignal) => AsyncIterable<{ eventCode: string }>,
  options: OutputAdmissionWaitOptions = {},
): Promise<T> {
  const interval = options.pollIntervalMs ?? 1000;
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(interval) || interval <= 0 || !Number.isFinite(timeout) || timeout <= 0) {
    throw new TrueOpenError('SDK_LOCAL', 'OUTPUT_ADMISSION_WAIT_INVALID', 'Polling interval and timeout must be positive and finite');
  }
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const deadline = setTimeout(() => { timedOut = true; cancel(); }, timeout);
  const aborted = (): TrueOpenError => new TrueOpenError(
    timedOut ? 'CHAIN_REJECT' : 'SDK_LOCAL',
    timedOut ? 'OUTPUT_TRUST_ANCHOR_TIMEOUT' : 'SDK_LOCAL_ABORTED',
    timedOut ? 'Timed out waiting for chain-recorded output anchors' : 'Output admission wait aborted',
    { retriable: timedOut },
  );
  let rejectAbort: (reason: unknown) => void = () => {};
  const abortPromise = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  // Keep cancellation handled even while between chain reads.
  void abortPromise.catch(() => {});
  const onAbort = () => rejectAbort(aborted());
  controller.signal.addEventListener('abort', onAbort, { once: true });
  let hints = 0;
  let wake: (() => void) | undefined;
  let iterator: AsyncIterator<{ eventCode: string }> | undefined;
  try {
    if (controller.signal.aborted) throw aborted();
    iterator = events(controller.signal)[Symbol.asyncIterator]();
    const pump = async () => {
      try {
        while (!controller.signal.aborted) {
          const step = await iterator!.next();
          if (step.done) break;
          if (ADMISSION_HINT_EVENTS.has(step.value.eventCode)) { hints++; wake?.(); }
        }
      } catch { /* Event transport loss falls back to bounded chain polling. */ }
    };
    void pump();
    for (;;) {
      const observedHints = hints;
      if (controller.signal.aborted) throw aborted();
      try { return await Promise.race([read(), abortPromise]); }
      catch (error) {
        if (!(error instanceof TrueOpenError) || error.code !== 'OUTPUT_TRUST_ANCHOR_PENDING') throw error;
      }
      if (hints !== observedHints) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, interval); }),
          abortPromise,
        ]);
      } finally { if (timer !== undefined) clearTimeout(timer); wake = undefined; }
    }
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
    controller.abort();
    // Do not await return() on a peer that stopped sending frames.
    void iterator?.return?.().catch(() => {});
  }
}
