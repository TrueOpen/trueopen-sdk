import { describe, it, expect } from 'vitest';
import { SessionManager } from '../../src/session/session-manager';
import { MockChainClient } from '../helpers/mock-chain-client';

describe('SessionManager', () => {
  it('create caches and returns a handle', async () => {
    const chain = new MockChainClient();
    const sm = new SessionManager(chain);
    const h = await sm.create('my-label');
    expect(h.sessionId).toBe('sess-1');
    expect(h.owner).toBe('trueopen1owner');
    expect(h.nextExpectedSequence).toBe(0n);
    expect(h.label).toBe('my-label');
    // Cache hit -- no chain query needed.
    expect((await sm.get('sess-1')).sessionId).toBe('sess-1');
  });

  it("rebuild overwrites the cache from the chain's StreamState", async () => {
    const chain = new MockChainClient();
    const sm = new SessionManager(chain);
    await sm.create();
    chain.sessions.set('sess-1', {
      sessionId: 'sess-1', owner: 'trueopen1owner', nextExpectedSequence: 5n,
      lastActiveHeight: 99n, openPendingCount: 2n, status: 'ACTIVE',
    });
    const h = await sm.rebuild('sess-1');
    expect(h.nextExpectedSequence).toBe(5n);
  });

  it('get falls back to rebuild when the cache is missing', async () => {
    const chain = new MockChainClient();
    chain.sessions.set('sess-x', {
      sessionId: 'sess-x', owner: 'trueopen1o', nextExpectedSequence: 1n,
      lastActiveHeight: 1n, openPendingCount: 0n, status: 'IDLE',
    });
    const sm = new SessionManager(chain);
    const h = await sm.get('sess-x');
    expect(h.status).toBe('IDLE');
    expect(h.nextExpectedSequence).toBe(1n);
  });
});
