import { Code, ConnectError } from '@connectrpc/connect';
import type { Transport } from '@connectrpc/connect';
import type { ChainClient, CancelOrderResult } from './transport/chain-client';
import type { TypedDataSigner } from './signer/typed-data-signer';
import { IngressClient } from './transport/ingress-client';
import type { OpenTaskAck, TaskStatusView, IngressAuth } from './transport/ingress-client';
import { SessionKeyManager } from './session/session-grant';
import { toAccountAddress } from './codec/address';
import { DEFAULT_SIGNATURE_CHAIN_ID, signatureChainIdBigInt } from './signature-chain-id';
import type {
  PrepareChallengeResponse,
  GetTaskEventsResponse,
  SubscribeOutputResponse,
} from './gen/nexus/v1/ingress_pb.js';
import { SessionManager } from './session/session-manager';
import type { SessionHandle, SessionKeyHandle } from './session/session-manager';
import { generateSessionKey, registeredSessionKey, RegisteredSessionKeys, sessionKeyAddressHex, sessionKeyFromPrivateKey } from './session/registered-session-key';
import type { RegisteredSessionKey, SessionKeyMaterial } from './session/registered-session-key';
import type { MsgUpdateSessionKeyResponse } from './transport/task-msgs';
import type { StreamStateView } from './types/node';
import { canonicalAccountAddressBytes } from './codec/address';
import { resolveTaskBuilderEndpoints } from './hub/stage1-routing';
import type { TaskBuilderReader } from './hub/stage1-routing';
import { fanOutToEndpoints } from './transport/fan-out-submit';
import { nexusGrpcEndpoint } from './types/hub';
import { isTLSPubkeyMismatch } from './transport/nexus-tls';
import type { DescriptorDocFetch } from './hub/builder-discovery';
import { buildTaskOrder, resolveTaskOrderContextWithBuilderSet, DEFAULT_ANCHOR_LAG } from './order/task-order-input';
import type { TaskOrderIntent, TaskOrderChainContext, TaskOrderContextReader, ResolvedTaskOrderContext } from './order/task-order-input';
import { TaskOrderContextCache } from './order/task-order-context-cache';
import type { TaskOrderContextCacheOptions } from './order/task-order-context-cache';
import { buildOpenTaskRequest } from './order/build-open-task';
import { deriveTaskId } from './order/order-signing';
import { TrueOpenError, dataError } from './errors/errors';
import { sha256 } from './codec/hash';
import { outputHash as outputMmrRoot, OutputStreamVerifier, verifyOutputFinSignature } from './output/output-commitment';
import type { OutputStreamVerifierCheckpoint } from './output/output-commitment';
import { confirmOutputWithReceipt } from './output/output-confirmation';
import type { ConfirmedOutputEvent } from './output/output-confirmation';
import type { FinishReasonV1 } from './gen/task/v1/evidence_pb.js';
import type { InferReceiptView, ChainTaskSnapshot } from './types/node';
import type { ProfileInfo, ProfilePricing, ServiceKeyBinding, ParticipantTypeName } from './types/hub';
import { PARTICIPANT_TYPE } from './types/hub';
import { resolveFeeDenom } from './order/fee-denom';
import type { TaskBuilderEndpoint } from './hub/stage1-routing';
import type { ByteRange } from './transport/task-data-signbytes';
import { classifyNexusError } from './errors/classify';
import { TASK_DATA_OBJECT_KIND } from './transport/task-data-signbytes';
import { randomBytes } from '@noble/hashes/utils';
import { hash32Text, isHash32Text, strictHash32 } from './codec/hash32';
import { bytesEqual } from './util/bytes';

export interface TrueOpenClientConfig {
  readonly chainId: string;
  /**
   * The user's account address: the order user and the signer of every request. Canonical
   * lowercase Bech32 with the account prefix `trueopen` (20 bytes), or a 0x EVM address, which
   * is converted to that Bech32 form.
   */
  readonly userAddress: string;
  /**
   * The user's wallet (see TypedDataSigner): signs the order, the OpenTask request envelope,
   * and every other request to Builder Ingress, all as EIP-712 typed data (65-byte R||S||V).
   * Each signature is recovered and checked against userAddress before it is sent. A session
   * with a registered session key loaded (createSession / useSessionKey) is the exception: that
   * key signs its orders and session-allowed requests instead.
   *
   * privateKeyTypedDataSigner (CLI, servers), eip1193TypedDataSigner (browser wallets) or
   * keplrTypedDataSigner (Keplr).
   */
  readonly wallet: TypedDataSigner;
  readonly chain: ChainClient; // chain read+write (createTrueOpenChainClient)
  readonly ingressTransport: Transport; // nexus IngressAPI Connect transport
  /** Request nonce generator; must return exactly 32 bytes. Defaults to 32 bytes from the platform's secure RNG. */
  readonly nonce?: () => Uint8Array;
  /** Request expiry (Unix ms) generator; defaults to now + requestTtlMs. */
  readonly expiry?: () => bigint;
  /** Default request TTL (ms), defaults to 5 minutes. Used for timestamp-style expiry on non-OpenTask requests. */
  readonly requestTtlMs?: number;
  /**
   * The OpenTask request envelope's expiry window, in **blocks** (default 10).
   *
   * OpenTask is the only request whose expiry is a block height (0 < expiry < 1e12), and the
   * Builder accepts it only within [currentHeight, currentHeight + its request TTL in blocks]
   * (20 by default). Picking too large a window risks NEXUS_DATA_EXPIRED, so the default is 10
   * to leave block-production margin.
   */
  readonly requestTtlBlocks?: number;
  /**
   * The Task data request (GetTaskDataMetadata / FetchTaskData) expiry window, in **blocks**
   * (default 10). The Builder accepts current_height <= expiry_height <= current_height +
   * max_service_material_expiry_blocks, a different window from OpenTask's request TTL; keep this
   * at or below the Builders' max_service_material_expiry_blocks. An expired request answers
   * NEXUS_DATA_EXPIRED, which the SDK re-signs and retries on the same Builder.
   */
  readonly taskDataExpiryBlocks?: number;
  /**
   * The signer-chosen EIP-712 domain chainId: the `chainId` of every EIP-712 domain (order, SDK
   * request, Task data request, session grant), a different thing from the cosmos chainId string
   * above. A browser wallet signs under its active network, so pass that network's numeric chain
   * ID here. Defaults to `1` (Ethereum mainnet) for session keys and server-side keys, where
   * there is no wallet network to ask (ADR-0033).
   */
  readonly signatureChainId?: bigint | number | string;
  /**
   * Opt-in session grants, off by default. When set, the wallet signs one SessionGrant for an
   * in-memory session key, and that key signs SubscribeOutput, AckOutput, GetTaskEvents,
   * PrepareChallenge and the OUTPUT GetTaskDataMetadata / FetchTaskData requests, so a browser
   * wallet prompts once per grant instead of once per request. The session key also signs the
   * OpenTask request envelope (wire PR #43); a granted key cannot sign the order itself, so with
   * a grant alone each order costs one wallet prompt. A session with a registered session key
   * loaded (ADR-0037, createSession({ sessionKey }) / useSessionKey) needs no grant and no wallet
   * prompt: its key signs both the order and those requests, and takes precedence over the grant
   * for that session. The grant is renewed before it expires (and once more if a Builder reports
   * it expired). The key is never persisted.
   *
   * `maxGrantBlocks` must be the Builders' max_session_grant_blocks (off-chain configuration,
   * the same on every Task Builder); see SessionKeyManagerOptions for the other two. Needs
   * `hub` (the grant expiry is a block height).
   */
  readonly session?: {
    readonly maxGrantBlocks: number;
    readonly grantBlocks?: number;
    readonly renewBeforeBlocks?: number;
  };
  /**
   * Optional override for the order's EIP-712 feeDenom.
   *
   * The chain's `params.phase0.business_denom` is authoritative and is read through
   * `hub.getBusinessDenom()` on every openTask. When given, this value is only checked
   * against the chain value, and the order is refused locally if they differ (the Keeper
   * would reject it after nexus accepted it). It is used on its own only when the hub reader
   * cannot read the denom.
   */
  readonly feeDenom?: string;
  /**
   * Hub reader (needed by openTask): must be able to fetch both the builder set /
   * descriptors needed for Task Builder routing, and the order context (anchor beacon /
   * param bucket version). HubReader satisfies both, plus the optional reads below.
   */
  readonly hub?: FacadeHubReader;
  /**
   * On-chain task reads (RestChainReader satisfies it). Needed to derive the output trust
   * anchors -- accepted task_hash, winner Worker, accepted InferReceipt -- so that
   * fetchTaskOutput and streamOutput do not need them pasted in.
   */
  readonly taskReader?: OutputTaskReader;
  /** Fetches descriptor document bytes (for byte-for-byte hash verification). */
  readonly fetchDescriptor?: DescriptorDocFetch;
  /**
   * Builds a nexus transport for a given serviceEndpoint (runtime-specific, injected by the caller).
   * tlsPubkeyHash is the sha256 (Hash32 text, `0x` + 64 lowercase hex) of the certificate public key registered in the on-chain
   * descriptor; https endpoints should verify the server certificate against it. Under Node, you
   * can use nexusIngressTransport directly (transport/nexus-tls).
   */
  readonly ingressTransportFactory?: (serviceEndpoint: string, tlsPubkeyHash?: string) => Transport;
  /**
   * Opens connections to a Builder's nexus ahead of use, so OpenTask and the output stream
   * skip the TCP + TLS handshake. Under Node, pass
   * `(uri, hash) => prewarmNexusConnections(uri, hash)` together with
   * `ingressTransportFactory: nexusIngressTransport`: both use the same shared keep-alive agent
   * per pinned certificate, which is what makes the warm connections reusable. When set,
   * openTask prewarms every selected Builder concurrently while the order is being signed, and
   * prewarmTaskBuilders does it on demand. Failures are ignored (the real request reports
   * them). Unset (the default, and the right choice in a browser), nothing is prewarmed.
   */
  readonly ingressPrewarm?: (serviceEndpoint: string, tlsPubkeyHash: string) => Promise<unknown>;
  /**
   * Reuse of the session anchor across orders (TaskOrderContextCache): on by default when the
   * hub reader can read the anchor freshness window (HubReader can), saving a sequential chain
   * round trip per order. The options bound the anchor age; `false` resolves a fresh context
   * for every order. A `context` passed to openTask is always used as is.
   */
  readonly orderContextReuse?: false | TaskOrderContextCacheOptions;
  /**
   * How long openTask waits, in milliseconds, for an anchor at or after a registered session
   * key's set_height (default DEFAULT_SESSION_KEY_ANCHOR_WAIT_MS, a few blocks). A fresh anchor
   * lags the latest height (anchorLag, 2 blocks by default), so right after createSession or a
   * rotate the anchor is still below the registration height; openTask polls the latest height
   * until a fresh anchor would reach it, then resolves one. 0 disables the wait. Must be finite
   * and >= 0 (else the constructor throws SDK_LOCAL_SESSION_KEY_CONFIG_INVALID).
   */
  readonly sessionKeyAnchorWaitMs?: number;
  /**
   * Poll interval of that wait (default DEFAULT_TRUST_ANCHOR_POLL_MS, about one block). Must be
   * finite and > 0 (else the constructor throws SDK_LOCAL_SESSION_KEY_CONFIG_INVALID).
   */
  readonly sessionKeyAnchorPollMs?: number;
  /**
   * Blocks of margin before a registered key's expiry for requests (default
   * DEFAULT_REGISTERED_KEY_EXPIRY_MARGIN_BLOCKS = 3): the key signs a session's requests only while
   * `latest + margin <= expiry`, so a request judged against a slightly old height, or arriving a
   * block later, is not refused by the Builder as expired; inside the margin requests fall back to
   * the grant or the wallet. Raise it on chains with very short blocks. Must be a non-negative
   * integer (else the constructor throws SDK_LOCAL_SESSION_KEY_CONFIG_INVALID). Orders are not
   * affected: openTask still accepts an order up to the expiry.
   */
  readonly sessionKeyRequestExpiryMarginBlocks?: number;
}

/**
 * Hub reads the facade uses. The optional ones are what HubReader provides beyond routing and
 * the order context; a reader without them makes the dependent features fail with an explicit
 * error instead of silently skipping a check.
 */
export type FacadeHubReader = TaskBuilderReader &
  TaskOrderContextReader & {
    /** params.phase0.business_denom: the order's EIP-712 feeDenom. */
    getBusinessDenom?(): Promise<string>;
    /** Profile pricing (min_order_value / verify_ratio_bps) for the local order-value checks. */
    getProfile?(modelId: string, profileVersion: bigint): Promise<ProfileInfo>;
    /** The Worker's current service key, for the output trust anchors. */
    getCurrentServiceKey?(participantType: ParticipantTypeName, operatorAddress: string): Promise<ServiceKeyBinding>;
    /** Latest height, for the task-data request expiry. */
    getLatestHeight(): Promise<bigint>;
    /** Task params session.anchor_freshness_window_blocks, for reusing a session anchor across orders. */
    getAnchorFreshnessWindowBlocks?(): Promise<bigint>;
    /** Task params session.max_session_key_blocks (0 = session keys unsupported); required to register a key. */
    getMaxSessionKeyBlocks?(): Promise<bigint>;
  };

/** On-chain task reads needed to derive the output trust anchors (RestChainReader satisfies it). */
export interface OutputTaskReader {
  queryTask(taskId: string): Promise<ChainTaskSnapshot>;
  queryInferReceipt(taskId: string): Promise<InferReceiptView | undefined>;
}

/**
 * What an output is verified against, all derived from chain queries:
 * task -> accepted task_hash and winner Worker; hub -> that Worker's current service key;
 * accepted InferReceipt -> output_hash (the MMR root), size and leaf count.
 */
export interface OutputTrustAnchors {
  readonly taskId: string;
  /** Hash32 text (`0x` + 64 lowercase hex), the on-chain accepted task_hash. */
  readonly taskHash: string;
  /** Operator address of the winner Worker. */
  readonly winnerWorker: string;
  /** The winner Worker's current service key (33-byte compressed). */
  readonly workerServicePubKey: Uint8Array;
  /** The accepted InferReceipt; undefined when it was not asked for or is not on chain yet. */
  readonly receipt?: InferReceiptView;
  /** receipt.outputHash, Hash32 text (`0x` + 64 lowercase hex). */
  readonly outputHash?: string;
}

/** Options for waitForOutputTrustAnchors. */
export interface WaitForOutputTrustAnchorsOptions {
  /**
   * The task's session. When set, the client's own Builder event stream (watchTask) is
   * watched, and its ASSIGNMENT_FINALIZED event triggers one immediate chain read instead of
   * waiting for the next poll. Without it the wait only polls.
   */
  readonly sessionId?: string;
  /** Milliseconds between chain reads; default DEFAULT_TRUST_ANCHOR_POLL_MS (about one block). */
  readonly pollIntervalMs?: number;
  /** Upper bound on the whole wait; default DEFAULT_TRUST_ANCHOR_WAIT_MS. */
  readonly timeoutMs?: number;
  /** Stops the wait (and the event stream) early. */
  readonly signal?: AbortSignal;
}

/** One selected Task Builder's outcome for an openTask call. */
export interface OpenTaskBuilderResult {
  /** Builder operator address; this is the builderAddress for task-data requests to it. */
  readonly address: string;
  /** Rank in the task_builder_seed selection, 1-based (1 = first). */
  readonly rank: number;
  /** The nexus endpoint the order was actually sent to (after any certificate re-read). */
  readonly serviceEndpoint: string;
  readonly tlsPubkeyHash: string;
  /** Present when the Builder answered. `ack.accepted` may still be false. */
  readonly ack?: OpenTaskAck;
  /** Present when the call to this Builder failed. */
  readonly error?: unknown;
}

