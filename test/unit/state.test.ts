import { describe, it, expect } from 'vitest';
import { reduce, initialState } from '../../src/state/local-state';
import type { LocalTaskState } from '../../src/state/local-state';
import { reconcile } from '../../src/state/reconcile';
import type { ChainTaskView } from '../../src/state/reconcile';

describe('reduce', () => {
  it('draft → submitted → in_progress', () => {
    let s: LocalTaskState = initialState();
    expect(s.kind).toBe('draft');
    s = reduce(s, { code: 'SUBMITTED', submitId: new Uint8Array([1]) });
    expect(s.kind).toBe('submitted');
    s = reduce(s, { code: 'PHASE', state: 'ASSIGNED', phase: 'ASSIGNMENT_FINALIZED' });
    expect(s.kind).toBe('in_progress');
    if (s.kind === 'in_progress') expect(s.state).toBe('ASSIGNED');
  });

  it('SETTLE event -> optimistic_finality', () => {
    let s: LocalTaskState = initialState();
    s = reduce(s, { code: 'SETTLED', verdict: 'PASS', challengeUntil: 100n, finality: 'PENDING' });
    expect(s.kind).toBe('optimistic_finality');
    if (s.kind === 'optimistic_finality') {
      expect(s.verdict).toBe('PASS');
      expect(s.challengeUntil).toBe(100n);
    }
  });
});

describe('reconcile', () => {
  it('on-chain state overrides local optimistic state', () => {
    const local: LocalTaskState = { kind: 'submitted', submitId: new Uint8Array([1]) };
    const chain: ChainTaskView = { state: 'VERIFYING', phase: 'OPEN_VERIFY' };
    const out = reconcile(local, chain);
    expect(out.kind).toBe('in_progress');
  });

  it('optimistic_finality_status is one-directional: OVERTURNED does not revert to CHALLENGED', () => {
    const local: LocalTaskState = {
      kind: 'optimistic_finality', verdict: 'PASS', challengeUntil: 100n, finality: 'OVERTURNED',
    };
    const chain: ChainTaskView = {
      state: 'SETTLED', phase: 'SETTLE', verdict: 'PASS', finality: 'CHALLENGED', challengeUntil: 100n,
    };
    const out = reconcile(local, chain);
    expect(out.kind).toBe('optimistic_finality');
    if (out.kind === 'optimistic_finality') expect(out.finality).toBe('OVERTURNED');
  });

  it('optimistic_finality_status absorbing state: local OVERTURNED is not overridden by on-chain FINAL', () => {
    const local: LocalTaskState = {
      kind: 'optimistic_finality', verdict: 'FAIL', challengeUntil: 100n, finality: 'OVERTURNED',
    };
    const chain: ChainTaskView = {
      state: 'SETTLED', phase: 'SETTLE', verdict: 'PASS', finality: 'FINAL', challengeUntil: 100n,
    };
    const out = reconcile(local, chain);
    expect(out.kind).toBe('optimistic_finality');
    if (out.kind === 'optimistic_finality') expect(out.finality).toBe('OVERTURNED');
  });

  it('FINAL on-chain state -> final', () => {
    const local: LocalTaskState = {
      kind: 'optimistic_finality', verdict: 'PASS', challengeUntil: 100n, finality: 'PENDING',
    };
    const chain: ChainTaskView = {
      state: 'SETTLED', phase: 'SETTLE', verdict: 'PASS', finality: 'FINAL', challengeUntil: 100n,
    };
    const out = reconcile(local, chain);
    expect(out.kind).toBe('final');
  });
});
