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
  readonly orderSequence: bigint;
  readonly builders: readonly string[];
  refreshBuilders?(): Promise<readonly string[]>;
  readSession(): Promise<StreamStateView>;
  readHeight(): Promise<bigint>;
  submit(builder: string, refreshOrder: boolean): Promise<OpenTaskAck>;
  /** Resolve the already admitted task without dispatching it again. */
  recorded(builder: string): Promise<OpenTaskAck>;
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
        const current = await port.readSession();
        target = current.boundBuilder;
        refresh = true;
      } else if (error.code === 'NEXUS_INGRESS_TAKEOVER_PENDING') {
        target = undefined;
        await sleep(policy.pollIntervalMs);
      } else if ((error.category === 'transport' && error.retriable) || error.code === 'NEXUS_INGRESS_NO_CAPACITY' || error.code === 'NEXUS_CONNECT_DEADLINE_EXCEEDED') {
        const next = builders[(builders.indexOf(target!) + 1) % builders.length];
        if (!next || next === target) throw error;
        target = next;
        refresh = false;
      } else throw error;
    }
  }
  throw new TrueOpenError('NEXUS_INGRESS', 'NEXUS_INGRESS_RECOVERY_EXHAUSTED', 'Dispatch recovery budget exhausted; query Session before retrying', { cause: lastError, retriable: true });
}