export interface OpenTaskParams {
  readonly sessionId: string;
  /**
   * Defaults to reading `StreamState.next_expected_sequence` from chain (the sole source of truth).
   *
   * This counter only advances when the Keeper **accepts** an order (node keeper/order_sequence.go:56-58);
   * `CancelOrder` also advances it (msg_server_session.go:267). It **stays put** when an order is
   * rejected, times out, or is replaced via RBF. So once a locally incremented
   * counter drifts out of sync, it never self-heals -- every subsequent order gets rejected with
   * `ErrInvalidOrderSequence`. Pass an explicit value only for RBF -- resending a bumped-fee order
   * under the same sequence number.
   */
  readonly orderSequence?: bigint;
  /** User intent (including the plaintext payload); userAddress/sessionId/orderSequence are filled in by the client. */
  readonly order: TaskOrderIntent;
  /** Required; the same key + the same input_hash returns the same result, the same key + a different input_hash is rejected. */
  readonly idempotencyKey: string;
  /** Defaults to resolveTaskOrderContext(hub, chainId). Reusing the same context saves a round trip to chain. */
  readonly context?: TaskOrderChainContext;
  /** Request envelope expiry as a **block height**; defaults to latestHeight + requestTtlBlocks. */
  readonly expiryHeight?: bigint;
  readonly inputMediaType?: string;
  readonly chunkSizeBytes?: number;
  /**
   * Profile pricing for the local min-order-value and max-fee checks. Defaults to
   * `hub.getProfile(modelId, profileVersion).pricing`; pass it to skip that read.
   */
  readonly pricing?: ProfilePricing;
  /**
   * Who signs the order. `'auto'` (default): a registered session key loaded for the session
   * signs it, after the key prechecks (see openTask), else the wallet. `'wallet'`: the wallet
   * signs it even when a key is loaded, the key prechecks are skipped, and the request envelope
   * is signed as for a session without a registered key (under config.session's grant when set,
   * else by the wallet). Use it to recover from an order the chain rejected because the key was
   * cleared, expired or ran out of cap, without unloading the key.
   */
  readonly orderSigner?: 'auto' | 'wallet';
}

/**
 * The first accepted ack's fields stay at the top level for compatibility; `builders` has
 * every selected Builder's outcome, so later calls know which Builders hold the task.
 */
export interface OpenTaskResult extends OpenTaskAck {
  readonly taskId: string;
  /** Canonical task_hash (content identity, the digest covered by the user's inner signature). */
  readonly taskHash: string;
  /** The on-chain context actually used (anchor / builder set / bucket version), kept for reuse and debugging. */
  readonly context: TaskOrderChainContext;
  readonly endpointsTried: number;
  /** The fee denom signed into the order (the chain business_denom). */
  readonly feeDenom: string;
  /** Every selected Builder that resolved to an endpoint, in selection order, with its ack or error. */
  readonly builders: readonly OpenTaskBuilderResult[];
  /** Selected Builders whose nexus endpoint could not be resolved from chain; the order was not sent to them. */
  readonly unresolvedBuilders: readonly { readonly address: string; readonly error: unknown }[];
  /** The order_sequence signed into the order (task_id is derived from it). */
  readonly orderSequence: bigint;
  /** Who signed the order: the wallet, or the session's registered key (ADR-0037). */
  readonly orderSignedBy: 'wallet' | 'session-key';
  /**
   * The 20-byte address of the registered key that signed the order (orderSignedBy
   * 'session-key' only). Never the private key.
   */
  readonly orderSignerAddress?: Uint8Array;
  /** The order's max_fee in atomic units (what a registered key's spend cap is charged). */
  readonly maxFee: bigint;
  /** The order's order_expire_height: the Keeper cannot admit it at a later height. */
  readonly orderExpireHeight: bigint;
  /**
   * The parameters of a re-signed order under the same order_sequence, for when the chain
   * rejects this one (see waitForAdmission): these params with `orderSequence` set to this
   * order's, `context` and `expiryHeight` removed (a retry resolves fresh ones), and a new
   * idempotency key `<key>#retry<n>` (a re-signed order has a new task_hash, and a key is only
   * ever reused for the same task_hash). The payload is the same object, not a copy. The SDK
   * never sends it by itself.
   */
  readonly retryParams: OpenTaskParams;
}

/** Options for waitForAdmission. */
export interface WaitForAdmissionOptions {
  /** Upper bound on the whole wait; default DEFAULT_ADMISSION_WAIT_MS. */
  readonly timeoutMs?: number;
  /** Milliseconds between chain reads; default DEFAULT_TRUST_ANCHOR_POLL_MS (about one block). */
  readonly pollIntervalMs?: number;
  /** Stops the wait (and the event streams) early; throws ORDER_ADMISSION_WAIT_ABORTED. */
  readonly signal?: AbortSignal;
}

/** Why the chain most likely refused an order, derived from the session's committed state. */
export type RejectionReason =
  | 'session-closed'
  | 'cleared'
  | 'rotated'
  | 'expired'
  | 'anchor-before-set-height'
  | 'spend-cap'
  | 'unrelated';

export interface RejectionDiagnosis {
  /**
   * The chain's next_expected_sequence is still this order's sequence, so a re-signed order can
   * reuse it. When false (the sequence was consumed by another order or a MsgCancelOrder), the
   * retry must use the next free sequence.
   */
  readonly sequenceFree: boolean;
  readonly reason: RejectionReason;
  /** The ASSIGN_REJECTED / ASSIGN_TIMEOUT events seen, one per Builder. */
  readonly events: readonly { readonly builderAddress: string; readonly eventCode: string }[];
  /** The session read the reason was derived from. */
  readonly session: StreamStateView;
}

/** What waitForAdmission found on chain. */
export type AdmissionOutcome =
  /** The chain has the task with this order's task_hash. */
  | { readonly kind: 'accepted'; readonly taskId: string }
  /** The chain has a task for this task_id with a different task_hash: another order took the sequence. */
  | { readonly kind: 'superseded'; readonly taskId: string; readonly chainTaskHash: string }
  /**
   * Every Builder that acked the order reported it rejected (or timed out), or the latest
   * height passed the order's order_expire_height, and the chain has no task for it. `retry` is the order's retryParams, without `orderSequence` when the
   * sequence is no longer free. The caller decides what to change and calls openTask again.
   */
  | { readonly kind: 'rejected'; readonly taskId: string; readonly diagnosis: RejectionDiagnosis; readonly retry: OpenTaskParams }
  /** Neither within timeoutMs. */
  | { readonly kind: 'timeout'; readonly taskId: string };

/** Expiry and cap of a registered session key grant (ADR-0037). */
export interface SessionKeyOptions {
  /**
   * Blocks from the latest height until the key expires: an integer in
   * [2, max_session_key_blocks]. Defaults to max_session_key_blocks - 2 (at least 2).
   */
  readonly expiryBlocks?: number;
  /**
   * Cap on the cumulative max_fee of the orders the key authorizes, in atomic units. "0" (or 0n)
   * is unlimited: a leaked key can then authorize orders up to the whole account balance.
   */
  readonly spendCap?: bigint | string;
}

/** The options of a registration of a new key: createSession and a rotate. */
export interface RegisterSessionKeyOptions extends SessionKeyOptions {
  /**
   * The key to register, from generateSessionKey(), so the caller can persist it before the
   * transaction is broadcast (a broadcast that fails ambiguously may still have landed). Without
   * it the SDK generates one. It is validated (a valid private key whose address is `address`,
   * not the owner's, not the key being rotated out) and its material never appears in an error.
   */
  readonly key?: SessionKeyMaterial;
}

export interface CreateSessionOptions {
  readonly label?: string;
  /** Registers a session key (freshly generated, or `key`) in the same MsgCreateSession. */
  readonly sessionKey?: RegisterSessionKeyOptions;
}

/** See TrueOpenClient.updateSessionKey. */
export type SessionKeyUpdate =
  | { readonly renew: SessionKeyOptions }
  | { readonly rotate: RegisterSessionKeyOptions }
  | { readonly clear: true };

export interface UpdateSessionKeyResult {
  /** The chain's session-key state after the update. */
  readonly response: MsgUpdateSessionKeyResponse;
  /** For `rotate`: the new key, already loaded. The caller persists its privateKey. */
  readonly newKey?: SessionKeyHandle;
}

/** A session's registered-key state as the chain reports it (QuerySession). */
export interface SessionKeyState {
  /** The chain has a key registered for the session. */
  readonly registered: boolean;
  /** A key is loaded on this client for the session and it is the registered one. */
  readonly matchesLoadedKey: boolean;
  readonly expiryHeight: bigint;
  /** Canonical decimal atomic units; "0" is unlimited (or no key). */
  readonly spendCap: string;
  /** Cumulative max_fee of the orders admitted under a key; never reset. */
  readonly spent: string;
  /** Height of the key's registration; orders need a session anchor at or after it. */
  readonly setHeight: bigint;
  readonly status: StreamStateView['status'];
}

/** A Builder/Nexus data source that can be subscribed to for the same task's OUTPUT. */
export interface OutputStreamSource {
  /** Used only for error and diagnostic messages; not part of the signature. */
  readonly id: string;
  /** Must already be configured with the same SDK request signing identity as the current TrueOpenClient. */
  readonly ingress: Pick<IngressClient, 'subscribeOutput' | 'ackOutput'>;
}

export interface StreamOutputParams {
  readonly sessionId: string;
  readonly taskId: string;
  /**
   * Hash32 text (`0x` + 64 lowercase hex), the on-chain accepted_task_hash. Defaults to the value from
   * resolveOutputTrustAnchors (needs config.taskReader and config.hub).
   */
  readonly taskHash?: string;
  /**
   * The selected Worker's service public key for this Task (33-byte compressed). Defaults to
   * the winner Worker's current service key from resolveOutputTrustAnchors.
   */
  readonly workerServicePubKey?: Uint8Array;
  /** Restored from a trusted local checkpoint previously exported by the SDK. */
  readonly checkpoint?: OutputStreamVerifierCheckpoint;
  /**
   * @deprecated A bare cursor cannot restore MMR state; it must be passed together with a
   * consistent checkpoint.
   */
  readonly resumeAfterSeq?: bigint;
  /** Candidate Builders; defaults to using only the current client's ingress. Rotates through the array in order on failure. */
  readonly sources?: readonly OutputStreamSource[];
  /** Total number of subscription attempts; defaults to at least 3, and never fewer than the number of candidate sources. */
  readonly maxAttempts?: number;
  /** Max idle milliseconds allowed between two frames within a single subscription; if unset, no SDK idle timeout is applied. */
  readonly idleTimeoutMs?: number;
  /** Called after each new frame is accepted; can be used to persist a defensive checkpoint. */
  readonly onCheckpoint?: (checkpoint: OutputStreamVerifierCheckpoint) => void | Promise<void>;
  /**
   * Whether to report local delivery progress after finishing, default true. This is only local
   * progress; it plays no part in settlement or fault attribution. Only a Worker-signed Fin is
   * ever acked: an unattested Fin (see `finSignaturePolicy`) is never acked, whatever this says.
   */
  readonly ack?: boolean;
  /**
   * Signature-verification policy for the trailing frame (`OutputFinV1`).
   *
   * - `'require'` (default): Fin must carry a valid `finish_reason` and a `worker_signature` that
   *   verifies against `workerServicePubKey` (the Worker's current service key) before the stream
   *   is treated as complete or acked. A Fin that fails this is treated like a bad frame: the
   *   stream moves on to the next source, and fails once attempts run out.
   * - `'accept-unsigned'`: an explicit opt-in for peers that still send the old, unsigned Fin. A
   *   Fin that does carry a signature is still verified. An unsigned Fin ends the stream, but it is
   *   surfaced as `attested: false` and is **never acked**.
   *
   * Why the default is `'require'`: an unsigned Fin only proves that the prefix received so far is
   * self-consistent. Nothing stops a Builder from sending one after any verified prefix, so
   * accepting it would let the Builder truncate the output silently. The Worker's signature over
   * `final_seq` and `output_mmr_root` is what says the output ends here; nexus stores and replays
   * the signed Fin byte for byte.
   *
   * A Fin with a bad signature is never trusted under any policy.
   */
  readonly finSignaturePolicy?: 'require' | 'accept-unsigned';
  /**
   * Early subscribe: open SubscribeOutput at once, while the anchors are still being waited
   * for, instead of after. Applies when taskHash / workerServicePubKey are not both given
   * (and pendingAnchors is not set). `true` waits with waitForOutputTrustAnchors and
   * `{ sessionId }`; an options object is passed to it as is (its `signal` is combined with
   * this call's `signal`). With a sessionId, the event hint is read from the first source when
   * its ingress can serve task events (an IngressClient), else from this client's ingress.
   *
   * Frames that arrive before the anchors are held unverified and are **never** delivered,
   * checkpointed or acked before they verify. Once the anchors arrive, every held frame, a
   * held Fin included, goes through exactly the checks it would have gone through on arrival,
   * in arrival order; the checks are the same as without early subscribe (the Worker key is
   * read once, so a service key rotated mid-stream is not covered, as before). If the wait
   * fails (no winner, timeout, an inactive key, a failed read), the subscription is closed and
   * that error is thrown. nexus never ends a subscription because a task reached a terminal
   * state, so the SDK closes it itself.
   */
  readonly waitForAnchors?: boolean | WaitForOutputTrustAnchorsOptions;
  /**
   * Early subscribe with anchors the caller is already waiting for (for example its own
   * waitForOutputTrustAnchors call). Same behaviour as `waitForAnchors`; takes precedence
   * over it. Explicit taskHash / workerServicePubKey still override what it resolves to. A
   * rejection closes the subscription and is thrown as is. The caller owns cancelling it.
   */
  readonly pendingAnchors?: PromiseLike<{ readonly taskHash: string; readonly workerServicePubKey: Uint8Array }>;
  /**
   * How many frames early subscribe reads ahead while the anchors are pending (default
   * DEFAULT_MAX_PENDING_FRAMES). At the limit the SDK simply stops reading the subscription
   * until the anchors arrive, so memory stays bounded and nothing is dropped. If the Builder
   * then gives up on the slow subscriber (ResourceExhausted), the SDK verifies what it holds
   * and resubscribes after the last verified frame.
   */
  readonly maxPendingFrames?: number;
  /**
   * Aborting stops the stream: the subscription and any anchor wait are closed and
   * `OUTPUT_STREAM_ABORTED` is thrown.
   */
  readonly signal?: AbortSignal;
}

/**
 * One event from `streamOutput`. The stream ends with exactly one `fin` after the last
 * `chunk`, so the terminal state is part of the control flow rather than something the
 * caller has to reconstruct from the iterator finishing.
 *
 * Two shapes rather than one carrying an optional field: a caller that only handles
 * `chunk` still type-checks under a non-exhaustive switch, but has to *say* it is ignoring
 * termination. `finish_reason` carries caveats (see below) that are easy to miss if the
 * value merely appears on every chunk.
 */
export type OutputStreamEvent =
  | {
      readonly kind: 'chunk';
      readonly seq: bigint;
      readonly text: string;
      readonly mmrRoot: Uint8Array;
    }
  | {
      readonly kind: 'fin';
      /** The Fin carried a Worker signature that verified: the output really ends here. */
      readonly attested: true;
      /**
       * The termination reason from the signature-verified `OutputFinV1`.
       *
       * **This cannot tell you the model made a tool call.** Cortex normalises vLLM's
       * `finish_reason: "tool_calls"` to EOS so that the chat path reuses the raw-text
       * resolver, so a turn that ended in a tool call arrives here as an ordinary EOS.
       * Detecting a tool call means parsing the committed text.
       */
      readonly finishReason: FinishReasonV1;
    }
  | {
      readonly kind: 'fin';
      /**
       * The peer sent an unsigned Fin and the caller opted in with
       * `finSignaturePolicy: 'accept-unsigned'`. Nothing attests that the output is complete: a
       * Builder could have cut it short. The SDK does not ack it; only the on-chain
       * `InferReceipt.output_hash` can confirm the text.
       */
      readonly attested: false;
      readonly finishReason: undefined;
    };

export interface ConfirmOutputParams {
  readonly taskId: string;
  readonly taskHash: string;
  readonly checkpoint: OutputStreamVerifierCheckpoint;
  readonly receipt: InferReceiptView;
}

async function nextWithIdleTimeout<T>(
  iterator: AsyncIterator<T>,
  idleTimeoutMs?: number,
  /** A next() already in flight (started before the anchors arrived), consumed instead of a new one. */
  pending?: Promise<IteratorResult<T>>,
): Promise<IteratorResult<T>> {
  const next = pending ?? iterator.next();
  if (idleTimeoutMs === undefined) return next;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      next,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new TrueOpenError('NEXUS_INGRESS', 'OUTPUT_STREAM_IDLE_TIMEOUT', `output stream idle for ${idleTimeoutMs}ms`, { retriable: true })),
          idleTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Top-level SDK facade: one place for signing, chain read/write, nexus order
 * submission/retrieval/challenge, and session management.
 * chain / ingressTransport are injected by the caller to keep this runtime-agnostic.
 * Hard rule: an ingress ack is not the same as on-chain acceptance; the chain
 * query/event is always the source of truth for final state.
 */
