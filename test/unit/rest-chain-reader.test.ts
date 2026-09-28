import { describe, it, expect } from 'vitest';
import { RestChainReader } from '../../src/transport/rest-chain-reader';
import type { FetchLike, FetchResponse } from '../../src/transport/rest-chain-reader';
import { TrueOpenError } from '../../src/errors/errors';
import { bytesToBase64 } from '../../src/codec/wire';
import { fromHex } from '../../src/util/bytes';

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

  /**
   * A pending Task in the shape the gateway actually sends. `core` is
   * `(gogoproto.nullable) = false` so it is always present; `assignment` is
   * nullable and appears only once the Task entered assignment, so the caller
   * picks which pending shape to build.
   *
   * Note every implicit-presence field is spelled out even at its zero value:
   * the REST gateway runs with EmitDefaults, so those are sent, and a fixture
   * that omitted them would be testing a response the chain never produces.
   */
  const TASK_ID = '11'.repeat(32);
  // model_id is `bytes` with REST_BYTES_ENCODING_HASH32_LOWER_HEX as of TaskOrderV3
  // (wire proto/task/v1/assignment.proto), so the gateway sends 64-hex, not a text slug.
  const MODEL_ID = '33'.repeat(32);
  const pendingTask = (assignment: unknown) => ({
    task: {
      active: {
        core: {
          accepted_task_hash: '22'.repeat(32),
          accepted_input_hash: '44'.repeat(32),
          receipt_status: 'RECEIPT_STATUS_NONE',
          assignment_status: 'ASSIGNMENT_STATUS_PENDING',
          model_id: MODEL_ID,
          profile_version: '1',
          order_sequence: '0',
        },
        assignment,
      },
    },
  });
  const readTask = (body: unknown) =>
    new RestChainReader({ baseUrl: 'http://rest.example:1317', fetch: stubFetch(okJson(body)).fetch }).queryTask(TASK_ID);

  // Pending shape 1: the Task has not entered assignment, so the whole view is
  // null. This is the state every poll right after submitOrder observes, and
  // treating it as malformed failed the first read of every task.
  it('queryTask returns a pending snapshot before the Task entered assignment', async () => {
    const snap = await readTask(pendingTask(null));
    expect(snap.winnerWorker).toBe('');
    expect(snap.assignmentStatus).toBe('PENDING');
    // task_id lives on the absent assignment view; it falls back to the queried id.
    expect(snap.taskId).toBe(TASK_ID);
    expect(snap.orderSequence).toBe(0n);
    // Decoded through the same Hash32 path hub.v1 uses, so the two readers' model ids
    // are comparable.
    expect(snap.modelId).toBe(MODEL_ID);
  });

  it('queryTask accepts the base64 form of model_id and normalizes it to hex', async () => {
    const b64 = bytesToBase64(fromHex(MODEL_ID));
    const body = pendingTask(null);
    (body.task.active.core as { model_id: string }).model_id = b64;
    expect((await readTask(body)).modelId).toBe(MODEL_ID);
  });

  it('queryTask rejects a model_id that is neither hex nor a 32-byte base64 value', async () => {
    const body = pendingTask(null);
    (body.task.active.core as { model_id: string }).model_id = 'llama3_8b';
    await expect(readTask(body)).rejects.toThrow(/malformed field model_id/);
  });

  // Pending shape 2: assignment exists, but no winner has been drawn.
  // winner_worker is `optional` in the contract, so explicit presence -- not
  // the zero value -- is what keeps it out of the response.
  it('queryTask returns a pending snapshot when winner_worker is absent', async () => {
    const snap = await readTask(pendingTask({ task_id: TASK_ID }));
    expect(snap.winnerWorker).toBe('');
    expect(snap.assignmentStatus).toBe('PENDING');
    expect(snap.taskId).toBe(TASK_ID);
  });

  // After cleanup compaction the chain answers with the terminal arm of
  // TaskViewV1 (TaskTerminalSummaryState). It must map, not throw.
  it('queryTask maps the terminal arm of a compacted task', async () => {
    const snap = await readTask({
      task: {
        terminal: {
          task_id: TASK_ID,
          session_id: '33'.repeat(32),
          order_sequence: '4',
          task_hash: '22'.repeat(32),
          terminal_phase: 'TASK_PHASE_SETTLED',
          model_id: '55'.repeat(32),
          profile_version: 2,
          winner_worker: 'trueopen1worker',
        },
      },
    });
    expect(snap).toMatchObject({
      view: 'terminal',
      terminalPhase: 'SETTLED',
      taskId: TASK_ID,
      acceptedTaskHash: '22'.repeat(32),
      winnerWorker: 'trueopen1worker',
      modelId: '55'.repeat(32),
      profileVersion: 2n,
      orderSequence: 4n,
    });
    // The summary carries none of these. Reporting "" would read, to a caller written
    // against the active arm, as a real empty input hash and a task with no receipt.
    expect(snap.acceptedInputHash).toBeUndefined();
    expect(snap.receiptStatus).toBeUndefined();
    expect(snap.assignmentStatus).toBeUndefined();
  });

  it('queryTask maps a terminal task that never had a winner', async () => {
    const snap = await readTask({
      task: {
        terminal: {
          task_id: TASK_ID, order_sequence: '0', task_hash: '22'.repeat(32),
          terminal_phase: 'TASK_PHASE_FAILED', model_id: '55'.repeat(32), profile_version: 1,
        },
      },
    });
    expect(snap).toMatchObject({ view: 'terminal', winnerWorker: '', terminalPhase: 'FAILED' });
  });

  it('queryTask reports the active arm with all three fields present', async () => {
    const snap = await readTask(pendingTask(null));
    expect(snap.view).toBe('active');
    expect(snap.acceptedInputHash).toBe('44'.repeat(32));
    expect(snap.receiptStatus).toBe('NONE');
    expect(snap.assignmentStatus).toBe('PENDING');
  });

  it('queryTask decodes the terminal arm model_id as a Hash32 too', async () => {
    const terminal = {
      task_id: TASK_ID, order_sequence: '0', task_hash: '22'.repeat(32),
      terminal_phase: 'TASK_PHASE_SETTLED', model_id: bytesToBase64(fromHex(MODEL_ID)), profile_version: 1,
    };
    expect((await readTask({ task: { terminal } })).modelId).toBe(MODEL_ID);
  });

  it('queryTask reports the active arm', async () => {
    expect((await readTask(pendingTask(null))).view).toBe('active');
  });

  it('queryTask rejects a view with neither arm', async () => {
    await expect(readTask({ task: {} })).rejects.toMatchObject({ code: 'CHAIN_QUERY_MALFORMED' });
  });

  it('queryTask still rejects a present winner_worker of the wrong type', async () => {
    await expect(readTask(pendingTask({ task_id: TASK_ID, winner_worker: 42 })))
      .rejects.toMatchObject({ code: 'CHAIN_QUERY_MALFORMED' });
  });

  // Absent is pending; a present assignment of the wrong type is a broken
  // response and must not be softened into one.
  it('queryTask still rejects an assignment of the wrong type', async () => {
    await expect(readTask(pendingTask('not-an-object')))
      .rejects.toMatchObject({ code: 'CHAIN_QUERY_MALFORMED' });
  });

  it('querySessionNonce', async () => {
    const { fetch, lastUrl } = stubFetch(okJson({ address: 'trueopen1o', next_session_nonce: '5' }));
    const r = new RestChainReader({ baseUrl: 'http://n', fetch });
    expect((await r.querySessionNonce('trueopen1o')).nextSessionNonce).toBe(5n);
    expect(lastUrl()).toBe('http://n/TrueOpen/task/v1/session_nonce/trueopen1o');
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
