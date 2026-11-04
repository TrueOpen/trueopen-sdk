import { TrueOpenError } from '../errors/errors';
import type { StreamStateView } from '../types/node';
import type { OpenTaskAck } from './ingress-client';

export interface DispatchRecoveryPolicy {
  readonly signal?: AbortSignal;
  readonly maxAttempts: number;
  readonly pollIntervalMs: number;
  readonly maxPolls: number;
  readonly sleep?: (ms: number) => Promise<void>;
}
export interface DispatchRecoveryPort {
  readonly taskId?: string;
  readonly orderSequence: bigint;
  readonly builders: readonly string[];
  refreshBuilders?(): Promise<readonly string[]>;
  readSession(): Promise<StreamStateView>;
  readHeight(): Promise<bigint>;
  submit(builder: string, refreshOrder: boolean): Promise<OpenTaskAck>;
  /** Resolve the already admitted task without dispatching it again. */
  recorded(builder: string, taskId?: string): Promise<OpenTaskAck>;
}
/** Sequential recovery. A pending takeover never permits speculative third-party dispatch. */
export async function recoverDispatch(port: DispatchRecoveryPort, policy: DispatchRecoveryPolicy): Promise<OpenTaskAck> {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 || !Number.isSafeInteger(policy.maxPolls) || policy.maxPolls < 1 || !Number.isFinite(policy.pollIntervalMs) || policy.pollIntervalMs < 0) throw new Error('invalid dispatch recovery policy');
  const checkAbort = () => {
    if (policy.signal?.aborted) throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_ABORTED', 'Dispatch recovery aborted');
  };
  const sleep = async (ms: number) => {
    checkAbort();
    if (policy.sleep) await policy.sleep(ms);
    else await new Promise<void>((resolve, reject) => {
      const done = () => { policy.signal?.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(done, ms);
      const abort = () => { clearTimeout(timer); policy.signal?.removeEventListener('abort', abort); reject(new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_ABORTED', 'Dispatch recovery aborted')); };
      policy.signal?.addEventListener('abort', abort, { once: true });
      if (policy.signal?.aborted) abort();
    });
    checkAbort();
  };
  let builders = port.builders;
  // Builders that answered NEXUS_INGRESS_BUILDER_KEY_ROTATING, with the activation height of their
  // pending service key (undefined when they gave none). They take no new work until then.
  const rotating = new Map<string, bigint | undefined>();
  /** The next Builder after `from` in snapshot order that is not rotating, if any. */
  const nextCandidate = (from: string | undefined): string | undefined => {
    const start = from === undefined ? -1 : builders.indexOf(from);
    for (let i = 1; i <= builders.length; i++) {
      const b = builders[(start + i) % builders.length]!;
      if (b !== from && !rotating.has(b)) return b;
    }
    return undefined;
  };
  let target: string | undefined;
  let refresh = false;
  let lastError: unknown;
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    checkAbort();
    let state = await port.readSession();
    if (!state.boundBuilder) throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_SESSION_BINDING_MISSING', 'Missing bound Builder');
    if (state.nextExpectedSequence > port.orderSequence) return port.recorded(state.boundBuilder);
    if (state.status === 'CLOSED' || state.pendingWithdrawKind === 'CLOSE') throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_SESSION_CLOSING', 'Session is closing');
    if (state.nextExpectedSequence < port.orderSequence) throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_SEQUENCE_GAP', 'An earlier order must be recorded before this sequence', { retriable: true });
    if (state.pendingTakeover) {
      let resolved = false;
      for (let poll = 0; poll < policy.maxPolls; poll++) {
        if (await port.readHeight() > state.pendingTakeover.activationHeight + 2n) break;
        await sleep(policy.pollIntervalMs);
        state = await port.readSession();
        if (!state.pendingTakeover) { resolved = true; break; }
      }
      if (!resolved && state.pendingTakeover && await port.readHeight() <= state.pendingTakeover.activationHeight + 2n) throw new TrueOpenError('NEXUS_INGRESS', 'NEXUS_INGRESS_TAKEOVER_PENDING', 'Takeover remains pending; resume after its activation height', { retriable: true, details: { activationHeight: state.pendingTakeover.activationHeight } });
      target = state.pendingTakeover?.candidateBuilder ?? state.boundBuilder;
      refresh = true;
      if (state.nextExpectedSequence > port.orderSequence) return port.recorded(state.boundBuilder!);
    }
    if (state.status === 'CLOSED' || state.pendingWithdrawKind === 'CLOSE') throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_SESSION_CLOSING', 'Session is closing');
    target ??= builders.includes(state.boundBuilder!) ? state.boundBuilder : builders[0];
    if (!target || !builders.includes(target)) throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_BUILDER_NOT_IN_SNAPSHOT', 'Recovery destination is outside the signed BuilderSet');
    try {
      checkAbort();
      const ack = await port.submit(target, refresh);
      if (ack.status !== 2) return ack;
      // Acknowledgement is not proof of chain registration: poll the authoritative state.
      let registered = false;
      for (let poll = 0; poll < policy.maxPolls; poll++) {
        const current = await port.readSession();
        if (current.pendingTakeover || current.boundBuilder !== state.boundBuilder || current.nextExpectedSequence > port.orderSequence) { registered = true; break; }
        if (ack.takeoverActivationHeight !== undefined && await port.readHeight() > ack.takeoverActivationHeight + 2n) break;
        await sleep(policy.pollIntervalMs);
      }
      if (!registered) throw new TrueOpenError('NEXUS_INGRESS', 'NEXUS_INGRESS_TAKEOVER_PENDING', 'Takeover registration is not yet observable', { retriable: true });
      target = undefined;
    } catch (error) {
      lastError = error;
      if (!(error instanceof TrueOpenError)) throw error;
      if (error.code === 'NEXUS_INGRESS_DISPATCH_NOT_READY') {
        const height = error.details?.dispatchAvailableHeight;
        if (typeof height !== 'bigint') throw error;
        let ready = false;
        for (let poll = 0; poll < policy.maxPolls; poll++) {
          if (await port.readHeight() >= height) { ready = true; break; }
          await sleep(policy.pollIntervalMs);
        }
        if (!ready) throw error;
        refresh = true; // same Builder, fresh envelope and chain context
      } else if (['NEXUS_INGRESS_ORDER_STALE', 'NEXUS_INGRESS_ORDER_FUTURE', 'NEXUS_INGRESS_BUILDER_SET_STALE'].includes(error.code)) {
        if (port.refreshBuilders) builders = await port.refreshBuilders();
        if (target && !builders.includes(target)) target = undefined;
        refresh = true;
      } else if (error.code === 'NEXUS_INGRESS_SESSION_BOUND_ELSEWHERE') {
        const hintedBuilder = error.details?.boundBuilder;
        const hintedTask = error.details?.taskId;
        if (typeof hintedBuilder === 'string' && hintedBuilder !== '' && !builders.includes(hintedBuilder)) {
          throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_BUILDER_NOT_IN_SNAPSHOT', 'Redirected Builder is outside the signed BuilderSet');
        }
        if (typeof hintedTask === 'string' && hintedTask !== '') {
          if (!/^0x[0-9a-f]{64}$/.test(hintedTask) || (port.taskId !== undefined && hintedTask !== port.taskId)) {
            throw new TrueOpenError('DATA', 'DATA_TASK_SEQUENCE_MISMATCH', 'OpenTask redirect names another task');
          }
          // Do not dispatch again while a lagging Session query catches up with this recorded task.
          const builder = typeof hintedBuilder === 'string' && hintedBuilder !== '' ? hintedBuilder : (await port.readSession()).boundBuilder!;
          for (let poll = 0; poll < policy.maxPolls; poll++) {
            checkAbort();
            try { return await port.recorded(builder, hintedTask); }
            catch (pending) {
              if (!(pending instanceof TrueOpenError) || !['CHAIN_QUERY_NOT_FOUND', 'OUTPUT_TRUST_ANCHOR_PENDING'].includes(pending.code)) throw pending;
            }
            await sleep(policy.pollIntervalMs);
          }
          throw new TrueOpenError('CHAIN_REJECT', 'OUTPUT_TRUST_ANCHOR_PENDING', 'Redirected task is not yet visible on the chain reader; resume querying without redispatch', { retriable: true, details: { boundBuilder: builder, taskId: hintedTask } });
        }
        const current = await port.readSession();
        target = current.boundBuilder !== state.boundBuilder ? current.boundBuilder
          : typeof hintedBuilder === 'string' && hintedBuilder !== '' ? hintedBuilder : current.boundBuilder;
        refresh = true;
      } else if (error.code === 'NEXUS_INGRESS_TAKEOVER_PENDING') {
        const candidate = error.details?.boundBuilder;
        const activation = error.details?.takeoverActivationHeight;
        if (typeof candidate === 'string' && candidate !== '' && !builders.includes(candidate)) throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_BUILDER_NOT_IN_SNAPSHOT', 'Takeover candidate is outside the signed BuilderSet');
        if (typeof activation === 'bigint' && activation > 0n) {
          let ready = false;
          for (let poll = 0; poll < policy.maxPolls; poll++) {
            const current = await port.readSession();
            if (current.nextExpectedSequence > port.orderSequence) return port.recorded(current.boundBuilder!);
            if (current.status === 'CLOSED' || current.pendingWithdrawKind === 'CLOSE') throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_SESSION_CLOSING', 'Session is closing');
            if (await port.readHeight() >= activation) { ready = true; break; }
            await sleep(policy.pollIntervalMs);
          }
          if (!ready) throw error;
          target = typeof candidate === 'string' && candidate !== '' ? candidate : undefined;
          refresh = true;
        } else {
          // No reliable activation height: wait for the authoritative pending state.
          const current = await port.readSession();
          if (!current.pendingTakeover && current.boundBuilder === state.boundBuilder && current.nextExpectedSequence === state.nextExpectedSequence) throw error;
          target = undefined;
          await sleep(policy.pollIntervalMs);
        }
      } else if (error.code === 'NEXUS_INGRESS_BUILDER_KEY_ROTATING') {
        // wire #49: route new work as for NO_CAPACITY, skip pending Builders, and when every
        // candidate is pending wait for the earliest activation height.
        const activation = error.details?.serviceKeyRotationEffectiveHeight;
        rotating.set(target!, typeof activation === 'bigint' ? activation : undefined);
        const next = nextCandidate(target);
        if (next !== undefined) {
          target = next;
          refresh = false;
          continue;
        }
        const heights = [...rotating.values()];
        if (heights.some((h) => h === undefined)) throw error;
        const earliest = (heights as bigint[]).reduce((a, b) => (b < a ? b : a));
        let ready = false;
        for (let poll = 0; poll < policy.maxPolls; poll++) {
          if (await port.readHeight() >= earliest) { ready = true; break; }
          await sleep(policy.pollIntervalMs);
        }
        if (!ready) throw error;
        for (const [b, h] of rotating) if (h !== undefined && h <= earliest) rotating.delete(b);
        target = [...builders].find((b) => !rotating.has(b) && b === state.boundBuilder) ?? nextCandidate(undefined);
        refresh = true; // time has passed: fresh order context and envelope
      } else if ((error.category === 'transport' && error.retriable) || error.code === 'NEXUS_INGRESS_NO_CAPACITY' || error.code === 'NEXUS_CONNECT_DEADLINE_EXCEEDED') {
        const next = nextCandidate(target);
        if (!next) throw error;
        target = next;
        refresh = false;
      } else throw error;
    }
  }
  throw new TrueOpenError('NEXUS_INGRESS', 'NEXUS_INGRESS_RECOVERY_EXHAUSTED', 'Dispatch recovery budget exhausted; query Session before retrying', { cause: lastError, retriable: true });
}