export class TrueOpenClient {
  private readonly cfg: TrueOpenClientConfig;
  private readonly sessionManager: SessionManager;
  readonly ingress: IngressClient;

  /** The session key and its grant, when config.session is set. */
  readonly sessionGrants: SessionKeyManager | undefined;

  /** Order contexts with session-anchor reuse; undefined without a hub or with orderContextReuse: false. */
  private readonly contextCache: TaskOrderContextCache | undefined;

  /** Registered session keys loaded on this client, by session (memory only), with their expiry. */
  private readonly registeredKeys: RegisteredSessionKeys;

  constructor(cfg: TrueOpenClientConfig) {
    // A 0x address (as an EIP-1193 wallet reports it) becomes the canonical Bech32 account
    // address; anything else must already be canonical with the account prefix.
    this.cfg = { ...cfg, userAddress: toAccountAddress(cfg.userAddress) };
    cfg = this.cfg;
    // Both bound the anchor wait: NaN or Infinity would never end it, a zero poll would storm the hub.
    const waitMs = cfg.sessionKeyAnchorWaitMs;
    if (waitMs !== undefined && (!Number.isFinite(waitMs) || waitMs < 0)) {
      throw local('SDK_LOCAL_SESSION_KEY_CONFIG_INVALID', `sessionKeyAnchorWaitMs must be a finite number >= 0, got ${String(waitMs)}`);
    }
    const pollMs = cfg.sessionKeyAnchorPollMs;
    if (pollMs !== undefined && (!Number.isFinite(pollMs) || pollMs <= 0)) {
      throw local('SDK_LOCAL_SESSION_KEY_CONFIG_INVALID', `sessionKeyAnchorPollMs must be a finite number > 0, got ${String(pollMs)}`);
    }
    const margin = cfg.sessionKeyRequestExpiryMarginBlocks;
    if (margin !== undefined && (!Number.isSafeInteger(margin) || margin < 0)) {
      throw local(
        'SDK_LOCAL_SESSION_KEY_CONFIG_INVALID',
        `sessionKeyRequestExpiryMarginBlocks must be a non-negative integer, got ${String(margin)}`,
      );
    }
    this.sessionManager = new SessionManager(cfg.chain);
    // Requests use a registered key only up to a margin before its expiry height; the height comes from the hub,
    // reused from the client's own recent reads (readLatestHeight) where one exists.
    const hub = cfg.hub;
    this.registeredKeys = new RegisteredSessionKeys({
      ...(hub !== undefined ? { latestHeight: () => hub.getLatestHeight() } : {}),
      heightMaxAgeMs: DEFAULT_TRUST_ANCHOR_POLL_MS,
      ...(margin !== undefined ? { expiryMarginBlocks: margin } : {}),
    });
    this.sessionGrants =
      cfg.session === undefined
        ? undefined
        : new SessionKeyManager({
            chainId: cfg.chainId,
            userAddress: cfg.userAddress,
            wallet: cfg.wallet,
            signatureChainId: this.signatureChainId(),
            latestHeight: () => this.latestHeight('a session grant expiry'),
            maxGrantBlocks: cfg.session.maxGrantBlocks,
            ...(cfg.session.grantBlocks !== undefined ? { grantBlocks: cfg.session.grantBlocks } : {}),
            ...(cfg.session.renewBeforeBlocks !== undefined ? { renewBeforeBlocks: cfg.session.renewBeforeBlocks } : {}),
          });
    this.ingress = new IngressClient(cfg.ingressTransport, this.ingressAuth());
    this.contextCache =
      cfg.hub === undefined || cfg.orderContextReuse === false
        ? undefined
        : new TaskOrderContextCache(cfg.hub, cfg.chainId, cfg.orderContextReuse ?? {});
  }

  /**
   * The signing context for Builder Ingress requests. A client built by the caller for another
   * Builder (for example an OutputStreamSource) should use this, so that it shares the wallet,
   * the nonce source, the session grant and the registered session keys.
   */
  ingressAuth(): IngressAuth {
    return {
      chainId: this.cfg.chainId,
      userAddress: this.cfg.userAddress,
      wallet: this.cfg.wallet,
      signatureChainId: this.signatureChainId(),
      nonce: () => this.nextNonce(),
      expiry: () => this.nextExpiry(),
      ...(this.sessionGrants !== undefined ? { session: this.sessionGrants } : {}),
      registeredKeys: this.registeredKeys,
    };
  }

  private async latestHeight(what: string): Promise<bigint> {
    const hub = this.cfg.hub;
    if (hub === undefined) {
      throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_HEIGHT_UNCONFIGURED', `${what} is a block height: config.hub is required`);
    }
    return this.readLatestHeight(hub);
  }

  /** The hub's latest height, also recorded for the registered keys' request expiry check. */
  private async readLatestHeight(hub: FacadeHubReader): Promise<bigint> {
    const h = await hub.getLatestHeight();
    this.registeredKeys.observeHeight(h);
    return h;
  }

  /** The signer-chosen EIP-712 domain chainId: config.signatureChainId, else the default 1. */
  signatureChainId(): bigint {
    return signatureChainIdBigInt(this.cfg.signatureChainId ?? DEFAULT_SIGNATURE_CHAIN_ID);
  }

  /**
   * Creates a session (MsgCreateSession, signed by the wallet). A string is the local label.
   *
   * With `sessionKey` (ADR-0037), the SDK generates a fresh key from a CSPRNG and registers its
   * address in the same transaction, then loads it: from then on that key, not the wallet, signs
   * this session's orders and session-allowed requests. The returned handle carries the key
   * material once. **The caller persists `sessionKey.privateKey`** and reloads it after a restart
   * with useSessionKey; the SDK never derives it from a signature, never logs it and keeps it in
   * memory only. `spendCap` defaults to "0", which is unlimited: a leaked key can then authorize
   * orders up to the whole account balance, so set a cap where that matters.
   *
   * `expiryBlocks` (default `max_session_key_blocks - 2`, at least 2) must be an integer in
   * [2, max_session_key_blocks]: the tx executes at the latest height + 1 or later and the chain
   * needs height < expiry, so 1 block never lands. The key expires at the latest height plus
   * that. Needs a hub reader with getMaxSessionKeyBlocks; a chain without session keys (absent
   * or 0), or with a limit below 2, is refused with SDK_LOCAL_SESSION_KEY_UNSUPPORTED.
   *
   * A key registered at height H authorizes only orders whose session anchor is at or after H;
   * openTask waits (sessionKeyAnchorWaitMs) for a fresh anchor to reach H, so the first order
   * right after registration may take a block or two longer.
   *
   * `sessionKey.key` registers caller-supplied material from generateSessionKey() instead, so the
   * caller can persist it before the broadcast: if the broadcast fails ambiguously (a timeout
   * after the tx landed), the key is not lost.
   *
   * The key signs this session's orders until its expiry height (then openTask refuses with
   * SDK_LOCAL_SESSION_KEY_EXPIRED); it signs the session-allowed requests up to the same height,
   * after which they fall back to config.session (the grant) when set, else the wallet.
   */
  async createSession(opts?: string | CreateSessionOptions): Promise<SessionHandle> {
    const o: CreateSessionOptions = typeof opts === 'string' ? { label: opts } : opts ?? {};
    if (o.sessionKey === undefined) return this.sessionManager.create(o.label);
    const key = this.newSessionKey(o.sessionKey.key);
    const { expiryHeight, spendCap } = await this.sessionKeyTerms(o.sessionKey, async () => '0');
    const handle = await this.sessionManager.create(o.label, { sessionKey: key.address, expiryHeight, spendCap });
    this.registeredKeys.set(registeredSessionKey(handle.sessionId, key.privateKey), expiryHeight);
    return { ...handle, sessionKey: keyHandle(key, expiryHeight, spendCap) };
  }

  /**
   * Renews, rotates or clears a session's registered key with MsgUpdateSessionKey. The wallet
   * signs it as a Cosmos transaction; a session key never signs a transaction.
   *
   *  - `renew` keeps the loaded key with a new expiry and cap. The key must be loaded and still be
   *    the chain's registered key (else SDK_LOCAL_SESSION_KEY_NOT_REGISTERED), and the session not
   *    CLOSED (SDK_LOCAL_SESSION_CLOSED); nothing is sent otherwise. `spendCap` defaults to the
   *    chain's current cap. The check and the transaction are not atomic: if another device
   *    rotates the key between the session read and the tx landing, the renew re-registers the
   *    old key (MsgUpdateSessionKey has no compare-and-set). Do not renew from one device while
   *    rotating from another; check sessionKeyState afterwards when that is possible.
   *  - `rotate` registers a fresh key (generated, or `rotate.key` from generateSessionKey(), never
   *    the old one) and, once the chain applied it, replaces the loaded key; `newKey` is its
   *    material, which the caller persists (see createSession). Orders the old key signed that
   *    are not admitted yet will be rejected. `spendCap` defaults to the chain's current cap, so a
   *    rotation never lifts a cap silently; when the chain has no key (never set, or cleared, which
   *    zeroes the cap) there is no cap to keep, and `spendCap` must be given
   *    (SDK_LOCAL_SESSION_KEY_INVALID otherwise, before any transaction).
   *  - `clear` removes the registration and, after success, the loaded key: the wallet signs
   *    this session's orders again.
   *
   * `spent` is never reset. `expiryBlocks` is validated as in createSession.
   */
  async updateSessionKey(sessionId: string, update: SessionKeyUpdate): Promise<UpdateSessionKeyResult> {
    const sid = sessionIdText(sessionId);
    if ('clear' in update) {
      const response = await this.cfg.chain.updateSessionKey({ sessionId: sid, action: { clear: true } });
      this.registeredKeys.delete(sid);
      return { response };
    }
    if ('renew' in update) {
      const loaded = this.registeredKeys.get(sid);
      if (loaded === undefined) {
        throw local('SDK_LOCAL_SESSION_KEY_NOT_REGISTERED', `no session key is loaded for session ${sid}: rotate, or load it with useSessionKey`);
      }
      // Renew only the chain's current key: re-registering a key that was rotated out or cleared
      // (perhaps on another device, perhaps because it leaked) would make it current again.
      const s = await this.cfg.chain.querySession(sid);
      if (s.status === 'CLOSED') throw local('SDK_LOCAL_SESSION_CLOSED', `session ${sid} is CLOSED`);
      if (s.sessionKey === undefined || !bytesEqual(s.sessionKey, loaded.address)) {
        throw local(
          'SDK_LOCAL_SESSION_KEY_NOT_REGISTERED',
          `the loaded key ${sessionKeyAddressHex(loaded.address)} is no longer the registered key of session ${sid} ` +
            '(rotated or cleared): rotate to a fresh key, or load the current one with useSessionKey',
        );
      }
      const { expiryHeight, spendCap } = await this.sessionKeyTerms(update.renew, async () => s.sessionKeySpendCap);
      const response = await this.cfg.chain.updateSessionKey({
        sessionId: sid,
        action: { set: { sessionKey: loaded.address, expiryHeight, spendCap } },
      });
      this.registeredKeys.refreshExpiry(sid, loaded.address, expiryHeight);
      return { response };
    }
    const old = this.registeredKeys.get(sid);
    const key = this.newSessionKey(update.rotate.key, old?.address);
    const { expiryHeight, spendCap } = await this.sessionKeyTerms(update.rotate, async () => {
      const s = await this.cfg.chain.querySession(sid);
      // A cleared (or never set) key has cap 0, which would register this one unlimited.
      if (s.sessionKey === undefined) {
        throw local(
          'SDK_LOCAL_SESSION_KEY_INVALID',
          `session ${sid} has no registered key, so there is no cap to keep: pass rotate.spendCap ("0" for unlimited)`,
        );
      }
      return s.sessionKeySpendCap;
    });
    const response = await this.cfg.chain.updateSessionKey({
      sessionId: sid,
      action: { set: { sessionKey: key.address, expiryHeight, spendCap } },
    });
    this.registeredKeys.set(registeredSessionKey(sid, key.privateKey), expiryHeight);
    return { response, newKey: keyHandle(key, expiryHeight, spendCap) };
  }

  /**
   * Loads a persisted registered key for a session (after a restart, or on another device). The
   * session must belong to this client's user and have exactly this key registered, and must not
   * be CLOSED; otherwise SDK_LOCAL_SESSION_KEY_NOT_REGISTERED / SDK_LOCAL_SESSION_CLOSED and
   * nothing is loaded.
   */
  async useSessionKey(sessionId: string, privateKey: Uint8Array): Promise<void> {
    const key = registeredSessionKey(sessionIdText(sessionId), privateKey);
    const s = await this.cfg.chain.querySession(key.sessionId);
    if (s.owner !== this.cfg.userAddress) {
      throw local(
        'SDK_LOCAL_SESSION_KEY_NOT_REGISTERED',
        `session ${key.sessionId} belongs to ${s.owner}, not this client's user ${this.cfg.userAddress}`,
      );
    }
    if (s.status === 'CLOSED') throw local('SDK_LOCAL_SESSION_CLOSED', `session ${key.sessionId} is CLOSED`);
    if (s.sessionKey === undefined || !bytesEqual(s.sessionKey, key.address)) {
      throw local(
        'SDK_LOCAL_SESSION_KEY_NOT_REGISTERED',
        `key ${sessionKeyAddressHex(key.address)} is not the registered session key of session ${key.sessionId}` +
          (s.sessionKey === undefined ? ' (it has none)' : ` (it has ${sessionKeyAddressHex(s.sessionKey)})`),
      );
    }
    this.registeredKeys.set(key, s.sessionKeyExpiryHeight);
  }

  /** Unloads a session's registered key; the wallet signs that session's orders again. The registration on chain is unchanged. */
  forgetSessionKey(sessionId: string): void {
    this.registeredKeys.delete(sessionId);
  }

  /** The chain's session-key state for a session (QuerySession), and whether the loaded key is the registered one. */
  async sessionKeyState(sessionId: string): Promise<SessionKeyState> {
    const s = await this.cfg.chain.querySession(sessionIdText(sessionId));
    const loaded = this.registeredKeys.get(s.sessionId);
    this.registeredKeys.refreshExpiry(s.sessionId, s.sessionKey, s.sessionKeyExpiryHeight);
    return {
      registered: s.sessionKey !== undefined,
      matchesLoadedKey: loaded !== undefined && s.sessionKey !== undefined && bytesEqual(s.sessionKey, loaded.address),
      expiryHeight: s.sessionKeyExpiryHeight,
      spendCap: s.sessionKeySpendCap,
      spent: s.sessionKeySpent,
      setHeight: s.sessionKeySetHeight,
      status: s.status,
    };
  }

  /**
   * The expiry height and spend cap of a key grant: checks the chain supports session keys and
   * that `expiryBlocks` fits `current < expiry <= current + max_session_key_blocks`.
   */
  private async sessionKeyTerms(
    o: SessionKeyOptions,
    defaultCap: () => Promise<string>,
  ): Promise<{ expiryHeight: bigint; spendCap: string }> {
    const hub = this.cfg.hub;
    if (hub?.getMaxSessionKeyBlocks === undefined) {
      throw local(
        'SDK_LOCAL_SESSION_KEY_UNSUPPORTED',
        'registering a session key needs a hub reader with getMaxSessionKeyBlocks (HubReader)',
      );
    }
    const spendCap = o.spendCap !== undefined ? canonicalSpendCap(o.spendCap) : undefined;
    const [max, latest, cap] = await Promise.all([
      hub.getMaxSessionKeyBlocks(),
      this.readLatestHeight(hub),
      spendCap !== undefined ? Promise.resolve(spendCap) : defaultCap(),
    ]);
    if (max <= 0n) {
      throw local('SDK_LOCAL_SESSION_KEY_UNSUPPORTED', 'the chain does not support session keys (max_session_key_blocks is 0)');
    }
    // The tx executes at latest + 1 or later and needs height < expiry, so 1 block never lands.
    if (max < MIN_SESSION_KEY_EXPIRY_BLOCKS) {
      throw local(
        'SDK_LOCAL_SESSION_KEY_UNSUPPORTED',
        `max_session_key_blocks ${max} leaves no expiry a transaction can land with (at least ${MIN_SESSION_KEY_EXPIRY_BLOCKS} blocks)`,
      );
    }
    // The default stays in bigint: max_session_key_blocks may exceed 2^53.
    if (o.expiryBlocks === undefined) {
      const blocks = max - 2n > MIN_SESSION_KEY_EXPIRY_BLOCKS ? max - 2n : MIN_SESSION_KEY_EXPIRY_BLOCKS;
      return { expiryHeight: latest + blocks, spendCap: cap };
    }
    const blocks = o.expiryBlocks;
    if (!Number.isSafeInteger(blocks) || BigInt(blocks) < MIN_SESSION_KEY_EXPIRY_BLOCKS || BigInt(blocks) > max) {
      throw local(
        'SDK_LOCAL_SESSION_KEY_INVALID',
        `expiryBlocks must be an integer in [${MIN_SESSION_KEY_EXPIRY_BLOCKS}, ${max}], got ${String(blocks)}`,
      );
    }
    return { expiryHeight: latest + BigInt(blocks), spendCap: cap };
  }

