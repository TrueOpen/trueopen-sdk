import type { StreamStateView, SettlementFinalityView } from '../types/node';
import type { ChallengeKind } from '../types/challenge';

/**
 * Read port: node task.v1 Query (the authoritative snapshot).
 * Can be implemented via a REST gateway (fetch, no codegen needed) or gRPC.
 */
export interface ChainReader {
  querySession(sessionId: string): Promise<StreamStateView>;
  querySessionNonce(address: string): Promise<{ nextSessionNonce: bigint }>;
  querySettlementFinality(sessionId: string, taskId: string): Promise<SettlementFinalityView>;
}

/**
 * Full port: read plus user tx (broadcast via Cosmos Tx, needs CosmJS + proto codegen).
 * Adapters implement this separately; business logic and mocks depend on this interface only.
 */
export interface ChainClient extends ChainReader {
  createSession(): Promise<CreateSessionResult>;
  cancelOrder(input: CancelOrderInput): Promise<CancelOrderResult>;
  userChallenge(input: UserChallengeInput): Promise<UserChallengeResult>;
}

export interface CreateSessionResult {
  /** Canonical lowercase 64-hex (32-byte bytes field in the node proto); can be sent to nexus as-is. */
  readonly sessionId: string;
  /** Session owner; not present on the node response, filled in by the write side from the tx signer. */
  readonly owner: string;
  /** node MsgCreateSessionResponse.session_nonce (the nonce this session uses). */
  readonly nonce: bigint;
  /** Enum name from hub.v1.MutationStatusV1 (APPLIED / NOOP / ...). */
  readonly status: string;
}

export interface CancelOrderInput {
  /** Canonical lowercase 64-hex. */
  readonly sessionId: string;
  readonly orderSequence: bigint;
  /**
   * @deprecated The frozen wire contract's MsgCancelOrder no longer has an owner_signature
   * field (authorization is handled by the Cosmos account signature instead). Any value passed
   * here is no longer sent on-chain; the field is kept only so callers don't break.
   */
  readonly ownerSignature?: string;
}
export interface CancelOrderResult {
  /** Canonical lowercase 64-hex; the node returns task_id here, not session_id. */
  readonly taskId: string;
  readonly cancelledSequence: bigint;
  readonly nextExpectedSequence: bigint;
  /** Enum name from hub.v1.MutationStatusV1. */
  readonly status: string;
}

export interface UserChallengeInput {
  readonly sessionId: string;
  readonly taskId: string;
  readonly settlementId: string;
  readonly kind: ChallengeKind; // must pass isChallengeKindEnabled at runtime
  /** Opaque string, passed through unchanged into the Msg and the signing bytes. */
  readonly evidenceDigest: string;
  readonly bondAmount: bigint;
  /** Hex secp256k1 detached signature (see signUserChallenge). */
  readonly challengerSignature: string;
}
export interface UserChallengeResult {
  readonly challengeId: string;
  readonly status: string;
  readonly challengeDeadlineHeight: bigint;
  readonly resolveDeadlineHeight: bigint;
  readonly bondLockedAmount: bigint;
}
