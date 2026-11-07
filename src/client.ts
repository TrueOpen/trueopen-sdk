import { recoverDispatch, type DispatchRecoveryPolicy } from './transport/dispatch-recovery';
import { ChainReadCache, hubOrderReads } from './transport/chain-read-cache';
import type { BuilderSetSnapshot } from './types/hub';
import { MAX_ORDER_LIFETIME_BLOCKS_V1, validateOrderLifetime } from './order/order-lifetime';
import type { CreateSessionInput, DepositSessionInput, WithdrawSessionInput } from './transport/session-funding';
import { Code, ConnectError } from '@connectrpc/connect';
import type { Transport } from '@connectrpc/connect';
import type { DispatchResultHeaderV1 } from './gen/nexus/v1/dispatch_pb.js';
import type { ChainClient, CancelOrderResult } from './transport/chain-client';
import type { TypedDataSigner } from './signer/typed-data-signer';
import { IngressClient, finalSignedError } from './transport/ingress-client';
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
import { fanOutToEndpoints, TaskBuilderAllEndpointsFailedError } from './transport/fan-out-submit';
import { nexusGrpcEndpoint } from './types/hub';
import type { ManifestSource } from './manifest/manifest-source';
import { toolCallIdFormatOf, type ToolCallIdFormat } from './manifest/model-manifest';
import { isTLSPubkeyMismatch } from './transport/nexus-tls';
import type { DescriptorDocFetch } from './hub/builder-discovery';
import { buildTaskOrder, resolveTaskOrderContextWithBuilderSet } from './order/task-order-input';
import type { TaskOrderIntent, TaskOrderChainContext, TaskOrderContextReader, ResolvedTaskOrderContext } from './order/task-order-input';
import { buildOpenTaskRequest } from './order/build-open-task';
import { taskOrderHashHex } from './order/task-order';
import type { TaskOrderV3 } from './order/task-order';
import { deriveTaskId } from './order/order-signing';
import { TrueOpenError, dataError } from './errors/errors';
import { sha256 } from './codec/hash';
import { outputHash as outputMmrRoot, OutputStreamVerifier, verifyOutputFinSignature } from './output/output-commitment';
import type { OutputStreamVerifierCheckpoint } from './output/output-commitment';
import { verifyDispatchResultHeader } from './output/dispatch-proof';
import type { DispatchProofKeyReader, VerifiedDispatchResult } from './output/dispatch-proof';
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
import {
  confirmAssistantMessageWithReceipt,
  deriveAssistantMessage,
  deriveAssistantStream,
  type DerivedViewOptions,
} from './toolcall/assistant-view';
import { BUILTIN_TOOL_CALL_PARSERS, resolveToolCalling, type ToolCallRegistry } from './toolcall/registry';
import { BUILTIN_REASONING_PARSERS, type ReasoningParser, type ReasoningRegistry } from './toolcall/reasoning';
import type {
  AssistantStreamEvent,
  ConfirmedAssistantMessage,
  DerivedAssistantMessage,
  ParserRef,
  ToolCallParser,
} from './toolcall/types';

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
   * descriptors needed for Task Builder routing, and the order context (current BuilderSet /
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
   * Where verified profile manifests come from (Node: createNodeManifestSource from
   * "trueopen-sdk/node"). Needed for what only the manifest carries -- `tool_calling.call_id_format`,
   * which is not projected on chain (ADR-0028).
   */
  readonly manifestSource?: ManifestSource;
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
   * How long openTask waits, in milliseconds, for an anchor at or after a registered session
   * key's set_height (default DEFAULT_SESSION_KEY_ANCHOR_WAIT_MS, a few blocks). A fresh anchor
   * is the latest height, which may still be below the registration height read right after
   * createSession or a rotate; openTask polls the latest height until a fresh anchor would reach
   * it, then resolves one. 0 disables the wait. Must be finite
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
  /**
   * Delay, in milliseconds, before a key-signed request or OpenTask that a Builder refused inside
   * the key-change window is re-signed and sent again (default DEFAULT_KEY_CHANGE_RETRY_DELAY_MS,
   * about one block). Builders may lag a key change by up to MAX_SESSION_KEY_CACHE_TTL_BLOCKS
   * (10) blocks; see IngressAuth.registeredKeys. Must be finite and >= 0 (else the constructor
   * throws SDK_LOCAL_SESSION_KEY_CONFIG_INVALID).
   */
  readonly sessionKeyChangeRetryMs?: number;
  /**
   * Delay, in milliseconds, before a retried order (openTask with waitForAdmission's `retry`) is
   * sent again to a Builder that answered NEXUS_INGRESS_ORDER_REPLACEMENT_UNSUPPORTED (default
   * DEFAULT_ORDER_REPLACEMENT_RETRY_MS, about one block), at most
   * ORDER_REPLACEMENT_RETRY_ATTEMPTS times. Must be finite and >= 0 (else the constructor throws
   * SDK_LOCAL_CONFIG_INVALID).
   */
  readonly orderReplacementRetryMs?: number;
  /**
   * Opt-in reuse of the chain reads an order makes that change only with governance or a
   * BuilderSet replacement: params.phase0.business_denom, the model profile's pricing, the
   * timeout bucket version, the task generation limits, the BuilderSet and Builder service
   * descriptors. Off by default. `true` or `{}` reuses each successful read for
   * MAX_CHAIN_READ_CACHE_TTL_MS (60 s); `ttlMs` shortens that (it must be in (0, 60000], else the
   * constructor throws SDK_LOCAL_CONFIG_INVALID). The latest height and the session are always
   * read fresh, so a warm order makes those two reads only, concurrently.
   *
   * The cache is dropped as a whole when: a fresh BuilderSet or timeout bucket read differs from
   * the cached one (a BuilderSet replacement or a params change); openTask or
   * openTaskWithRecovery fails in any way; waitForAdmission finds an order rejected; a Builder's
   * certificate re-read finds a new endpoint; or invalidateChainReadCache is called. openTask
   * retries once, with fresh reads, an order refused for a BuilderSet the cache may have kept
   * too long (NEXUS_INGRESS_BUILDER_SET_STALE, SDK_LOCAL_BUILDER_SET_MISMATCH).
   *
   * Trade-off: business_denom, the pricing and the bucket version are checked only by the chain,
   * after a Builder accepted the order. A governance change inside the TTL can therefore make
   * one order fail on chain (waitForAdmission reports it `rejected` and drops the cache, so the
   * retry it returns is built on fresh reads). Leave this off where that is not acceptable.
   */
  readonly chainReadCache?: boolean | { readonly ttlMs?: number };
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
/**
 * Parameters of TrueOpenClient.fetchAssistantMessage: those of fetchTaskOutput, with the hashes
 * and key always taken from the chain anchors (so the result can be confirmed against the
 * receipt), and the Builder optional.
 */
export type FetchAssistantMessageParams = Omit<FetchTaskOutputParams, 'builderAddress' | 'taskHash' | 'outputHash' | 'workerServicePubKey'> & {
  /** Fetch from this Builder only. Omitted: the SDK asks the task's frozen Task Builders. */
  builderAddress?: string;
};

/** Parameters of TrueOpenClient.fetchTaskOutput. */
export type FetchTaskOutputParams = {
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
  /**
   * The winner Worker's service key, for verifying the stored Fin. Defaults to the anchors'
   * key, and is resolved from chain when the metadata carries a signed Fin and neither is given.
   */
  workerServicePubKey?: Uint8Array;
};

export interface OutputTaskReader {
  queryTask(taskId: string): Promise<ChainTaskSnapshot>;
  queryInferReceipt(taskId: string): Promise<InferReceiptView | undefined>;
  /**
   * The task's frozen Task Builder addresses, in rank order (RestChainReader provides it). Needed
   * only to let fetchAssistantMessage choose the Builder itself.
   */
  queryTaskBuilders?(taskId: string): Promise<readonly string[]>;
}

/**
 * What an output is verified against, all derived from chain queries:
 * task -> accepted task_hash and winner Worker; hub -> that Worker's current service key;
 * accepted InferReceipt -> output_hash (the MMR root), size and leaf count.
 */
export interface OutputTrustAnchors {
  readonly dispatchTicketHash?: string;
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
   * watched, and its DISPATCH_RECORDED event triggers one immediate chain read instead of
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
  /** Position in cyclic snapshot order, 1-based (1 = dispatching Builder). */
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
  /** Opt in to an on-chain registered key for the order; request grants remain separate. */
  readonly delegatedOrderSigner?: { readonly signer: TypedDataSigner; readonly address: Uint8Array };
  /** Abort an in-flight submission. */
  readonly signal?: AbortSignal;
  /** Per-attempt acknowledgement timeout; defaults to 30 seconds. */
  readonly ackTimeoutMs?: number;
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
  /**
   * The order window relative to the latest height of the context the order is built on: when
   * set, `order.earliestSubmitHeight` and `order.orderExpireHeight` are ignored and replaced by
   * `context.latestHeight + earliestSubmitBlocks` and `context.latestHeight + orderExpireBlocks`
   * (each at least 1). retryParams sets it from the original order, so a retry keeps the window's
   * length instead of its old absolute heights (which may already have passed).
   */
  readonly orderWindow?: OrderWindowOffsets;
  /** Internal: the task_hash of the rejected order these params retry (set by retryParams). */
  readonly [REJECTED_TASK_HASH]?: string;
}

/** An order window as offsets from the latest height (OpenTaskParams.orderWindow). May be negative. */
export interface OrderWindowOffsets {
  readonly earliestSubmitBlocks: bigint;
  readonly orderExpireBlocks: bigint;
}

/** Internal: a session read recovery made just before submitting, used instead of reading it again. */
const READ_SESSION: unique symbol = Symbol('trueopen.readSession');
/** Internal: the BuilderSet recovery read with its context, used for routing when it is the context's set. */
const READ_BUILDER_SET: unique symbol = Symbol('trueopen.readBuilderSet');

/** OpenTaskParams with the reads openTaskWithRecovery hands to submitOpenTask. */
type InternalOpenTaskParams = OpenTaskParams & {
  readonly [READ_SESSION]?: StreamStateView | undefined;
  readonly [READ_BUILDER_SET]?: BuilderSetSnapshot | undefined;
};

/**
 * Carries the rejected order's task_hash in retryParams. A symbol, so an object spread of the
 * params (`{ ...retry, orderSigner: 'wallet' }`) keeps it while it stays out of the public API.
 */
const REJECTED_TASK_HASH: unique symbol = Symbol('trueopen.rejectedTaskHash');

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
  /** The order's earliest_submit_height: the Keeper cannot admit it at an earlier height. */
  readonly earliestSubmitHeight: bigint;
  /** The order's order_expire_height: the Keeper cannot admit it at a later height. */
  readonly orderExpireHeight: bigint;
  /** The signing key's expiry height as the session read showed it (orderSignedBy 'session-key' only). */
  readonly sessionKeyExpiryHeight?: bigint;
  /**
   * Set when a registered key signed the order and the order's window runs past the key's
   * expiry: the Keeper checks the expiry at the admitting height, so if the Builders admit the
   * order after sessionKeyExpiryHeight the chain rejects it. Renew the key, or shorten the
   * window, when that matters.
   */
  readonly keyExpiresInOrderWindow?: true;
  /**
   * The parameters of a re-signed order under the same order_sequence, for when the chain
   * rejects this one (see waitForAdmission): these params with `orderSequence` set to this
   * order's, `context` and `expiryHeight` removed (a retry resolves fresh ones), `orderWindow`
   * holding this order's window relative to its context's latest height (so the retry's window is
   * rebased on its own context instead of reusing heights that may have passed), and a new
   * idempotency key `<key>#retry<n>`. `order` is the same object (its two heights are ignored
   * while `orderWindow` is set), and so is the payload. They also remember this order's task_hash:
   * a retry that would come out identical (the Builders keep a tombstone for the rejected input)
   * resolves a fresh context once, then fails with SDK_LOCAL_RETRY_ORDER_UNCHANGED. The SDK never
   * sends it by itself.
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
  /**
   * One report per Builder: the RECORD_REJECTED / NO_CAPACITY / ASSIGN_TIMEOUT / ORDER_EXPIRED event seen after its last
   * ORDER_RECEIVED, or ABANDONED_REPORT when its event stream answered NotFound.
   */
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

/** What TrueOpenClient.prefetch warms besides the order-independent reads. */
export interface PrefetchParams {
  /** Reads the session and warms its bound Builder's descriptor and connection. */
  readonly sessionId?: string;
  /** Warms this model profile's pricing (what openTask reads unless params.pricing is given). */
  readonly model?: { readonly modelId: string; readonly profileVersion: number | bigint };
}

/** What TrueOpenClient.prefetch could not read (each failure; empty when everything was warmed). */
export interface PrefetchResult {
  readonly errors: readonly unknown[];
}

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
  /**
   * Phase 1: the Builder the Session is bound to from its first order (operator address,
   * `trueopen1...`, as in `StreamStateView.boundBuilder`). Required by the chain.
   */
  readonly initialBuilder?: string;
  /** Phase 1: the Session's prefunded balance, atomic units of the settlement denom; default "0". */
  readonly initialDeposit?: string;
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
  /**
   * For `rotate`: the new key. The caller persists its privateKey. It is loaded at once when the
   * chain applied the change immediately; when the change is pending (`effectiveHeight`), the old
   * key stays loaded and the caller loads this one with useSessionKey once the chain applied it.
   */
  readonly newKey?: SessionKeyHandle;
  /** Set when the chain registered the change as pending (restrictive updates are delayed). */
  readonly effectiveHeight?: bigint;
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
  readonly ingress: Pick<IngressClient, 'subscribeOutput' | 'ackOutput'> & Partial<Pick<IngressClient, 'resumeOutput'>>;
}