  /**
   * The key a registration uses: `supplied` (validated) or a new CSPRNG key; never the owner's
   * address, nor `previous` (the key being rotated out). No error carries key material.
   */
  private newSessionKey(supplied?: SessionKeyMaterial, previous?: Uint8Array): SessionKeyMaterial {
    let key: SessionKeyMaterial;
    if (supplied === undefined) {
      key = generateSessionKey();
    } else {
      if (typeof supplied !== 'object' || supplied === null) {
        throw local('SDK_LOCAL_SESSION_KEY_INVALID', 'sessionKey.key must be the material generateSessionKey() returns');
      }
      key = sessionKeyFromPrivateKey(supplied.privateKey);
      if (!(supplied.address instanceof Uint8Array) || !bytesEqual(key.address, supplied.address)) {
        throw local('SDK_LOCAL_SESSION_KEY_INVALID', 'sessionKey.key.address is not the address of its private key');
      }
    }
    const what = supplied === undefined ? 'the generated session key' : 'the supplied session key';
    const owner = canonicalAccountAddressBytes('owner', this.cfg.userAddress);
    if (bytesEqual(key.address, owner)) throw local('SDK_LOCAL_SESSION_KEY_INVALID', `${what} is the owner's address`);
    if (previous !== undefined && bytesEqual(key.address, previous)) {
      throw local('SDK_LOCAL_SESSION_KEY_INVALID', `${what} is the key being rotated out`);
    }
    return key;
  }

  getSession(sessionId: string): Promise<SessionHandle> {
    return this.sessionManager.get(sessionId);
  }

