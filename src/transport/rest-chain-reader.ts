import { stringToU64 } from '../codec/wire';
import { TrueOpenError } from '../errors/errors';
import type { ChainReader } from './chain-client';
import type { StreamStateView, SettlementFinalityView, ChainTaskSnapshot, InferReceiptView } from '../types/node';
import type { OptimisticFinalityStatus } from '../types/challenge';

/** Minimal fetch abstraction, portable across runtimes and easy to mock. */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (url: string) => Promise<FetchResponse>;

export interface RestChainReaderOptions {
  /** gRPC-gateway REST root, e.g. http://localhost:1317 */
  readonly baseUrl: string;
  readonly fetch: FetchLike;
}

const SESSION_STATUS = new Set(['ACTIVE', 'IDLE', 'CLOSED']);
const FINALITY_STATUS = new Set(['PENDING', 'CHALLENGED', 'FINAL', 'OVERTURNED']);

/**
 * Reads the chain via the node's gRPC-gateway REST/JSON API (task.v1.Query).
 *
 * Two quirks of the actual protojson shape have to be accounted for (verified
 * against a live devnet, not assumed):
 *   1. **Only uint64/int64 are quoted**. uint32 fields (e.g.
 *      open_pending_count) still arrive as a bare JSON number, so every
 *      numeric field goes through u64Field, which accepts both string and
 *      number.
 *   2. **Enums come back with their full name**, e.g. `SESSION_STATUS_IDLE` /
 *      `OPTIMISTIC_FINALITY_STATUS_FINAL`, not the bare short name, so enum
 *      fields go through enumField, which strips the proto prefix first.
 * Field names are tolerant of both forms: snake_case (the gateway default) is
 * tried first, falling back to camelCase (the proto3 JSON default).
 */
export class RestChainReader implements ChainReader {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;

  constructor(opts: RestChainReaderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetch = opts.fetch;
  }

  async querySession(sessionId: string): Promise<StreamStateView> {
    const body = await this.getJson(`/TrueOpen/task/v1/session/${encodeURIComponent(sessionId)}`);
    const s = body['session'];
    if (typeof s !== 'object' || s === null) throw malformed('session object');
    return toStreamState(s as Record<string, unknown>);
  }

  async querySessionNonce(address: string): Promise<{ nextSessionNonce: bigint }> {
    const body = await this.getJson(`/TrueOpen/task/v1/session_nonce/${encodeURIComponent(address)}`);
    return { nextSessionNonce: u64Field(body, 'next_session_nonce') };
  }

  async querySettlementFinality(sessionId: string, taskId: string): Promise<SettlementFinalityView> {
    const body = await this.getJson(
      `/TrueOpen/task/v1/settlement_finality/${encodeURIComponent(sessionId)}/${encodeURIComponent(taskId)}`,
    );
    const status = enumField(body, 'optimistic_finality_status', 'OPTIMISTIC_FINALITY_STATUS_');
    if (!FINALITY_STATUS.has(status)) {
      throw malformed(`optimistic_finality_status=${status}`);
    }
    return {
      optimisticFinalityStatus: status as OptimisticFinalityStatus,
      challengeCloseHeight: u64Field(body, 'challenge_close_height'),
      maxChallengeResolveDeadlineHeight: u64Field(body, 'max_challenge_resolve_deadline_height'),
      taskFinalityHeight: u64Field(body, 'task_finality_height'),
      claimableAfterHeight: u64Field(body, 'claimable_after_height'),
    };
  }

  /**
   * On-chain task snapshot. Must be read before retrieval to get
   * accepted_task_hash and winner_worker -- the former is the first field of
   * TaskDataObjectRefV1, and the latter determines whose signature the
   * streamed frames should be verified against.
   *
   * winnerWorker is "" while the assignment is still pending. That is a state
   * to poll on, not a malformed response, so callers wait for it rather than
   * failing on the first read.
   */
  async queryTask(taskId: string): Promise<ChainTaskSnapshot> {
    const body = await this.getJson(`/TrueOpen/task/v1/task/${encodeURIComponent(taskId)}`);
    const active = obj(obj(body, 'task'), 'active');
    const core = obj(active, 'core');
    const assignment = obj(active, 'assignment');
    return {
      taskId: field(assignment, 'task_id'),
      acceptedTaskHash: field(core, 'accepted_task_hash'),
      acceptedInputHash: field(core, 'accepted_input_hash'),
      // Absent until a Worker is assigned: protojson omits a string still at
      // its default, so a pending Task carries no winner_worker at all.
      winnerWorker: pendingField(assignment, 'winner_worker'),
      receiptStatus: enumField(core, 'receipt_status', 'RECEIPT_STATUS_'),
      assignmentStatus: enumField(core, 'assignment_status', 'ASSIGNMENT_STATUS_'),
      modelId: field(core, 'model_id'),
      profileVersion: u64Field(core, 'profile_version'),
      orderSequence: u64Field(core, 'order_sequence'),
    };
  }