export interface StreamOutputParams {
  /**
   * Early subscribe with this wait (waitForAnchors with `{ sessionId, ...admissionWait }`): the
   * chain is polled for the anchors, with the Builder's DISPATCH_RECORDED event as a hint.
   * `waitForAnchors` takes precedence.
   */
  readonly admissionWait?: Omit<WaitForOutputTrustAnchorsOptions, 'sessionId'>;
  /** Authenticate an optimistic replacement header and return its trusted anchors.
   * Defaults to chain-derived anchors. Never trust a header solely because it arrived from a Builder.
   */
  readonly resolveDispatchResult?: (header: DispatchResultHeaderV1) => Promise<OutputTrustAnchors>;
  /** Trusted dispatch attempt Hash32; required by the Phase 1 verifier. */
  readonly dispatchTicketHash?: string;
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
   * Stream before the chain records the dispatch: deliver verified output while the dispatch
   * record is still pending, instead of waiting for the chain's anchors first. Pass the
   * `openTask` result (it has `taskHash`, `builders` and `earliestSubmitHeight`). Needs a hub
   * reader with getCurrentServiceKey, and config.taskReader for the confirmation.
   *
   * The Builder's first message is its signed DispatchResultHeaderV1. It is verified with
   * verifyDispatchResultHeader (the winner ticket binds this order and comes from one of these
   * Builders; the header and ticket are signed by that Builder and the accept by the target
   * Worker; the Worker's current key is ACTIVE) and frames are then verified against its ticket
   * and the Worker's key, as usual, and delivered at once with `recorded: false`. The Builder
   * forwards only the first max_prerecord_output_tokens of output until the record lands.
   *
   * When the Builder reports the record (a RECORDED header), or a verified Fin arrives first,
   * the chain anchors are read (polled with `admissionWait`'s pollIntervalMs / timeoutMs). If
   * they name this task_hash, ticket and Worker (with the same key), later chunks carry
   * `recorded: true`. If the chain recorded another attempt of this task, a `reset` is emitted
   * and the stream continues with the chain's attempt. A REJECTED header ends the stream with
   * OUTPUT_RECORD_REJECTED. `fin` (and the ack) only ever follow a confirmed record.
   *
   * Trust: output delivered with `recorded: false` trusts the dispatching Builder's statement of
   * who won. The SDK verifies the signatures, the ticket and the accept, but not the VRF draw or
   * the roster behind the ticket. The exposure is bounded by the chain's
   * max_prerecord_output_tokens, and if the chain records another attempt the stream resets.
   * config.taskReader, the hub reader and `admissionWait`'s values are checked when the stream
   * starts.
   *
   * Explicit taskHash + workerServicePubKey + dispatchTicketHash take precedence (the stream
   * then runs as without this option, and chunks carry `recorded: true`); `waitForAnchors`,
   * `pendingAnchors` and early subscribe are not used with this option, and a replacement
   * attempt's header (after NEXUS_INGRESS_ATTEMPT_STALE) is verified the same way instead of
   * through `resolveDispatchResult`, and is provisional until the chain records it. Without the
   * option, chunks have no `recorded` field and nothing changes.
   */
  readonly beforeRecord?: StreamBeforeRecordOptions;
  /**
   * Aborting stops the stream: the subscription and any anchor wait are closed and
   * `OUTPUT_STREAM_ABORTED` is thrown.
   */
  readonly signal?: AbortSignal;
}

/** What streamOutput's `beforeRecord` checks the dispatch header against. An OpenTaskResult fits. */
export interface StreamBeforeRecordOptions {
  /** Hash32 text of the task_hash signed into the order (OpenTaskResult.taskHash). */
  readonly taskHash: string;
  /** The Builders the order was sent to (OpenTaskResult.builders, or their addresses). */
  readonly builders: readonly (string | { readonly address: string })[];
  /**
   * The order's earliest_submit_height (OpenTaskResult.earliestSubmitHeight). Without it, a
   * header, ticket or accept signed by a previous or emergency-revoked service key is refused.
   */
  readonly earliestSubmitHeight?: bigint;
}

/**
 * One event from `streamOutput`. The stream ends with exactly one `fin` after the last
 * `chunk`, so the terminal state is part of the control flow rather than something the
 * caller has to reconstruct from the iterator finishing.
 *
 * A `reset` invalidates earlier text after a voided attempt; consumers must clear it.
 * A `fin` ends the currently verified attempt. `finish_reason` carries caveats (see below) that are easy to miss if the
 * value merely appears on every chunk.
 */
export type OutputStreamEvent =
  | {
      /** Discard previously displayed output; the replacement starts again at seq 0. */
      readonly kind: 'reset';
      readonly previousDispatchTicketHash: string;
      readonly dispatchTicketHash: string;
    }
  | {
      readonly kind: 'chunk';
      readonly seq: bigint;
      readonly text: string;
      readonly mmrRoot: Uint8Array;
      /**
       * Set only with `beforeRecord`: false while the chain has not been seen to record this
       * attempt (the text is provisional and may still be reset), true once it has. A true
       * chunk also confirms every earlier chunk of the same attempt.
       */
      readonly recorded?: boolean;
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
  /** Ticket from the accepted QueryTask assignment/terminal summary. */
  readonly dispatchTicketHash: string;
  readonly taskId: string;
  readonly taskHash: string;
  readonly checkpoint: OutputStreamVerifierCheckpoint;
  readonly receipt: InferReceiptView;
}

function dispatchHeaderTicket(header: DispatchResultHeaderV1, chainId: string, sessionId: string, taskId: string, taskHash: Uint8Array): Uint8Array {
  const ticket = header.winnerTicket;
  const accept = header.accept;
  const task = strictHash32('task_id', taskId);
  if (!ticket || !accept || ticket.schemaVersion !== 1 || accept.schemaVersion !== 1 ||
      ticket.chainId !== chainId || accept.chainId !== chainId ||
      !bytesEqual(header.taskId, task) || !bytesEqual(ticket.taskId, task) || !bytesEqual(accept.taskId, task) ||
      !bytesEqual(ticket.sessionId, strictHash32('session_id', sessionId)) ||
      !bytesEqual(ticket.taskHash, taskHash) || !bytesEqual(accept.taskHash, taskHash) ||
      !ticket.target?.operatorAddress || ticket.target.operatorAddress !== accept.member?.operatorAddress ||
      accept.dispatchTicketHash.length !== 32) {
    throw dataError('DATA_OUTPUT_DISPATCH_HEADER_INVALID', 'DispatchResultHeaderV1 has inconsistent task, attempt or Worker identity');
  }
  return Uint8Array.from(accept.dispatchTicketHash);
}

/**
 * Tool-calling parameters for `streamAssistantMessage` / `fetchAssistantMessage`.
 *
 * The alternative to passing an already-resolved `parser` (the phase-1 path). When this shape is
 * used, the facade resolves the parser from the profile's on-chain `tool_call_parser` projection
 * (design S5.1), and degrades to `content`-only output when the profile does not support tool
 * calling. The two shapes are disjoint: this one has no `parser` and a required `toolCallParser`.
 */
export interface ToolCallParams {
  /** The profile's on-chain tool-call parser (ProfileInfo.toolCallParser); zero value = "no tool calling". */
  readonly toolCallParser: ParserRef;
  /** Defaults to the built-in registry (hermes@1, qwen3_coder@1; unverified); injectable for tests/custom parsers. */
  readonly registry?: ToolCallRegistry;
  /** Whether an unverified parser may be used (design S6 `parser-unverified`). */
  readonly allowUnverified?: boolean;
  /**
   * The profile's on-chain reasoning parser (ProfileInfo.reasoningParser). When it resolves, the
   * leading reasoning span is split off first and tool calls are parsed from the remainder only
   * (Manifest S7.3 rule 5). Zero value or absent = no reasoning separation.
   */
  readonly reasoningParser?: ParserRef;
  /** Defaults to the built-in reasoning registry (qwen3@1, unverified). */
  readonly reasoningRegistry?: ReasoningRegistry;
}

/** The parsers a task's profile pins on chain (ProfileState.tool_call_parser / reasoning_parser). */
export interface ProfileParsers {
  /** Zero value when the profile offers no tool calling. */
  readonly toolCallParser: ParserRef;
  /** Zero value when the profile pins no reasoning parser. */
  readonly reasoningParser: ParserRef;
}

/**
 * Parameters of TrueOpenClient.assistantTurn: the stream's, with the trust anchors always from
 * chain, plus the parser options (the profile's on-chain parsers when not given) and the wait for
 * the receipt.
 */
export interface AssistantTurnParams extends Omit<StreamOutputParams, 'taskHash' | 'workerServicePubKey'> {
  /** Defaults to the task profile's on-chain parser (profileParsers). */
  readonly toolCallParser?: ParserRef;
  /** Defaults to the task profile's on-chain reasoning parser. Ignored when toolCallParser is given without it. */
  readonly reasoningParser?: ParserRef;
  readonly registry?: ToolCallRegistry;
  readonly reasoningRegistry?: ReasoningRegistry;
  /** Whether unverified parsers may be used (the built-in parsers are unverified until their vectors exist). */
  readonly allowUnverified?: boolean;
  /** How long to wait for the accepted InferReceipt after the stream ends; default 120 s. */
  readonly receiptTimeoutMs?: number;
  /** Interval between receipt reads; default 1000 ms. */
  readonly receiptPollIntervalMs?: number;
  /** Aborts the wait for the receipt. */
  readonly signal?: AbortSignal;
}

/**
 * What assistantTurn yields: reasoning and content as frames verify (provisional, for display),
 * then the confirmed message once the receipt matched. Tool calls appear only in `confirmed`.
 */
export type AssistantTurnEvent =
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'content'; readonly text: string }
  /** The dispatch attempt was voided (Phase 1): discard the reasoning and content shown so far. */
  | { readonly kind: 'reset' }
  | { readonly kind: 'confirmed'; readonly message: ConfirmedAssistantMessage };

/**
 * The tool parser used when the profile has none, or this build cannot vouch for it: the output
 * is content, with no calls (design S6). Running it through the same pipeline keeps reasoning
 * separation working for a profile that pins only a reasoning parser (S7.3 rule 9).
 */
const NO_TOOL_CALLS: ToolCallParser = {
  name: '',
  version: 0,
  parseComplete: (text) => ({ role: 'assistant', content: text, toolCalls: [] }),
  createStreamState: () => ({
    push: (text) => (text === '' ? [] : [{ kind: 'content', text }]),
    finish: () => [],
  }),
};

/**
 * Resolves both parsers the profile pins. A parser that does not resolve -- not pinned, unknown
 * to this build, or unverified without the caller's opt-in -- is simply not used (S7.3 rule 8,
 * design S6): the output still arrives, without that view.
 *
 * A pinned reasoning parser that does not resolve takes the tool-call parser with it
 * (TOOL_CALL_PARSER_V1, Support): without the reasoning split, a call the model wrote while
 * reasoning would be parsed, so the whole output is content with no calls.
 */
function resolveParsers(p: ToolCallParams): { parser: ToolCallParser; reasoning?: ReasoningParser } {
  const allow = p.allowUnverified === true ? { allowUnverified: true } : undefined;
  const tool = resolveToolCalling({
    toolCallParser: p.toolCallParser,
    registry: p.registry ?? BUILTIN_TOOL_CALL_PARSERS,
    ...(allow ?? {}),
  });
  const reasoning = (p.reasoningRegistry ?? BUILTIN_REASONING_PARSERS).lookup(p.reasoningParser ?? { name: '', version: 0 }, allow);
  const reasoningUsable = reasoning.supported || reasoning.reason === 'parser-not-pinned';
  return {
    parser: tool.supported && reasoningUsable ? tool.parser : NO_TOOL_CALLS,
    ...(reasoning.supported ? { reasoning: reasoning.parser } : {}),
  };
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
  /**
   * input_hash first sent under each idempotency key by this client. A Builder answers a retry
   * under the same key with the first result only when the input is the same and refuses it
   * otherwise; re-serializing the payload on retry changes the bytes and hits that refusal. This
   * refuses it before anything is signed. It lives as long as this client, not across processes.
   */
  private readonly inputHashByIdempotencyKey = new Map<string, string>();

  /** Registered session keys loaded on this client, by session (memory only), with their expiry. */
  private readonly registeredKeys: RegisteredSessionKeys;

  /** config.chainReadCache, when enabled. */
  private readonly readCache: ChainReadCache | undefined;
  /**
   * The hub reads an order makes: through readCache when it is enabled, and recording every
   * latest height read (readLatestHeight).
   */
  private readonly orderHub: FacadeHubReader | undefined;
  /** The highest latest height read so far and when (Date.now()). */
  private observedHeight: { readonly height: bigint; readonly at: number } | undefined;

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
    const keyRetryMs = cfg.sessionKeyChangeRetryMs;
    if (keyRetryMs !== undefined && (!Number.isFinite(keyRetryMs) || keyRetryMs < 0)) {
      throw local('SDK_LOCAL_SESSION_KEY_CONFIG_INVALID', `sessionKeyChangeRetryMs must be a finite number >= 0, got ${String(keyRetryMs)}`);
    }
    const replacementMs = cfg.orderReplacementRetryMs;
    if (replacementMs !== undefined && (!Number.isFinite(replacementMs) || replacementMs < 0)) {
      throw local('SDK_LOCAL_CONFIG_INVALID', `orderReplacementRetryMs must be a finite number >= 0, got ${String(replacementMs)}`);
    }
    const cacheOpt = cfg.chainReadCache;
    this.readCache =
      cacheOpt === undefined || cacheOpt === false ? undefined : new ChainReadCache(cacheOpt === true ? {} : cacheOpt);
    const rawHub = cfg.hub;
    this.orderHub =
      rawHub === undefined ? undefined : { ...hubOrderReads(rawHub, this.readCache), getLatestHeight: () => this.readLatestHeight(rawHub) };
    this.sessionManager = new SessionManager(cfg.chain);
    // Requests use a registered key only up to a margin before its expiry height; the height comes from the hub,
    // reused from the client's own recent reads (readLatestHeight) where one exists.
    const hub = cfg.hub;
    this.registeredKeys = new RegisteredSessionKeys({
      ...(hub !== undefined ? { latestHeight: () => hub.getLatestHeight() } : {}),
      heightMaxAgeMs: DEFAULT_TRUST_ANCHOR_POLL_MS,
      ...(margin !== undefined ? { expiryMarginBlocks: margin } : {}),
      ...(keyRetryMs !== undefined ? { keyChangeRetryDelayMs: keyRetryMs } : {}),
    });
    this.sessionGrants =
      cfg.session === undefined
        ? undefined
        : new SessionKeyManager({
            chainId: cfg.chainId,
            userAddress: cfg.userAddress,
            wallet: cfg.wallet,
            signatureChainId: this.signatureChainId(),
            // A height read within about a block is reused: the renewal margin covers it, and a
            // lagging height only moves a new grant's expiry earlier.
            latestHeight: () => this.recentLatestHeight('a session grant expiry'),
            maxGrantBlocks: cfg.session.maxGrantBlocks,
            ...(cfg.session.grantBlocks !== undefined ? { grantBlocks: cfg.session.grantBlocks } : {}),
            ...(cfg.session.renewBeforeBlocks !== undefined ? { renewBeforeBlocks: cfg.session.renewBeforeBlocks } : {}),
          });
    this.ingress = new IngressClient(cfg.ingressTransport, this.ingressAuth());
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
    if (this.observedHeight === undefined || h >= this.observedHeight.height) this.observedHeight = { height: h, at: Date.now() };
    return h;
  }

  /**
   * A latest height read at most RECENT_HEIGHT_MAX_AGE_MS (about one block) ago, else a fresh
   * one. For an expiry counted from the head, where a block of lag only shortens the window.
   */
  private async recentLatestHeight(what: string): Promise<bigint> {
    const seen = this.observedHeight;
    if (seen !== undefined && Date.now() - seen.at <= RECENT_HEIGHT_MAX_AGE_MS) return seen.height;
    return this.latestHeight(what);
  }

  /** Drops every result config.chainReadCache holds (a no-op without it). */
  invalidateChainReadCache(): void {
    this.readCache?.invalidate();
  }

  /** The signer-chosen EIP-712 domain chainId: config.signatureChainId, else the default 1. */
  signatureChainId(): bigint {
    return signatureChainIdBigInt(this.cfg.signatureChainId ?? DEFAULT_SIGNATURE_CHAIN_ID);
  }

  /**
   * Creates a session (MsgCreateSession, signed by the wallet). A string is the local label.
   *
   * Phase 1: the chain requires `initialBuilder` (the Session's bound Builder) and takes an
   * optional `initialDeposit` prefunding the Session in the same transaction.
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
    const funding = { initialBuilder: o.initialBuilder ?? '', initialDeposit: o.initialDeposit ?? '0' };
    if (o.sessionKey === undefined) return this.sessionManager.create(o.label, funding);
    const key = this.newSessionKey(o.sessionKey.key);
    const { expiryHeight, spendCap, latest } = await this.sessionKeyTerms(o.sessionKey, async () => '0');
    const handle = await this.sessionManager.create(o.label, { ...funding, sessionKey: { sessionKey: key.address, expiryHeight, spendCap } });
    this.registeredKeys.set(registeredSessionKey(handle.sessionId, key.privateKey), expiryHeight, await this.keyChangeHeight(latest + 1n));
    return { ...handle, sessionKey: keyHandle(key, expiryHeight, spendCap) };
  }

  /** Adds funds to a Session (MsgDepositSession, signed by the wallet). */
  depositSession(input: DepositSessionInput) {
    if (!this.cfg.chain.depositSession) throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_SESSION_FUNDING_UNSUPPORTED', 'Chain adapter does not support Session deposits');
    return this.cfg.chain.depositSession(input);
  }