  /**
   * Place an order through OpenTask, the order-placement entry point.
   *
   * Full flow: read the on-chain context -> assemble the frozen TaskOrderV3 -> sign the order's
   * EIP-712 digest, then the request envelope (no outer order signature) -> select
   * Task Builders via task_builder_seed -> submit concurrently to all selected endpoints,
   * succeeding as soon as any one is accepted.
   *
   * Requires config.hub and config.ingressTransportFactory. The order is signed by config.wallet.
   * So is the request envelope, unless config.session is set, in which case the session key signs
   * it under a grant for the same user.
   *
   * When a registered session key is loaded for `params.sessionId` (createSession / useSessionKey),
   * that key signs both instead, and the session is read first (sharing the read that yields the
   * order sequence) to check, before anything is signed, what the chain will check at admission:
   * the session is not CLOSED (SDK_LOCAL_SESSION_CLOSED); its registered key is still the loaded
   * one (SDK_LOCAL_SESSION_KEY_NOT_REGISTERED); the latest height is at or before the key's expiry
   * (SDK_LOCAL_SESSION_KEY_EXPIRED; admission happens at the latest height + 1 or later, so an
   * order signed at latest == expiry may still be rejected); the session anchor is at or after
   * the key's registration height (SDK_LOCAL_SESSION_KEY_ANCHOR_BEFORE_SET_HEIGHT; when the SDK
   * resolved the context it first waits up to sessionKeyAnchorWaitMs for a fresh anchor that is,
   * while a caller's context is used as is); spent + max_fee fits a u64 even with an unlimited cap
   * (SDK_LOCAL_SESSION_KEY_SPEND_CAP_EXCEEDED, where the chain answers AMOUNT_OVERFLOW); and, with
   * a nonzero cap, spent + max_fee <= cap (SDK_LOCAL_SESSION_KEY_SPEND_CAP_EXCEEDED). A failed
   * check never falls back to the wallet: renew or raise the cap with updateSessionKey, load the
   * current key, or forgetSessionKey to sign with the wallet. The session read also refreshes the
   * loaded key's expiry for the request-side fallback (see IngressAuth.registeredKeys).
   *
   * Hard rule unchanged: an ingress ack is only local acceptance; the on-chain query/event is the
   * source of truth for final state.
   */
  async openTask(params: OpenTaskParams): Promise<OpenTaskResult> {
    const { hub, ingressTransportFactory } = this.cfg;
    if (!hub || !ingressTransportFactory) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_ROUTING_UNCONFIGURED',
        'openTask requires config.hub and config.ingressTransportFactory',
      );
    }
    const signer = params.orderSigner ?? 'auto';
    if (signer !== 'auto' && signer !== 'wallet') {
      throw local('SDK_LOCAL_ORDER_SIGNER_INVALID', `orderSigner must be 'auto' or 'wallet', got ${JSON.stringify(signer)}`);
    }
    const signatureChainId = this.signatureChainId();
    // These reads are independent, so they run concurrently. The fee denom and the pricing go
    // into the signature or decide whether the chain accepts the order, and a mistake in
    // either only surfaces after nexus accepted the order: the task just vanishes.
    // With a registered key loaded, one session read serves both the key prechecks and the
    // order sequence.
    // orderSigner 'wallet': as if no key were loaded (no prechecks, no key-signed envelope).
    const registered = signer === 'wallet' ? undefined : this.registeredKeys.get(params.sessionId);
    const sessionRead = registered !== undefined ? this.cfg.chain.querySession(params.sessionId) : undefined;
    const [feeDenom, pricing, orderSequence, firstResolved, stream] = await Promise.all([
      this.resolveFeeDenom(),
      params.pricing !== undefined ? Promise.resolve(params.pricing) : this.readProfilePricing(params.order),
      params.orderSequence !== undefined
        ? Promise.resolve(params.orderSequence)
        : sessionRead !== undefined
          ? sessionRead.then((s) => s.nextExpectedSequence)
          : this.nextOrderSequence(params.sessionId),
      params.context !== undefined ? Promise.resolve({ context: params.context }) : this.resolveOrderContext(),
      sessionRead,
    ]);
    if (registered !== undefined && stream !== undefined) {
      this.registeredKeys.refreshExpiry(params.sessionId, stream.sessionKey, stream.sessionKeyExpiryHeight);
    }
    let resolved: ResolvedTaskOrderContext | { context: TaskOrderChainContext } = firstResolved;
    if (registered !== undefined && stream !== undefined && !checkSessionKeyAdmission(registered, stream, resolved.context)) {
      // Only the anchor failed: it predates the key's registration (set or rotated after it).
      resolved = await this.anchorAfterSetHeight(registered, stream, resolved.context, params.context !== undefined);
    }
    const ctx = resolved.context;
    const order = buildTaskOrder(
      ctx,
      {
        ...params.order,
        userAddress: this.cfg.userAddress,
        sessionId: params.sessionId,
        orderSequence,
      },
      pricing,
    );
    if (registered !== undefined && stream !== undefined) checkSessionKeySpendCap(stream, order.maxFee.atomicUnits);
    const taskId = deriveTaskId(params.sessionId, orderSequence);
    // expiry must be a block height: nexus interprets values >= 1e12 as unix milliseconds and rejects them.
    const expiryHeight = params.expiryHeight ?? ctx.latestHeight + BigInt(this.cfg.requestTtlBlocks ?? 10);

    // Routing needs only task_id and the context, not the signature, so it runs while the
    // order is being signed (a browser wallet prompt can take seconds), and the selected
    // Builders are prewarmed as soon as they are known. The selection seed and the candidate
    // pool must use the same BuilderSet / anchor that is signed into the order: the set in
    // effect at session_anchor_height.
    const routing = resolveTaskBuilderEndpoints(hub, {
      chainId: this.cfg.chainId,
      taskId,
      builderSetHash: ctx.builderSetHash,
      sessionAnchorBlockHash: ctx.sessionAnchorBlockHash,
      sessionAnchorHeight: ctx.sessionAnchorHeight,
      ...('builderSet' in resolved ? { builderSet: resolved.builderSet } : {}),
    });
    // Handled here so a signing failure below does not leave it unobserved; awaited after signing.
    routing.then((r) => this.prewarmTaskBuilders(r.endpoints), () => undefined);

    const built = await buildOpenTaskRequest({
      order,
      payload: params.order.payload,
      sessionId: params.sessionId,
      taskId,
      expiryHeight,
      requestNonce: this.nextNonce(),
      idempotencyKey: params.idempotencyKey,
      wallet: this.cfg.wallet,
      // A registered key signs the order and the envelope, never falling back to the wallet; a
      // grant is not used alongside it.
      ...(registered !== undefined
        ? { registeredKey: registered }
        : this.sessionGrants !== undefined
          ? { session: await this.sessionGrants.current() }
          : {}),
      orderEip712: { signatureChainId, feeDenom },
      chainId: this.cfg.chainId,
      ...(params.inputMediaType !== undefined ? { inputMediaType: params.inputMediaType } : {}),
      ...(params.chunkSizeBytes !== undefined ? { chunkSizeBytes: params.chunkSizeBytes } : {}),
    });

    const { endpoints, errors } = await routing;
    if (endpoints.length === 0) {
      throw new TrueOpenError(
        'NEXUS_INGRESS',
        'TASK_BUILDER_NO_REACHABLE_ENDPOINT',
        `no reachable Task Builder nexus (${errors.length} errors)`,
        { retriable: true },
      );
    }

    // Where each Builder was actually reached: a certificate re-read can move it.
    const usedEndpoint = new Map<string, { uri: string; tlsPubkeyHash: string }>();
    const fan = await fanOutToEndpoints(built.input, endpoints, async (endpoint: TaskBuilderEndpoint, req) => {
      const submit = (serviceEndpoint: string, tlsPubkeyHash: string): Promise<OpenTaskAck> => {
        usedEndpoint.set(endpoint.address, { uri: serviceEndpoint, tlsPubkeyHash });
        return new IngressClient(ingressTransportFactory(serviceEndpoint, tlsPubkeyHash)).openTask(req);
      };
      try {
        return await submit(endpoint.serviceEndpoint, endpoint.tlsPubkeyHash ?? '');
      } catch (err) {
        // The Builder rotated its certificate and the locally cached fingerprint is
        // stale -> re-read that Builder's descriptor; if the fingerprint changed, retry with the
        // new fingerprint, otherwise the peer certificate really is wrong, so return the original error.
        if (!isTLSPubkeyMismatch(err)) throw err;
        const fresh = await rereadNexusEndpoint(hub, endpoint.address);
        if (!fresh || fresh.tlsPubkeyHash === (endpoint.tlsPubkeyHash ?? '')) throw err;
        return await submit(fresh.uri, fresh.tlsPubkeyHash);
      }
    });
    const ack = fan.ack as OpenTaskAck;
    const builders: OpenTaskBuilderResult[] = fan.results.map((r) => {
      const used = usedEndpoint.get(r.endpoint.address);
      return {
        address: r.endpoint.address,
        rank: r.endpoint.rank,
        serviceEndpoint: used?.uri ?? r.endpoint.serviceEndpoint,
        tlsPubkeyHash: used?.tlsPubkeyHash ?? r.endpoint.tlsPubkeyHash ?? '',
        ...(r.ack !== undefined ? { ack: r.ack } : {}),
        ...(r.error !== undefined ? { error: r.error } : {}),
      };
    });
    return {
      ...ack,
      taskId,
      taskHash: built.taskHash,
      context: ctx,
      endpointsTried: endpoints.length,
      feeDenom,
      builders,
      unresolvedBuilders: errors,
      orderSequence,
      orderSignedBy: registered !== undefined ? 'session-key' : 'wallet',
      ...(registered !== undefined ? { orderSignerAddress: Uint8Array.from(registered.address) } : {}),
      maxFee: BigInt(order.maxFee.atomicUnits),
      orderExpireHeight: order.orderExpireHeight,
      retryParams: retryParamsOf(params, orderSequence),
    };
  }

  /**
   * Waits until the chain decides an order openTask placed, and diagnoses a rejection.
   *
   * openTask's acks are only local acceptance: the chain's Keeper is the final authority and can
   * still refuse the order (a key rotated or cleared elsewhere, expired, a spend cap used up by
   * concurrent orders, a session closed). A refused order does not consume its sequence, so the
   * recovery is a new order, re-signed under the same order_sequence.
   *
   * The chain is the truth. It is read (QueryTask on config.taskReader) straight away and then
   * every `pollIntervalMs`: a task with this order's task_hash is `accepted`; a task for the
   * task_id with another task_hash is `superseded`. Meanwhile the task event stream of every
   * Builder that acked the order is watched, as hints only: ASSIGNMENT_FINALIZED (or
   * WORKER_ASSIGNMENT_FINALIZED / WORKER_HANDRAISES_ACCEPTED) triggers an immediate chain read;
   * ASSIGN_REJECTED / ASSIGN_TIMEOUT is recorded. A failing event stream is ignored. One
   * Builder's rejection does not prove another did not get the order admitted, so the result is
   * `rejected` only once every acked Builder has reported a rejection or a timeout and a chain
   * read started after the last report still finds no task; or, whatever the Builders
   * reported, once the latest height is past the order's order_expire_height (the Keeper can no
   * longer admit it) and a read made after that finds no task. The second rule matters because
   * the event streams are signed with this client's ingressAuth(), so with the loaded key: a
   * Builder refuses them once that key was rotated or cleared or the session closed, and such a
   * Builder never reports. A task with no valid accepted task_hash decides nothing yet. The
   * session is then read
   * (QuerySession) to diagnose the reason (`expired` is judged against the latest height at
   * diagnosis time) and whether the sequence is still free; `retry` is
   * `res.retryParams`, without `orderSequence` when the sequence moved on (then openTask reads
   * the next free one).
   *
   * The SDK never re-signs, renews, raises a cap or switches to the wallet by itself: the caller
   * decides (renew or rotate with updateSessionKey, `orderSigner: 'wallet'`, ...) and calls
   * openTask with `retry`. A re-signed order has a new task_hash, which is why the retry carries
   * a new idempotency key. Re-sending to a Builder that already holds this task_id as a terminal
   * task needs Nexus local terminal-task retry support, which is a separate Nexus requirement.
   *
   * Running out of `timeoutMs` resolves `{ kind: 'timeout' }`; aborting `signal` throws
   * ORDER_ADMISSION_WAIT_ABORTED. `timeoutMs` takes effect between reads. Every event stream is
   * closed when the wait ends. Needs config.taskReader, config.ingressTransportFactory and
   * config.hub (the latest height).
   */
  async waitForAdmission(res: OpenTaskResult, opts: WaitForAdmissionOptions = {}): Promise<AdmissionOutcome> {
    const { taskReader, ingressTransportFactory, hub } = this.cfg;
    if (taskReader === undefined || ingressTransportFactory === undefined || hub === undefined) {
      throw local(
        'SDK_LOCAL_ADMISSION_UNCONFIGURED',
        'waitForAdmission needs config.taskReader (RestChainReader), config.ingressTransportFactory and config.hub',
      );
    }
    const pollMs = opts.pollIntervalMs ?? DEFAULT_TRUST_ANCHOR_POLL_MS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_ADMISSION_WAIT_MS;
    if (typeof pollMs !== 'number' || !Number.isFinite(pollMs) || pollMs <= 0) {
      throw local('SDK_LOCAL_POLL_INTERVAL_INVALID', 'pollIntervalMs must be a positive finite number');
    }
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw local('SDK_LOCAL_TIMEOUT_INVALID', 'timeoutMs must be a positive finite number');
    }
    const taskId = res.taskId;
    const sessionId = res.retryParams.sessionId;
    const aborted = (): TrueOpenError => local('ORDER_ADMISSION_WAIT_ABORTED', `waiting for the admission of task ${taskId} was aborted`);
    if (opts.signal?.aborted === true) throw aborted();

    const deadline = Date.now() + timeoutMs;
    const done = new AbortController();
    const onAbort = (): void => done.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const abortedP = new Promise<'abort'>((resolve) => done.signal.addEventListener('abort', () => resolve('abort'), { once: true }));

    // An event wakes the wait for an immediate chain read. `woken` covers an event that lands
    // while a read is in flight: the next read then starts without sleeping.
    let woken = false;
    let wakeNow: () => void = () => undefined;
    let wakeP: Promise<'wake'> = Promise.resolve('wake');
    const rearm = (): void => {
      woken = false;
      wakeP = new Promise<'wake'>((resolve) => {
        wakeNow = () => resolve('wake');
      });
    };
    const wake = (): void => {
      woken = true;
      wakeNow();
    };

    // The Builders that accepted the order; each one's first rejection report, and a counter
    // of reports so a read can tell whether one landed after it started.
    const acked = res.builders.filter((b) => b.ack?.accepted === true);
    const reports = new Map<string, { readonly builderAddress: string; readonly eventCode: string }>();
    let reportGen = 0;
    // Each read records reportGen when it starts. The first one starts before the event streams
    // are set up (their requests are signed).
    rearm();
    let genAtRead = reportGen;
    let read = this.readAdmittedTask(taskReader, taskId);
    read.catch(() => undefined);
    const streams: AbortController[] = [];
    for (const b of acked) {
      const ac = new AbortController();
      streams.push(ac);
      void (async () => {
        try {
          const events = new IngressClient(ingressTransportFactory(b.serviceEndpoint, b.tlsPubkeyHash), this.ingressAuth());
          for await (const ev of events.getTaskEvents({ sessionId, taskId, signal: ac.signal })) {
            if (ADMISSION_REJECT_EVENTS.has(ev.eventCode)) {
              if (!reports.has(b.address)) {
                reports.set(b.address, { builderAddress: b.address, eventCode: ev.eventCode });
                reportGen += 1;
                wake();
              }
            } else if (ADMISSION_HINT_EVENTS.has(ev.eventCode)) {
              wake();
            }
          }
        } catch {
          // A hint only: polling does not depend on it.
        }
      })();
    }

    const race = async <T>(p: Promise<T>): Promise<T> => {
      const r = await Promise.race([p, abortedP]);
      if (r === 'abort') throw aborted();
      return r as T;
    };
    // A task without a valid accepted task_hash decides nothing yet (keep polling).
    const decided = (task: ChainTaskSnapshot): AdmissionOutcome | undefined =>
      !isHash32Text(task.acceptedTaskHash)
        ? undefined
        : task.acceptedTaskHash === res.taskHash
          ? { kind: 'accepted', taskId }
          : { kind: 'superseded', taskId, chainTaskHash: task.acceptedTaskHash };
    // No task for task_id, and either every acked Builder reported or the order's deadline has
    // passed: read the session and diagnose. Undefined when a re-read finds a task with no
    // valid hash yet (keep polling).
    const rejected = async (): Promise<AdmissionOutcome | undefined> => {
      const session = await race(this.cfg.chain.querySession(sessionId));
      const sequenceFree = session.nextExpectedSequence === res.orderSequence;
      if (!sequenceFree) {
        // The sequence moved on: perhaps this very order was admitted after the read above.
        const again = await race(this.readAdmittedTask(taskReader, taskId));
        if (again !== undefined) return decided(again);
      }
      const reason = await race(this.rejectionReason(res, session));
      const diagnosis: RejectionDiagnosis = { sequenceFree, reason, events: [...reports.values()], session };
      let retry: OpenTaskParams = res.retryParams;
      if (!sequenceFree) {
        const { orderSequence: _, ...rest } = retry;
        void _;
        retry = rest;
      }
      return { kind: 'rejected', taskId, diagnosis, retry };
    };

    // The Keeper cannot admit the order once the latest height is past its order_expire_height.
    // `pastDeadline` is set from a height read; a read that starts after that and finds no task
    // is a rejection whatever the Builders reported (a Builder may refuse the event stream, for
    // example when the key that signs it was rotated or cleared). `deadlineAtRead` is the flag
    // when the current read started.
    let pastDeadline = false;
    let deadlineAtRead = false;

    try {
      for (;;) {
        const task = await race(read);
        if (task !== undefined) {
          const out = decided(task);
          if (out !== undefined) return out;
        } else if (deadlineAtRead || (acked.length > 0 && reports.size === acked.length && genAtRead === reportGen)) {
          const out = await rejected();
          if (out !== undefined) return out;
        } else if (!pastDeadline && (await race(this.readLatestHeight(hub))) > res.orderExpireHeight) {
          // Confirm with one more read, straight away.
          pastDeadline = true;
          rearm();
          genAtRead = reportGen;
          deadlineAtRead = true;
          read = this.readAdmittedTask(taskReader, taskId);
          continue;
        }
        const left = deadline - Date.now();
        if (left <= 0) return { kind: 'timeout', taskId };
        if (!woken) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const slept = new Promise<'tick'>((resolve) => {
            timer = setTimeout(() => resolve('tick'), Math.min(pollMs, left));
          });
          try {
            await race(Promise.race([slept, wakeP]));
          } finally {
            clearTimeout(timer);
          }
        }
        rearm();
        genAtRead = reportGen;
        deadlineAtRead = pastDeadline;
        read = this.readAdmittedTask(taskReader, taskId);
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      for (const ac of streams) ac.abort();
      done.abort();
    }
  }

  /** The chain's task for task_id, or undefined while there is none (node answers 404). */
  private async readAdmittedTask(reader: OutputTaskReader, taskId: string): Promise<ChainTaskSnapshot | undefined> {
    try {
      return await reader.queryTask(taskId);
    } catch (e) {
      if (e instanceof TrueOpenError && e.code === 'CHAIN_QUERY_NOT_FOUND') return undefined;
      throw e;
    }
  }

  /** Why the chain most likely refused `res`, from the session state read after the rejection. */
  private async rejectionReason(res: OpenTaskResult, s: StreamStateView): Promise<RejectionReason> {
    if (s.status === 'CLOSED') return 'session-closed';
    if (res.orderSignedBy !== 'session-key' || res.orderSignerAddress === undefined) return 'unrelated';
    if (s.sessionKey === undefined) return 'cleared';
    if (!bytesEqual(s.sessionKey, res.orderSignerAddress)) return 'rotated';
    if ((await this.latestHeight('the session key expiry')) > s.sessionKeyExpiryHeight) return 'expired';
    if (res.context.sessionAnchorHeight < s.sessionKeySetHeight) return 'anchor-before-set-height';
    const cap = BigInt(s.sessionKeySpendCap);
    const total = BigInt(s.sessionKeySpent) + res.maxFee;
    // Past u64 the chain refuses even an unlimited cap (AMOUNT_OVERFLOW).
    if ((cap !== 0n && total > cap) || total > U64_MAX) return 'spend-cap';
    return 'unrelated';
  }

  /**
   * A context whose anchor is at or after the registered key's set_height. A caller's context is
   * used as is, so an older anchor is refused (not retriable: pass a newer context). Otherwise
   * the latest height is polled, for at most sessionKeyAnchorWaitMs, until a fresh anchor
   * (latest - anchorLag) reaches set_height; then one fresh context is resolved and rechecked.
   */
  private async anchorAfterSetHeight(
    key: RegisteredSessionKey,
    s: StreamStateView,
    current: TaskOrderChainContext,
    callerContext: boolean,
  ): Promise<ResolvedTaskOrderContext | { context: TaskOrderChainContext }> {
    const setHeight = s.sessionKeySetHeight;
    const refuse = (anchorHeight: bigint, retriable: boolean, hint: string): TrueOpenError =>
      local(
        'SDK_LOCAL_SESSION_KEY_ANCHOR_BEFORE_SET_HEIGHT',
        `the session key was registered at height ${setHeight}, after the order's session anchor ${anchorHeight}: ${hint}`,
        { retriable, details: { setHeight, anchorHeight } },
      );
    if (callerContext) throw refuse(current.sessionAnchorHeight, false, 'pass a newer context');
    const hub = this.cfg.hub!;
    const reuse = this.cfg.orderContextReuse;
    const lag = (reuse !== false ? reuse?.anchorLag : undefined) ?? DEFAULT_ANCHOR_LAG;
    const waitMs = this.cfg.sessionKeyAnchorWaitMs ?? DEFAULT_SESSION_KEY_ANCHOR_WAIT_MS;
    const pollMs = this.cfg.sessionKeyAnchorPollMs ?? DEFAULT_TRUST_ANCHOR_POLL_MS;
    const deadline = Date.now() + waitMs;
    for (;;) {
      if ((await this.readLatestHeight(hub)) - lag >= setHeight) break;
      const left = deadline - Date.now();
      if (left <= 0) throw refuse(current.sessionAnchorHeight, true, `no fresh anchor reached it within ${waitMs} ms; retry shortly`);
      await new Promise((r) => setTimeout(r, Math.min(pollMs, left)));
    }
    this.contextCache?.invalidate();
    const fresh = await this.resolveOrderContext();
    if (!checkSessionKeyAdmission(key, s, fresh.context)) {
      throw refuse(fresh.context.sessionAnchorHeight, true, 'retry shortly');
    }
    return fresh;
  }

  /**
   * The order's EIP-712 feeDenom: the chain business_denom, cross-checked against the
   * optional config override (see resolveFeeDenom).
   */
  async resolveFeeDenom(): Promise<string> {
    const read = this.cfg.hub?.getBusinessDenom;
    const chainDenom = read !== undefined ? await read.call(this.cfg.hub) : undefined;
    return resolveFeeDenom(chainDenom, this.cfg.feeDenom);
  }

  /** A fresh or anchor-reusing order context (see TrueOpenClientConfig.orderContextReuse). */
  private async resolveOrderContext(): Promise<ResolvedTaskOrderContext> {
    const hub = this.cfg.hub!;
    return this.contextCache !== undefined
      ? this.contextCache.resolve()
      : resolveTaskOrderContextWithBuilderSet(hub, this.cfg.chainId);
  }

  /**
   * The Task Builders an order would be sent to, before anything is signed: the selection
   * depends only on task_id (session_id + order_sequence) and the order context. openTask
   * resolves them itself (while signing); call this to prewarm connections even earlier, for
   * example while the user is still typing. Pass the returned `context` to openTask so the
   * order is signed against the same anchor and BuilderSet; a different context selects
   * different Builders.
   */
  async resolveTaskBuilders(p: {
    readonly sessionId: string;
    /** Defaults to the on-chain next order sequence. */
    readonly orderSequence?: bigint;
    /** Defaults to a fresh (or anchor-reusing) context. */
    readonly context?: TaskOrderChainContext;
  }): Promise<{
    readonly taskId: string;
    readonly orderSequence: bigint;
    readonly context: TaskOrderChainContext;
    readonly endpoints: readonly TaskBuilderEndpoint[];
    readonly unresolvedBuilders: readonly { readonly address: string; readonly error: unknown }[];
  }> {
    const hub = this.cfg.hub;
    if (hub === undefined) {
      throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_ROUTING_UNCONFIGURED', 'resolveTaskBuilders requires config.hub');
    }
    const [orderSequence, resolved] = await Promise.all([
      p.orderSequence !== undefined ? Promise.resolve(p.orderSequence) : this.nextOrderSequence(p.sessionId),
      p.context !== undefined ? Promise.resolve({ context: p.context }) : this.resolveOrderContext(),
    ]);
    const ctx = resolved.context;
    const taskId = deriveTaskId(p.sessionId, orderSequence);
    const { endpoints, errors } = await resolveTaskBuilderEndpoints(hub, {
      chainId: this.cfg.chainId,
      taskId,
      builderSetHash: ctx.builderSetHash,
      sessionAnchorBlockHash: ctx.sessionAnchorBlockHash,
      sessionAnchorHeight: ctx.sessionAnchorHeight,
      ...('builderSet' in resolved ? { builderSet: resolved.builderSet } : {}),
    });
    return { taskId, orderSequence, context: ctx, endpoints, unresolvedBuilders: errors };
  }

  /**
   * Opens connections to these Builders concurrently through config.ingressPrewarm (a no-op
   * without it). Never rejects: a Builder that cannot be reached shows up when the real
   * request is made.
   */
  async prewarmTaskBuilders(endpoints: readonly Pick<TaskBuilderEndpoint, 'serviceEndpoint' | 'tlsPubkeyHash'>[]): Promise<void> {
    const prewarm = this.cfg.ingressPrewarm;
    if (prewarm === undefined) return;
    await Promise.all(
      endpoints.map(async (e) => {
        try {
          await prewarm(e.serviceEndpoint, e.tlsPubkeyHash ?? '');
        } catch {
          // Best effort only.
        }
      }),
    );
  }

  /** Profile pricing for the local order-value checks; refuses to sign when it cannot be read. */
  private async readProfilePricing(order: TaskOrderIntent): Promise<ProfilePricing> {
    const hub = this.cfg.hub;
    if (hub?.getProfile === undefined) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_PRICING_UNAVAILABLE',
        'openTask needs the profile pricing to check min_order_value and max_fee before signing: ' +
          'use a hub reader with getProfile (HubReader), or pass params.pricing',
      );
    }
    const profile = await hub.getProfile(order.modelId, BigInt(order.profileVersion));
    return profile.pricing;
  }

  /**
   * The next available order_sequence for this session in the on-chain StreamState.
   * Note this is a point-in-time read: concurrent orders on the same session must be serialized
   * by the caller, otherwise the second order will collide on the sequence number.
   */
  async nextOrderSequence(sessionId: string): Promise<bigint> {
    const stream = await this.cfg.chain.querySession(sessionId);
    return stream.nextExpectedSequence;
  }

  /** Cancels a pending order. MsgCancelOrder is authorized by the account signature alone. */
  async cancelOrder(sessionId: string, orderSequence: bigint): Promise<CancelOrderResult> {
    return this.cfg.chain.cancelOrder({ sessionId, orderSequence });
  }

  /** A local, nexus-side snapshot of task status (informational only; the chain query is authoritative). */
  taskStatus(sessionId: string, taskId: string): Promise<TaskStatusView> {
    return this.ingress.getTaskStatus(sessionId, taskId);
  }

  /**
   * Subscribe to the task event stream (for UX feedback and reconnect recovery; feeding a
   * state-machine reducer is left to the caller). Abort `opts.signal` to close the request when
   * giving up on it; it cancels only this stream, not the transport.
   */
  watchTask(
    sessionId: string,
    taskId: string,
    fromCursor?: string,
    opts?: { readonly signal?: AbortSignal },
  ): AsyncIterable<GetTaskEventsResponse> {
    return this.ingress.getTaskEvents({
      sessionId,
      taskId,
      ...(fromCursor !== undefined ? { fromCursor } : {}),
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }

  /**
   * Derive what an output is verified against from chain queries, so callers never paste
   * hashes or keys:
   *  - `task/{task_id}` -> accepted task_hash and winner Worker;
   *  - `current_service_key/PARTICIPANT_TYPE_CORTEX/{winner}` -> the Worker's service key
   *    (must be ACTIVE);
   *  - `task/{task_id}/infer_receipt` -> output_hash (the MMR root), size and leaf count.
   *
   * The receipt lands one generation after the winner, so streaming does not need it: pass
   * `withReceipt: false` to skip that read. A task not on chain yet (node answers 404), a missing
   * winner, or a missing receipt when one is asked for, is a retriable
   * `OUTPUT_TRUST_ANCHOR_PENDING`: poll and call again (waitForOutputTrustAnchors does this). A
   * task that settled or failed without a winner (task phase SETTLED / FAILED, or the terminal
   * arm after compaction) never gets one, so that is a final `OUTPUT_TRUST_ANCHOR_NO_WINNER`.
   *
   * Needs config.taskReader (RestChainReader) and a hub reader with getCurrentServiceKey.
   *
   * These anchors are the root of everything the output is checked against, and they are only
   * as trustworthy as the endpoints those two readers point at. A plaintext REST URL means
   * whoever is on the network path chooses the task_hash, the winner and the output_hash, and
   * every later check then confirms their answer. Point both readers at an endpoint you
   * authenticate, or pass taskHash / outputHash / workerServicePubKey explicitly.
   */
  async resolveOutputTrustAnchors(
    taskId: string,
    opts?: { readonly withReceipt?: boolean },
  ): Promise<OutputTrustAnchors> {
    const { taskReader, hub } = this.cfg;
    if (taskReader === undefined || hub?.getCurrentServiceKey === undefined) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_TRUST_ANCHORS_UNCONFIGURED',
        'deriving output trust anchors needs config.taskReader (RestChainReader) and a hub reader with ' +
          'getCurrentServiceKey (HubReader); otherwise pass taskHash / outputHash / workerServicePubKey explicitly',
      );
    }
    const pending = (what: string): TrueOpenError =>
      new TrueOpenError('CHAIN_REJECT', 'OUTPUT_TRUST_ANCHOR_PENDING', `task ${taskId}: ${what}`, { retriable: true });

    let task: ChainTaskSnapshot;
    try {
      task = await taskReader.queryTask(taskId);
    } catch (e) {
      // Between nexus accepting the order and the chain including it, node answers 404: the
      // task is not there yet, which is a state to poll on, not a final failure.
      if (e instanceof TrueOpenError && e.code === 'CHAIN_QUERY_NOT_FOUND') {
        throw new TrueOpenError('CHAIN_REJECT', 'OUTPUT_TRUST_ANCHOR_PENDING', `task ${taskId}: not on chain yet`, {
          retriable: true,
          cause: e,
        });
      }
      throw e;
    }
    // A task that settled or failed never gets a winner: on the active arm (before cleanup
    // compaction) the phase says so, on the terminal arm the arm itself does.
    const phase = task.view === 'terminal' ? task.terminalPhase : task.taskPhase;
    const ended = task.view === 'terminal' || phase === 'SETTLED' || phase === 'FAILED';
    if (ended && task.winnerWorker === '') {
      throw new TrueOpenError(
        'CHAIN_REJECT',
        'OUTPUT_TRUST_ANCHOR_NO_WINNER',
        `task ${taskId} ended (${phase || 'terminal'}) without a winner Worker`,
      );
    }
    const taskHash = task.acceptedTaskHash;
    if (!isHash32Text(taskHash)) throw pending('no accepted task_hash on chain yet');
    if (task.winnerWorker === '') throw pending('no winner Worker on chain yet');

    const key = await hub.getCurrentServiceKey.call(hub, PARTICIPANT_TYPE.CORTEX, task.winnerWorker);
    if (key.status !== 'ACTIVE') {
      throw new TrueOpenError(
        'CHAIN_REJECT',
        'OUTPUT_TRUST_ANCHOR_WORKER_KEY_INACTIVE',
        `winner Worker ${task.winnerWorker} service key status is ${key.status || 'unset'}, not ACTIVE`,
      );
    }
    const base = { taskId, taskHash, winnerWorker: task.winnerWorker, workerServicePubKey: key.servicePubKey };
    if (opts?.withReceipt === false) return base;

    const receipt = await taskReader.queryInferReceipt(taskId);
    if (receipt === undefined) throw pending('no accepted InferReceipt on chain yet');
    if (receipt.winnerWorker !== task.winnerWorker) {
      throw new TrueOpenError(
        'CHAIN_REJECT',
        'OUTPUT_TRUST_ANCHOR_INCONSISTENT',
        `InferReceipt winner ${receipt.winnerWorker} != task winner ${task.winnerWorker}`,
      );
    }
    return { ...base, receipt, outputHash: receipt.outputHash };
  }

  /**
   * Wait until the chain names the task's winner, then return the streaming anchors
   * (resolveOutputTrustAnchors with `withReceipt: false`), ready to pass to streamOutput as
   * taskHash / workerServicePubKey.
   *
   * The chain is read once straight away, then every `pollIntervalMs`. With `sessionId`, the
   * client's Builder event stream is watched too: the first ASSIGNMENT_FINALIZED event triggers
   * one immediate read. If a read is already in flight then, the event's read starts at once
   * alongside it instead of waiting for it; the first read to find the winner wins, and an
   * older read's "not yet" never overrides a newer read. The event is only a hint, so a failed
   * or silent event stream changes nothing and polling carries on. Each read is the task, then
   * the winner's key, in order, and the event stream is closed when the wait ends. `signal`
   * takes effect at once; `timeoutMs` takes effect between reads (a single chain read is
   * bounded only by the reader's own limits).
   *
   * Only `OUTPUT_TRUST_ANCHOR_PENDING` is waited out; any other error (an inactive Worker key, a
   * task that ended without a winner, a failed read) is thrown at once. Running out of
   * `timeoutMs` throws `OUTPUT_TRUST_ANCHOR_TIMEOUT`; aborting `signal` throws
   * `OUTPUT_TRUST_ANCHOR_WAIT_ABORTED`.
   */
  async waitForOutputTrustAnchors(taskId: string, opts: WaitForOutputTrustAnchorsOptions = {}): Promise<OutputTrustAnchors> {
    return this.waitForAnchorsWithEvents(taskId, opts, this.ingress);
  }

  /** waitForOutputTrustAnchors, with the event hint read from `events` (an IngressClient for some Builder). */
  private async waitForAnchorsWithEvents(
    taskId: string,
    opts: WaitForOutputTrustAnchorsOptions,
    events: Pick<IngressClient, 'getTaskEvents'>,
  ): Promise<OutputTrustAnchors> {
    const pollMs = opts.pollIntervalMs ?? DEFAULT_TRUST_ANCHOR_POLL_MS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TRUST_ANCHOR_WAIT_MS;
    if (!Number.isFinite(pollMs) || pollMs <= 0) {
      throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_POLL_INTERVAL_INVALID', 'pollIntervalMs must be a positive finite number');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_TIMEOUT_INVALID', 'timeoutMs must be a positive finite number');
    }
    const aborted = (): TrueOpenError =>
      new TrueOpenError('SDK_LOCAL', 'OUTPUT_TRUST_ANCHOR_WAIT_ABORTED', `waiting for task ${taskId} anchors was aborted`);
    if (opts.signal?.aborted === true) throw aborted();

    const deadline = Date.now() + timeoutMs;
    // Ends this wait. Aborting cancels only this wait's own requests; the transport and its
    // connection stay up.
    const done = new AbortController();
    const onAbort = (): void => done.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const abortedP = new Promise<'abort'>((resolve) => done.signal.addEventListener('abort', () => resolve('abort'), { once: true }));

    // The event triggers at most one extra read. `kicked` records that it fired; `kickUsed`
    // that the extra read was started.
    let kicked = false;
    let kickUsed = false;
    let fireKick!: () => void;
    const kickP = new Promise<'kick'>((resolve) => {
      fireKick = () => resolve('kick');
    });
    // The event stream has its own controller so it can close right after its one trigger.
    const eventsDone = new AbortController();

    // Reads carry a generation number. Only the newest read's PENDING or error counts: an
    // older read that is still in flight when a newer one starts can only win by succeeding,
    // never by overwriting the newer read's answer with an older "not yet".
    type ReadOutcome =
      | { readonly gen: number; readonly ok: true; readonly value: OutputTrustAnchors }
      | { readonly gen: number; readonly ok: false; readonly error: unknown };
    let gen = 0;
    const inflight = new Map<number, Promise<ReadOutcome>>();
    const startRead = (): void => {
      const g = ++gen;
      inflight.set(
        g,
        this.resolveOutputTrustAnchors(taskId, { withReceipt: false }).then(
          (value): ReadOutcome => ({ gen: g, ok: true, value }),
          (error: unknown): ReadOutcome => ({ gen: g, ok: false, error }),
        ),
      );
    };

    try {
      if (opts.sessionId !== undefined) {
        const stream = events.getTaskEvents({ sessionId: opts.sessionId, taskId, signal: eventsDone.signal });
        void (async () => {
          try {
            for await (const ev of stream) {
              if (ev.eventCode === ASSIGNMENT_FINALIZED_EVENT) {
                kicked = true;
                fireKick();
                eventsDone.abort();
                return;
              }
            }
          } catch {
            // A hint only: polling does not depend on it.
          }
        })();
      }

      startRead();
      for (;;) {
        let last: TrueOpenError | undefined;
        while (inflight.size > 0) {
          if (kicked && !kickUsed) {
            // The event landed while a read was in flight: read again now rather than after it.
            kickUsed = true;
            startRead();
          }
          const r = await Promise.race<ReadOutcome | 'abort' | 'kick'>([
            ...inflight.values(),
            abortedP,
            ...(kickUsed ? [] : [kickP]),
          ]);
          if (r === 'abort') throw aborted();
          if (r === 'kick') continue;
          inflight.delete(r.gen);
          if (r.ok) return r.value;
          // A stale read's "not yet" (or failure) says nothing the newer read will not.
          if (r.gen !== gen) continue;
          const e = r.error;
          if (!(e instanceof TrueOpenError && e.code === 'OUTPUT_TRUST_ANCHOR_PENDING')) throw e;
          last = e;
          inflight.clear();
        }
        if (done.signal.aborted) throw aborted();
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new TrueOpenError('SDK_LOCAL', 'OUTPUT_TRUST_ANCHOR_TIMEOUT', `task ${taskId}: no winner on chain within ${timeoutMs} ms`, {
            cause: last,
          });
        }
        if (!(kicked && !kickUsed)) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const slept = new Promise<'tick'>((resolve) => {
            timer = setTimeout(() => resolve('tick'), Math.min(pollMs, left));
          });
          const r = await Promise.race<'tick' | 'abort' | 'kick'>([slept, abortedP, ...(kickUsed ? [] : [kickP])]);
          clearTimeout(timer);
          if (r === 'abort') throw aborted();
        }
        // A read started after the event (or straight after the sleep it cut short) is the
        // event's one read.
        if (kicked) kickUsed = true;
        startRead();
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      eventsDone.abort();
      done.abort();
    }
  }

  /**
   * Retrieve the OUTPUT body over the task data plane:
   * GetTaskDataMetadata gets size / chunk_lengths / output_leaf_count ->
   * FetchTaskData fetches the bytes in ranges -> re-split into chunks per chunk_lengths ->
   * compute the MMR root and compare it against the receipt's output_hash.
   *
   * **Verification criterion**: output_hash is no longer a whole-object
   * sha256, it is the MMR root of the ordered chunk list under TRUEOPEN_OUTPUT_MMR_V1. Chunk
   * boundaries are part of the commitment, so re-splitting must follow chunk_lengths exactly --
   * merging or re-segmenting chunks yourself produces a different root for the same underlying bytes.
   *
   * **Trust anchors**: taskHash and outputHash default to resolveOutputTrustAnchors (the
   * accepted task and InferReceipt on chain); explicit values override them. When the receipt
   * is known, the metadata's size and leaf count must match it.
   *
   * **Ranges**: nexus refuses any single read larger than its max range (8 MiB by default),
   * so the object is fetched in ranges of at most `maxRangeBytes`. Every range's
   * served_range and chunk offsets are checked, the total never exceeds the metadata size,
   * and a range that fails on transport is retried (with a freshly signed request) without
   * refetching the ranges already received. A size-0 object is not fetched at all.
   *
   * builderAddress must be the operator address of the Builder being queried (nexus compares
   * it against its own configuration; openTask returns it per Builder). expiresAtHeight is a
   * block height and defaults to latest height + taskDataExpiryBlocks (10), which must fit the
   * Builders' max_service_material_expiry_blocks.
   */
  async fetchTaskOutput(p: {
    sessionId: string;
    taskId: string;
    /** Hash32 text (`0x` + 64 lowercase hex), the on-chain accepted_task_hash. Defaults to the chain value. */
    taskHash?: string;
    /** Hash32 text (`0x` + 64 lowercase hex), the on-chain InferReceipt.output_hash (= MMR root). Defaults to the chain value. */
    outputHash?: string;
    /** Anchors already resolved by the caller; saves the chain reads. */
    anchors?: OutputTrustAnchors;
    builderAddress: string;
    expiresAtHeight?: bigint;
    /** Largest range per FetchTaskData call; defaults to 8 MiB (nexus's default max range). */
    maxRangeBytes?: number;
    /** Attempts per range for transport failures; default 3. */
    rangeAttempts?: number;
  }): Promise<{
    bytes: Uint8Array;
    text: string;
    outputHash: string;
    taskHash: string;
    chunks: Uint8Array[];
    sizeBytes: bigint;
    mediaType: string;
    /** The accepted InferReceipt the output was checked against, when it was read. */
    receipt?: InferReceiptView;
  }> {
    const maxRange = BigInt(p.maxRangeBytes ?? DEFAULT_MAX_RANGE_BYTES);
    if (maxRange <= 0n) throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_RANGE_INVALID', 'maxRangeBytes must be positive');
    const attempts = p.rangeAttempts ?? 3;

    let anchors = p.anchors;
    if (anchors === undefined && (p.taskHash === undefined || p.outputHash === undefined)) {
      anchors = await this.resolveOutputTrustAnchors(p.taskId);
    }
    const taskHash = p.taskHash ?? anchors?.taskHash;
    const outputHash = p.outputHash ?? anchors?.outputHash;
    if (taskHash === undefined || outputHash === undefined) {
      throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_TRUST_ANCHORS_MISSING', 'taskHash and outputHash are both required');
    }
    strictHash32('task_hash', taskHash);
    strictHash32('output_hash', outputHash);
    // The receipt only binds the size when it is the receipt for this output hash.
    const receipt = anchors?.receipt !== undefined && anchors.receipt.outputHash === outputHash ? anchors.receipt : undefined;

    const expiry = async (): Promise<bigint> => p.expiresAtHeight ?? (await this.defaultTaskDataExpiry());
    const objectRef = {
      taskHash,
      sessionId: p.sessionId,
      taskId: p.taskId,
      objectKind: TASK_DATA_OBJECT_KIND.OUTPUT,
      contentHash: outputHash,
    };

    const meta = await this.ingress.getTaskDataMetadata({ objectRef, builderAddress: p.builderAddress, expiresAtHeight: await expiry() });
    if (!meta) {
      throw dataError('DATA_OUTPUT_NOT_FOUND', `no OUTPUT object for task ${p.taskId}`);
    }
    if (receipt !== undefined && (meta.sizeBytes !== receipt.outputSizeBytes || meta.outputLeafCount !== receipt.outputLeafCount)) {
      throw dataError(
        'DATA_OUTPUT_SIZE_MISMATCH',
        `metadata says ${meta.sizeBytes} bytes / ${meta.outputLeafCount} leaves, the accepted receipt says ` +
          `${receipt.outputSizeBytes} bytes / ${receipt.outputLeafCount} leaves`,
      );
    }
    if (meta.sizeBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw dataError('DATA_OUTPUT_SIZE_MISMATCH', `metadata size ${meta.sizeBytes} is not addressable`);
    }
    // Check the split plan before spending any bandwidth on it.
    const lengths = meta.sizeBytes === 0n && meta.chunkLengths.length === 0 ? [0] : meta.chunkLengths;
    const bytes = new Uint8Array(Number(meta.sizeBytes));
    const chunks = splitByChunkLengths(bytes, lengths);
    if (meta.outputLeafCount !== BigInt(chunks.length)) {
      throw dataError(
        'DATA_OUTPUT_LEAF_COUNT_MISMATCH',
        `chunk_lengths has ${chunks.length} entries but output_leaf_count is ${meta.outputLeafCount}`,
      );
    }

    // A size-0 object has nothing to fetch, and nexus refuses any range into it.
    for (let offset = 0n; offset < meta.sizeBytes; ) {
      const range: ByteRange = { offset, length: minBig(maxRange, meta.sizeBytes - offset) };
      const got = await retryTransient(attempts, async () =>
        this.ingress.fetchTaskDataRange({
          objectRef,
          builderAddress: p.builderAddress,
          expiresAtHeight: await expiry(),
          range,
        }),
      );
      if (got.totalSizeBytes !== meta.sizeBytes) {
        throw dataError(
          'DATA_OUTPUT_SIZE_MISMATCH',
          `FetchTaskData says the object is ${got.totalSizeBytes} bytes, metadata says ${meta.sizeBytes}`,
        );
      }
      // fetchTaskDataRange already checked served_range == range and the byte count.
      bytes.set(got.bytes, Number(offset));
      offset += range.length;
    }

    const got = hash32Text(outputMmrRoot(chunks));
    if (got !== outputHash) {
      throw dataError(
        'DATA_OUTPUT_HASH_MISMATCH',
        `MMR root of ${chunks.length} chunks = ${got}, receipt output_hash = ${outputHash}`,
      );
    }

    return {
      // bytes is the committed object verbatim; text is the presented view with the chat
      // template's trailing EOS marker stripped. They differ only by that suffix.
      bytes,
      text: stripChatTemplateEos(new TextDecoder().decode(bytes)),
      outputHash: got,
      taskHash,
      chunks,
      sizeBytes: meta.sizeBytes,
      mediaType: meta.mediaType,
      ...(receipt !== undefined ? { receipt } : {}),
    };
  }

  /** Task-data request expiry: latest height + taskDataExpiryBlocks (default 10). */
  private async defaultTaskDataExpiry(): Promise<bigint> {
    const hub = this.cfg.hub;
    if (hub === undefined) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_EXPIRY_UNCONFIGURED',
        'expiresAtHeight is required when config.hub is not set (it is a block height)',
      );
    }
    return (await this.readLatestHeight(hub)) + BigInt(this.cfg.taskDataExpiryBlocks ?? DEFAULT_TASK_DATA_EXPIRY_BLOCKS);
  }

  /**
   * Subscribe to output as a stream. Yields verified text segments frame by frame.
   *
   * The Builder forwards Worker-signed frames as-is without adding its own signature, so
   * verification happens entirely on the client side, with two checks per frame:
   *  1. the locally computed MMR root over the first seq+1 leaves must equal the frame's mmr_root;
   *  2. the Worker service key's signature over TRUEOPEN_OUTPUT_CHUNK_V1(chain_id, task_hash, seq, mmr_root)
   *     must verify.
   * If either check fails, an error is thrown and the stream stops -- accepting frames first and
   * asking questions later would let a "streamed one thing, committed to another" fault pass silently.
   *
   * Resuming after a disconnect: `verifier.resumeAfterSeq` is the last segment index verified
   * locally; re-subscribing to **any** Task Builder with it picks up where it left off (frames
   * carry their own signature, so switching Builders doesn't affect verifiability). seq alone is
   * not enough to restore MMR state; `checkpoint` also holds the peaks and already-verified
   * chunks. When `sources` is non-empty, the stream rotates to the next source after a disconnect,
   * idle timeout, bad frame, or sequence gap; duplicate frames are fully re-verified but not
   * re-delivered to the caller.
   *
   * The stream is complete only once a Fin arrives whose `final_seq` and `output_mmr_root` match
   * the locally verified prefix and whose Worker signature verifies (see `finSignaturePolicy`).
   * The on-chain InferReceipt.output_hash remains the authoritative final commitment.
   */
  async *streamOutput(p: StreamOutputParams): AsyncIterable<OutputStreamEvent> {
    const aborted = (): TrueOpenError =>
      new TrueOpenError('SDK_LOCAL', 'OUTPUT_STREAM_ABORTED', `output stream for task ${p.taskId} was aborted`);
    if (p.signal?.aborted === true) throw aborted();

    // Early subscribe: the anchors are waited for while the subscription is already open.
    const explicitAnchors = p.taskHash !== undefined && p.workerServicePubKey !== undefined;
    const early = !explicitAnchors && (p.pendingAnchors !== undefined || (p.waitForAnchors !== undefined && p.waitForAnchors !== false));

    let verifier: OutputStreamVerifier | undefined;
    let taskHash: Uint8Array = new Uint8Array();
    let workerServicePubKey: Uint8Array = new Uint8Array();
    const setAnchors = (taskHashHex: string, key: Uint8Array): OutputStreamVerifier => {
      taskHash = strictHash32('task_hash', taskHashHex);
      workerServicePubKey = key;
      const v = new OutputStreamVerifier({ chainId: this.cfg.chainId, taskHash, workerServicePubKey }, p.checkpoint);
      if (p.resumeAfterSeq !== undefined && p.resumeAfterSeq !== v.resumeAfterSeq) {
        throw new TrueOpenError(
          'SDK_LOCAL',
          'OUTPUT_STREAM_RESUME_CURSOR_MISMATCH',
          `resumeAfterSeq=${p.resumeAfterSeq} does not match checkpoint cursor ${v.resumeAfterSeq}`,
        );
      }
      return v;
    };

    if (p.resumeAfterSeq !== undefined && p.checkpoint === undefined) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'OUTPUT_STREAM_RESUME_CHECKPOINT_REQUIRED',
        'resumeAfterSeq alone cannot restore MMR state; pass checkpoint returned by OutputStreamVerifier.checkpoint()',
      );
    }
    if (!early) {
      // Anchors default to the chain: the accepted task_hash and the winner Worker's current
      // service key. The receipt is not needed (and usually not there yet) while streaming.
      let taskHashHex = p.taskHash;
      let key = p.workerServicePubKey;
      if (taskHashHex === undefined || key === undefined) {
        const anchors = await this.resolveOutputTrustAnchors(p.taskId, { withReceipt: false });
        taskHashHex ??= anchors.taskHash;
        key ??= anchors.workerServicePubKey;
      }
      verifier = setAnchors(taskHashHex, key);
    }
    // Without a verifier yet, the subscription cursor comes from the checkpoint alone; the
    // verifier rechecks the checkpoint against the anchors once they arrive.
    const checkpointLeafCount = p.checkpoint?.mmr.leafCount ?? 0n;
    if (early && p.resumeAfterSeq !== undefined && p.resumeAfterSeq !== checkpointLeafCount - 1n) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'OUTPUT_STREAM_RESUME_CURSOR_MISMATCH',
        `resumeAfterSeq=${p.resumeAfterSeq} does not match checkpoint cursor ${checkpointLeafCount - 1n}`,
      );
    }
    if (p.idleTimeoutMs !== undefined && (!Number.isFinite(p.idleTimeoutMs) || p.idleTimeoutMs <= 0)) {
      throw new TrueOpenError('SDK_LOCAL', 'OUTPUT_STREAM_IDLE_TIMEOUT_INVALID', 'idleTimeoutMs must be a positive finite number');
    }

    const sources = p.sources ?? [{ id: 'default', ingress: this.ingress }];
    if (sources.length === 0) throw new TrueOpenError('SDK_LOCAL', 'OUTPUT_STREAM_NO_SOURCES', 'at least one output source is required');
    const maxAttempts = p.maxAttempts ?? Math.max(3, sources.length);
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
      throw new TrueOpenError('SDK_LOCAL', 'OUTPUT_STREAM_ATTEMPTS_INVALID', 'maxAttempts must be a positive integer');
    }
    const maxPendingFrames = p.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES;
    if (!Number.isInteger(maxPendingFrames) || maxPendingFrames <= 0) {
      throw new TrueOpenError('SDK_LOCAL', 'OUTPUT_STREAM_PENDING_FRAMES_INVALID', 'maxPendingFrames must be a positive integer');
    }

    // Lives as long as this stream: the caller's signal aborts it, and so does the stream
    // ending for any reason (including the caller breaking out of its loop), which closes the
    // anchor wait and any open subscription.
    const life = new AbortController();
    const onAbort = (): void => life.abort();
    p.signal?.addEventListener('abort', onAbort, { once: true });
    const lifeEnded = new Promise<'abort'>((resolve) => life.signal.addEventListener('abort', () => resolve('abort'), { once: true }));

    type AnchorOutcome =
      | { readonly ok: true; readonly taskHash: string; readonly workerServicePubKey: Uint8Array }
      | { readonly ok: false; readonly error: unknown };
    let anchorsP: Promise<AnchorOutcome> | undefined;
    // Errors that end the whole stream rather than one attempt.
    const fatal = (error: unknown): StreamFatal => new StreamFatal(error);
    // Listeners on caller-owned signals, removed when the stream ends.
    const cleanups: Array<() => void> = [];

    try {
      if (early) {
        let source: PromiseLike<{ readonly taskHash: string; readonly workerServicePubKey: Uint8Array }>;
        if (p.pendingAnchors !== undefined) {
          source = p.pendingAnchors;
        } else {
          const waitOpts: WaitForOutputTrustAnchorsOptions = p.waitForAnchors === true ? { sessionId: p.sessionId } : (p.waitForAnchors as WaitForOutputTrustAnchorsOptions);
          const waitAbort = new AbortController();
          const stopWait = (): void => waitAbort.abort();
          life.signal.addEventListener('abort', stopWait, { once: true });
          const callerSignal = waitOpts.signal;
          if (callerSignal !== undefined) {
            if (callerSignal.aborted) waitAbort.abort();
            else {
              callerSignal.addEventListener('abort', stopWait, { once: true });
              cleanups.push(() => callerSignal.removeEventListener('abort', stopWait));
            }
          }
          // The event hint goes to the first source when it can serve task events (an
          // IngressClient for a Builder that took the order), else to this client's ingress.
          const first = sources[0]!.ingress as Partial<Pick<IngressClient, 'getTaskEvents'>>;
          const events: Pick<IngressClient, 'getTaskEvents'> =
            typeof first.getTaskEvents === 'function' ? (first as Pick<IngressClient, 'getTaskEvents'>) : this.ingress;
          source = this.waitForAnchorsWithEvents(p.taskId, { ...waitOpts, signal: waitAbort.signal }, events);
        }
        anchorsP = Promise.resolve(source).then(
          (a): AnchorOutcome => ({
            ok: true,
            taskHash: p.taskHash ?? a.taskHash,
            workerServicePubKey: p.workerServicePubKey ?? a.workerServicePubKey,
          }),
          (error: unknown): AnchorOutcome => ({ ok: false, error }),
        );
      }

      const failures: string[] = [];
      // Free resubscribes after a ResourceExhausted with progress, capped independently.
      let overflowResubscribes = 0;
      let finSource: OutputStreamSource | undefined;
      // The termination reason declared by a signature-verified Fin; stays undefined for an unattested Fin.
      let finishReason: FinishReasonV1 | undefined;
      for (let attempt = 0; attempt < maxAttempts && finSource === undefined; attempt += 1) {
        if (life.signal.aborted) throw aborted();
        const source = sources[attempt % sources.length]!;
        const leafCount = verifier?.leafCount ?? checkpointLeafCount;
        const cursor = leafCount > 0n ? leafCount - 1n : undefined;
        // A fresh AbortController per subscription: abandoning this stream must actually cut the
        // underlying request. iterator.return() only stops reading -- connect-node does not close
        // the HTTP connection because of it. If the Builder being asked isn't the dispatching one,
        // it has no frame to push, and that connection just hangs waiting for a response, keeping
        // the event loop referenced and preventing the caller's process from exiting (this was
        // observed hanging the CLI output stream).
        const abort = new AbortController();
        const onLifeEnd = (): void => abort.abort();
        life.signal.addEventListener('abort', onLifeEnd, { once: true });
        const iterator = source.ingress.subscribeOutput({
          sessionId: p.sessionId,
          taskId: p.taskId,
          ...(cursor !== undefined ? { resumeAfterSeq: cursor } : {}),
          signal: abort.signal,
        })[Symbol.asyncIterator]();
        // A next() started before the anchors arrived and still in flight.
        let pending: Promise<IteratorResult<SubscribeOutputResponse>> | undefined;
        // What the subscription delivered before the anchors arrived, in arrival order: frames,
        // then possibly its end or its error. Nothing in here has been verified.
        const held: Array<{ readonly step: IteratorResult<SubscribeOutputResponse> } | { readonly error: unknown }> = [];
        let progressFrom = leafCount;
        let sawFin = false;
        try {
          if (verifier === undefined) {
            const anchors = anchorsP!;
            // Read ahead until the anchors settle, the subscription ends, or the bound is hit.
            // At the bound, stop reading: the transport's flow control then pushes back on nexus.
            for (;;) {
              const last = held[held.length - 1];
              const ended = last !== undefined && ('error' in last || last.step.done === true || last.step.value.frame.case === 'fin');
              if (ended || held.length >= maxPendingFrames) break;
              if (pending === undefined) {
                pending = iterator.next();
                // Observed here so an abandoned next() never becomes an unhandled rejection.
                pending.catch(() => undefined);
              }
              const r = await Promise.race([
                pending.then(
                  (step) => ({ step }),
                  (error: unknown) => ({ error }),
                ),
                anchors.then(() => 'anchors' as const),
                lifeEnded,
              ]);
              if (r === 'abort') throw fatal(aborted());
              if (r === 'anchors') break;
              pending = undefined;
              held.push(r);
            }
            const settled = await Promise.race([anchors, lifeEnded]);
            if (settled === 'abort') throw fatal(aborted());
            // No winner, a timeout or a failed read: nothing can verify these frames, and nexus
            // will not end the subscription on its own, so it is closed (finally) and the
            // anchor error is the answer.
            if (!settled.ok) throw fatal(settled.error);
            try {
              verifier = setAnchors(settled.taskHash, settled.workerServicePubKey);
            } catch (e) {
              throw fatal(e);
            }
            progressFrom = verifier.leafCount;
          }
          const v = verifier;
          for (;;) {
            let step: IteratorResult<SubscribeOutputResponse>;
            const h = held.shift();
            if (h !== undefined) {
              if ('error' in h) throw h.error;
              step = h.step;
            } else {
              const carried = pending;
              pending = undefined;
              // The idle clock starts when the anchors are known, not when the subscription opened.
              step = await nextWithIdleTimeout(iterator, p.idleTimeoutMs, carried);
            }
            if (step.done) break;
            const frame = step.value.frame;
            if (frame.case === 'chunk') {
              const c = frame.value;
              if (c.attachment.length > 0 || c.attachmentSignature.length > 0) {
                throw dataError('DATA_OUTPUT_ATTACHMENT_NOT_ALLOWED', `frame ${c.seq} carries an attachment; Phase 0 requires it empty`);
              }
              const acceptance = v.acceptOrDeduplicate({
                seq: c.seq,
                text: c.text,
                mmrRoot: c.mmrRoot,
                signature: c.workerSignature,
              });
              if (acceptance === 'duplicate') continue;
              if (p.onCheckpoint !== undefined) {
                try {
                  await p.onCheckpoint(v.checkpoint());
                } catch (cause) {
                  throw fatal(
                    new TrueOpenError(
                      'SDK_LOCAL',
                      'OUTPUT_STREAM_CHECKPOINT_PERSIST_FAILED',
                      `failed to persist checkpoint after frame ${c.seq}`,
                      { cause },
                    ),
                  );
                }
              }
              yield {
                kind: 'chunk',
                seq: c.seq,
                // text is the presented view (chat-template EOS stripped); mmrRoot still
                // covers the committed bytes, so it is what verification ran against.
                text: stripChatTemplateEos(new TextDecoder().decode(c.text)),
                mmrRoot: Uint8Array.from(c.mmrRoot),
              };
              continue;
            }
            if (frame.case === 'fin') {
              const f = frame.value;
              if (f.finalSeq !== v.resumeAfterSeq) {
                throw dataError('DATA_OUTPUT_FIN_SEQ_MISMATCH', `fin says final_seq=${f.finalSeq} but ${v.resumeAfterSeq} was verified`);
              }
              if (!v.matchesReceipt(f.outputMmrRoot)) {
                throw dataError('DATA_OUTPUT_FIN_ROOT_MISMATCH', `fin root does not match the locally computed root for task ${p.taskId}`);
              }
              // Fin carries finish_reason + worker_signature.
              // If present it must verify; if absent, the stream only ends under an explicit 'accept-unsigned'.
              const policy = p.finSignaturePolicy ?? 'require';
              const signed = f.workerSignature.length > 0;
              if (!signed && policy === 'require') {
                throw dataError(
                  'DATA_OUTPUT_FIN_UNSIGNED',
                  `fin for task ${p.taskId} carries no worker_signature but finSignaturePolicy is 'require'`,
                );
              }
              if (signed) {
                const finFields = {
                  chainId: this.cfg.chainId,
                  taskHash,
                  finalSeq: f.finalSeq,
                  outputMmrRoot: Uint8Array.from(f.outputMmrRoot),
                  finishReason: Number(f.finishReason),
                };
                if (!verifyOutputFinSignature(finFields, f.workerSignature, workerServicePubKey)) {
                  throw dataError(
                    'DATA_OUTPUT_FIN_SIGNATURE_INVALID',
                    `fin signature for task ${p.taskId} did not verify (finish_reason=${f.finishReason})`,
                  );
                }
                finishReason = f.finishReason;
              }
              sawFin = true;
              finSource = source;
              break;
            }
            throw dataError('DATA_OUTPUT_STREAM_FRAME_MISSING', `SubscribeOutput returned no frame for task ${p.taskId}`);
          }
          if (!sawFin) {
            failures.push(`${source.id}: stream ended without fin after seq ${v.resumeAfterSeq}`);
          }
        } catch (e) {
          if (e instanceof StreamFatal) throw e.error;
          if (life.signal.aborted) throw aborted();
          // nexus drops a subscriber that fell 256 frames behind with ResourceExhausted
          // ("re-subscribe with resume_after_seq"). When this subscription still delivered new
          // verified frames, resuming on the same source is progress, not a failed attempt, up
          // to MAX_OVERFLOW_RESUBSCRIBES; past that it counts as one.
          if (
            isResourceExhausted(e) &&
            verifier !== undefined &&
            verifier.leafCount > progressFrom &&
            overflowResubscribes < MAX_OVERFLOW_RESUBSCRIBES
          ) {
            overflowResubscribes += 1;
            attempt -= 1;
            continue;
          }
          const err = e as { message?: string };
          failures.push(`${source.id}: ${err.message ?? String(e)}`);
        } finally {
          // Order matters: call return() first to let the generator wind down, then abort() to cut
          // the underlying connection. Even the one that received fin must be aborted -- keep-alive
          // would otherwise leave it sitting in the idle pool; that doesn't block process exit, but
          // a short-lived process never gets to reuse it, so it's just occupying the peer's connection.
          life.signal.removeEventListener('abort', onLifeEnd);
          void iterator.return?.().catch(() => undefined);
          abort.abort();
        }
      }

      if (finSource === undefined) {
        throw new TrueOpenError(
          'DATA',
          'DATA_OUTPUT_STREAM_RETRIES_EXHAUSTED',
          `output stream did not reach a valid fin after ${maxAttempts} attempts:\n  ${failures.join('\n  ')}`,
          { retriable: true },
        );
      }
      if (finishReason === undefined) {
        // Unattested Fin (only reachable under an explicit 'accept-unsigned'): nothing says the
        // output is complete, so report no delivery progress for it.
        yield { kind: 'fin', attested: false, finishReason: undefined };
        return;
      }
      if (p.ack !== false && verifier !== undefined && verifier.leafCount > 0n) {
        await finSource.ingress.ackOutput({ sessionId: p.sessionId, taskId: p.taskId, lastSeq: verifier.resumeAfterSeq });
      }
      // After the ack, not before: `break`ing on the fin event runs the generator's cleanup
      // path, so anything left after the yield never executes. Acking first makes the caller's
      // loop shape irrelevant to whether delivery progress is reported.
      yield { kind: 'fin', attested: true, finishReason };
    } finally {
      p.signal?.removeEventListener('abort', onAbort);
      for (const cleanup of cleanups) cleanup();
      life.abort();
    }
  }

  /** Upgrade a locally verified output to confirmed, using the root/count/size from the on-chain InferReceipt. */
  confirmOutput(p: ConfirmOutputParams): ConfirmedOutputEvent {
    return confirmOutputWithReceipt({ chainId: this.cfg.chainId, ...p });
  }

  /** Prepare challenge materials (does not submit a verdict). */
  prepareChallenge(
    sessionId: string,
    taskId: string,
    /** The challenge kind name nexus expects (a free-form string on the wire). */
    challengeKind: string,
    localEvidenceDigest?: Uint8Array,
  ): Promise<PrepareChallengeResponse> {
    const p =
      localEvidenceDigest !== undefined
        ? { sessionId, taskId, challengeKind, localEvidenceDigest }
        : { sessionId, taskId, challengeKind };
    return this.ingress.prepareChallenge(p);
  }

  /**
   * A fresh 32-byte request nonce.
   *
   * noble's randomBytes resolves to `node:crypto`'s webcrypto under Node (Node 18 has no
   * unflagged `globalThis.crypto`) and to `globalThis.crypto` in browsers, which covers both
   * without importing a Node built-in into the browser bundle.
   */
  private nextNonce(): Uint8Array {
    if (this.cfg.nonce) return this.cfg.nonce();
    try {
      return randomBytes(32);
    } catch (cause) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_NO_CRYPTO',
        'no secure random source (a browser needs a secure context); provide config.nonce',
        { cause },
      );
    }
  }

  private nextExpiry(): bigint {
    if (this.cfg.expiry) return this.cfg.expiry();
    const ttl = this.cfg.requestTtlMs ?? 5 * 60 * 1000;
    return BigInt(Date.now() + ttl);
  }
}

