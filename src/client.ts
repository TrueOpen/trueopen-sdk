import type { Transport } from '@connectrpc/connect';
import type { ChainClient, CancelOrderResult } from './transport/chain-client';
import type { CosmosSecp256k1Signer } from './signer/secp256k1';
import type { Eip712Signer } from './signer/eth-secp256k1';
import { ethSecp256k1AddressMatches } from './signer/eth-secp256k1';
import { IngressClient } from './transport/ingress-client';
import type { OpenTaskAck, TaskStatusView } from './transport/ingress-client';
import type { AccessLevelName } from './transport/sdk-request-envelope';
import type {
  FetchOutputRefResponse,
  PrepareChallengeResponse,
  GetTaskEventsResponse,
} from './gen/nexus/v1/ingress_pb.js';
import { SessionManager } from './session/session-manager';
import type { SessionHandle } from './session/session-manager';
import { resolveTaskBuilderEndpoints } from './hub/stage1-routing';
import type { TaskBuilderReader } from './hub/stage1-routing';
import { fanOutToEndpoints } from './transport/fan-out-submit';
import { nexusGrpcEndpoint } from './types/hub';
import { isTLSPubkeyMismatch } from './transport/nexus-tls';
import type { DescriptorDocFetch } from './hub/builder-discovery';
import { buildTaskOrder, resolveTaskOrderContext } from './order/task-order-input';
import type { TaskOrderIntent, TaskOrderChainContext, TaskOrderContextReader } from './order/task-order-input';
import { buildOpenTaskRequest } from './order/build-open-task';
import { deriveTaskId } from './order/order-signing';
import type { ChallengeKind } from './types/challenge';
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
import { toHex, fromHex } from './util/bytes';
import { bytesEqual } from './util/bytes';

export interface TrueOpenClientConfig {
  readonly chainId: string;
  readonly userAddress: string;
  readonly signerPubKey: Uint8Array; // 33-byte compressed public key
  readonly signer: CosmosSecp256k1Signer;
  readonly chain: ChainClient; // chain read+write (createTrueOpenChainClient)
  readonly ingressTransport: Transport; // nexus IngressAPI Connect transport
  /**
   * Two separate identities: the signing identity for the nexus request envelope
   * (SDKRequestEnvelopeV1) is independent of the user identity that signs the
   * OrderEnvelope. Both default to falling back to the user identity, matching
   * the old byte-for-byte behavior (backward compatible).
   */
  readonly sdkSigner?: CosmosSecp256k1Signer; // default = signer (user)
  readonly sdkSignerPubKey?: Uint8Array; // default = signerPubKey
  readonly sdkSignerAddress?: string; // default = userAddress
  /**
   * If provided, checks at construction time that the SDK request signing
   * identity is self-consistent:
   * signer_address == bech32(addressPrefix, keccak256(uncompressed_XY)[12:32]).
   * nexus enforces this constraint; a mismatch returns SDK_AUTH_INVALID_SIGNATURE.
   */
  readonly addressPrefix?: string;
  /** Request nonce generator; defaults to 16 random bytes from WebCrypto. */
  readonly nonce?: () => Uint8Array;
  /** Request expiry (Unix ms) generator; defaults to now + requestTtlMs. */
  readonly expiry?: () => bigint;
  /** Default request TTL (ms), defaults to 5 minutes. Used for timestamp-style expiry on non-OpenTask requests. */
  readonly requestTtlMs?: number;
  /**
   * The OpenTask request envelope's expiry window, in **blocks** (default 10).
   *
   * nexus applies two constraints to OpenTask:
   *  1. expiry must be a block height, not a timestamp (0 < expiry < 1e12, ingress/taskdata.go:221);
   *  2. it must also fall within [currentHeight, currentHeight + RequestTTLBlocks]
   *     (taskdata/authorizer.go:327-329), where RequestTTLBlocks defaults to **20**
   *     (nexus internal/config, overridable via NEXUS_TASK_DATA_REQUEST_TTL_BLOCKS).
   * Picking too large a window risks NEXUS_DATA_EXPIRED, so the default is 10 to leave block-production margin.
   */
  readonly requestTtlBlocks?: number;
  /**
   * Signer for the order's EIP-712 digest (SignedOrderV2.user_signature, a 65-byte R||S||V signature).
   * **Cannot** reuse signer: that one produces a 64-byte sha256-based Cosmos signature, while this one
   * needs a keccak-based recoverable signature -- the two are incompatible. Required for openTask.
   */
  readonly orderSigner?: Eip712Signer;
  /**
   * The chainId inside the EIP-712 domain is the **numeric EVM chain ID** (424242 in the golden
   * vectors), which is a different thing from the cosmos string chainId above -- both go into the
   * order signature. Required for openTask.
   */
  readonly evmChainId?: bigint | number | string;
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
   * tlsPubkeyHash is the sha256 (hex) of the certificate public key registered in the on-chain
   * descriptor; https endpoints should verify the server certificate against it. Under Node, you
   * can use nexusIngressTransport directly (transport/nexus-tls).
   */
  readonly ingressTransportFactory?: (serviceEndpoint: string, tlsPubkeyHash?: string) => Transport;
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
  /** Canonical lowercase 64-hex, the on-chain accepted task_hash. */
  readonly taskHash: string;
  /** Operator address of the winner Worker. */
  readonly winnerWorker: string;
  /** The winner Worker's current service key (33-byte compressed). */
  readonly workerServicePubKey: Uint8Array;
  /** The accepted InferReceipt; undefined when it was not asked for or is not on chain yet. */
  readonly receipt?: InferReceiptView;
  /** receipt.outputHash, canonical lowercase 64-hex. */
  readonly outputHash?: string;
}

