import { describe, it, expect } from 'vitest';
import { RestChainReader, withQueryRetry, DEFAULT_QUERY_RETRY } from '../../src/transport/rest-chain-reader';
import type { FetchLike, FetchResponse, QueryRetryPolicy } from '../../src/transport/rest-chain-reader';
import { HubReader } from '../../src/transport/hub-reader';
import { TrueOpenError } from '../../src/errors/errors';

/**
 * The failure this exists for, reproduced from a live run: undici hands back a
 * pooled keep-alive socket the server has already closed, fetch() rejects with
 * `SocketError: other side closed` before a single byte is read, and the whole
 * e2e died on it -- twice in three runs, both times inside resolveTaskOrderContext.
 * A second dial succeeds immediately, so one retry is the entire fix.
 */
const socketClosed = (): Error => {
  const e = new Error('other side closed');
  (e as Error & { code?: string }).code = 'UND_ERR_SOCKET';
  return e;
};

const okJson = (body: unknown): FetchResponse => ({ ok: true, status: 200, json: async () => body });
const httpErr = (status: number): FetchResponse => ({ ok: false, status, json: async () => ({}) });

/** A fetch scripted per call, so a test can say "fail, fail, then succeed". */
function scriptedFetch(steps: Array<FetchResponse | (() => never)>): { fetch: FetchLike; calls: () => number } {
  let i = 0;
  const fetch: FetchLike = async () => {
    const step = steps[Math.min(i, steps.length - 1)]!;
    i++;
    if (typeof step === 'function') step();
    return step as FetchResponse;
  };
  return { fetch, calls: () => i };
}

/** No real waiting, but record what the backoff would have been. */
function fakeClock(): { policy: Partial<QueryRetryPolicy>; delays: number[] } {
  const delays: number[] = [];
  return {
    policy: { sleep: async (ms: number) => { delays.push(ms); } },
    delays,
  };
}

const SESSION = {
  session: {
    session_id: 'aa'.repeat(32), owner_user_address: 'trueopen1u', next_expected_sequence: '0',
    last_active_height: '10', open_pending_count: 0, status: 'SESSION_STATUS_IDLE',
  },
};