/** Re-read a Builder's descriptor to get its NEXUS_GRPC endpoint and current fingerprint; returns undefined if it can't be read. */
/**
 * Split the whole-object bytes back into the original chunk list using metadata's chunk_lengths.
 * The lengths must sum to exactly the byte count -- a mismatch means metadata and the object
 * aren't the same version, and "best-effort splitting" anyway would only defer the error to the
 * MMR root comparison, with a more confusing message.
 */
function splitByChunkLengths(bytes: Uint8Array, lengths: readonly number[]): Uint8Array[] {
  if (lengths.length === 0) {
    throw dataError('DATA_OUTPUT_CHUNK_LENGTHS_MISSING', 'metadata carries no chunk_lengths; cannot rebuild the MMR');
  }
  const total = lengths.reduce((n, x) => n + x, 0);
  if (total !== bytes.length) {
    throw dataError(
      'DATA_OUTPUT_CHUNK_LENGTHS_MISMATCH',
      `chunk_lengths sum to ${total} but the object is ${bytes.length} bytes`,
    );
  }
  const out: Uint8Array[] = [];
  let off = 0;
  for (const len of lengths) {
    if (len < 0) throw dataError('DATA_OUTPUT_CHUNK_LENGTHS_MISMATCH', `negative chunk length ${len}`);
    out.push(bytes.subarray(off, off + len));
    off += len;
  }
  return out;
}

