import type {
  ChainClient, CreateSessionResult, CancelOrderInput, CancelOrderResult,
  UserChallengeInput, UserChallengeResult,
} from '../../src/transport/chain-client';
import type { StreamStateView, SettlementFinalityView } from '../../src/types/node';

/** In-memory ChainClient test double: session state and the createSession result can be seeded. */
export class MockChainClient implements ChainClient {
  sessions = new Map<string, StreamStateView>();
  nextCreate: CreateSessionResult = {
    sessionId: 'sess-1', owner: 'trueopen1owner', nonce: 0n, status: 'MUTATION_STATUS_V1_APPLIED',
  };

  async querySession(sessionId: string): Promise<StreamStateView> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`session not found: ${sessionId}`);
    return s;
  }
  async querySessionNonce(): Promise<{ nextSessionNonce: bigint }> {
    return { nextSessionNonce: 0n };
  }
  async querySettlementFinality(): Promise<SettlementFinalityView> {
    throw new Error('not used in these tests');
  }
  async createSession(): Promise<CreateSessionResult> {
    const r = this.nextCreate;
    this.sessions.set(r.sessionId, {
      sessionId: r.sessionId, owner: r.owner, nextExpectedSequence: 0n,
      lastActiveHeight: 0n, openPendingCount: 0n, status: 'ACTIVE',
    });
    return r;
  }
  async cancelOrder(_i: CancelOrderInput): Promise<CancelOrderResult> {
    throw new Error('not used');
  }
  async userChallenge(_i: UserChallengeInput): Promise<UserChallengeResult> {
    throw new Error('not used');
  }
}
