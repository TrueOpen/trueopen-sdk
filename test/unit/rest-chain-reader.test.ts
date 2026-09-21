import { describe, it, expect } from 'vitest';
import { RestChainReader } from '../../src/transport/rest-chain-reader';
import type { FetchLike, FetchResponse } from '../../src/transport/rest-chain-reader';
import { TrueOpenError } from '../../src/errors/errors';

function okJson(body: unknown): FetchResponse {
  return { ok: true, status: 200, json: async () => body };
}
function httpErr(status: number): FetchResponse {
  return { ok: false, status, json: async () => ({}) };
}
/** A fetch that records the last requested URL. */
function stubFetch(res: FetchResponse | ((url: string) => FetchResponse)): { fetch: FetchLike; lastUrl: () => string } {
  let last = '';
  const fetch: FetchLike = async (url) => {
    last = url;
    return typeof res === 'function' ? res(url) : res;
  };
  return { fetch, lastUrl: () => last };
}

/**
 * The real response body from node's gRPC-gateway, copied byte-for-byte from devnet
 * trueopen-localnet-1:
 *   GET http://rest.example:1317/TrueOpen/task/v1/session/845ae6e6…c72bbf8a
 *
 * Two shape differences that hand-written fixtures previously masked (both used to make
 * querySession throw CHAIN_QUERY_MALFORMED for every real session):
 *   - open_pending_count is a uint32 -> a bare JSON number, not a quoted string;
 *   - status is the full enum name SESSION_STATUS_IDLE, not the short name IDLE.
 */
const LIVE_SESSION = {
  session: {
    last_active_height: '71324',
    next_expected_sequence: '0',
    open_pending_count: 0,
    owner_user_address: 'trueopen1qp5c4zkm4q4efuqrwjaww8n5yvrht7fdvnp2mq',
    session_id: '845ae6e61c1219d496343a0cdaabab50c4ac2919343fc578d306462dc72bbf8a',
    status: 'SESSION_STATUS_IDLE',
  },
};