/**
 * Default Task data request lifetime in blocks. Small on purpose: it has to fit inside every
 * Builder's max_service_material_expiry_blocks, whose value the SDK cannot read.
 */
export const DEFAULT_TASK_DATA_EXPIRY_BLOCKS = 10;

/** nexus's default max range (task_data.max_range_bytes); a larger single read is refused. */
export const DEFAULT_MAX_RANGE_BYTES = 8 << 20;

/** waitForOutputTrustAnchors chain poll interval: about one block. */
export const DEFAULT_TRUST_ANCHOR_POLL_MS = 1000;

/** openTask's default wait for an anchor at or after a registered key's set_height: a few blocks. */
export const DEFAULT_SESSION_KEY_ANCHOR_WAIT_MS = 15_000;

/** waitForOutputTrustAnchors upper bound on the whole wait. */
export const DEFAULT_TRUST_ANCHOR_WAIT_MS = 60_000;

/** The nexus task event that follows the chain finalizing the winner. */
const ASSIGNMENT_FINALIZED_EVENT = 'ASSIGNMENT_FINALIZED';

/** waitForAdmission upper bound on the whole wait. */
export const DEFAULT_ADMISSION_WAIT_MS = 60_000;

/** Builder task events that report the order was not admitted (recorded by waitForAdmission). */
const ADMISSION_REJECT_EVENTS: ReadonlySet<string> = new Set(['ASSIGN_REJECTED', 'ASSIGN_TIMEOUT']);