describe('withQueryRetry', () => {
  it('retries a retriable failure and returns the first success', async () => {
    let n = 0;
    const clock = fakeClock();
    const out = await withQueryRetry({ ...DEFAULT_QUERY_RETRY, ...clock.policy }, async () => {
      n++;
      if (n < 3) throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_UNAVAILABLE', 'boom', { retriable: true });
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(n).toBe(3);
    // Exponential, starting at baseDelayMs.
    expect(clock.delays).toEqual([200, 400]);
  });

  it('does not retry a non-retriable failure', async () => {
    let n = 0;
    const clock = fakeClock();
    await expect(withQueryRetry({ ...DEFAULT_QUERY_RETRY, ...clock.policy }, async () => {
      n++;
      throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_NOT_FOUND', 'nope', { retriable: false });
    })).rejects.toMatchObject({ code: 'CHAIN_QUERY_NOT_FOUND' });
    expect(n).toBe(1);
    expect(clock.delays).toEqual([]);
  });

  it('rethrows the original error once attempts run out, cause chain intact', async () => {
    const clock = fakeClock();
    const cause = socketClosed();
    const err = await withQueryRetry({ ...DEFAULT_QUERY_RETRY, ...clock.policy }, async () => {
      throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_UNAVAILABLE', 'boom', { retriable: true, cause });
    }).then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
    expect((err as TrueOpenError).code).toBe('CHAIN_QUERY_UNAVAILABLE');
    // Not wrapped in a "retries exhausted" error: the caller still sees the real one.
    expect((err as Error).cause).toBe(cause);
    expect(clock.delays).toEqual([200, 400]);
  });

  it('attempts: 1 disables retrying', async () => {
    let n = 0;
    await expect(withQueryRetry({ attempts: 1, baseDelayMs: 200 }, async () => {
      n++;
      throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_UNAVAILABLE', 'boom', { retriable: true });
    })).rejects.toBeInstanceOf(TrueOpenError);
    expect(n).toBe(1);
  });

  it('a non-TrueOpenError is never retried -- retriability is not guessed', async () => {
    let n = 0;
    await expect(withQueryRetry(DEFAULT_QUERY_RETRY, async () => {
      n++;
      throw new TypeError('programmer error');
    })).rejects.toBeInstanceOf(TypeError);
    expect(n).toBe(1);
  });
});

describe('RestChainReader retries reads', () => {
  it('survives a dropped keep-alive socket on the first dial', async () => {
    const clock = fakeClock();
    const { fetch, calls } = scriptedFetch([() => { throw socketClosed(); }, okJson(SESSION)]);
    const r = new RestChainReader({ baseUrl: 'http://n:1317', fetch, retry: clock.policy });
    const s = await r.querySession('aa'.repeat(32));
    expect(s.status).toBe('IDLE');
    expect(calls()).toBe(2);
  });

  it('retries a 5xx but not a 404', async () => {
    const clock = fakeClock();
    const a = scriptedFetch([httpErr(503), okJson(SESSION)]);
    await expect(new RestChainReader({ baseUrl: 'http://n:1317', fetch: a.fetch, retry: clock.policy })
      .querySession('aa'.repeat(32))).resolves.toBeDefined();
    expect(a.calls()).toBe(2);

    const b = scriptedFetch([httpErr(404)]);
    await expect(new RestChainReader({ baseUrl: 'http://n:1317', fetch: b.fetch, retry: clock.policy })
      .querySession('aa'.repeat(32))).rejects.toMatchObject({ code: 'CHAIN_QUERY_NOT_FOUND' });
    expect(b.calls()).toBe(1);
  });

  it('retries a body that dies mid-read, and gives up on a malformed one', async () => {
    const clock = fakeClock();
    const truncated: FetchResponse = { ok: true, status: 200, json: async () => { throw socketClosed(); } };
    const a = scriptedFetch([truncated, okJson(SESSION)]);
    await expect(new RestChainReader({ baseUrl: 'http://n:1317', fetch: a.fetch, retry: clock.policy })
      .querySession('aa'.repeat(32))).resolves.toBeDefined();
    expect(a.calls()).toBe(2);

    // A body that parses but is not an object is the server's answer, not a blip.
    const b = scriptedFetch([okJson('a string')]);
    await expect(new RestChainReader({ baseUrl: 'http://n:1317', fetch: b.fetch, retry: clock.policy })
      .querySession('aa'.repeat(32))).rejects.toMatchObject({ code: 'CHAIN_QUERY_MALFORMED' });
    expect(b.calls()).toBe(1);
  });
});

describe('HubReader retries reads', () => {
  // getParameterBucket and getBeacon are where the live runs actually died.
  it('survives a dropped socket on getParameterBucket', async () => {
    const clock = fakeClock();
    const body = {
      bucket: { bucket_kind: 'BUCKET_KIND_TIMEOUT', bucket_key: 'default', version: '1', effective_height: '0' },
      current_version: '1',
    };
    const { fetch, calls } = scriptedFetch([() => { throw socketClosed(); }, okJson(body)]);
    const hub = new HubReader({ baseUrl: 'http://n:1317', fetch, retry: clock.policy });
    const b = await hub.getParameterBucket('BUCKET_KIND_TIMEOUT');
    expect(b.currentVersion).toBe(1n);
    expect(calls()).toBe(2);
  });

  it('gives up after the configured number of attempts', async () => {
    const clock = fakeClock();
    const { fetch, calls } = scriptedFetch([() => { throw socketClosed(); }]);
    const hub = new HubReader({ baseUrl: 'http://n:1317', fetch, retry: { ...clock.policy, attempts: 4 } });
    await expect(hub.listBuilders()).rejects.toMatchObject({ code: 'CHAIN_QUERY_UNAVAILABLE' });
    expect(calls()).toBe(4);
    expect(clock.delays).toEqual([200, 400, 800]);
  });
});