describe('RestChainReader', () => {
  it('querySession parses a real response body from a live chain', async () => {
    const { fetch, lastUrl } = stubFetch(okJson(LIVE_SESSION));
    const r = new RestChainReader({ baseUrl: 'http://localhost:1317/', fetch });
    const s = await r.querySession(LIVE_SESSION.session.session_id);
    expect(lastUrl()).toBe(
      `http://localhost:1317/TrueOpen/task/v1/session/${LIVE_SESSION.session.session_id}`,
    );
    expect(s.owner).toBe('trueopen1qp5c4zkm4q4efuqrwjaww8n5yvrht7fdvnp2mq');
    // A newly created session's first order sequence is 0, not 1.
    expect(s.nextExpectedSequence).toBe(0n);
    expect(s.openPendingCount).toBe(0n);
    expect(s.lastActiveHeight).toBe(71_324n);
    expect(s.status).toBe('IDLE');
  });

  it('querySession maps snake_case JSON and builds the URL correctly', async () => {
    const { fetch, lastUrl } = stubFetch(
      okJson({
        session: {
          session_id: 'sess-1',
          owner_user_address: 'trueopen1owner',
          next_expected_sequence: '7',
          last_active_height: '1234',
          open_pending_count: 2,
          status: 'SESSION_STATUS_ACTIVE',
        },
      }),
    );
    const r = new RestChainReader({ baseUrl: 'http://localhost:1317/', fetch });
    const s = await r.querySession('sess-1');
    expect(lastUrl()).toBe('http://localhost:1317/TrueOpen/task/v1/session/sess-1');
    expect(s.owner).toBe('trueopen1owner');
    expect(s.nextExpectedSequence).toBe(7n);
    expect(s.openPendingCount).toBe(2n);
    expect(s.status).toBe('ACTIVE');
  });

  it('integer fields accept both string and number forms (protojson only quotes 64-bit values)', async () => {
    const { fetch } = stubFetch(
      okJson({
        session: {
          session_id: 's', owner_user_address: 'o',
          next_expected_sequence: 3, last_active_height: '9', open_pending_count: '1',
          status: 'IDLE',
        },
      }),
    );
    const s = await new RestChainReader({ baseUrl: 'http://n', fetch }).querySession('s');
    expect(s.nextExpectedSequence).toBe(3n);
    expect(s.lastActiveHeight).toBe(9n);
    expect(s.openPendingCount).toBe(1n);
  });

  it('non-safe integers / negative numbers → CHAIN_QUERY_MALFORMED (no silent truncation)', async () => {
    for (const bad of [1.5, -1, Number.MAX_SAFE_INTEGER + 2]) {
      const { fetch } = stubFetch(
        okJson({
          session: {
            session_id: 's', owner_user_address: 'o',
            next_expected_sequence: bad, last_active_height: '0', open_pending_count: 0,
            status: 'IDLE',
          },
        }),
      );
      await expect(new RestChainReader({ baseUrl: 'http://n', fetch }).querySession('s'))
        .rejects.toMatchObject({ code: 'CHAIN_QUERY_MALFORMED' });
    }
  });

  it('querySession tolerates camelCase fields', async () => {
    const { fetch } = stubFetch(
      okJson({
        session: {
          sessionId: 'sess-2',
          ownerUserAddress: 'trueopen1o',
          nextExpectedSequence: '0',
          lastActiveHeight: '0',
          openPendingCount: '0',
          status: 'IDLE',
        },
      }),
    );
    const r = new RestChainReader({ baseUrl: 'http://n', fetch });
    const s = await r.querySession('sess-2');
    expect(s.sessionId).toBe('sess-2');
    expect(s.status).toBe('IDLE');
  });

  // A Task that has been admitted but not yet assigned carries no winner_worker:
  // protojson omits a string still at its default. Treating that as malformed made
  // every client polling for assignment fail on its first read.
  it('queryTask returns a pending snapshot when winner_worker is absent', async () => {
    const { fetch } = stubFetch(okJson({
      task: {
        active: {
          core: {
            accepted_task_hash: '22'.repeat(32),
            accepted_input_hash: '44'.repeat(32),
            receipt_status: 'RECEIPT_STATUS_NONE',
            assignment_status: 'ASSIGNMENT_STATUS_PENDING',
            model_id: 'model_1',
            profile_version: '1',
            order_sequence: '0',
          },
          assignment: { task_id: '11'.repeat(32) },
        },
      },
    }));
    const snap = await new RestChainReader({ baseUrl: 'http://rest.example:1317', fetch }).queryTask('11'.repeat(32));
    expect(snap.winnerWorker).toBe('');
    expect(snap.assignmentStatus).toBe('PENDING');
    expect(snap.taskId).toBe('11'.repeat(32));
  });

  it('queryTask still rejects a present winner_worker of the wrong type', async () => {
    const { fetch } = stubFetch(okJson({
      task: {
        active: {
          core: {
            accepted_task_hash: '22'.repeat(32),
            accepted_input_hash: '44'.repeat(32),
            receipt_status: 'RECEIPT_STATUS_NONE',
            assignment_status: 'ASSIGNMENT_STATUS_PENDING',
            model_id: 'model_1',
            profile_version: '1',
            order_sequence: '0',
          },
          assignment: { task_id: '11'.repeat(32), winner_worker: 42 },
        },
      },
    }));
    await expect(new RestChainReader({ baseUrl: 'http://rest.example:1317', fetch }).queryTask('11'.repeat(32)))
      .rejects.toMatchObject({ code: 'CHAIN_QUERY_MALFORMED' });
  });

  it('querySessionNonce', async () => {
    const { fetch, lastUrl } = stubFetch(okJson({ address: 'trueopen1o', next_session_nonce: '5' }));
    const r = new RestChainReader({ baseUrl: 'http://n', fetch });
    expect((await r.querySessionNonce('trueopen1o')).nextSessionNonce).toBe(5n);
    expect(lastUrl()).toBe('http://n/TrueOpen/task/v1/session_nonce/trueopen1o');
  });

  it('querySettlementFinality mapping (enum returns full name, prefix must be stripped)', async () => {
    const { fetch, lastUrl } = stubFetch(
      okJson({
        optimistic_finality_status: 'OPTIMISTIC_FINALITY_STATUS_CHALLENGED',
        challenge_close_height: '200',
        max_challenge_resolve_deadline_height: '250',
        task_finality_height: '0',
        claimable_after_height: '0',
        challenge_refs_hash: 'abc',
      }),
    );
    const r = new RestChainReader({ baseUrl: 'http://n', fetch });
    const f = await r.querySettlementFinality('s', 't');
    expect(lastUrl()).toBe('http://n/TrueOpen/task/v1/settlement_finality/s/t');
    expect(f.optimisticFinalityStatus).toBe('CHALLENGED');
    expect(f.challengeCloseHeight).toBe(200n);
    expect(f.maxChallengeResolveDeadlineHeight).toBe(250n);
  });

  it('404 → CHAIN_QUERY_NOT_FOUND (not retriable)', async () => {
    const { fetch } = stubFetch(httpErr(404));
    const r = new RestChainReader({ baseUrl: 'http://n', fetch });
    try {
      await r.querySession('missing');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TrueOpenError);
      expect((e as TrueOpenError).code).toBe('CHAIN_QUERY_NOT_FOUND');
      expect((e as TrueOpenError).retriable).toBe(false);
    }
  });

  it('5xx → retriable', async () => {
    const { fetch } = stubFetch(httpErr(503));
    const r = new RestChainReader({ baseUrl: 'http://n', fetch });
    try {
      await r.querySessionNonce('a');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as TrueOpenError).code).toBe('CHAIN_QUERY_HTTP_503');
      expect((e as TrueOpenError).retriable).toBe(true);
    }
  });

  it('network error → CHAIN_QUERY_UNAVAILABLE (retriable)', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const r = new RestChainReader({ baseUrl: 'http://n', fetch });
    try {
      await r.querySession('s');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as TrueOpenError).code).toBe('CHAIN_QUERY_UNAVAILABLE');
      expect((e as TrueOpenError).retriable).toBe(true);
    }
  });

  it('unknown status → CHAIN_QUERY_MALFORMED', async () => {
    const { fetch } = stubFetch(
      okJson({
        session: {
          session_id: 's', owner_user_address: 'o', next_expected_sequence: '0',
          last_active_height: '0', open_pending_count: 0, status: 'SESSION_STATUS_BOGUS',
        },
      }),
    );
    const r = new RestChainReader({ baseUrl: 'http://n', fetch });
    await expect(r.querySession('s')).rejects.toThrowError(TrueOpenError);
  });
});
