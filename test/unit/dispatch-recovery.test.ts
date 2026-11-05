import { expect, it } from 'vitest';
import { recoverDispatch, type DispatchRecoveryPort } from '../../src/transport/dispatch-recovery';
import { TrueOpenError } from '../../src/errors/errors';
import type { StreamStateView } from '../../src/types/node';
const policy = { maxAttempts: 4, maxPolls: 3, pollIntervalMs: 0, sleep: async () => {} };
const state: StreamStateView = { sessionId: 's', owner: 'u', nextExpectedSequence: 2n, lastActiveHeight: 0n, openPendingCount: 0n, status: 'ACTIVE', boundBuilder: 'a', sessionKeyExpiryHeight: 0n, sessionKeySpendCap: '0', sessionKeySpent: '0', sessionKeySetHeight: 0n };
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

it('uses a recorded-task redirect despite a lagging Session reader and never dispatches twice', async () => {
  const taskId = `0x${'12'.repeat(32)}`;
  let submits = 0, reads = 0;
  const result = await recoverDispatch(port({ taskId,
    submit: async () => { submits++; throw new TrueOpenError('NEXUS_INGRESS', 'NEXUS_INGRESS_SESSION_BOUND_ELSEWHERE', 'moved', { details: { taskId, boundBuilder: 'b' } }); },
    recorded: async (builder, id) => {
      expect([builder, id]).toEqual(['b', taskId]);
      if (++reads === 1) throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_NOT_FOUND', 'reader behind');
      return { ...ack, taskId, status: 4, boundBuilder: builder };
    },
  }), policy);
  expect(result.status).toBe(4);
  expect(submits).toBe(1);
  expect(reads).toBe(2);
});

it('keeps a redirected recorded task pending when QueryTask has not caught up', async () => {
  const taskId = `0x${'12'.repeat(32)}`;
  let submits = 0;
  await expect(recoverDispatch(port({ taskId,
    submit: async () => { submits++; throw new TrueOpenError('NEXUS_INGRESS', 'NEXUS_INGRESS_SESSION_BOUND_ELSEWHERE', 'moved', { details: { taskId, boundBuilder: 'b' } }); },
    recorded: async () => { throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_NOT_FOUND', 'behind'); },
  }), policy)).rejects.toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_PENDING', details: { boundBuilder: 'b', taskId } });
  expect(submits).toBe(1);
});

it('honors the takeover detail activation height while Session state is lagging', async () => {
  let height = 10n;
  const calls: [string, bigint][] = [];
  await recoverDispatch(port({ readHeight: async () => height,
    submit: async builder => { calls.push([builder, height]); if (calls.length === 1) throw new TrueOpenError('NEXUS_INGRESS', 'NEXUS_INGRESS_TAKEOVER_PENDING', 'wait', { details: { boundBuilder: 'b', takeoverActivationHeight: 12n } }); return ack; },
  }), { ...policy, sleep: async () => { height++; } });
  expect(calls).toEqual([['a', 10n], ['b', 12n]]);
});

it('a pending takeover detail never permits early dispatch or a third candidate', async () => {
  const calls: string[] = [];
  const error = new TrueOpenError('NEXUS_INGRESS', 'NEXUS_INGRESS_TAKEOVER_PENDING', 'wait', { details: { boundBuilder: 'b', takeoverActivationHeight: 20n } });
  await expect(recoverDispatch(port({ submit: async b => { calls.push(b); throw error; } }), policy)).rejects.toBe(error);
  expect(calls).toEqual(['a']);
});

it('rejects redirects to a different task or an operator outside the snapshot', async () => {
  const taskId = `0x${'12'.repeat(32)}`;
  for (const details of [{ boundBuilder: 'b', taskId: `0x${'34'.repeat(32)}` }, { boundBuilder: 'outside', taskId }]) {
    let calls = 0;
    await expect(recoverDispatch(port({ taskId, submit: async () => { calls++; throw new TrueOpenError('NEXUS_INGRESS', 'NEXUS_INGRESS_SESSION_BOUND_ELSEWHERE', 'moved', { details }); } }), policy)).rejects.toMatchObject({ code: details.boundBuilder === 'outside' ? 'SDK_LOCAL_BUILDER_NOT_IN_SNAPSHOT' : 'DATA_TASK_SEQUENCE_MISMATCH' });
    expect(calls).toBe(1);
  }
});

it('uses the bound Builder hint for redirection when the chain Session view has not changed', async () => {
  const calls: string[] = [];
  await recoverDispatch(port({ submit: async builder => { calls.push(builder); if (calls.length === 1) throw new TrueOpenError('NEXUS_INGRESS', 'NEXUS_INGRESS_SESSION_BOUND_ELSEWHERE', 'moved', { details: { boundBuilder: 'b' } }); return ack; } }), policy);
  expect(calls).toEqual(['a', 'b']);
});

const rotating = (h?: bigint) => new TrueOpenError('NEXUS_INGRESS', 'NEXUS_INGRESS_BUILDER_KEY_ROTATING', 'key rotating', {
  category: 'capacity', retriable: true, ...(h === undefined ? {} : { details: { serviceKeyRotationEffectiveHeight: h } }),
});

it('routes new work past a Builder whose service key is rotating (wire #49)', async () => {
  const calls: [string, boolean][] = [];
  await recoverDispatch(port({ submit: async (b, refresh) => {
    calls.push([b, refresh]);
    if (b === 'a') throw rotating(20n);
    return ack;
  } }), policy);
  expect(calls).toEqual([['a', false], ['b', false]]);
});

it('skips every rotating Builder, and waits for the earliest activation when all are pending', async () => {
  let height = 10n;
  const calls: [string, boolean][] = [];
  await recoverDispatch(port({
    readHeight: async () => height,
    submit: async (b, refresh) => {
      calls.push([b, refresh]);
      if (calls.length <= 3) {
        if (b === 'c') height = 15n; // the chain advances while the last Builder answers
        throw rotating(b === 'b' ? 15n : 30n);
      }
      return ack;
    },
  }), { ...policy, maxAttempts: 5 });
  // a, b, c all rotating; the earliest activation is b's at 15, reached: retry there, re-signed.
  expect(calls).toEqual([['a', false], ['b', false], ['c', false], ['b', true]]);
});

it('gives up when every Builder is rotating and one gave no activation height', async () => {
  const error = rotating();
  await expect(recoverDispatch(port({ submit: async (b) => { if (b === 'a') throw rotating(20n); throw error; } }), policy)).rejects.toBe(error);
});

it('gives up when the earliest activation is not reached within the poll budget', async () => {
  const calls: string[] = [];
  await expect(recoverDispatch(port({ submit: async (b) => { calls.push(b); throw rotating(99n); } }), { ...policy, maxAttempts: 6 }))
    .rejects.toMatchObject({ code: 'NEXUS_INGRESS_BUILDER_KEY_ROTATING' });
  expect(calls).toEqual(['a', 'b', 'c']);
});
