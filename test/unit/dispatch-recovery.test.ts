import { expect, it } from 'vitest';
import { recoverDispatch, type DispatchRecoveryPort } from '../../src/transport/dispatch-recovery';
import { TrueOpenError } from '../../src/errors/errors';
import type { StreamStateView } from '../../src/types/node';
const policy = { maxAttempts: 4, maxPolls: 3, pollIntervalMs: 0, sleep: async () => {} };
const state: StreamStateView = { sessionId: 's', owner: 'u', nextExpectedSequence: 2n, lastActiveHeight: 0n, openPendingCount: 0n, status: 'ACTIVE', boundBuilder: 'a' };
const ack = { sessionId: 's', taskId: 't', accepted: true, reason: '', status: 3 };
function port(overrides: Partial<DispatchRecoveryPort> = {}): DispatchRecoveryPort {
  return { orderSequence: 2n, builders: ['a', 'b', 'c'], readSession: async () => state, readHeight: async () => 10n, submit: async () => ack, recorded: async () => ({ ...ack, status: 4 }), ...overrides };
}
it('does not submit consumed or future sequences', async () => {
  let calls = 0;
  expect((await recoverDispatch(port({ readSession: async () => ({ ...state, nextExpectedSequence: 3n }), submit: async () => { calls++; return ack; } }), policy)).status).toBe(4);
  expect(calls).toBe(0);
  await expect(recoverDispatch(port({ orderSequence: 3n }), policy)).rejects.toMatchObject({ code: 'SDK_LOCAL_SEQUENCE_GAP' });
});
it('retries readiness on the same Builder and refreshes the signed context', async () => {
  const calls: unknown[] = [];
  await recoverDispatch(port({ submit: async (b, refresh) => {
    calls.push([b, refresh]);
    if (calls.length === 1) throw new TrueOpenError('NEXUS_INGRESS', 'NEXUS_INGRESS_DISPATCH_NOT_READY', 'wait', { details: { dispatchAvailableHeight: 10n } });
    return ack;
  } }), policy);
  expect(calls).toEqual([['a', false], ['a', true]]);
});
it('moves to a candidate only after transport failure, then waits for chain activation', async () => {
  let stage = 0, reads = 0;
  const calls: string[] = [];
  await recoverDispatch(port({
    readSession: async () => {
      if (stage === 2 && reads++ < 2) return { ...state, pendingTakeover: { candidateBuilder: 'b', orderSequence: 2n, orderTaskHash: 'h', registeredHeight: 9n, activationHeight: 12n } };
      if (stage === 2) return { ...state, boundBuilder: 'b' };
      return state;
    },
    submit: async b => {
      calls.push(b);
      if (stage++ === 0) throw new TrueOpenError('NEXUS_INGRESS', 'NEXUS_TRANSPORT_FAILED', 'disconnect', { category: 'transport', retriable: true });
      if (stage === 2) return { ...ack, status: 2, takeoverActivationHeight: 12n };
      return ack;
    },
  }), policy);
  expect(calls).toEqual(['a', 'b', 'b']);
});
it('does not contact a third Builder while takeover remains pending', async () => {
  const calls: string[] = [];
  await expect(recoverDispatch(port({
    readSession: async () => ({ ...state, pendingTakeover: { candidateBuilder: 'b', orderSequence: 2n, orderTaskHash: 'h', registeredHeight: 9n, activationHeight: 12n } }),
    submit: async b => { calls.push(b); return ack; },
  }), policy)).rejects.toMatchObject({ code: 'NEXUS_INGRESS_TAKEOVER_PENDING' });
  expect(calls).toEqual([]);
});
it('does not switch on signature failure or close registration', async () => {
  const error = new TrueOpenError('SDK_AUTH', 'SDK_AUTH_INVALID_SIGNATURE', 'bad', { category: 'auth' });
  await expect(recoverDispatch(port({ submit: async () => { throw error; } }), policy)).rejects.toBe(error);
  await expect(recoverDispatch(port({ readSession: async () => ({ ...state, pendingWithdrawKind: 'CLOSE' }) }), policy)).rejects.toMatchObject({ code: 'SDK_LOCAL_SESSION_CLOSING' });
});

it('does not resume dispatch after Session close becomes effective during takeover polling', async () => {
  let reads = 0, submits = 0;
  await expect(recoverDispatch(port({ readSession: async () => ++reads === 1 ? { ...state, pendingTakeover: { candidateBuilder: 'b', orderSequence: 2n, orderTaskHash: 'h', registeredHeight: 9n, activationHeight: 12n } } : { ...state, status: 'CLOSED' }, submit: async () => { submits++; return ack; } }), policy)).rejects.toMatchObject({ code: 'SDK_LOCAL_SESSION_CLOSING' });
  expect(submits).toBe(0);
});
it('an aborted recovery sends no requests', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(recoverDispatch(port(), { ...policy, signal: controller.signal })).rejects.toMatchObject({ code: 'SDK_LOCAL_ABORTED' });
});
it('a stale BuilderSet refresh retries the same sequence against the new snapshot', async () => {
  const calls: string[] = [];
  await recoverDispatch(port({ refreshBuilders: async () => ['d', 'e'], submit: async b => { calls.push(b); if (calls.length === 1) throw new TrueOpenError('NEXUS_INGRESS', 'NEXUS_INGRESS_BUILDER_SET_STALE', 'stale'); return ack; } }), policy);
  expect(calls).toEqual(['a', 'd']);
});