  /**
   * On-chain InferReceipt. When the Worker hasn't submitted yet, the chain
   * returns "infer receipt not found", which is translated to undefined here
   * -- "not yet available" and "query failed" are different things, and
   * callers typically need to poll.
   */
  async queryInferReceipt(taskId: string): Promise<InferReceiptView | undefined> {
    let body: Record<string, unknown>;
    try {
      body = await this.getJson(`/TrueOpen/task/v1/task/${encodeURIComponent(taskId)}/infer_receipt`);
    } catch (e) {
      if (e instanceof TrueOpenError && e.code === 'CHAIN_QUERY_NOT_FOUND') return undefined;
      throw e;
    }
    const r = obj(body, 'receipt');
    return {
      taskId: field(r, 'task_id'),
      winnerWorker: field(r, 'winner_worker'),
      inferReceiptHash: field(r, 'infer_receipt_hash'),
      outputHash: field(r, 'output_hash'),
      outputSizeBytes: u64Field(r, 'output_size_bytes'),
      outputLeafCount: u64Field(r, 'output_leaf_count'),
    };
  }

  private async getJson(path: string): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    let res: FetchResponse;
    try {
      res = await this.fetch(url);
    } catch (e) {
      throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_UNAVAILABLE', `chain query failed: ${url}`, {
        retriable: true,
        cause: e,
      });
    }
    if (!res.ok) {
      const notFound = res.status === 404;
      throw new TrueOpenError(
        'CHAIN_REJECT',
        notFound ? 'CHAIN_QUERY_NOT_FOUND' : `CHAIN_QUERY_HTTP_${res.status}`,
        `chain query ${url} -> HTTP ${res.status}`,
        { retriable: res.status >= 500 },
      );
    }
    const body = await res.json();
    if (typeof body !== 'object' || body === null) {
      throw malformed('response object');
    }
    return body as Record<string, unknown>;
  }
}

function toStreamState(s: Record<string, unknown>): StreamStateView {
  const status = enumField(s, 'status', 'SESSION_STATUS_');
  if (!SESSION_STATUS.has(status)) throw malformed(`session status=${status}`);
  return {
    sessionId: field(s, 'session_id'),
    owner: field(s, 'owner_user_address'),
    nextExpectedSequence: u64Field(s, 'next_expected_sequence'),
    lastActiveHeight: u64Field(s, 'last_active_height'),
    // uint32: protojson leaves it unquoted; verified to arrive as a bare number.
    openPendingCount: u64Field(s, 'open_pending_count'),
    status: status as 'ACTIVE' | 'IDLE' | 'CLOSED',
  };
}

/** Reads the raw value, preferring snake_case and falling back to camelCase. */
function raw(o: Record<string, unknown>, snakeKey: string): unknown {
  const camel = snakeKey.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  return o[snakeKey] ?? o[camel];
}

/** Reads a nested object field. */
function obj(o: Record<string, unknown>, snakeKey: string): Record<string, unknown> {
  const v = raw(o, snakeKey);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw malformed(`object ${snakeKey}`);
  return v as Record<string, unknown>;
}

/** Reads a string field, preferring snake_case and falling back to camelCase. */
function field(o: Record<string, unknown>, snakeKey: string): string {
  const v = raw(o, snakeKey);
  if (typeof v !== 'string') {
    throw malformed(`field ${snakeKey}`);
  }
  return v;
}

/**
 * Reads a string field that is legitimately absent while it still holds its
 * default value. Absent reads as ""; a present value of the wrong type is
 * still malformed, because that is a broken response rather than an unset one.
 */
function pendingField(o: Record<string, unknown>, snakeKey: string): string {
  const v = raw(o, snakeKey);
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') {
    throw malformed(`field ${snakeKey}`);
  }
  return v;
}

/**
 * Reads an unsigned integer field. Accepts both string and number: protojson
 * only quotes 64-bit integers, while uint32/int32 arrive as a bare JSON
 * number, and both forms can coexist in the same message. A number must be a
 * safe, non-negative integer, or it's treated as malformed -- silent
 * truncation is harder to debug than an error.
 */
function u64Field(o: Record<string, unknown>, snakeKey: string): bigint {
  const v = raw(o, snakeKey);
  if (typeof v === 'string') return stringToU64(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw malformed(`field ${snakeKey}=${v}`);
    return BigInt(v);
  }
  throw malformed(`field ${snakeKey}`);
}

/**
 * Reads an enum field and strips the proto prefix: the gateway returns the
 * full name (`SESSION_STATUS_IDLE`), while the SDK types use the short name
 * (`IDLE`). If it's already a short name, it's returned as-is, for
 * compatibility with hand-written fixtures and future gateway config changes.
 */
function enumField(o: Record<string, unknown>, snakeKey: string, prefix: string): string {
  const v = field(o, snakeKey);
  return v.startsWith(prefix) ? v.slice(prefix.length) : v;
}

function malformed(what: string): TrueOpenError {
  return new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_MALFORMED', `chain query returned malformed ${what}`);
}
