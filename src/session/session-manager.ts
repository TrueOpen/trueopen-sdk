import type { ChainClient } from '../transport/chain-client';
import type { SessionKeyGrant } from '../transport/task-msgs';
import type { StreamStateView } from '../types/node';

/**
 * A registered session key's material (ADR-0037), returned once when the SDK generates it.
 *
 * The caller persists `privateKey` (in memory, an encrypted store, a KMS or a keychain) and
 * reloads it with TrueOpenClient.useSessionKey; the SDK never derives it from a signature, never
 * logs it and keeps it in memory only. A `spendCap` of "0" is unlimited: a leaked key can then
 * authorize orders up to the whole account balance.
 */
export interface SessionKeyHandle {
  /** The key's eth-style address, `0x` + 40 lowercase hex: what is registered on chain. */
  readonly address: string;
  /** 32 bytes. */
  readonly privateKey: Uint8Array;
  /** The key signs nothing the chain accepts after this height. */
  readonly expiryHeight: bigint;
  /** Canonical decimal atomic units of cumulative max_fee; "0" means unlimited. */
  readonly spendCap: string;
}

export interface SessionHandle {
  readonly sessionId: string;
  readonly owner: string;
  readonly nextExpectedSequence: bigint;
  readonly status: 'ACTIVE' | 'IDLE' | 'CLOSED';
  readonly label?: string;
  /**
   * Present only on the handle TrueOpenClient.createSession returns when it registered a key.
   * Persist `privateKey` now: it is not kept in any cache and cannot be recovered.
   */
  readonly sessionKey?: SessionKeyHandle;
}

/**
 * Creates a session, caches its handle, and rebuilds the handle from on-chain
 * StreamState if the cache is lost.
 * The single source of truth for next_expected_sequence is the chain; the local
 * cache is observational only, and rebuild always wins on conflict.
 */
export class SessionManager {
  private cache = new Map<string, SessionHandle>();

  constructor(private readonly chain: ChainClient) {}

  /** With `sessionKey`, the key is registered in the same MsgCreateSession. */
  async create(label?: string, sessionKey?: SessionKeyGrant): Promise<SessionHandle> {
    const r = await (sessionKey !== undefined ? this.chain.createSession({ sessionKey }) : this.chain.createSession());
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