/** One selected Task Builder's outcome for an openTask call. */
export interface OpenTaskBuilderResult {
  /** Builder operator address; this is the builderAddress for task-data requests to it. */
  readonly address: string;
  /** Rank in the task_builder_seed selection (0 = first). */
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
   * Canonical lowercase 64-hex, the on-chain accepted_task_hash. Defaults to the value from
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

async function nextWithIdleTimeout<T>(iterator: AsyncIterator<T>, idleTimeoutMs?: number): Promise<IteratorResult<T>> {
  if (idleTimeoutMs === undefined) return iterator.next();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      iterator.next(),
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

  constructor(cfg: TrueOpenClientConfig) {
    this.cfg = cfg;
    if (cfg.addressPrefix !== undefined) {
      const addr = cfg.sdkSignerAddress ?? cfg.userAddress;
      const pk = cfg.sdkSignerPubKey ?? cfg.signerPubKey;
      // Accounts are EVM-style (keccak(uncompressed XY)[12:32]), no longer ripemd160.
      if (!ethSecp256k1AddressMatches(addr, pk, cfg.addressPrefix)) {
        throw new TrueOpenError(
          'SDK_LOCAL',
          'SDK_LOCAL_ADDRESS_PUBKEY_MISMATCH',
          `SDK request signer_address ${addr} does not match pubkey-derived address (prefix ${cfg.addressPrefix}); nexus will reject with SDK_AUTH_INVALID_SIGNATURE`,
        );
      }
    }
    this.sessionManager = new SessionManager(cfg.chain);
    // The ingress request envelope uses the "effective SDK identity" (defaults to falling back
    // to user); the order signature still uses the user signer.
    this.ingress = new IngressClient(cfg.ingressTransport, {
      chainId: cfg.chainId,
      userAddress: this.effectiveSdkSignerAddress,
      signerPubKey: this.effectiveSdkSignerPubKey,
      signer: this.effectiveSdkSigner,
      nonce: () => this.nextNonce(),
      expiry: () => this.nextExpiry(),
      // The USER branch of the task data plane uses EIP-712; if it isn't configured, methods on
      // that plane fail with an explicit error instead of silently falling back to a 64-byte
      // signature that nexus would reject anyway.
      ...(cfg.orderSigner !== undefined ? { eip712Signer: cfg.orderSigner } : {}),
      ...(cfg.evmChainId !== undefined ? { evmChainId: cfg.evmChainId } : {}),
    });
  }

  /** Effective SDK request signer: falls back to the user signer by default. */
  private get effectiveSdkSigner(): CosmosSecp256k1Signer {
    return this.cfg.sdkSigner ?? this.cfg.signer;
  }

  /** Effective SDK request public key: falls back to the user signerPubKey by default. */
  private get effectiveSdkSignerPubKey(): Uint8Array {
    return this.cfg.sdkSignerPubKey ?? this.cfg.signerPubKey;
  }

  /** Effective SDK request address: falls back to userAddress by default. */
  private get effectiveSdkSignerAddress(): string {
    return this.cfg.sdkSignerAddress ?? this.cfg.userAddress;
  }

  createSession(label?: string): Promise<SessionHandle> {
    return this.sessionManager.create(label);
  }

  getSession(sessionId: string): Promise<SessionHandle> {
    return this.sessionManager.get(sessionId);
  }

  /**
   * Place an order through OpenTask, the order-placement entry point.
   *
   * Full flow: read the on-chain context -> assemble the frozen TaskOrderV3 -> sign the order's
   * inner EIP-712 digest, sign the outer order envelope, then sign the request envelope -> select
   * Task Builders via task_builder_seed -> submit concurrently to all selected endpoints,
   * succeeding as soon as any one is accepted.
   *
   * Requires config to provide orderSigner (a digest signer for the raw task_hash), hub, and
   * ingressTransportFactory.
   *
   * Hard rule unchanged: an ingress ack is only local acceptance; the on-chain query/event is the
   * source of truth for final state.
   */
  async openTask(params: OpenTaskParams): Promise<OpenTaskResult> {
    const { hub, ingressTransportFactory, orderSigner } = this.cfg;
    if (!hub || !ingressTransportFactory) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_ROUTING_UNCONFIGURED',
        'openTask requires config.hub and config.ingressTransportFactory',
      );
    }
    if (!orderSigner) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_ORDER_SIGNER_REQUIRED',
        'openTask requires config.orderSigner: SignedOrderV2.user_signature signs the EIP-712 digest (keccak, ' +
          '65-byte R||S||V), which cannot use the sha256-based CosmosSecp256k1Signer',
      );
    }
    if (this.cfg.evmChainId === undefined) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_ORDER_EIP712_UNCONFIGURED',
        'openTask requires config.evmChainId: it goes into the order EIP-712 signature and cannot be guessed',
      );
    }
    // Both go into the signature or decide whether the chain accepts the order, and a
    // mistake in either only surfaces after nexus accepted the order: the task just vanishes.
    const feeDenom = await this.resolveFeeDenom();
    const pricing = params.pricing ?? (await this.readProfilePricing(params.order));

    const orderSequence = params.orderSequence ?? (await this.nextOrderSequence(params.sessionId));
    const ctx = params.context ?? (await resolveTaskOrderContext(hub, this.cfg.chainId));
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
    const taskId = deriveTaskId(params.sessionId, orderSequence);
    // expiry must be a block height: nexus interprets values >= 1e12 as unix milliseconds and rejects them.
    const expiryHeight = params.expiryHeight ?? ctx.latestHeight + BigInt(this.cfg.requestTtlBlocks ?? 10);

    const built = await buildOpenTaskRequest({
      order,
      payload: params.order.payload,
      sessionId: params.sessionId,
      taskId,
      expiryHeight,
      requestNonce: this.nextNonce(),
      idempotencyKey: params.idempotencyKey,
      orderSigner,
      orderEip712: { evmChainId: this.cfg.evmChainId, feeDenom },
      signer: this.cfg.signer,
      signerPubKey: this.cfg.signerPubKey,
      ...(params.inputMediaType !== undefined ? { inputMediaType: params.inputMediaType } : {}),
      ...(params.chunkSizeBytes !== undefined ? { chunkSizeBytes: params.chunkSizeBytes } : {}),
      ...(this.cfg.sdkSigner !== undefined ? { sdkSigner: this.cfg.sdkSigner } : {}),
      ...(this.cfg.sdkSignerPubKey !== undefined ? { sdkSignerPubKey: this.cfg.sdkSignerPubKey } : {}),
      ...(this.cfg.sdkSignerAddress !== undefined ? { sdkSignerAddress: this.cfg.sdkSignerAddress } : {}),
    });

    // The selection seed and the candidate pool must use the same BuilderSet / anchor that was
    // signed into the order: the set in effect at session_anchor_height.
    const { endpoints, errors } = await resolveTaskBuilderEndpoints(hub, {
      chainId: this.cfg.chainId,
      taskId,
      builderSetHash: ctx.builderSetHash,
      sessionAnchorBlockHash: ctx.sessionAnchorBlockHash,
      sessionAnchorHeight: ctx.sessionAnchorHeight,
    });
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
    };
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

  /** Subscribe to the task event stream (for UX feedback and reconnect recovery; feeding a state-machine reducer is left to the caller). */
  watchTask(sessionId: string, taskId: string, fromCursor?: string): AsyncIterable<GetTaskEventsResponse> {
    const p = fromCursor !== undefined ? { sessionId, taskId, fromCursor } : { sessionId, taskId };
    return this.ingress.getTaskEvents(p);
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
   * `withReceipt: false` to skip that read. A missing winner, or a missing receipt when one is
   * asked for, is a retriable `OUTPUT_TRUST_ANCHOR_PENDING`: poll and call again.
   *
   * Needs config.taskReader (RestChainReader) and a hub reader with getCurrentServiceKey.
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

    const task = await taskReader.queryTask(taskId);
    const taskHash = task.acceptedTaskHash.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(taskHash)) throw pending('no accepted task_hash on chain yet');
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
    return { ...base, receipt, outputHash: receipt.outputHash.toLowerCase() };
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
   * block height and defaults to latest height + requestTtlBlocks (10), inside nexus's
   * 20-block request window.
   */
  async fetchTaskOutput(p: {
    sessionId: string;
    taskId: string;
    /** Canonical lowercase 64-hex, the on-chain accepted_task_hash. Defaults to the chain value. */
    taskHash?: string;
    /** Canonical lowercase 64-hex, the on-chain InferReceipt.output_hash (= MMR root). Defaults to the chain value. */
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
    const taskHash = (p.taskHash ?? anchors?.taskHash)?.toLowerCase();
    const outputHash = (p.outputHash ?? anchors?.outputHash)?.toLowerCase();
    if (taskHash === undefined || outputHash === undefined) {
      throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_TRUST_ANCHORS_MISSING', 'taskHash and outputHash are both required');
    }
    // The receipt only binds the size when it is the receipt for this output hash.
    const receipt = anchors?.receipt !== undefined && anchors.receipt.outputHash.toLowerCase() === outputHash ? anchors.receipt : undefined;

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

    const got = toHex(outputMmrRoot(chunks));
    if (got !== outputHash) {
      throw dataError(
        'DATA_OUTPUT_HASH_MISMATCH',
        `MMR root of ${chunks.length} chunks = ${got}, receipt output_hash = ${outputHash}`,
      );
    }

    return {
      bytes,
      text: new TextDecoder().decode(bytes),
      outputHash: got,
      taskHash,
      chunks,
      sizeBytes: meta.sizeBytes,
      mediaType: meta.mediaType,
      ...(receipt !== undefined ? { receipt } : {}),
    };
  }

  /** Task-data request expiry: latest height + requestTtlBlocks (default 10), inside nexus's 20-block window. */
  private async defaultTaskDataExpiry(): Promise<bigint> {
    const hub = this.cfg.hub;
    if (hub === undefined) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_EXPIRY_UNCONFIGURED',
        'expiresAtHeight is required when config.hub is not set (it is a block height)',
      );
    }
    return (await hub.getLatestHeight()) + BigInt(this.cfg.requestTtlBlocks ?? 10);
  }

  /** Fetch a retrieval credential (defaults to the SEALED_KEY access level, usage SDK_DELIVERY). The V1 data plane is plaintext; the credential only authorizes retrieval and carries no key material. */
  fetchOutputRef(
    sessionId: string,
    taskId: string,
    opts?: { accessLevel?: AccessLevelName; usage?: string },
  ): Promise<FetchOutputRefResponse> {
    return this.ingress.fetchOutputRef({
      sessionId,
      taskId,
      requester: this.cfg.userAddress,
      accessLevel: opts?.accessLevel ?? 'SEALED_KEY',
      usage: opts?.usage ?? 'SDK_DELIVERY',
    });
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
    // Anchors default to the chain: the accepted task_hash and the winner Worker's current
    // service key. The receipt is not needed (and usually not there yet) while streaming.
    let taskHashHex = p.taskHash;
    let workerServicePubKey = p.workerServicePubKey;
    if (taskHashHex === undefined || workerServicePubKey === undefined) {
      const anchors = await this.resolveOutputTrustAnchors(p.taskId, { withReceipt: false });
      taskHashHex ??= anchors.taskHash;
      workerServicePubKey ??= anchors.workerServicePubKey;
    }
    const taskHash = fromHex(taskHashHex);
    const verifier = new OutputStreamVerifier({
      chainId: this.cfg.chainId,
      taskHash,
      workerServicePubKey,
    }, p.checkpoint);

    if (p.resumeAfterSeq !== undefined) {
      if (p.checkpoint === undefined) {
        throw new TrueOpenError(
          'SDK_LOCAL',
          'OUTPUT_STREAM_RESUME_CHECKPOINT_REQUIRED',
          'resumeAfterSeq alone cannot restore MMR state; pass checkpoint returned by OutputStreamVerifier.checkpoint()',
        );
      }
      if (p.resumeAfterSeq !== verifier.resumeAfterSeq) {
        throw new TrueOpenError(
          'SDK_LOCAL',
          'OUTPUT_STREAM_RESUME_CURSOR_MISMATCH',
          `resumeAfterSeq=${p.resumeAfterSeq} does not match checkpoint cursor ${verifier.resumeAfterSeq}`,
        );
      }
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

    const failures: string[] = [];
    let finSource: OutputStreamSource | undefined;
    // The termination reason declared by a signature-verified Fin; stays undefined for an unattested Fin.
    let finishReason: FinishReasonV1 | undefined;
    for (let attempt = 0; attempt < maxAttempts && finSource === undefined; attempt += 1) {
      const source = sources[attempt % sources.length]!;
      const cursor = verifier.leafCount > 0n ? verifier.resumeAfterSeq : undefined;
      // A fresh AbortController per subscription: abandoning this stream must actually cut the
      // underlying request. iterator.return() only stops reading -- connect-node does not close
      // the HTTP connection because of it. If the Builder being asked isn't the dispatching one,
      // it has no frame to push, and that connection just hangs waiting for a response, keeping
      // the event loop referenced and preventing the caller's process from exiting (this was
      // observed hanging the CLI output stream).
      const abort = new AbortController();
      const iterator = source.ingress.subscribeOutput({
        sessionId: p.sessionId,
        taskId: p.taskId,
        ...(cursor !== undefined ? { resumeAfterSeq: cursor } : {}),
        signal: abort.signal,
      })[Symbol.asyncIterator]();
      let sawFin = false;
      try {
        for (;;) {
          const step = await nextWithIdleTimeout(iterator, p.idleTimeoutMs);
          if (step.done) break;
          const frame = step.value.frame;
          if (frame.case === 'chunk') {
            const c = frame.value;
            if (c.attachment.length > 0 || c.attachmentSignature.length > 0) {
              throw dataError('DATA_OUTPUT_ATTACHMENT_NOT_ALLOWED', `frame ${c.seq} carries an attachment; Phase 0 requires it empty`);
            }
            const acceptance = verifier.acceptOrDeduplicate({
              seq: c.seq,
              text: c.text,
              mmrRoot: c.mmrRoot,
              signature: c.workerSignature,
            });
            if (acceptance === 'duplicate') continue;
            if (p.onCheckpoint !== undefined) {
              try {
                await p.onCheckpoint(verifier.checkpoint());
              } catch (cause) {
                throw new TrueOpenError(
                  'SDK_LOCAL',
                  'OUTPUT_STREAM_CHECKPOINT_PERSIST_FAILED',
                  `failed to persist checkpoint after frame ${c.seq}`,
                  { cause },
                );
              }
            }
            yield {
              kind: 'chunk',
              seq: c.seq,
              text: new TextDecoder().decode(c.text),
              mmrRoot: Uint8Array.from(c.mmrRoot),
            };
            continue;
          }
          if (frame.case === 'fin') {
            const f = frame.value;
            if (f.finalSeq !== verifier.resumeAfterSeq) {
              throw dataError('DATA_OUTPUT_FIN_SEQ_MISMATCH', `fin says final_seq=${f.finalSeq} but ${verifier.resumeAfterSeq} was verified`);
            }
            if (!verifier.matchesReceipt(f.outputMmrRoot)) {
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
          failures.push(`${source.id}: stream ended without fin after seq ${verifier.resumeAfterSeq}`);
        }
      } catch (e) {
        if (e instanceof TrueOpenError && e.code === 'OUTPUT_STREAM_CHECKPOINT_PERSIST_FAILED') throw e;
        const err = e as { message?: string };
        failures.push(`${source.id}: ${err.message ?? String(e)}`);
      } finally {
        // Order matters: call return() first to let the generator wind down, then abort() to cut
        // the underlying connection. Even the one that received fin must be aborted -- keep-alive
        // would otherwise leave it sitting in the idle pool; that doesn't block process exit, but
        // a short-lived process never gets to reuse it, so it's just occupying the peer's connection.
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
    if (p.ack !== false && verifier.leafCount > 0n) {
      await finSource.ingress.ackOutput({ sessionId: p.sessionId, taskId: p.taskId, lastSeq: verifier.resumeAfterSeq });
    }
    // After the ack, not before: `break`ing on the fin event runs the generator's cleanup
    // path, so anything left after the yield never executes. Acking first makes the caller's
    // loop shape irrelevant to whether delivery progress is reported.
    yield { kind: 'fin', attested: true, finishReason };
  }

  /** Upgrade a locally verified output to confirmed, using the root/count/size from the on-chain InferReceipt. */
  confirmOutput(p: ConfirmOutputParams): ConfirmedOutputEvent {
    return confirmOutputWithReceipt({ chainId: this.cfg.chainId, ...p });
  }

  /** Prepare challenge materials (does not submit a verdict). */
  prepareChallenge(
    sessionId: string,
    taskId: string,
    challengeKind: ChallengeKind,
    localEvidenceDigest?: Uint8Array,
  ): Promise<PrepareChallengeResponse> {
    const p =
      localEvidenceDigest !== undefined
        ? { sessionId, taskId, challengeKind, localEvidenceDigest }
        : { sessionId, taskId, challengeKind };
    return this.ingress.prepareChallenge(p);
  }

  private nextNonce(): Uint8Array {
    if (this.cfg.nonce) return this.cfg.nonce();
    const g = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
    if (!g?.getRandomValues) {
      throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_NO_CRYPTO', 'no WebCrypto getRandomValues; provide config.nonce');
    }
    return g.getRandomValues(new Uint8Array(16));
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

/** nexus's default max range (task_data.max_range_bytes); a larger single read is refused. */
export const DEFAULT_MAX_RANGE_BYTES = 8 << 20;

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

async function retryTransient<T>(attempts: number, run: () => Promise<T>): Promise<T> {
  const n = Math.max(1, attempts);
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (e) {
      if (i >= n - 1 || !isTransientTransportError(e)) throw e;
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
