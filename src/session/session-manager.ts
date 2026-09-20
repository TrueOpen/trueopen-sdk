import type { ChainClient } from '../transport/chain-client';
import type { StreamStateView } from '../types/node';

export interface SessionHandle {
  readonly sessionId: string;
  readonly owner: string;
  readonly nextExpectedSequence: bigint;
  readonly status: 'ACTIVE' | 'IDLE' | 'CLOSED';
  readonly label?: string;
}

/**
 * Creates a session, caches its handle, and rebuilds the handle from on-chain
 * StreamState if the cache is lost (Implementation Design §2.2).
 * The single source of truth for next_expected_sequence is the chain; the local
 * cache is observational only, and rebuild always wins on conflict.
 */
export class SessionManager {
  private cache = new Map<string, SessionHandle>();

  constructor(private readonly chain: ChainClient) {}

  async create(label?: string): Promise<SessionHandle> {
    const r = await this.chain.createSession();
    const handle: SessionHandle = {
      sessionId: r.sessionId,
      owner: r.owner,
      nextExpectedSequence: 0n,
      status: 'ACTIVE',
      ...(label !== undefined ? { label } : {}),
    };
    this.cache.set(handle.sessionId, handle);
    return handle;
  }

  async get(sessionId: string): Promise<SessionHandle> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    return this.rebuild(sessionId);
  }

  async rebuild(sessionId: string): Promise<SessionHandle> {
    const s = await this.chain.querySession(sessionId);
    const handle = toHandle(s, this.cache.get(sessionId)?.label);
    this.cache.set(sessionId, handle);
    return handle;
  }
}

function toHandle(s: StreamStateView, label?: string): SessionHandle {
  return {
    sessionId: s.sessionId,
    owner: s.owner,
    nextExpectedSequence: s.nextExpectedSequence,
    status: s.status,
    ...(label !== undefined ? { label } : {}),
  };
}