/** Builder task events after which the chain likely has the task: waitForAdmission reads it at once. */
const ADMISSION_HINT_EVENTS: ReadonlySet<string> = new Set([
  ASSIGNMENT_FINALIZED_EVENT,
  'WORKER_ASSIGNMENT_FINALIZED',
  'WORKER_HANDRAISES_ACCEPTED',
]);

const RETRY_SUFFIX = /^(.*)#retry([1-9][0-9]*)$/s;

/** `key#retry1` for a first retry; `key#retryK` becomes `key#retry(K+1)`. */
export function nextRetryIdempotencyKey(key: string): string {
  const m = RETRY_SUFFIX.exec(key);
  return m === null ? `${key}#retry1` : `${m[1]}#retry${BigInt(m[2]!) + 1n}`;
}

/** An order's params for a re-signed retry under the same sequence (OpenTaskResult.retryParams). */
function retryParamsOf(params: OpenTaskParams, orderSequence: bigint): OpenTaskParams {
  const { context: _c, expiryHeight: _e, ...rest } = params;
  void _c;
  void _e;
  return { ...rest, orderSequence, idempotencyKey: nextRetryIdempotencyKey(params.idempotencyKey) };
}

/**
 * Early subscribe's default read-ahead bound while the anchors are pending: the size of
 * nexus's per-subscriber buffer, so a full read-ahead plus nexus's buffer covers about twice
 * that before nexus asks for a resubscribe.
 */
export const DEFAULT_MAX_PENDING_FRAMES = 256;

/** Cap on streamOutput's free resubscribes after nexus drops a slow subscriber; past it each counts as a failed attempt. */
export const MAX_OVERFLOW_RESUBSCRIBES = 64;

/** Carries an error out of streamOutput's per-attempt handling: it ends the stream instead of the attempt. */
class StreamFatal {
  constructor(readonly error: unknown) {}
}

/** Whether a stream ended with Connect ResourceExhausted (nexus's slow-subscriber overflow), anywhere in the cause chain. */
function isResourceExhausted(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof ConnectError) return current.code === Code.ResourceExhausted;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Qwen3's chat template ends every assistant turn with the literal `<|im_end|>` marker (its
 * end-of-turn / EOS token). The serving layer applies the template but does not yet strip
 * that trailing marker, so it is committed on chain as part of the output bytes. It is not
 * model content, so the SDK strips it from the *presented* text while the committed bytes
 * stay untouched -- verification still runs over the bytes that hash to the on-chain
 * receipt. Trailing whitespace left behind by the template is dropped with it.
 *
 * Temporary: once cortex strips the marker server side this becomes a no-op.
 */
const CHAT_TEMPLATE_EOS = '<|im_end|>';

export function stripChatTemplateEos(text: string): string {
  if (text.endsWith(CHAT_TEMPLATE_EOS)) {
    return text.slice(0, -CHAT_TEMPLATE_EOS.length).trimEnd();
  }
  return text;
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Whether a failed call is worth repeating against the same peer: the classified error says
 * so (a dropped connection, an expired request window, a peer that is busy or not ready, a
 * stream cut short). Anything about the content -- a wrong range, a bad hash -- is final.
 */
function isTransientTransportError(e: unknown): boolean {
  const c = classifyNexusError(e);
  return c instanceof TrueOpenError && c.retriable;
}

/** Delay before retry i (0-based): 200ms then 400ms. */
const RANGE_RETRY_BASE_DELAY_MS = 200;

/**
 * Retries a range, backing off between attempts.
 *
 * The backoff is the point, not politeness: ResourceExhausted and Unavailable mean the peer is
 * already past what it can serve, and an immediate retry is another request into the same
 * overload. Every attempt re-reads the expiry height and re-signs, so it is a fresh request,
 * not a replay.
 */
async function retryTransient<T>(
  attempts: number,
  run: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  const n = Math.max(1, attempts);
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (e) {
      if (i >= n - 1 || !isTransientTransportError(e)) throw e;
      await sleep(RANGE_RETRY_BASE_DELAY_MS * 2 ** i);
    }
  }
}

async function rereadNexusEndpoint(
  hub: { getServiceDescriptor(operatorAddress: string, participantType?: string): Promise<import('./types/hub').ServiceDescriptorRef> },
  address: string,
): Promise<{ uri: string; tlsPubkeyHash: string } | undefined> {
  try {
    const endpoint = nexusGrpcEndpoint(await hub.getServiceDescriptor(address));
    if (!endpoint || endpoint.uri === '') return undefined;
    return { uri: endpoint.uri, tlsPubkeyHash: endpoint.tlsPubkeyHash ?? '' };
  } catch {
    return undefined;
  }
}

function local(
  code: string,
  message: string,
  opts?: { readonly retriable?: boolean; readonly details?: Readonly<Record<string, unknown>> },
): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', code, message, opts);
}

/** The shortest key lifetime a registration can land with: it executes at latest + 1 and needs height < expiry. */
const MIN_SESSION_KEY_EXPIRY_BLOCKS = 2n;

const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;

/** A spend cap as the canonical unsigned decimal the grant carries ("0" = unlimited). */
function canonicalSpendCap(cap: bigint | string): string {
  if (typeof cap === 'bigint') {
    if (cap < 0n) throw local('SDK_LOCAL_SESSION_KEY_INVALID', `spendCap must not be negative, got ${cap}`);
    return cap.toString();
  }
  if (typeof cap !== 'string' || !CANONICAL_DECIMAL.test(cap)) {
    throw local('SDK_LOCAL_SESSION_KEY_INVALID', `spendCap must be a canonical decimal (0 or [1-9][0-9]*), got ${JSON.stringify(cap)}`);
  }
  return cap;
}

function keyHandle(key: SessionKeyMaterial, expiryHeight: bigint, spendCap: string): SessionKeyHandle {
  return { address: sessionKeyAddressHex(key.address), privateKey: key.privateKey, expiryHeight, spendCap };
}

/**
 * The admission checks of a registered-key order the SDK can make before signing, in the
 * chain's order (SESSION_KEYS_V1 "First order admission"), except the spend cap, which needs the
 * built order (checkSessionKeySpendCap). Throws for a CLOSED session, a key that is no longer the
 * registered one and an expired key; returns false when only the anchor predates the key's
 * registration, so the caller can try a fresh anchor. `ctx.latestHeight` stands in for the
 * admission height.
 */
function checkSessionKeyAdmission(key: RegisteredSessionKey, s: StreamStateView, ctx: TaskOrderChainContext): boolean {
  if (s.status === 'CLOSED') throw local('SDK_LOCAL_SESSION_CLOSED', `session ${key.sessionId} is CLOSED`);
  if (s.sessionKey === undefined || !bytesEqual(s.sessionKey, key.address)) {
    throw local(
      'SDK_LOCAL_SESSION_KEY_NOT_REGISTERED',
      `the loaded session key ${sessionKeyAddressHex(key.address)} is no longer registered for session ${key.sessionId}: ` +
        'it was rotated or cleared. Use the wallet (forgetSessionKey) or load the current key (useSessionKey)',
    );
  }
  // The chain admits at latest + 1 or later, so latest == expiry passes here but may still be
  // rejected; the constraint is checked as written, with no margin.
  if (ctx.latestHeight > s.sessionKeyExpiryHeight) {
    throw local(
      'SDK_LOCAL_SESSION_KEY_EXPIRED',
      `the session key expired at height ${s.sessionKeyExpiryHeight} (latest ${ctx.latestHeight}): renew it via updateSessionKey`,
    );
  }
  return ctx.sessionAnchorHeight >= s.sessionKeySetHeight;
}

const U64_MAX = (1n << 64n) - 1n;

/**
 * spent + max_fee must fit a u64 whatever the cap (the chain refuses with AMOUNT_OVERFLOW, wire
 * fixture unlimited_still_checks_overflow), and with a nonzero cap must not exceed it; a zero cap
 * is otherwise unlimited. Both are SDK_LOCAL_SESSION_KEY_SPEND_CAP_EXCEEDED: the key can sign no
 * order this large. `spent` is never reset, so an overflow is fixed only by the wallet signing.
 */
function checkSessionKeySpendCap(s: StreamStateView, maxFee: string): void {
  const cap = BigInt(s.sessionKeySpendCap);
  const spent = BigInt(s.sessionKeySpent);
  if (spent + BigInt(maxFee) > U64_MAX) {
    throw local(
      'SDK_LOCAL_SESSION_KEY_SPEND_CAP_EXCEEDED',
      `spent ${spent} + max_fee ${maxFee} overflows the u64 the chain accounts spent in (AMOUNT_OVERFLOW); ` +
        'spent is never reset, so sign with the wallet (forgetSessionKey)',
      { details: { overflow: true } },
    );
  }
  if (cap === 0n) return;
  if (spent + BigInt(maxFee) > cap) {
    throw local(
      'SDK_LOCAL_SESSION_KEY_SPEND_CAP_EXCEEDED',
      `spent ${spent} + max_fee ${maxFee} exceeds the session key's spend cap ${cap}: raise it via updateSessionKey`,
    );
  }
}

/** A session ID as given, after checking it is Hash32 text (`0x` + 64 lowercase hex). */
function sessionIdText(sessionId: string): string {
  strictHash32('session_id', sessionId);
  return sessionId;
}