  /** Registers a delayed withdrawal or CLOSE (MsgWithdrawSession, signed by the wallet). */
  withdrawSession(input: WithdrawSessionInput) {
    if (!this.cfg.chain.withdrawSession) throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_SESSION_FUNDING_UNSUPPORTED', 'Chain adapter does not support Session withdrawals');
    return this.cfg.chain.withdrawSession(input);
  }

  /** Registers a delayed CLOSE of the Session (withdrawSession with `close`). */
  closeSession(sessionId: string) {
    return this.withdrawSession({ sessionId, close: true });
  }

  /**
   * The height a key registration that just landed is taken to have changed at: the latest
   * height read now, which is at or after the transaction's height (so the key-change window,
   * see IngressAuth.registeredKeys, is never shorter than the Builders' cache lag), else
   * `fallback` when that read fails.
   */
  private async keyChangeHeight(fallback: bigint): Promise<bigint> {
    const hub = this.cfg.hub;
    if (hub === undefined) return fallback;
    try {
      const h = await this.readLatestHeight(hub);
      return h > fallback ? h : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * The session read every MsgUpdateSessionKey action starts with: refuses, before any
   * transaction, a session that is not this client's user's (SDK_LOCAL_SESSION_NOT_OWNER; the
   * chain answers sdk ErrUnauthorized) or that is CLOSED (SDK_LOCAL_SESSION_CLOSED; the chain
   * answers "session cannot update authorization").
   */
  private async updatableSession(sid: string): Promise<StreamStateView> {
    const s = await this.cfg.chain.querySession(sid);
    if (s.owner !== this.cfg.userAddress) {
      throw local('SDK_LOCAL_SESSION_NOT_OWNER', `session ${sid} belongs to ${s.owner}, not this client's user ${this.cfg.userAddress}`);
    }
    if (s.status === 'CLOSED') throw local('SDK_LOCAL_SESSION_CLOSED', `session ${sid} is CLOSED`);
    return s;
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
   * Every action first reads the session and sends nothing when it belongs to another user
   * (SDK_LOCAL_SESSION_NOT_OWNER) or is CLOSED (SDK_LOCAL_SESSION_CLOSED). `spent` is never reset.
   * `expiryBlocks` is validated as in createSession. A transaction the chain refuses is
   * classified (CHAIN_SESSION_KEY_INVALID, CHAIN_SESSION_KEY_EXPIRED,
   * CHAIN_SESSION_KEY_SPEND_CAP_EXCEEDED, CHAIN_SESSION_CLOSED, CHAIN_SESSION_NOT_OWNER; see
   * CosmjsChainWriter).
   *
   * Builders may lag a rotate or renew by up to MAX_SESSION_KEY_CACHE_TTL_BLOCKS (10) blocks: their
   * cached session state can still hold the old key or expiry. Within that window a key-signed
   * request or OpenTask they refuse is re-sent after about a block (see IngressAuth.registeredKeys).
   * Renew at least 10 blocks before the expiry, so no Builder still holding the old expiry sees it
   * pass.
   */
  async updateSessionKey(sessionId: string, update: SessionKeyUpdate): Promise<UpdateSessionKeyResult> {
    const sid = sessionIdText(sessionId);
    if ('clear' in update) {
      await this.updatableSession(sid);
      const response = await this.cfg.chain.updateSessionKey({ sessionId: sid, action: { clear: true } });
      // The wallet signs from now on, which the chain accepts whether or not the clear is pending.
      this.registeredKeys.delete(sid);
      const effectiveHeight = response.pendingChange?.effectiveHeight;
      return effectiveHeight !== undefined ? { response, effectiveHeight } : { response };
    }
    if ('renew' in update) {
      const loaded = this.registeredKeys.get(sid);
      if (loaded === undefined) {
        throw local('SDK_LOCAL_SESSION_KEY_NOT_REGISTERED', `no session key is loaded for session ${sid}: rotate, or load it with useSessionKey`);
      }
      // Renew only the chain's current key: re-registering a key that was rotated out or cleared
      // (perhaps on another device, perhaps because it leaked) would make it current again.
      const s = await this.updatableSession(sid);
      if (s.sessionKey === undefined || !bytesEqual(s.sessionKey, loaded.address)) {
        throw local(
          'SDK_LOCAL_SESSION_KEY_NOT_REGISTERED',
          `the loaded key ${sessionKeyAddressHex(loaded.address)} is no longer the registered key of session ${sid} ` +
            '(rotated or cleared): rotate to a fresh key, or load the current one with useSessionKey',
        );
      }
      const { expiryHeight, spendCap, latest } = await this.sessionKeyTerms(update.renew, async () => s.sessionKeySpendCap);
      const response = await this.cfg.chain.updateSessionKey({
        sessionId: sid,
        action: { set: { sessionKey: loaded.address, expiryHeight, spendCap } },
      });
      this.registeredKeys.refreshExpiry(sid, loaded.address, expiryHeight);
      // A renew keeps set_height, so the change height is the transaction's.
      this.registeredKeys.noteKeyChange(sid, await this.keyChangeHeight(latest + 1n));
      return { response };
    }
    const old = this.registeredKeys.get(sid);
    const key = this.newSessionKey(update.rotate.key, old?.address);
    const s = await this.updatableSession(sid);
    const { expiryHeight, spendCap, latest } = await this.sessionKeyTerms(update.rotate, async () => {
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
    const pending = response.pendingChange?.effectiveHeight ?? response.effectiveHeight;
    if (pending !== undefined && response.pendingChange !== undefined) {
      // Restrictive changes are delayed (wire #49): the old key stays the chain's key until the
      // effective height, so it stays loaded; the caller loads the new one then (useSessionKey).
      return { response, newKey: keyHandle(key, expiryHeight, spendCap), effectiveHeight: pending };
    }
    // A new key's set_height is the height the transaction executed at.
    const changed = response.setHeight > 0n ? response.setHeight : await this.keyChangeHeight(latest + 1n);
    this.registeredKeys.set(registeredSessionKey(sid, key.privateKey), expiryHeight, changed);
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
    // The registration's set_height opens the key-change window (a renew elsewhere is not visible).
    this.registeredKeys.set(key, s.sessionKeyExpiryHeight, s.sessionKeySetHeight);
  }

  /** Unloads a session's registered key; the wallet signs that session's orders again. The registration on chain is unchanged. */
  forgetSessionKey(sessionId: string): void {
    this.registeredKeys.delete(sessionId);
  }

  /** The chain's session-key state for a session (QuerySession), and whether the loaded key is the registered one. */
  async sessionKeyState(sessionId: string): Promise<SessionKeyState> {
    const s = await this.cfg.chain.querySession(sessionIdText(sessionId));
    const loaded = this.registeredKeys.get(s.sessionId);
    this.registeredKeys.refreshExpiry(s.sessionId, s.sessionKey, s.sessionKeyExpiryHeight, s.sessionKeySetHeight);
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
  ): Promise<{ expiryHeight: bigint; spendCap: string; latest: bigint }> {
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
    const terms = (blocks: bigint): { expiryHeight: bigint; spendCap: string; latest: bigint } => {
      const expiryHeight = latest + blocks;
      // The chain's heights live in [0, 2^63 - 1] (node CheckedHeightAddV1).
      if (expiryHeight > MAX_BLOCK_HEIGHT) {
        throw local('SDK_LOCAL_SESSION_KEY_INVALID', `expiry height ${expiryHeight} exceeds the chain's maximum height ${MAX_BLOCK_HEIGHT}`);
      }
      return { expiryHeight, spendCap: cap, latest };
    };
    if (o.expiryBlocks === undefined) {
      return terms(max - 2n > MIN_SESSION_KEY_EXPIRY_BLOCKS ? max - 2n : MIN_SESSION_KEY_EXPIRY_BLOCKS);
    }
    const blocks = o.expiryBlocks;
    if (!Number.isSafeInteger(blocks) || BigInt(blocks) < MIN_SESSION_KEY_EXPIRY_BLOCKS || BigInt(blocks) > max) {
      throw local(
        'SDK_LOCAL_SESSION_KEY_INVALID',
        `expiryBlocks must be an integer in [${MIN_SESSION_KEY_EXPIRY_BLOCKS}, ${max}], got ${String(blocks)}`,
      );
    }
    return terms(BigInt(blocks));
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
   * Read the current BuilderSet and Session binding, sign the order, and submit to
   * the bound Builder. Use openTaskWithRecovery for bounded sequential takeover.
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
   * The Keeper checks a registered key's expiry at the height that admits the order, which lies
   * in [earliest_submit_height, order_expire_height]: an order whose earliest_submit_height is
   * after the key's expiry is refused (SDK_LOCAL_SESSION_KEY_EXPIRED); one whose window only ends
   * after it is sent, with `keyExpiresInOrderWindow` set on the result (the chain rejects it if it
   * is admitted after the expiry).
   *
   * An order whose order_expire_height is below the context's latest height is refused before
   * signing (SDK_LOCAL_ORDER_EXPIRED): every Builder would answer NEXUS_INGRESS_ORDER_EXPIRED.
   * With `orderWindow` (as in retryParams) the window is rebased on the context's latest height.
   *
   * Re-sends to one Builder, each with the envelope re-signed under a fresh nonce (the Builder
   * consumed the previous one; the signed order is unchanged): a key-signed OpenTask refused
   * inside the key-change window (Builders may lag a key change by up to
   * MAX_SESSION_KEY_CACHE_TTL_BLOCKS blocks; see IngressAuth.registeredKeys); and a retry (params
   * from retryParams) refused with NEXUS_INGRESS_ORDER_REPLACEMENT_UNSUPPORTED, by a Builder still
   * tracking the rejected version until its next reconcile, after orderReplacementRetryMs (about a
   * block), at most ORDER_REPLACEMENT_RETRY_ATTEMPTS times. A wallet-signed envelope prompts the
   * wallet on each such re-send. openTask returns once every Builder settled.
   *
   * Hard rule unchanged: an ingress ack is only local acceptance; the on-chain query/event is the
   * source of truth for final state.
   */
  async openTask(params: OpenTaskParams): Promise<OpenTaskResult> {
    if (this.readCache === undefined) return this.submitOpenTask(params);
    try {
      return await this.submitWithFreshReadsOnError(params);
    } catch (err) {
      // Every failure drops the cache (see submitWithFreshReadsOnError); an order refused for a
      // BuilderSet the cache may have kept too long is sent once more, built on fresh reads.
      if (!isStaleChainDataError(err)) throw err;
      return this.submitWithFreshReadsOnError(params);
    }
  }

  /** submitOpenTask, dropping config.chainReadCache when it fails, so what follows reads fresh. */
  private async submitWithFreshReadsOnError(params: InternalOpenTaskParams, destination?: string): Promise<OpenTaskResult> {
    try {
      return await this.submitOpenTask(params, destination);
    } catch (err) {
      this.readCache?.invalidate();
      throw err;
    }
  }

  /** Recover one sequence from chain state; never submits a sequence already consumed. */
  async openTaskWithRecovery(params: OpenTaskParams, policy: DispatchRecoveryPolicy): Promise<OpenTaskResult | OpenTaskAck> {
    const hub = this.orderHub;
    if (!hub) throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_ROUTING_UNCONFIGURED', 'Recovery requires a Hub reader');
    // Independent, so concurrent; the context resolution also yields the BuilderSet it read.
    const [state, first] = await Promise.all([
      this.cfg.chain.querySession(params.sessionId),
      params.context !== undefined ? undefined : this.resolveOrderContext(),
    ]);
    const orderSequence = params.orderSequence ?? state.nextExpectedSequence;
    let context = params.context ?? first!.context;
    let set: BuilderSetSnapshot = first?.builderSet ?? await hub.getBuilderSetAtHeight(context.sessionAnchorHeight);
    const membersOf = (s: BuilderSetSnapshot): string[] => s.builders.split(',').map(x => x.trim()).filter(Boolean);
    // The session read above serves the first readSession; every later one reads the chain. The
    // last read is handed to submitOpenTask when it is at most about a block old and the order is
    // not refreshed, instead of reading the session once more.
    let unread: StreamStateView | undefined = state;
    let lastSession: { readonly view: StreamStateView; readonly at: number } | undefined;
    let result: OpenTaskResult | undefined;
    const ack = await recoverDispatch({
      taskId: deriveTaskId(params.sessionId, orderSequence),
      orderSequence, builders: membersOf(set),
      refreshBuilders: async () => {
        this.readCache?.invalidate();
        ({ context, builderSet: set } = await this.resolveOrderContext());
        return membersOf(set);
      },
      readSession: async () => {
        const view = unread ?? await this.cfg.chain.querySession(params.sessionId);
        unread = undefined;
        lastSession = { view, at: Date.now() };
        return view;
      },
      readHeight: () => hub.getLatestHeight(),
      submit: async (builder, refresh) => {
        const { context: _oldContext, expiryHeight: _oldExpiry, ...rest } = params;
        if (refresh) ({ context, builderSet: set } = await this.resolveOrderContext());
        const session = !refresh && lastSession !== undefined && Date.now() - lastSession.at <= RECENT_HEIGHT_MAX_AGE_MS ? lastSession.view : undefined;
        lastSession = undefined;
        result = await this.submitWithFreshReadsOnError({
          ...rest, orderSequence, context,
          ...(policy.signal === undefined ? {} : { signal: policy.signal }),
          [READ_SESSION]: session,
          [READ_BUILDER_SET]: set,
        }, builder);
        return result;
      },
      recorded: async (builder, hintedTaskId) => {
        const taskId = deriveTaskId(params.sessionId, orderSequence);
        if (hintedTaskId !== undefined && hintedTaskId !== taskId) throw new TrueOpenError('DATA', 'DATA_TASK_SEQUENCE_MISMATCH', 'OpenTask redirect names another task');
        if (!this.cfg.taskReader) throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_TRUST_ANCHORS_UNCONFIGURED', 'QueryTask is required to distinguish admission from cancellation');
        const task = await this.cfg.taskReader.queryTask(taskId);
        if (task.taskId !== taskId || task.orderSequence !== orderSequence) throw new TrueOpenError('DATA', 'DATA_TASK_SEQUENCE_MISMATCH', 'Recorded task has another sequence');
        result = undefined;
        return { taskId, sessionId: params.sessionId, accepted: true, reason: '', status: 4, boundBuilder: builder };
      },
    }, policy);
    return result ?? ack;
  }

  private async submitOpenTask(input: InternalOpenTaskParams, destination?: string): Promise<OpenTaskResult> {
    // The reads recovery hands over stay out of the params (and so out of retryParams).
    const { [READ_SESSION]: readSession, [READ_BUILDER_SET]: callerSet, ...params } = input;
    const { ingressTransportFactory } = this.cfg;
    const rawHub = this.cfg.hub;
    const hub = this.orderHub;
    if (!rawHub || !hub || !ingressTransportFactory) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_ROUTING_UNCONFIGURED',
        'openTask requires config.hub and config.ingressTransportFactory',
      );
    }
    if (params.ackTimeoutMs !== undefined && (!Number.isFinite(params.ackTimeoutMs) || params.ackTimeoutMs <= 0)) {
      throw local('SDK_LOCAL_INVALID_TIMEOUT', 'ackTimeoutMs must be positive and finite');
    }
    const signer = params.orderSigner ?? 'auto';
    if (signer !== 'auto' && signer !== 'wallet') {
      throw local('SDK_LOCAL_ORDER_SIGNER_INVALID', `orderSigner must be 'auto' or 'wallet', got ${JSON.stringify(signer)}`);
    }
    const signatureChainId = this.signatureChainId();
    // These reads are independent, so they run concurrently. The fee denom and the pricing go
    // into the signature or decide whether the chain accepts the order, and a mistake in
    // either only surfaces after nexus accepted the order: the task just vanishes.
    // One session read serves the Phase 1 checks (binding, closing, frozen lifetime), the key
    // prechecks and the order sequence.
    // orderSigner 'wallet': as if no key were loaded (no prechecks, no key-signed envelope).
    const registered = signer === 'wallet' ? undefined : this.registeredKeys.get(params.sessionId);
    const callerContext = params.context !== undefined;
    // With a caller's context, the envelope expiry needs the head (unless expiryHeight is given)
    // and routing needs the BuilderSet at the context's anchor: both are known now, so they are
    // read alongside the rest.
    const [feeDenom, pricing, stream, firstResolved, callerHead] = await Promise.all([
      this.resolveFeeDenom(),
      params.pricing !== undefined ? Promise.resolve(params.pricing) : this.readProfilePricing(params.order),
      readSession ?? this.cfg.chain.querySession(params.sessionId),
      params.context !== undefined
        ? (callerSet !== undefined && callerSet.setHash === params.context.builderSetHash
            ? Promise.resolve(callerSet)
            : hub.getBuilderSetAtHeight(params.context.sessionAnchorHeight)
          ).then((builderSet): ResolvedTaskOrderContext => ({ context: params.context!, builderSet }))
        : this.resolveOrderContext(),
      callerContext && params.expiryHeight === undefined ? this.recentLatestHeight('the OpenTask expiry') : undefined,
    ]);
    if (stream.status === 'CLOSED' || stream.pendingWithdrawKind === 'CLOSE') {
      throw local('SDK_LOCAL_SESSION_CLOSING', `session ${params.sessionId} is closed or has a pending close`);
    }
    if (!stream.boundBuilder) {
      throw local('SDK_LOCAL_SESSION_BINDING_MISSING', `session ${params.sessionId} has no bound Builder; refresh its chain state`);
    }
    const dispatchingBuilder = destination ?? stream.boundBuilder;
    const orderSequence = params.orderSequence ?? stream.nextExpectedSequence;
    if (registered !== undefined) {
      this.registeredKeys.refreshExpiry(params.sessionId, stream.sessionKey, stream.sessionKeyExpiryHeight, stream.sessionKeySetHeight);
    }
    const windowOffsets = params.orderWindow !== undefined ? checkOrderWindow(params.orderWindow) : undefined;
    // The context (with the key's anchor check) and the order built on it. A retry whose order
    // would come out identical to the rejected one resolves one fresh context (see below).
    const orderOn = async (
      first: ResolvedTaskOrderContext,
    ): Promise<{ resolved: ResolvedTaskOrderContext; order: TaskOrderV3 }> => {
      let resolved = first;
      if (registered !== undefined && !checkSessionKeyAdmission(registered, stream, resolved.context)) {
        // Only the anchor failed: it predates the key's registration (set or rotated after it).
        resolved = await this.anchorAfterSetHeight(registered, stream, resolved.context, callerContext);
      }
      const c = resolved.context;
      // A relative window (retryParams) is rebased on this context's latest height. Otherwise
      // the order is anchored at the latest height and keeps the lifetime the caller asked for,
      // so a re-signed retry -- including after DISPATCH_NOT_READY past the old expiry -- gets a
      // later expiry too.
      const window =
        windowOffsets === undefined
          ? {
              earliestSubmitHeight: c.latestHeight,
              orderExpireHeight: c.latestHeight + (params.order.orderExpireHeight - params.order.earliestSubmitHeight),
            }
          : {
              earliestSubmitHeight: rebaseHeight(c.latestHeight, windowOffsets.earliestSubmitBlocks),
              orderExpireHeight: rebaseHeight(c.latestHeight, windowOffsets.orderExpireBlocks),
            };
      // The lifetime must fit the Session's frozen max_order_lifetime_blocks (wire #49), else the
      // chain refuses it after the order was dispatched.
      validateOrderLifetime(
        window.earliestSubmitHeight,
        window.orderExpireHeight,
        stream.frozenParams?.maxOrderLifetimeBlocks ?? MAX_ORDER_LIFETIME_BLOCKS_V1,
      );
      const built = buildTaskOrder(
        c,
        { ...params.order, ...window, userAddress: this.cfg.userAddress, sessionId: params.sessionId, orderSequence },
        pricing,
      );
      // Every Builder refuses an order past its order_expire_height (NEXUS_INGRESS_ORDER_EXPIRED).
      if (c.latestHeight > built.orderExpireHeight) {
        throw local(
          'SDK_LOCAL_ORDER_EXPIRED',
          `the order's order_expire_height ${built.orderExpireHeight} is below the latest height ${c.latestHeight}: ` +
            'no Builder accepts it and the chain cannot admit it; choose a later order_expire_height',
          { details: { orderExpireHeight: built.orderExpireHeight, latestHeight: c.latestHeight } },
        );
      }
      if (registered !== undefined) checkSessionKeyOrderWindow(stream, built);
      return { resolved, order: built };
    };
    let { resolved, order } = await orderOn(firstResolved);
    const rejectedTaskHash = params[REJECTED_TASK_HASH];
    if (rejectedTaskHash !== undefined && taskOrderHashHex(order) === rejectedTaskHash) {
      // The Builders deleted the rejected order's input and keep a tombstone for it, so the very
      // same order would be refused (NEXUS_DATA_CONFLICT). A fresh anchor, or a later latest
      // height under a relative window, changes it.
      if (!callerContext) {
        ({ resolved, order } = await orderOn(await this.resolveOrderContext()));
      }
      if (taskOrderHashHex(order) === rejectedTaskHash) {
        throw local(
          'SDK_LOCAL_RETRY_ORDER_UNCHANGED',
          `the retried order has the same task_hash ${rejectedTaskHash} as the rejected one, which the Builders refuse: ` +
            'change the order (for example its order_expire_height or fees) or retry a block later',
          { retriable: true },
        );
      }
    }
    const ctx = resolved.context;
    if (registered !== undefined) checkSessionKeySpendCap(stream, order.maxFee.atomicUnits);
    const taskId = deriveTaskId(params.sessionId, orderSequence);
    const inputHash = hash32Text(order.inputHash);
    this.checkIdempotencyKey(params.idempotencyKey, inputHash);
    // expiry must be a block height: nexus interprets values >= 1e12 as unix milliseconds and rejects them.
    // The envelope is signed now, so its expiry counts from the current head. A context the caller
    // (or recovery, moving to another Builder) passes in may be many blocks old: counting from its
    // latestHeight would send an envelope that is already expired (NEXUS_DATA_EXPIRED). The head
    // read for it may be up to about a block old (recentLatestHeight), well inside the window.
    const head = callerContext ? callerHead : ctx.latestHeight;
    const expiryHeight = params.expiryHeight ?? head! + BigInt(this.cfg.requestTtlBlocks ?? 10);

    // Routing needs only task_id and the context, not the signature, so it runs while the
    // order is being signed (a browser wallet prompt can take seconds), and the dispatching
    // Builder is prewarmed as soon as it is known. The snapshot must be the BuilderSet that is
    // signed into the order (the set in effect at session_anchor_height); Phase 1 dispatches
    // directly to the Session's bound Builder (or the recovery destination).
    const routing = resolveTaskBuilderEndpoints(hub, {
      chainId: this.cfg.chainId,
      taskId,
      builderSetHash: ctx.builderSetHash,
      sessionAnchorHeight: ctx.sessionAnchorHeight,
      dispatchingBuilder,
      dispatchingOnly: true,
      builderSet: resolved.builderSet,
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

    // From here a Builder may hold the input under this key, so a different input is refused.
    // A failure before this point sent nothing, and leaves the key free.
    this.inputHashByIdempotencyKey.set(params.idempotencyKey, inputHash);
    // Where each Builder was actually reached: a certificate re-read can move it.
    const usedEndpoint = new Map<string, { uri: string; tlsPubkeyHash: string }>();
    const isRetry = rejectedTaskHash !== undefined;
    const replacementMs = this.cfg.orderReplacementRetryMs ?? DEFAULT_ORDER_REPLACEMENT_RETRY_MS;
    const signedWith = { ...(built.input.requestEnvelope.sessionGrant !== undefined ? { grant: built.input.requestEnvelope.sessionGrant } : {}),
      ...(registered !== undefined ? { keySession: registered.sessionId } : {}) };
    const fan = await fanOutToEndpoints(built.input, endpoints, async (endpoint: TaskBuilderEndpoint, first) => {
      let at = { uri: endpoint.serviceEndpoint, tlsPubkeyHash: endpoint.tlsPubkeyHash ?? '' };
      const submit = (req: typeof first): Promise<OpenTaskAck> => {
        usedEndpoint.set(endpoint.address, at);
        return new IngressClient(ingressTransportFactory(at.uri, at.tlsPubkeyHash)).openTask(req, {
          timeoutMs: params.ackTimeoutMs ?? 30_000,
          ...(params.signal === undefined ? {} : { signal: params.signal }),
        });
      };
      let req = first;
      let keyRetries = 0;
      let replacementRetries = 0;
      for (;;) {
        try {
          try {
            return await submit(req);
          } catch (err) {
            // The Builder rotated its certificate and the locally cached fingerprint is
            // stale -> re-read that Builder's descriptor; if the fingerprint changed, retry with the
            // new fingerprint, otherwise the peer certificate really is wrong, so return the original error.
            if (!isTLSPubkeyMismatch(err)) throw err;
            // Read past config.chainReadCache: the cached descriptor is what just failed.
            const fresh = await rereadNexusEndpoint(rawHub, endpoint.address);
            if (!fresh || fresh.tlsPubkeyHash === at.tlsPubkeyHash) throw err;
            this.readCache?.invalidate();
            at = { uri: fresh.uri, tlsPubkeyHash: fresh.tlsPubkeyHash };
            return await submit(req);
          }
        } catch (err) {
          // A Builder still caching the session's state from before a key change refuses the
          // key-signed order or envelope for up to MAX_SESSION_KEY_CACHE_TTL_BLOCKS blocks.
          if (registered !== undefined && (await this.registeredKeys.retryAfterKeyChange(registered.sessionId, err, keyRetries))) {
            keyRetries += 1;
          } else if (
            isRetry &&
            err instanceof TrueOpenError &&
            err.code === 'NEXUS_INGRESS_ORDER_REPLACEMENT_UNSUPPORTED' &&
            replacementRetries < ORDER_REPLACEMENT_RETRY_ATTEMPTS
          ) {
            // A Builder whose FSM for the rejected order is still pending abandons it on its next
            // reconcile, about a block after the order's deadline; then it takes the new version.
            replacementRetries += 1;
            await new Promise((r) => setTimeout(r, replacementMs));
          } else {
            throw finalSignedError(err, signedWith, false);
          }
          // The Builder consumed the previous nonce: sign the envelope again with a fresh one.
          req = await built.resign(this.nextNonce());
        }
      }
    }).catch((error: unknown) => {
      if (error instanceof TaskBuilderAllEndpointsFailedError) {
        const rejection = error.results[0]?.error;
        if (rejection instanceof TrueOpenError && ['NEXUS_INGRESS_SESSION_BOUND_ELSEWHERE', 'NEXUS_INGRESS_TAKEOVER_PENDING'].includes(rejection.code)) throw rejection;
      }
      if (destination !== undefined && error instanceof TaskBuilderAllEndpointsFailedError) {
        const first = error.results[0];
        if (first?.error !== undefined) throw first.error;
        if (first?.ack?.status === 2) return { ack: first.ack, results: [...error.results] };
      }
      throw error;
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
      earliestSubmitHeight: order.earliestSubmitHeight,
      orderExpireHeight: order.orderExpireHeight,
      ...(registered !== undefined
        ? {
            sessionKeyExpiryHeight: stream.sessionKeyExpiryHeight,
            ...(order.orderExpireHeight > stream.sessionKeyExpiryHeight ? { keyExpiresInOrderWindow: true as const } : {}),
          }
        : {}),
      retryParams: retryParamsOf(params, orderSequence, order, ctx.latestHeight, built.taskHash),
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
   * Builder that acked the order is watched, as hints only: DISPATCH_RECORDED
   * triggers an immediate chain read; RECORD_REJECTED / NO_CAPACITY / ASSIGN_TIMEOUT / ORDER_EXPIRED is
   * recorded as that Builder's report. A Builder keeps an abandoned task's journal and appends a
   * retry's events to it, and the stream replays it from the start, so only a report after the
   * last ORDER_RECEIVED counts (an ORDER_RECEIVED clears the Builder's report). A stream that
   * fails NotFound counts as the report ABANDONED_REPORT (the Builder no longer tracks a task it
   * acked); any other stream failure is ignored. One
   * Builder's rejection does not prove another did not get the order admitted, so the result is
   * `rejected` only once every acked Builder has reported a rejection or a timeout and a chain
   * read started after the last report still finds no task; or, whatever the Builders
   * reported, once the latest height is past the order's order_expire_height (the Keeper can no
   * longer admit it) and a read made after that finds no task. The second rule matters because
   * the event streams are signed with this client's ingressAuth(), so with the loaded key: a
   * Builder refuses them once that key was rotated or cleared or the session closed, and such a
   * Builder never reports. A task with no valid accepted task_hash decides nothing yet. The
   * session is then read
   * (QuerySession) to diagnose the reason (`expired` is judged against the later of the latest
   * height at diagnosis time and the order's earliest_submit_height) and whether the sequence is
   * still free; `retry` is
   * `res.retryParams`, without `orderSequence` when the sequence moved on (then openTask reads
   * the next free one).
   *
   * The SDK never re-signs, renews, raises a cap or switches to the wallet by itself: the caller
   * decides (renew or rotate with updateSessionKey, `orderSigner: 'wallet'`, ...) and calls
   * openTask with `retry`. A re-signed order has a new task_hash, which is why the retry carries
   * a new idempotency key; its window is rebased (retryParams.orderWindow). Builders that
   * abandoned the rejected order accept the new version; one still tracking it answers
   * NEXUS_INGRESS_ORDER_REPLACEMENT_UNSUPPORTED until it reconciles, which openTask retries (see
   * openTask). A task that reached the chain and finished is refused (NEXUS_INGRESS_TASK_TERMINAL).
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

    // The Builders that accepted the order; each one's rejection report for this attempt, and a
    // counter of report changes so a read can tell whether one landed after it started.
    const acked = res.builders.filter((b) => b.ack?.accepted === true);
    const reports = new Map<string, { readonly builderAddress: string; readonly eventCode: string }>();
    let reportGen = 0;
    const report = (address: string, eventCode: string): void => {
      if (reports.has(address)) return;
      reports.set(address, { builderAddress: address, eventCode });
      reportGen += 1;
      wake();
    };
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
            if (ev.eventCode === ORDER_RECEIVED_EVENT) {
              // A Builder keeps an abandoned task's journal and appends a retry's events to it, and
              // the stream replays it from the start: only reports after the last ORDER_RECEIVED
              // (this order's, appended before its ack) are about this order.
              if (reports.delete(b.address)) reportGen += 1;
            } else if (ADMISSION_REJECT_EVENTS.has(ev.eventCode)) {
              report(b.address, ev.eventCode);
            } else if (ADMISSION_HINT_EVENTS.has(ev.eventCode)) {
              wake();
            }
          }
        } catch (e) {
          // NotFound from a Builder that acked the order: it no longer tracks the task, so it
          // abandoned it (rejected or timed out). Any other failure is ignored: polling does not
          // depend on the streams.
          if (isNotFoundError(e)) report(b.address, ABANDONED_REPORT);
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
      // The chain alone checks the fee denom, the pricing and the bucket version: drop what
      // config.chainReadCache holds, so the retry is built on fresh reads.
      this.readCache?.invalidate();
      return { kind: 'rejected', taskId, diagnosis, retry };
    };

    // The Keeper cannot admit the order once the latest height is past its order_expire_height.
    // `pastDeadline` is set from a height read; a read that starts after that and finds no task
    // is a rejection whatever the Builders reported (a Builder may refuse the event stream, for
    // example when the key that signs it was rotated or cleared). `deadlineAtRead` is the flag
    // when the current read started.
    let pastDeadline = false;
    let deadlineAtRead = false;
    // A failed height read is "not past the deadline yet": like a failed task read, a hub blip
    // must not end the wait (abort still does, through race).
    const heightOrUndefined = (): Promise<bigint | undefined> => this.readLatestHeight(hub).catch(() => undefined);

    try {
      for (;;) {
        const task = await race(read);
        if (task !== undefined) {
          const out = decided(task);
          if (out !== undefined) return out;
        } else if (deadlineAtRead || (acked.length > 0 && reports.size === acked.length && genAtRead === reportGen)) {
          const out = await rejected();
          if (out !== undefined) return out;
        } else if (!pastDeadline && ((await race(heightOrUndefined())) ?? 0n) > res.orderExpireHeight) {
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
        // Let the event streams drain what has already arrived first: a replayed journal comes in
        // one burst, and a read decided between its rejection report and the ORDER_RECEIVED after it
        // would count the previous attempt's rejection.
        await race(new Promise<void>((r) => setTimeout(r, 0)));
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
    // The Keeper checks the expiry at the admitting height, which is at least earliest_submit_height.
    const latest = await this.latestHeight('the session key expiry');
    const admission = latest > res.earliestSubmitHeight ? latest : res.earliestSubmitHeight;
    if (admission > s.sessionKeyExpiryHeight) return 'expired';
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
   * (the latest height) reaches set_height; then one fresh context is resolved and rechecked.
   */
  private async anchorAfterSetHeight(
    key: RegisteredSessionKey,
    s: StreamStateView,
    current: TaskOrderChainContext,
    callerContext: boolean,
  ): Promise<ResolvedTaskOrderContext> {
    const setHeight = s.sessionKeySetHeight;
    const refuse = (anchorHeight: bigint, retriable: boolean, hint: string): TrueOpenError =>
      local(
        'SDK_LOCAL_SESSION_KEY_ANCHOR_BEFORE_SET_HEIGHT',
        `the session key was registered at height ${setHeight}, after the order's session anchor ${anchorHeight}: ${hint}`,
        { retriable, details: { setHeight, anchorHeight } },
      );
    if (callerContext) throw refuse(current.sessionAnchorHeight, false, 'pass a newer context');
    const hub = this.cfg.hub!;
    const waitMs = this.cfg.sessionKeyAnchorWaitMs ?? DEFAULT_SESSION_KEY_ANCHOR_WAIT_MS;
    const pollMs = this.cfg.sessionKeyAnchorPollMs ?? DEFAULT_TRUST_ANCHOR_POLL_MS;
    const deadline = Date.now() + waitMs;
    for (;;) {
      if ((await this.readLatestHeight(hub)) >= setHeight) break;
      const left = deadline - Date.now();
      if (left <= 0) throw refuse(current.sessionAnchorHeight, true, `no fresh anchor reached it within ${waitMs} ms; retry shortly`);
      await new Promise((r) => setTimeout(r, Math.min(pollMs, left)));
    }
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
    const read = this.orderHub?.getBusinessDenom;
    const chainDenom = read !== undefined ? await read() : undefined;
    return resolveFeeDenom(chainDenom, this.cfg.feeDenom);
  }

  /**
   * A fresh order context, anchored at the latest height, with the BuilderSet it read. The
   * latest height is always read; the rest may come from config.chainReadCache.
   */
  private async resolveOrderContext(): Promise<ResolvedTaskOrderContext> {
    return resolveTaskOrderContextWithBuilderSet(this.orderHub!, this.cfg.chainId);
  }

  /**
   * Warms what the next order reads, for a long-lived client (a chat server, say) that wants its
   * first order not to pay for cold reads: business_denom, the timeout bucket, the generation
   * limits, the BuilderSet at the latest height, and, when given, the model profile (`model`) and
   * the session's bound Builder descriptor (whose connection is then prewarmed through
   * config.ingressPrewarm). The results stay in config.chainReadCache; without it only the
   * connection prewarm lasts, so enable the cache to benefit. Call it again within the cache TTL
   * (60 s by default) to keep it warm; nothing runs in the background.
   *
   * Never rejects for a failed read: each failure is returned in `errors` (the order itself will
   * read again and report it). Needs config.hub (else SDK_LOCAL_ROUTING_UNCONFIGURED).
   */
  async prefetch(p: PrefetchParams = {}): Promise<PrefetchResult> {
    const hub = this.orderHub;
    if (hub === undefined) throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_ROUTING_UNCONFIGURED', 'prefetch requires config.hub');
    const errors: unknown[] = [];
    const attempt = async (read: () => Promise<unknown>): Promise<void> => {
      try {
        await read();
      } catch (e) {
        errors.push(e);
      }
    };
    const getProfile = hub.getProfile;
    const { sessionId, model } = p;
    await Promise.all([
      attempt(() => this.resolveFeeDenom()),
      attempt(() => this.resolveOrderContext()),
      ...(model !== undefined && getProfile !== undefined ? [attempt(() => getProfile(model.modelId, BigInt(model.profileVersion)))] : []),
      ...(sessionId !== undefined
        ? [
            attempt(async () => {
              const { boundBuilder } = await this.cfg.chain.querySession(sessionId);
              if (!boundBuilder) return;
              const endpoint = nexusGrpcEndpoint(await hub.getServiceDescriptor(boundBuilder));
              if (endpoint && endpoint.uri !== '') {
                await this.prewarmTaskBuilders([{ serviceEndpoint: endpoint.uri, tlsPubkeyHash: endpoint.tlsPubkeyHash ?? '' }]);
              }
            }),
          ]
        : []),
    ]);
    return { errors };
  }

  /**
   * The Task Builder an order would be sent to, before anything is signed: Phase 1 dispatches
   * directly to the Session's bound Builder, resolved from the BuilderSet of the order context.
   * openTask resolves it itself (while signing); call this to prewarm the connection even
   * earlier, for example while the user is still typing. Pass the returned `context` to openTask
   * so the order is signed against the same anchor and BuilderSet.
   */
  async resolveTaskBuilders(p: {
    readonly sessionId: string;
    /** Defaults to the on-chain next order sequence. */
    readonly orderSequence?: bigint;
    /** Defaults to a fresh context. */
    readonly context?: TaskOrderChainContext;
  }): Promise<{
    readonly taskId: string;
    readonly orderSequence: bigint;
    readonly context: TaskOrderChainContext;
    readonly endpoints: readonly TaskBuilderEndpoint[];
    readonly unresolvedBuilders: readonly { readonly address: string; readonly error: unknown }[];
  }> {
    const hub = this.orderHub;
    if (hub === undefined) {
      throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_ROUTING_UNCONFIGURED', 'resolveTaskBuilders requires config.hub');
    }
    const [stream, resolved] = await Promise.all([
      this.cfg.chain.querySession(p.sessionId),
      p.context !== undefined ? Promise.resolve<{ context: TaskOrderChainContext }>({ context: p.context }) : this.resolveOrderContext(),
    ]);
    if (!stream.boundBuilder) {
      throw local('SDK_LOCAL_SESSION_BINDING_MISSING', `session ${p.sessionId} has no bound Builder; refresh its chain state`);
    }
    const orderSequence = p.orderSequence ?? stream.nextExpectedSequence;
    const ctx = resolved.context;
    const taskId = deriveTaskId(p.sessionId, orderSequence);
    const { endpoints, errors } = await resolveTaskBuilderEndpoints(hub, {
      chainId: this.cfg.chainId,
      taskId,
      builderSetHash: ctx.builderSetHash,
      sessionAnchorHeight: ctx.sessionAnchorHeight,
      dispatchingBuilder: stream.boundBuilder,
      dispatchingOnly: true,
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
    const hub = this.orderHub;
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
    const base = { ...(task.dispatchTicketHash !== undefined ? { dispatchTicketHash: task.dispatchTicketHash } : {}), taskId, taskHash, winnerWorker: task.winnerWorker, workerServicePubKey: key.servicePubKey };
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
   * client's Builder event stream is watched too: the first DISPATCH_RECORDED event triggers
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
              if (ev.eventCode === DISPATCH_RECORDED_EVENT) {
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
  async fetchTaskOutput(p: FetchTaskOutputParams): Promise<{
    bytes: Uint8Array;
    text: string;
    outputHash: string;
    taskHash: string;
    chunks: Uint8Array[];
    sizeBytes: bigint;
    mediaType: string;
    /** The accepted InferReceipt the output was checked against, when it was read. */
    receipt?: InferReceiptView;
    /**
     * The termination reason from the Worker-signed Fin the Builder stored with the object
     * (TaskDataObjectMetadataV1.fin, ADR-0027), verified against the Worker's service key, the
     * leaf count and the output root. Undefined when the metadata carries no Fin or an unsigned
     * one: the reason is then unavailable, never inferred from the text or its length.
     */
    finishReason?: FinishReasonV1;
  }> {
    return this.fetchTaskOutputVia(this.ingress, p);
  }

  /** fetchTaskOutput against a given Builder's ingress (fetchAssistantMessage picks the Builder itself). */
  private async fetchTaskOutputVia(ingress: IngressClient, p: FetchTaskOutputParams): Promise<{
    bytes: Uint8Array;
    text: string;
    outputHash: string;
    taskHash: string;
    chunks: Uint8Array[];
    sizeBytes: bigint;
    mediaType: string;
    /** The accepted InferReceipt the output was checked against, when it was read. */
    receipt?: InferReceiptView;
    /**
     * The termination reason from the Worker-signed Fin the Builder stored with the object
     * (TaskDataObjectMetadataV1.fin, ADR-0027), verified against the Worker's service key, the
     * leaf count and the output root. Undefined when the metadata carries no Fin or an unsigned
     * one: the reason is then unavailable, never inferred from the text or its length.
     */
    finishReason?: FinishReasonV1;
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

    const meta = await ingress.getTaskDataMetadata({ objectRef, builderAddress: p.builderAddress, expiresAtHeight: await expiry() });
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
        ingress.fetchTaskDataRange({
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

    const finishReason = await this.verifyStoredFin(meta.fin, {
      taskId: p.taskId,
      taskHash,
      outputHash: got,
      leafCount: meta.outputLeafCount,
      workerServicePubKey: p.workerServicePubKey ?? anchors?.workerServicePubKey,
      dispatchTicketHash: anchors?.dispatchTicketHash,
    });

    return {
      // bytes is the committed object; text is its decoding. Cortex strips the trailing EOS
      // before committing (output_decoding.strip_trailing_eos), so nothing is stripped here.
      bytes,
      text: new TextDecoder().decode(bytes),
      outputHash: got,
      taskHash,
      chunks,
      sizeBytes: meta.sizeBytes,
      mediaType: meta.mediaType,
      ...(receipt !== undefined ? { receipt } : {}),
      ...(finishReason !== undefined ? { finishReason } : {}),
    };
  }

  /**
   * The finish reason of a stored Fin, checked the way the stream checks its trailing frame:
   * final_seq is the last leaf, output_mmr_root is the root just verified against the receipt,
   * and the Worker signed both together with the reason. A Fin that is present and signed but
   * fails any of these is a fault, not a missing fact, so it throws. An unsigned Fin attests
   * nothing and yields undefined.
   */
  private async verifyStoredFin(
    fin: { finalSeq: bigint; outputMmrRoot: Uint8Array; finishReason: FinishReasonV1; workerSignature: Uint8Array; dispatchTicketHash: Uint8Array } | undefined,
    c: {
      taskId: string; taskHash: string; outputHash: string; leafCount: bigint; workerServicePubKey: Uint8Array | undefined;
      /** The chain's accepted dispatch ticket, when known; the Fin must be for that attempt. */
      dispatchTicketHash: string | undefined;
    },
  ): Promise<FinishReasonV1 | undefined> {
    if (fin === undefined || fin.workerSignature.length === 0) return undefined;
    if (fin.finalSeq !== c.leafCount - 1n) {
      throw dataError('DATA_OUTPUT_FIN_SEQ_MISMATCH', `stored fin says final_seq=${fin.finalSeq} but the object has ${c.leafCount} leaves`);
    }
    if (fin.outputMmrRoot.length !== 32 || hash32Text(fin.outputMmrRoot) !== c.outputHash) {
      throw dataError('DATA_OUTPUT_FIN_ROOT_MISMATCH', `stored fin root does not match output_hash for task ${c.taskId}`);
    }
    const key = c.workerServicePubKey
      ?? (await this.resolveOutputTrustAnchors(c.taskId, { withReceipt: false })).workerServicePubKey;
    // Phase 1: the Fin signs its dispatch attempt. With the chain's ticket known, the Fin must be
    // for that attempt; otherwise the signature is checked over the ticket the Fin carries.
    if (c.dispatchTicketHash !== undefined && !bytesEqual(fin.dispatchTicketHash, strictHash32('dispatch_ticket_hash', c.dispatchTicketHash))) {
      throw dataError('DATA_OUTPUT_ATTEMPT_MISMATCH', `stored fin for task ${c.taskId} belongs to another dispatch attempt`);
    }
    const fields = {
      chainId: this.cfg.chainId,
      taskHash: strictHash32('task_hash', c.taskHash),
      dispatchTicketHash: Uint8Array.from(fin.dispatchTicketHash),
      finalSeq: fin.finalSeq,
      outputMmrRoot: Uint8Array.from(fin.outputMmrRoot),
      finishReason: Number(fin.finishReason),
    };
    if (!verifyOutputFinSignature(fields, fin.workerSignature, key)) {
      throw dataError('DATA_OUTPUT_FIN_SIGNATURE_INVALID', `stored fin signature for task ${c.taskId} did not verify (finish_reason=${fin.finishReason})`);
    }
    return fin.finishReason;
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

    // Phase 1: every frame is bound to its dispatch attempt. The ticket comes from the caller,
    // else from the checkpoint, else from the chain along with the other anchors.
    const givenTicket = p.dispatchTicketHash ?? (p.checkpoint?.dispatchTicketHash === undefined ? undefined : hash32Text(p.checkpoint.dispatchTicketHash));
    // Early subscribe: the anchors are waited for while the subscription is already open.
    const explicitAnchors = p.taskHash !== undefined && p.workerServicePubKey !== undefined && givenTicket !== undefined;
    const waitForAnchors = p.waitForAnchors ?? (p.admissionWait !== undefined ? { sessionId: p.sessionId, ...p.admissionWait } : undefined);
    // Streaming before the record: the attempt comes from the Builder-signed header, the chain
    // only confirms it later.
    const before = p.beforeRecord;
    const prerecord = before !== undefined && !explicitAnchors;
    const early = !prerecord && !explicitAnchors && (p.pendingAnchors !== undefined || (waitForAnchors !== undefined && waitForAnchors !== false));
    // Whether the chain is known to record the current attempt; undefined without beforeRecord.
    let recorded: boolean | undefined = before === undefined ? undefined : !prerecord;
    let verifyHeader: ((header: DispatchResultHeaderV1) => Promise<VerifiedDispatchResult>) | undefined;
    if (prerecord) {
      const hub = this.cfg.hub;
      if (hub?.getCurrentServiceKey === undefined) {
        throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_TRUST_ANCHORS_UNCONFIGURED',
          'beforeRecord verifies the dispatch header with service keys from chain: it needs a hub reader with getCurrentServiceKey (HubReader)');
      }
      // The confirmation reads the chain anchors later; refuse now what it could not do then.
      if (this.cfg.taskReader === undefined) {
        throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_TRUST_ANCHORS_UNCONFIGURED',
          'beforeRecord confirms the dispatch against the chain: it needs config.taskReader (RestChainReader)');
      }
      const pollMs = p.admissionWait?.pollIntervalMs;
      const waitMs = p.admissionWait?.timeoutMs;
      if (pollMs !== undefined && (!Number.isFinite(pollMs) || pollMs <= 0)) {
        throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_POLL_INTERVAL_INVALID', 'pollIntervalMs must be a positive finite number');
      }
      if (waitMs !== undefined && (!Number.isFinite(waitMs) || waitMs <= 0)) {
        throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_TIMEOUT_INVALID', 'timeoutMs must be a positive finite number');
      }
      const signedTaskHash = hash32Text(strictHash32('beforeRecord.taskHash', before.taskHash));
      if (p.taskHash !== undefined && p.taskHash !== signedTaskHash) {
        throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_TASK_HASH_MISMATCH', 'taskHash differs from beforeRecord.taskHash');
      }
      const builders = before.builders.map((b) => (typeof b === 'string' ? b : b.address));
      if (builders.length === 0) {
        throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_BUILDERS_REQUIRED', 'beforeRecord.builders must name the Builders the order was sent to');
      }
      // Signer keys are read once per stream: the Builder re-sends its header on every record
      // status change and at every (re)subscription, and a chain read there would hold up the
      // output behind it. The Builder keys are read at once, while the subscription opens. A
      // header that does not verify with the cached bindings (a newer key generation, say) is
      // verified once more with fresh reads. The chain confirmation always reads afresh.
      const cache = new Map<string, Promise<ServiceKeyBinding>>();
      const cachedKeys: DispatchProofKeyReader = {
        getCurrentServiceKey: (pt, addr) => {
          const k = `${pt}/${addr}`;
          let read = cache.get(k);
          if (read === undefined) {
            read = hub.getCurrentServiceKey!.call(hub, pt, addr);
            cache.set(k, read);
            read.catch(() => { if (cache.get(k) === read) cache.delete(k); });
          }
          return read;
        },
      };
      for (const b of builders) void cachedKeys.getCurrentServiceKey(PARTICIPANT_TYPE.BUILDER, b).catch(() => undefined);
      const verifyWith = (header: DispatchResultHeaderV1, keys: DispatchProofKeyReader): Promise<VerifiedDispatchResult> =>
        verifyDispatchResultHeader(header, {
          chainId: this.cfg.chainId, sessionId: p.sessionId, taskId: p.taskId, taskHash: signedTaskHash, builders,
          ...(before.earliestSubmitHeight !== undefined ? { earliestSubmitHeight: before.earliestSubmitHeight } : {}), keys,
        });
      verifyHeader = async (header) => {
        try {
          return await verifyWith(header, cachedKeys);
        } catch (e) {
          const stale = e instanceof TrueOpenError &&
            ['DATA_OUTPUT_DISPATCH_KEY_UNAVAILABLE', 'DATA_OUTPUT_DISPATCH_SIGNATURE_INVALID', 'OUTPUT_TRUST_ANCHOR_WORKER_KEY_INACTIVE'].includes(e.code);
          if (!stale) throw e;
          cache.clear();
          return verifyWith(header, cachedKeys);
        }
      };
    }

    let verifier: OutputStreamVerifier | undefined;
    let taskHash: Uint8Array = new Uint8Array();
    let workerServicePubKey: Uint8Array = new Uint8Array();
    let dispatchTicketHash: Uint8Array | undefined = givenTicket === undefined ? undefined : strictHash32('dispatch_ticket_hash', givenTicket);
    const setAnchors = (taskHashHex: string, key: Uint8Array, ticketHex: string | undefined): OutputStreamVerifier => {
      taskHash = strictHash32('task_hash', taskHashHex);
      workerServicePubKey = key;
      dispatchTicketHash = strictHash32('dispatch_ticket_hash', ticketHex ?? '');
      const v = new OutputStreamVerifier({ chainId: this.cfg.chainId, taskHash, workerServicePubKey, dispatchTicketHash }, p.checkpoint);
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
    if (!early && !prerecord) {
      // Anchors default to the chain: the accepted task_hash and the winner Worker's current
      // service key. The receipt is not needed (and usually not there yet) while streaming.
      let taskHashHex = p.taskHash;
      let key = p.workerServicePubKey;
      let ticketHex = givenTicket;
      if (taskHashHex === undefined || key === undefined || ticketHex === undefined) {
        const anchors = await this.resolveOutputTrustAnchors(p.taskId, { withReceipt: false });
        taskHashHex ??= anchors.taskHash;
        key ??= anchors.workerServicePubKey;
        ticketHex ??= anchors.dispatchTicketHash;
      }
      verifier = setAnchors(taskHashHex, key, ticketHex);
    }
    // Without a verifier yet, the subscription cursor comes from the checkpoint alone; the
    // verifier rechecks the checkpoint against the anchors once they arrive.
    const checkpointLeafCount = p.checkpoint?.mmr.leafCount ?? 0n;
    if ((early || prerecord) && p.resumeAfterSeq !== undefined && p.resumeAfterSeq !== checkpointLeafCount - 1n) {
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
      | { readonly ok: true; readonly taskHash: string; readonly workerServicePubKey: Uint8Array; readonly dispatchTicketHash?: string }
      | { readonly ok: false; readonly error: unknown };
    type ConfirmOutcome = { readonly ok: true; readonly anchors: OutputTrustAnchors } | { readonly ok: false; readonly error: unknown };
    let anchorsP: Promise<AnchorOutcome> | undefined;
    // Errors that end the whole stream rather than one attempt.
    const fatal = (error: unknown): StreamFatal => new StreamFatal(error);
    // Listeners on caller-owned signals, removed when the stream ends.
    const cleanups: Array<() => void> = [];

    try {
      if (early) {
        let source: PromiseLike<{ readonly taskHash: string; readonly workerServicePubKey: Uint8Array; readonly dispatchTicketHash?: string }>;
        if (p.pendingAnchors !== undefined) {
          source = p.pendingAnchors;
        } else {
          const waitOpts: WaitForOutputTrustAnchorsOptions = waitForAnchors === true ? { sessionId: p.sessionId } : (waitForAnchors as WaitForOutputTrustAnchorsOptions);
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
            ...(givenTicket ?? a.dispatchTicketHash) !== undefined ? { dispatchTicketHash: (givenTicket ?? a.dispatchTicketHash)! } : {},
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
      // After NEXUS_INGRESS_ATTEMPT_STALE: the next subscription names no ticket and must start
      // with the replacement attempt's DispatchResultHeaderV1.
      let discoveringAttempt = false;
      // beforeRecord: the current attempt's Worker, the chain confirmation in flight for the
      // attempt, and whether its verified Fin is waiting for that confirmation.
      let winnerWorker = '';
      let confirmP: Promise<ConfirmOutcome> | undefined;
      let heldFin = false;
      const recordRejected = (ticket: string): TrueOpenError =>
        new TrueOpenError('CHAIN_REJECT', 'OUTPUT_RECORD_REJECTED',
          `the chain refused the dispatch record of task ${p.taskId} (attempt ${ticket}); ` +
            'its output is void. Re-sign the order (OpenTaskResult.retryParams) to try again',
          { category: 'chain-rejected' });
      const startConfirm = (): void => {
        if (confirmP !== undefined) return;
        const wait: WaitForOutputTrustAnchorsOptions = {
          ...(p.admissionWait?.pollIntervalMs !== undefined ? { pollIntervalMs: p.admissionWait.pollIntervalMs } : {}),
          ...(p.admissionWait?.timeoutMs !== undefined ? { timeoutMs: p.admissionWait.timeoutMs } : {}),
          signal: life.signal,
        };
        const started = this.waitForOutputTrustAnchors(p.taskId, wait).then(
          (anchors): ConfirmOutcome => ({ ok: true, anchors }),
          (error: unknown): ConfirmOutcome => ({ ok: false, error }),
        );
        confirmP = started;
      };
      // Applies a settled confirmation. Returns undefined when the chain records the current
      // attempt; when it records another attempt of this task, switches to that attempt and
      // returns the reset to emit.
      const settleConfirm = async (o: ConfirmOutcome): Promise<{ readonly previousDispatchTicketHash: string; readonly dispatchTicketHash: string } | undefined> => {
        confirmP = undefined;
        if (life.signal.aborted) throw fatal(aborted());
        if (!o.ok) throw fatal(o.error);
        const a = o.anchors;
        const current = dispatchTicketHash === undefined ? '' : hash32Text(dispatchTicketHash);
        if (a.taskHash !== hash32Text(taskHash) || a.dispatchTicketHash === undefined) {
          throw fatal(dataError('DATA_OUTPUT_DISPATCH_ANCHOR_MISMATCH', `the chain does not record task ${p.taskId} with the signed task_hash and a dispatch ticket`));
        }
        if (a.dispatchTicketHash === current) {
          if (a.winnerWorker !== winnerWorker || !bytesEqual(a.workerServicePubKey, workerServicePubKey)) {
            throw fatal(dataError('DATA_OUTPUT_DISPATCH_ANCHOR_MISMATCH',
              `the chain records attempt ${current} with Worker ${a.winnerWorker}, not ${winnerWorker} with the key the output was verified against`));
          }
          recorded = true;
          return undefined;
        }
        // The chain recorded another attempt: continue with it, from seq 0.
        const ticket = strictHash32('dispatch_ticket_hash', a.dispatchTicketHash);
        const nextVerifier = new OutputStreamVerifier({ chainId: this.cfg.chainId, taskHash, dispatchTicketHash: ticket, workerServicePubKey: a.workerServicePubKey });
        if (p.onCheckpoint !== undefined) {
          try {
            await p.onCheckpoint(nextVerifier.checkpoint());
          } catch (cause) {
            throw fatal(new TrueOpenError('SDK_LOCAL', 'OUTPUT_STREAM_CHECKPOINT_PERSIST_FAILED', 'failed to persist replacement checkpoint', { cause }));
          }
        }
        verifier = nextVerifier;
        dispatchTicketHash = ticket;
        workerServicePubKey = a.workerServicePubKey;
        winnerWorker = a.winnerWorker;
        recorded = true;
        heldFin = false;
        finishReason = undefined;
        return { previousDispatchTicketHash: current, dispatchTicketHash: a.dispatchTicketHash };
      };
      let sourceIndex = 0;
      for (let attempt = 0; attempt < maxAttempts && finSource === undefined; attempt += 1) {
        if (life.signal.aborted) throw aborted();
        const source = sources[sourceIndex % sources.length]!;
        let retrySameSource = false;
        const leafCount = discoveringAttempt ? 0n : verifier?.leafCount ?? checkpointLeafCount;
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
        const outputRequest = {
          sessionId: p.sessionId,
          taskId: p.taskId,
          ...(cursor !== undefined ? { resumeAfterSeq: cursor } : {}),
          signal: abort.signal,
          ...(discoveringAttempt || dispatchTicketHash === undefined ? {} : { dispatchTicketHash }),
        };
        // Phase 1 resumes through ResumeOutput; SubscribeOutput starts from the first frame.
        if (cursor !== undefined && source.ingress.resumeOutput === undefined) {
          life.signal.removeEventListener('abort', onLifeEnd);
          throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_RESUME_UNSUPPORTED', 'Output source must implement ResumeOutput to resume a Phase 1 stream');
        }
        const output = cursor === undefined
          ? source.ingress.subscribeOutput(outputRequest)
          : unwrapResumeOutput(source.ingress.resumeOutput!(outputRequest));
        const iterator = output[Symbol.asyncIterator]();
        // A next() started before the anchors arrived and still in flight.
        let pending: Promise<IteratorResult<SubscribeOutputResponse>> | undefined;
        // What the subscription delivered before the anchors arrived, in arrival order: frames,
        // then possibly its end or its error. Nothing in here has been verified.
        const held: Array<{ readonly step: IteratorResult<SubscribeOutputResponse> } | { readonly error: unknown }> = [];
        let progressFrom = leafCount;
        let sawFin = false;
        let replacedAttempt = false;
        try {
          if (verifier === undefined && prerecord) {
            // The first message names the attempt: the Builder-signed header, verified before
            // any output is.
            const first = await nextWithIdleTimeout(iterator, p.idleTimeoutMs);
            if (first.done) throw dataError('DATA_OUTPUT_DISPATCH_HEADER_REQUIRED', 'the output stream ended before its DispatchResultHeaderV1');
            const header = first.value.dispatchResult;
            if (!header) throw dataError('DATA_OUTPUT_DISPATCH_HEADER_REQUIRED', 'streaming before the record needs the DispatchResultHeaderV1 first');
            const att = await verifyHeader!(header);
            if (att.recordStatus === 'REJECTED') throw fatal(recordRejected(att.dispatchTicketHash));
            try {
              verifier = setAnchors(att.taskHash, att.workerServicePubKey, att.dispatchTicketHash);
            } catch (e) {
              throw fatal(e);
            }
            winnerWorker = att.winnerWorker;
            progressFrom = verifier.leafCount;
            if (att.recordStatus === 'RECORDED') startConfirm();
            // A frame that came with the header goes through the usual checks.
            if (first.value.frame.case !== undefined) held.push({ step: { done: false, value: { ...first.value, dispatchResult: undefined } } });
          }
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
              verifier = setAnchors(settled.taskHash, settled.workerServicePubKey, settled.dispatchTicketHash);
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
              if (confirmP === undefined) {
                // The idle clock starts when the anchors are known, not when the subscription opened.
                step = await nextWithIdleTimeout(iterator, p.idleTimeoutMs, carried);
              } else {
                // beforeRecord: the chain confirmation may settle while the subscription is quiet
                // (a held Fin waits for it).
                const next = nextWithIdleTimeout(iterator, p.idleTimeoutMs, carried);
                next.catch(() => undefined);
                const r = await Promise.race([
                  next.then((s) => ({ step: s }), (error: unknown) => ({ error })),
                  confirmP.then((outcome) => ({ outcome })),
                  lifeEnded,
                ]);
                if (r === 'abort') throw fatal(aborted());
                if ('outcome' in r) {
                  pending = next;
                  const reset = await settleConfirm(r.outcome);
                  if (reset !== undefined) {
                    replacedAttempt = true;
                    retrySameSource = true;
                    yield { kind: 'reset', ...reset };
                    break;
                  }
                  if (heldFin) {
                    sawFin = true;
                    finSource = source;
                    break;
                  }
                  continue;
                }
                if ('error' in r) throw r.error;
                step = r.step;
              }
            }
            if (step.done) {
              if (heldFin && confirmP !== undefined) {
                // The Builder ended the call after the Fin: the chain decides.
                const o = await Promise.race([confirmP, lifeEnded]);
                if (o === 'abort') throw fatal(aborted());
                const reset = await settleConfirm(o);
                if (reset !== undefined) {
                  replacedAttempt = true;
                  retrySameSource = true;
                  yield { kind: 'reset', ...reset };
                  break;
                }
                sawFin = true;
                finSource = source;
              }
              break;
            }
            const header = step.value.dispatchResult;
            if (discoveringAttempt) {
              if (!header) throw dataError('DATA_OUTPUT_DISPATCH_HEADER_REQUIRED', 'A replacement attempt must supply DispatchResultHeaderV1 before output');
              const replacement = dispatchHeaderTicket(header, this.cfg.chainId, p.sessionId, p.taskId, taskHash);
              if (dispatchTicketHash !== undefined && bytesEqual(replacement, dispatchTicketHash)) {
                throw dataError('DATA_OUTPUT_ATTEMPT_STALE', 'Builder still reports the voided dispatch attempt');
              }
              // Never trust a header solely because a Builder sent it: the chain (or the caller's
              // resolver) must name the same attempt and Worker. With beforeRecord the header is
              // verified on its own and the chain confirms the attempt later.
              let replacementStatus: VerifiedDispatchResult['recordStatus'] | undefined;
              let anchors: OutputTrustAnchors;
              if (prerecord) {
                const att = await verifyHeader!(header);
                if (att.recordStatus === 'REJECTED') throw fatal(recordRejected(att.dispatchTicketHash));
                replacementStatus = att.recordStatus;
                anchors = { taskId: p.taskId, taskHash: att.taskHash, dispatchTicketHash: att.dispatchTicketHash, winnerWorker: att.winnerWorker, workerServicePubKey: att.workerServicePubKey };
              } else {
                anchors = p.resolveDispatchResult === undefined
                  ? await this.resolveOutputTrustAnchors(p.taskId, { withReceipt: false })
                  : await p.resolveDispatchResult(header);
              }
              if (anchors.taskId !== p.taskId || anchors.taskHash !== hash32Text(taskHash) || anchors.dispatchTicketHash !== hash32Text(replacement) || anchors.winnerWorker !== header.accept!.member!.operatorAddress) {
                throw dataError('DATA_OUTPUT_DISPATCH_ANCHOR_MISMATCH', 'Replacement header does not match trusted output anchors');
              }
              if (prerecord) {
                // The replacement is provisional until the chain records it.
                winnerWorker = anchors.winnerWorker;
                recorded = false;
                heldFin = false;
                confirmP = undefined;
              }
              const previousDispatchTicketHash = dispatchTicketHash === undefined ? '' : hash32Text(dispatchTicketHash);
              const nextVerifier = new OutputStreamVerifier({ chainId: this.cfg.chainId, taskHash, dispatchTicketHash: replacement, workerServicePubKey: anchors.workerServicePubKey });
              // Persist an empty replacement checkpoint before delivering any new output.
              if (p.onCheckpoint !== undefined) {
                try {
                  await p.onCheckpoint(nextVerifier.checkpoint());
                } catch (cause) {
                  throw fatal(new TrueOpenError('SDK_LOCAL', 'OUTPUT_STREAM_CHECKPOINT_PERSIST_FAILED', 'failed to persist replacement checkpoint', { cause }));
                }
              }
              verifier = nextVerifier;
              dispatchTicketHash = replacement;
              workerServicePubKey = anchors.workerServicePubKey;
              discoveringAttempt = false;
              if (replacementStatus === 'RECORDED') startConfirm();
              replacedAttempt = true;
              retrySameSource = true;
              yield { kind: 'reset', previousDispatchTicketHash, dispatchTicketHash: hash32Text(replacement) };
              // Reopen with the replacement ticket and no cursor, including any chunk that accompanied the header.
              break;
            }
            if (header && !bytesEqual(dispatchHeaderTicket(header, this.cfg.chainId, p.sessionId, p.taskId, taskHash), dispatchTicketHash!)) {
              throw dataError('DATA_OUTPUT_ATTEMPT_MISMATCH', 'Unannounced dispatch attempt change');
            }
            if (header && recorded === false) {
              // beforeRecord: the Builder re-signs the header when the record status changes.
              const att = await verifyHeader!(header);
              if (att.recordStatus === 'REJECTED') throw fatal(recordRejected(att.dispatchTicketHash));
              if (att.recordStatus === 'RECORDED') startConfirm();
            }
            const frame = step.value.frame;
            if (header && frame.case === undefined) continue;
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
                dispatchTicketHash: c.dispatchTicketHash,
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
                // mmrRoot covers the committed bytes, so it is what verification ran against.
                text: new TextDecoder().decode(c.text),
                mmrRoot: Uint8Array.from(c.mmrRoot),
                ...(recorded !== undefined ? { recorded } : {}),
              };
              continue;
            }
            if (frame.case === 'fin') {
              const f = frame.value;
              // beforeRecord: a replayed Fin while the first one waits for the chain.
              if (heldFin && f.finalSeq === v.resumeAfterSeq && bytesEqual(f.dispatchTicketHash, dispatchTicketHash!)) continue;
              if (f.finalSeq !== v.resumeAfterSeq) {
                throw dataError('DATA_OUTPUT_FIN_SEQ_MISMATCH', `fin says final_seq=${f.finalSeq} but ${v.resumeAfterSeq} was verified`);
              }
              if (!v.matchesReceipt(f.outputMmrRoot)) {
                throw dataError('DATA_OUTPUT_FIN_ROOT_MISMATCH', `fin root does not match the locally computed root for task ${p.taskId}`);
              }
              if (!bytesEqual(f.dispatchTicketHash, dispatchTicketHash!)) {
                throw dataError('DATA_OUTPUT_ATTEMPT_MISMATCH', 'fin belongs to another dispatch attempt');
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
                  dispatchTicketHash: dispatchTicketHash!,
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
                // Keep the verified Fin in the checkpoint: confirmation reads the finish reason from
                // there (re-verified against the receipt), and a persisted checkpoint carries it.
                v.acceptFin({
                  finalSeq: f.finalSeq, outputMmrRoot: Uint8Array.from(f.outputMmrRoot),
                  finishReason: Number(f.finishReason), workerSignature: Uint8Array.from(f.workerSignature),
                });
                if (p.onCheckpoint !== undefined) {
                  try {
                    await p.onCheckpoint(v.checkpoint());
                  } catch (cause) {
                    throw fatal(
                      new TrueOpenError('SDK_LOCAL', 'OUTPUT_STREAM_CHECKPOINT_PERSIST_FAILED', 'failed to persist checkpoint after fin', { cause }),
                    );
                  }
                }
              }
              if (recorded === false) {
                // beforeRecord: the output is complete, but `fin` waits until the chain records
                // this attempt. Keep reading: the Builder still sends the record status.
                heldFin = true;
                startConfirm();
                continue;
              }
              sawFin = true;
              finSource = source;
              break;
            }
            throw dataError('DATA_OUTPUT_STREAM_FRAME_MISSING', `SubscribeOutput returned no frame for task ${p.taskId}`);
          }
          if (!sawFin && !replacedAttempt) {
            failures.push(`${source.id}: stream ended without fin after seq ${v.resumeAfterSeq}`);
          }
        } catch (e) {
          if (e instanceof StreamFatal) throw e.error;
          if (life.signal.aborted) throw aborted();
          // The Builder voided this dispatch attempt: rediscover the replacement on the same source.
          const classified = classifyNexusError(e);
          if (classified instanceof TrueOpenError && classified.code === 'NEXUS_INGRESS_ATTEMPT_STALE') {
            discoveringAttempt = true;
            finishReason = undefined;
            retrySameSource = true;
          }
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
        if (!retrySameSource) sourceIndex++;
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

  /**
   * The derived-view counterpart of `streamOutput` (design S4.1, S5).
   *
   * Stage one of the execution gate: every tool call it yields is provisional and must not be
   * executed. Obtain the checkpoint the usual way, via `onCheckpoint`, then call
   * `confirmAssistantMessage` with the on-chain receipt to get the executable list.
   *
   * Two entry shapes, discriminated on `'parser' in p`:
   *  - pass an already-resolved `parser` (phase-1, backward compatible), or
   *  - pass `toolCallParser` (the profile's on-chain projection, `ProfileInfo.toolCallParser`)
   *    and let this method resolve it through the registry up front (design S5.1). When the
   *    profile does not support tool calling, the stream degrades to `content`-only events and
   *    never throws.
   */
  async *streamAssistantMessage(
    p: StreamOutputParams & (DerivedViewOptions | ToolCallParams),
  ): AsyncIterable<AssistantStreamEvent> {
    if ('parser' in p) {
      // Phase-1 path, unchanged: the caller already resolved the parser.
      yield* deriveAssistantStream(this.streamOutput(p), p);
      return;
    }
    yield* deriveAssistantStream(this.streamOutput(p), resolveParsers(p));
  }

  /**
   * The derived-view counterpart of `confirmOutput` (design S4.1, S5).
   *
   * Synchronous and receipt-taking for the same reason `confirmOutput` is: the chain read
   * belongs to the caller, which is what lets the stream run against a Builder while the caller
   * decides when to reach the node.
   *
   * It takes the same two shapes as `streamAssistantMessage`, and should be given the same
   * values: an already-resolved `parser`, or the profile's `toolCallParser` / `reasoningParser`
   * refs, resolved here exactly as the stream resolved them. This is the step that yields
   * executable calls, so it must not parse more permissively than the stream did -- in
   * particular, a reasoning parser the stream applied must be applied here too, or a call the
   * model only drafted while reasoning would become executable (Manifest S7.3 rule 7). Resolution
   * is a registry lookup, so the method stays synchronous.
   */
  confirmAssistantMessage(p: ConfirmOutputParams & (DerivedViewOptions | ToolCallParams)): ConfirmedAssistantMessage {
    const receiptInput = {
      chainId: this.cfg.chainId, taskId: p.taskId, taskHash: p.taskHash, dispatchTicketHash: p.dispatchTicketHash,
      checkpoint: p.checkpoint, receipt: p.receipt,
    };
    if ('parser' in p) return confirmAssistantMessageWithReceipt(receiptInput, p);
    return confirmAssistantMessageWithReceipt(receiptInput, resolveParsers(p));
  }

  /**
   * The parsers the task's profile pins on chain: the task's model and profile version from the
   * task, then that profile's tool_call_parser / reasoning_parser (ADR-0028 projects both on
   * chain). Needs config.taskReader and config.hub with getProfile.
   */
  async profileParsers(taskId: string): Promise<ProfileParsers> {
    const reader = this.cfg.taskReader;
    const getProfile = this.cfg.hub?.getProfile?.bind(this.cfg.hub);
    if (reader === undefined || getProfile === undefined) {
      throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_PROFILE_UNREADABLE', 'resolving the profile parsers needs config.taskReader and config.hub with getProfile');
    }
    const task = await reader.queryTask(taskId);
    const profile = await getProfile(task.modelId, task.profileVersion);
    const none = { name: '', version: 0 };
    return { toolCallParser: profile.toolCallParser ?? none, reasoningParser: profile.reasoningParser ?? none };
  }

  /**
   * One assistant turn, streamed and then confirmed (sdk_详细设计 §5.2, §5.5).
   *
   * Yields reasoning and content as frames verify -- provisional, for display -- and never a tool
   * call from unconfirmed frames. When the stream has ended, it waits for the accepted
   * InferReceipt and yields `confirmed` with the ConfirmedAssistantMessage: the calls an agent may
   * execute, and the protocol finishReason from the Worker-signed Fin. The stream checkpoint is
   * kept internally (and still handed to `onCheckpoint`).
   *
   * Parsers default to the ones the task's profile pins on chain. Both built-in parsers are
   * unverified until wire publishes their vectors, so they take effect only with
   * `allowUnverified`; otherwise the output is content with no calls. Needs config.taskReader and
   * config.hub.
   */
  async *assistantTurn(p: AssistantTurnParams): AsyncIterable<AssistantTurnEvent> {
    const reader = this.cfg.taskReader;
    if (reader === undefined) {
      throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_TASK_READER_REQUIRED', 'assistantTurn waits for the receipt and needs config.taskReader');
    }
    const anchors = await this.resolveOutputTrustAnchors(p.taskId, { withReceipt: false });
    const refs = p.toolCallParser !== undefined
      ? { toolCallParser: p.toolCallParser, ...(p.reasoningParser !== undefined ? { reasoningParser: p.reasoningParser } : {}) }
      : await this.profileParsers(p.taskId);
    const opts = {
      ...resolveParsers({
        ...refs,
        ...(p.registry !== undefined ? { registry: p.registry } : {}),
        ...(p.reasoningRegistry !== undefined ? { reasoningRegistry: p.reasoningRegistry } : {}),
        ...(p.allowUnverified !== undefined ? { allowUnverified: p.allowUnverified } : {}),
      }),
    };

    let checkpoint: OutputStreamVerifierCheckpoint | undefined;
    const source = this.streamOutput({
      ...p,
      taskHash: anchors.taskHash,
      workerServicePubKey: anchors.workerServicePubKey,
      ...(anchors.dispatchTicketHash !== undefined ? { dispatchTicketHash: anchors.dispatchTicketHash } : {}),
      onCheckpoint: async (c) => {
        checkpoint = c;
        await p.onCheckpoint?.(c);
      },
    });
    for await (const e of deriveAssistantStream(source, opts)) {
      // A provisional call is not executable and is not handed out; the confirmed list follows.
      if (e.kind === 'reasoning' || e.kind === 'content' || e.kind === 'reset') yield e;
    }
    if (checkpoint === undefined) throw dataError('DATA_OUTPUT_STREAM_EMPTY', `output stream for task ${p.taskId} verified no frame`);

    const receipt = await this.waitForReceipt(reader, p);
    // The receipt names the attempt that counts; read the chain's ticket now, not the one the
    // stream started with (a voided attempt may have been replaced meanwhile).
    const { dispatchTicketHash } = await this.resolveOutputTrustAnchors(p.taskId, { withReceipt: false });
    if (dispatchTicketHash === undefined) {
      throw new TrueOpenError('CHAIN_REJECT', 'OUTPUT_TRUST_ANCHOR_PENDING', `task ${p.taskId}: no dispatch ticket on chain`, { retriable: true });
    }
    yield {
      kind: 'confirmed',
      message: confirmAssistantMessageWithReceipt(
        { chainId: this.cfg.chainId, taskId: p.taskId, taskHash: anchors.taskHash, dispatchTicketHash, checkpoint, receipt },
        opts,
      ),
    };
  }

  /** Polls for the accepted InferReceipt until it appears, the timeout passes, or the signal aborts. */
  private async waitForReceipt(reader: OutputTaskReader, p: AssistantTurnParams): Promise<InferReceiptView> {
    const timeoutMs = p.receiptTimeoutMs ?? 120_000;
    const intervalMs = p.receiptPollIntervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (p.signal?.aborted === true) throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_ABORTED', 'assistantTurn aborted while waiting for the receipt');
      const receipt = await reader.queryInferReceipt(p.taskId);
      if (receipt !== undefined) return receipt;
      if (Date.now() + intervalMs > deadline) {
        throw new TrueOpenError('DATA', 'OUTPUT_RECEIPT_TIMEOUT', `no accepted InferReceipt for task ${p.taskId} within ${timeoutMs}ms`, { retriable: true });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        p.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }

  /**
   * The confirmed assistant message of a finished task, retrieved without streaming
   * (sdk_详细设计 §5.3, §5.5).
   *
   * Confirmed means reconciled with the chain: the output is fetched against the accepted
   * InferReceipt's output_hash, so the anchors must carry that receipt (resolved from chain when
   * not given). The result carries the same `confirmation` as the streaming path, and the protocol
   * `finishReason` from the Worker-signed Fin the Builder stored (ADR-0027).
   *
   * Without `builderAddress` the SDK chooses: it asks the task's frozen Task Builders in rank
   * order and prefers one that stored the signed Fin, since a Builder without it cannot say how
   * the output ended. When none has it, the output is still returned, with `finishReason`
   * undefined (unavailable) -- a Provider maps that to its own error, never to a guess.
   *
   * Parsers: an already-resolved `parser`, or the profile's `toolCallParser` / `reasoningParser`
   * refs resolved through the registries. When the profile pins no tool parser, the text is
   * `content` with no calls.
   */
  async fetchAssistantMessage(
    p: FetchAssistantMessageParams & (DerivedViewOptions | ToolCallParams),
  ): Promise<ConfirmedAssistantMessage> {
    const anchors = p.anchors ?? (await this.resolveOutputTrustAnchors(p.taskId));
    const receipt = anchors.receipt;
    if (receipt === undefined) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_RECEIPT_REQUIRED',
        'fetchAssistantMessage confirms against the accepted InferReceipt; pass anchors that carry it',
      );
    }
    const base = {
      sessionId: p.sessionId,
      taskId: p.taskId,
      anchors,
      workerServicePubKey: anchors.workerServicePubKey,
      ...(p.expiresAtHeight !== undefined ? { expiresAtHeight: p.expiresAtHeight } : {}),
      ...(p.maxRangeBytes !== undefined ? { maxRangeBytes: p.maxRangeBytes } : {}),
      ...(p.rangeAttempts !== undefined ? { rangeAttempts: p.rangeAttempts } : {}),
    };
    const got = p.builderAddress !== undefined
      ? await this.fetchTaskOutputVia(this.ingress, { ...base, builderAddress: p.builderAddress })
      : await this.fetchFromSelectedBuilders(p.taskId, base);

    // The stored Fin's reason decides whether an unclosed final call is recovered.
    const finish = got.finishReason !== undefined ? { finishReason: got.finishReason } : {};
    const message = deriveAssistantMessage(got.text, 'parser' in p ? { ...p, ...finish } : {
      ...resolveParsers(p),
      ...finish,
    });
    // fetchTaskOutput already held root, size and leaf count to this receipt.
    const confirmation: ConfirmedOutputEvent = {
      type: 'confirmed',
      taskId: p.taskId,
      taskHash: got.taskHash,
      winnerWorker: receipt.winnerWorker,
      inferReceiptHash: receipt.inferReceiptHash,
      outputHash: got.outputHash,
      outputMmrRoot: strictHash32('output_hash', got.outputHash),
      outputLeafCount: BigInt(got.chunks.length),
      outputSizeBytes: got.sizeBytes,
      ...(got.finishReason !== undefined ? { finishReason: got.finishReason } : {}),
    };
    return {
      ...message,
      confirmation,
      ...(got.finishReason !== undefined ? { finishReason: got.finishReason } : {}),
    };
  }

  /**
   * Fetches from the task's frozen Task Builders concurrently, preferring one that stored the
   * signed Fin (sdk_详细设计 §5.3: a Builder without it leaves the reason unavailable). Falls back to
   * the highest-ranked output that verified without one.
   */
  private async fetchFromSelectedBuilders(
    taskId: string,
    base: Omit<FetchTaskOutputParams, 'builderAddress'>,
  ): Promise<Awaited<ReturnType<TrueOpenClient['fetchTaskOutput']>>> {
    const { taskReader, hub, ingressTransportFactory } = this.cfg;
    if (taskReader?.queryTaskBuilders === undefined || hub === undefined || ingressTransportFactory === undefined) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_BUILDER_ROUTING_UNCONFIGURED',
        'choosing the Builder needs config.taskReader with queryTaskBuilders, config.hub and config.ingressTransportFactory; or pass builderAddress',
      );
    }
    const addresses = await taskReader.queryTaskBuilders(taskId);
    if (addresses.length === 0) throw dataError('DATA_OUTPUT_NO_BUILDERS', `task ${taskId} has no Task Builder selection on chain`);
    type Fetched = Awaited<ReturnType<TrueOpenClient['fetchTaskOutput']>>;
    const fetchFrom = async (address: string): Promise<Fetched> => {
      const endpoint = nexusGrpcEndpoint(await hub.getServiceDescriptor(address));
      if (endpoint === undefined || endpoint.uri === '') throw new Error('descriptor has no NEXUS_GRPC endpoint');
      const ingress = new IngressClient(ingressTransportFactory(endpoint.uri, endpoint.tlsPubkeyHash ?? ''), this.ingressAuth());
      return this.fetchTaskOutputVia(ingress, { ...base, builderAddress: address });
    };
    // All Builders at once: the first verified output with the signed Fin wins without waiting
    // for the rest. Only when every one has settled without a Fin does the rank order pick the
    // output to return; when all failed, every failure is reported.
    return new Promise<Fetched>((resolve, reject) => {
      const results: Array<{ got: Fetched } | { error: unknown } | undefined> = new Array(addresses.length);
      let pending = addresses.length;
      addresses.forEach((address, i) => {
        fetchFrom(address).then(
          (got) => {
            results[i] = { got };
            if (got.finishReason !== undefined) resolve(got);
          },
          (error: unknown) => { results[i] = { error }; },
        ).finally(() => {
          if (--pending > 0) return;
          const withoutFin = results.find((r): r is { got: Fetched } => r !== undefined && 'got' in r);
          if (withoutFin !== undefined) {
            resolve(withoutFin.got);
            return;
          }
          const failures = results.map((r, j) => `${addresses[j]}: ${(r as { error?: { message?: string } }).error?.message ?? String((r as { error?: unknown }).error)}`);
          reject(new TrueOpenError(
            'DATA',
            'DATA_OUTPUT_ALL_BUILDERS_FAILED',
            `no Task Builder returned a verified output for task ${taskId}:\n  ${failures.join('\n  ')}`,
            { retriable: true },
          ));
        });
      });
    });
  }

  /**
   * The profile's `tool_calling.call_id_format`, from its verified manifest (sdk_详细设计 §5.5):
   * what newToolCallId needs. Undefined when the profile does not offer tool calling. Fails when
   * the manifest cannot be fetched or does not verify against the chain -- a guessed format would
   * break the second turn of a model whose chat template checks it.
   */
  async toolCallIdFormat(modelId: string, profileVersion: bigint): Promise<ToolCallIdFormat | undefined> {
    const source = this.cfg.manifestSource;
    if (source === undefined) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_MANIFEST_SOURCE_UNCONFIGURED',
        'reading call_id_format needs config.manifestSource (Node: createNodeManifestSource from "trueopen-sdk/node")',
      );
    }
    return toolCallIdFormatOf((await source.fetchManifest(modelId, profileVersion)).manifest);
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
  private checkIdempotencyKey(key: string, inputHash: string): void {
    const first = this.inputHashByIdempotencyKey.get(key);
    if (first !== undefined && first !== inputHash) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_IDEMPOTENCY_KEY_REUSED',
        `idempotency_key ${JSON.stringify(key)} was first used with input_hash ${first}, not ${inputHash}: ` +
          'a retry must resend the same payload bytes, and a different input needs a new key',
        { category: 'conflict' },
      );
    }
  }

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

/**
 * How old a latest height may be and still count as the current head for an expiry counted from
 * it (the OpenTask envelope with a caller's context, a session grant), and how old a session read
 * openTaskWithRecovery hands to the submit may be: about one block.
 */
const RECENT_HEIGHT_MAX_AGE_MS = 1000;

/** openTask's default wait for an anchor at or after a registered key's set_height: a few blocks. */
export const DEFAULT_SESSION_KEY_ANCHOR_WAIT_MS = 15_000;

/** waitForOutputTrustAnchors upper bound on the whole wait. */
export const DEFAULT_TRUST_ANCHOR_WAIT_MS = 60_000;

/** The nexus task event that follows the chain recording the dispatch (and its Worker). */
const DISPATCH_RECORDED_EVENT = 'DISPATCH_RECORDED';

/** waitForAdmission upper bound on the whole wait. */
export const DEFAULT_ADMISSION_WAIT_MS = 60_000;

/** Builder task events that report the order was not admitted (recorded by waitForAdmission). */
const ADMISSION_REJECT_EVENTS: ReadonlySet<string> = new Set(['RECORD_REJECTED', 'NO_CAPACITY', 'ASSIGN_TIMEOUT', 'ORDER_EXPIRED']);

/**
 * Builder task events after which the chain likely has the task: waitForAdmission reads it at
 * once. Phase 1 nexus emits DISPATCH_RECORDED once the dispatch landed on chain.
 */
const ADMISSION_HINT_EVENTS: ReadonlySet<string> = new Set([DISPATCH_RECORDED_EVENT]);

/** The first event of every order attempt in a Builder's task journal (nexus onOrder). */
const ORDER_RECEIVED_EVENT = 'ORDER_RECEIVED';

/**
 * The report waitForAdmission records for an acked Builder whose GetTaskEvents answered NotFound:
 * the Builder no longer tracks the task, which for a task it acked means it abandoned it (rejected
 * or timed out). Not a nexus event code.
 */
export const ABANDONED_REPORT = 'ABANDONED';

/** Default of TrueOpenClientConfig.orderReplacementRetryMs: about one block. */
export const DEFAULT_ORDER_REPLACEMENT_RETRY_MS = 1000;

/** Most re-sends of a retried order to one Builder answering NEXUS_INGRESS_ORDER_REPLACEMENT_UNSUPPORTED. */
export const ORDER_REPLACEMENT_RETRY_ATTEMPTS = 3;

const RETRY_SUFFIX = /^(.*)#retry([1-9][0-9]*)$/s;

/** `key#retry1` for a first retry; `key#retryK` becomes `key#retry(K+1)`. */
export function nextRetryIdempotencyKey(key: string): string {
  const m = RETRY_SUFFIX.exec(key);
  return m === null ? `${key}#retry1` : `${m[1]}#retry${BigInt(m[2]!) + 1n}`;
}

/** An order's params for a re-signed retry under the same sequence (OpenTaskResult.retryParams). */
function retryParamsOf(
  params: OpenTaskParams,
  orderSequence: bigint,
  order: TaskOrderV3,
  latestHeight: bigint,
  taskHash: string,
): OpenTaskParams {
  const { context: _c, expiryHeight: _e, ...rest } = params;
  void _c;
  void _e;
  return {
    ...rest,
    orderSequence,
    idempotencyKey: nextRetryIdempotencyKey(params.idempotencyKey),
    orderWindow: {
      earliestSubmitBlocks: order.earliestSubmitHeight - latestHeight,
      orderExpireBlocks: order.orderExpireHeight - latestHeight,
    },
    [REJECTED_TASK_HASH]: taskHash,
  };
}

/** OpenTaskParams.orderWindow, checked: two bigint offsets. */
function checkOrderWindow(w: OrderWindowOffsets): OrderWindowOffsets {
  if (typeof w !== 'object' || w === null || typeof w.earliestSubmitBlocks !== 'bigint' || typeof w.orderExpireBlocks !== 'bigint') {
    throw local('SDK_LOCAL_ORDER_WINDOW_INVALID', 'orderWindow must hold bigint earliestSubmitBlocks and orderExpireBlocks');
  }
  return w;
}

/** `latest + offset`, at least 1 (a window height is never 0). */
function rebaseHeight(latest: bigint, offset: bigint): bigint {
  const h = latest + offset;
  return h < 1n ? 1n : h;
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

/** Whether a nexus call failed with Connect NotFound (classified or not). */
function isNotFoundError(err: unknown): boolean {
  if (err instanceof ConnectError) return err.code === Code.NotFound;
  return err instanceof TrueOpenError && err.details?.['connectCode'] === Code[Code.NotFound];
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

/**
 * A refusal config.chainReadCache may have caused by keeping a BuilderSet too long: openTask
 * retries it once on fresh reads. Read through a one-Builder TASK_BUILDER_ALL_ENDPOINTS_FAILED.
 */
const STALE_CHAIN_DATA_CODES: ReadonlySet<string> = new Set(['NEXUS_INGRESS_BUILDER_SET_STALE', 'SDK_LOCAL_BUILDER_SET_MISMATCH']);

function isStaleChainDataError(error: unknown): boolean {
  if (error instanceof TaskBuilderAllEndpointsFailedError) {
    return error.results.length === 1 && isStaleChainDataError(error.results[0]!.error);
  }
  return error instanceof TrueOpenError && STALE_CHAIN_DATA_CODES.has(error.code);
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

async function* unwrapResumeOutput(source: AsyncIterable<import('./gen/nexus/v1/ingress_pb.js').ResumeOutputResponse>) {
  for await (const response of source) {
    if (response.frame === undefined) throw new TrueOpenError('DATA', 'DATA_OUTPUT_RESUME_FRAME_MISSING', 'ResumeOutput response has no frame');
    yield response.frame;
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
    if (cap > U64_MAX) throw local('SDK_LOCAL_SESSION_KEY_INVALID', `spendCap must fit a u64 (at most ${U64_MAX}), got ${cap}`);
    return cap.toString();
  }
  if (typeof cap !== 'string' || !CANONICAL_DECIMAL.test(cap)) {
    throw local('SDK_LOCAL_SESSION_KEY_INVALID', `spendCap must be a canonical decimal (0 or [1-9][0-9]*), got ${JSON.stringify(cap)}`);
  }
  // The chain parses the cap as a u64 (node ParseAmount) and refuses a larger one, after the fee.
  if (BigInt(cap) > U64_MAX) throw local('SDK_LOCAL_SESSION_KEY_INVALID', `spendCap must fit a u64 (at most ${U64_MAX}), got ${cap}`);
  return cap;
}

/** The highest block height the chain accepts (node MaxBlockHeightV1 = MaxInt64). */
const MAX_BLOCK_HEIGHT = (1n << 63n) - 1n;

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
 * The Keeper checks a registered key's expiry at the height that admits the order, which is at
 * or after earliest_submit_height: an order whose window starts after the expiry can never be
 * admitted (SDK_LOCAL_SESSION_KEY_EXPIRED). A window that only ends after it is allowed and
 * reported through OpenTaskResult.keyExpiresInOrderWindow.
 */
function checkSessionKeyOrderWindow(s: StreamStateView, order: TaskOrderV3): void {
  if (order.earliestSubmitHeight > s.sessionKeyExpiryHeight) {
    throw local(
      'SDK_LOCAL_SESSION_KEY_EXPIRED',
      `the order's earliest_submit_height ${order.earliestSubmitHeight} is after the session key's expiry ` +
        `${s.sessionKeyExpiryHeight}, so the chain can never admit it: renew the key via updateSessionKey or start the window earlier`,
      { details: { earliestSubmitHeight: order.earliestSubmitHeight, expiryHeight: s.sessionKeyExpiryHeight } },
    );
  }
}

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
