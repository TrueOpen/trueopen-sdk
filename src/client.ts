import type { Transport } from '@connectrpc/connect';
import type { ChainClient, CancelOrderResult, UserChallengeResult } from './transport/chain-client';
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
import { signCancelOrder, signUserChallenge } from './signer/order-signer';
import type { ChallengeKind } from './types/challenge';
import { TrueOpenError, dataError } from './errors/errors';
import { sha256 } from './codec/hash';
import { outputHash as outputMmrRoot, OutputStreamVerifier, verifyOutputFinSignature } from './output/output-commitment';
import type { OutputStreamVerifierCheckpoint } from './output/output-commitment';
import { confirmOutputWithReceipt } from './output/output-confirmation';
import type { ConfirmedOutputEvent } from './output/output-confirmation';
import {
  confirmAssistantMessageWithReceipt,
  deriveAssistantMessage,
  deriveAssistantStream,
  type DerivedViewOptions,
} from './toolcall/assistant-view';
import type {
  AssistantStreamEvent,
  ConfirmedAssistantMessage,
  DerivedAssistantMessage,
} from './toolcall/types';
import type { FinishReasonV1 } from './gen/task/v1/evidence_pb.js';
import type { InferReceiptView } from './types/node';
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
   * Fee denomination, goes into the order's EIP-712 feeDenom field.
   * shared.v1.Amount only carries atomic_units; the denom is determined by chain params. Required for openTask.
   */
  readonly feeDenom?: string;
  /**
   * Hub reader (needed by openTask): must be able to fetch both the builder set /
   * descriptors needed for Task Builder routing, and the order context (anchor beacon /
   * param bucket version). HubReader satisfies both.
   */
  readonly hub?: TaskBuilderReader & TaskOrderContextReader;
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

export interface OpenTaskParams {
  readonly sessionId: string;
  /**
   * Defaults to reading `StreamState.next_expected_sequence` from chain (the sole source of truth).
   *
   * This counter only advances when the Keeper **accepts** an order (node keeper/order_sequence.go:56-58);
   * `CancelOrder` also advances it (msg_server_session.go:267). It **stays put** when an order is
   * rejected, times out, or is replaced via RBF (SDK design §5.2). So once a locally incremented
   * counter drifts out of sync, it never self-heals -- every subsequent order gets rejected with
   * `ErrInvalidOrderSequence`. Pass an explicit value only for RBF -- resending a bumped-fee order
   * under the same sequence number.
   */
  readonly orderSequence?: bigint;
  /** User intent (including the plaintext payload); userAddress/sessionId/orderSequence are filled in by the client. */
  readonly order: TaskOrderIntent;
  /** Required per contract §3.1; the same key + the same input_hash returns the same result, the same key + a different input_hash is rejected. */
  readonly idempotencyKey: string;
  /** Defaults to resolveTaskOrderContext(hub, chainId). Reusing the same context saves a round trip to chain. */
  readonly context?: TaskOrderChainContext;
  /** Request envelope expiry as a **block height**; defaults to latestHeight + requestTtlBlocks. */
  readonly expiryHeight?: bigint;
  readonly inputMediaType?: string;
  readonly chunkSizeBytes?: number;
}

export interface OpenTaskResult extends OpenTaskAck {
  readonly taskId: string;
  /** Canonical task_hash (content identity, the digest covered by the user's inner signature). */
  readonly taskHash: string;
  /** The on-chain context actually used (anchor / builder set / bucket version), kept for reuse and debugging. */
  readonly context: TaskOrderChainContext;
  readonly endpointsTried: number;
}

export interface ChallengeParams {
  readonly sessionId: string;
  readonly taskId: string;
  readonly settlementId: string;
  readonly kind: ChallengeKind;
  readonly evidenceDigest: string;
  readonly bondAmount: bigint;
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
  /** Canonical lowercase 64-hex, the on-chain accepted_task_hash. */
  readonly taskHash: string;
  /** The selected Worker's service public key for this Task (33-byte compressed). */
  readonly workerServicePubKey: Uint8Array;
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
  /** Whether to report local delivery progress after finishing, default true. This is only local progress; it plays no part in settlement or fault attribution. */
  readonly ack?: boolean;
  /**
   * Signature-verification policy for the trailing frame (`OutputFinV1`).
   *
   * - `'require'`: Fin must carry a valid `finish_reason` and a verifiable `worker_signature`,
   *   otherwise an error is thrown. **This is the protocol's target state**, but it requires the
   *   peer to already produce a signed Fin per wire v0.4.3.
   * - `'accept-unsigned'` (default): if Fin carries a signature it is verified; if not, it is let through.
   *
   * Why the default isn't `'require'`: wire v0.4.3 only **adds fields** -- an old Fin decodes with
   * `finish_reason=0` and an empty `worker_signature`. Before nexus forwards signed Fins (nexus#99)
   * goes live, every live chain sends old-style Fins -- defaulting to fail-closed would make the SDK
   * immediately unusable against the whole network. The wire CHANGELOG also requires an explicit
   * consumer replay policy for pre-activation streams.
   *
   * Note this switch only relaxes **whether a signature is required to be present**; once a Fin does
   * carry a signature, either policy must verify it before accepting it -- a Fin with a bad signature
   * is never trusted under any policy.
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
      /**
       * The termination reason from a signature-verified `OutputFinV1`.
       *
       * `undefined` when the peer sent an unsigned Fin -- the default
       * `finSignaturePolicy: 'accept-unsigned'` lets those through, so absence means "not
       * attested", never "ended normally".
       *
       * **This cannot tell you the model made a tool call.** Cortex normalises vLLM's
       * `finish_reason: "tool_calls"` to EOS so that the chat path reuses the raw-text
       * resolver, so a turn that ended in a tool call arrives here as an ordinary EOS.
       * Detecting a tool call means parsing the committed text (ADR-0022).
       */
      readonly finishReason: FinishReasonV1 | undefined;
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
      // As of v0.4.1 accounts are EVM-style (keccak(uncompressed XY)[12:32]), no longer ripemd160.
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
   * Place an order (contract §3.1 target-state entry point, OpenTask).
   *
   * Full flow: read the on-chain context -> assemble the frozen TaskOrderV2 -> sign the order's
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
    if (this.cfg.evmChainId === undefined || this.cfg.feeDenom === undefined) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_ORDER_EIP712_UNCONFIGURED',
        'openTask requires config.evmChainId and config.feeDenom: both go into the order EIP-712 signature and cannot be guessed',
      );
    }

    const orderSequence = params.orderSequence ?? (await this.nextOrderSequence(params.sessionId));
    const ctx = params.context ?? (await resolveTaskOrderContext(hub, this.cfg.chainId));
    const order = buildTaskOrder(ctx, {
      ...params.order,
      userAddress: this.cfg.userAddress,
      sessionId: params.sessionId,
      orderSequence,
    });
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
      orderEip712: { evmChainId: this.cfg.evmChainId, feeDenom: this.cfg.feeDenom },
      signer: this.cfg.signer,
      signerPubKey: this.cfg.signerPubKey,
      ...(params.inputMediaType !== undefined ? { inputMediaType: params.inputMediaType } : {}),
      ...(params.chunkSizeBytes !== undefined ? { chunkSizeBytes: params.chunkSizeBytes } : {}),
      ...(this.cfg.sdkSigner !== undefined ? { sdkSigner: this.cfg.sdkSigner } : {}),
      ...(this.cfg.sdkSignerPubKey !== undefined ? { sdkSignerPubKey: this.cfg.sdkSignerPubKey } : {}),
      ...(this.cfg.sdkSignerAddress !== undefined ? { sdkSignerAddress: this.cfg.sdkSignerAddress } : {}),
    });

    // The selection seed must use the same builder_set_hash / anchor that was signed into the order.
    const { endpoints, errors } = await resolveTaskBuilderEndpoints(hub, {
      chainId: this.cfg.chainId,
      taskId,
      builderSetHash: ctx.builderSetHash,
      sessionAnchorBlockHash: ctx.sessionAnchorBlockHash,
    });
    if (endpoints.length === 0) {
      throw new TrueOpenError(
        'NEXUS_INGRESS',
        'TASK_BUILDER_NO_REACHABLE_ENDPOINT',
        `no reachable Task Builder nexus (${errors.length} errors)`,
        { retriable: true },
      );
    }

    const fan = await fanOutToEndpoints(built.input, endpoints, async (endpoint, req) => {
      const submit = (serviceEndpoint: string, tlsPubkeyHash: string): Promise<OpenTaskAck> =>
        new IngressClient(ingressTransportFactory(serviceEndpoint, tlsPubkeyHash)).openTask(req);
      try {
        return await submit(endpoint.serviceEndpoint, endpoint.tlsPubkeyHash ?? '');
      } catch (err) {
        // ADR-0015: the Builder rotated its certificate and the locally cached fingerprint is
        // stale -> re-read that Builder's descriptor; if the fingerprint changed, retry with the
        // new fingerprint, otherwise the peer certificate really is wrong, so return the original error.
        if (!isTLSPubkeyMismatch(err)) throw err;
        const fresh = await rereadNexusEndpoint(hub, endpoint.address);
        if (!fresh || fresh.tlsPubkeyHash === (endpoint.tlsPubkeyHash ?? '')) throw err;
        return await submit(fresh.uri, fresh.tlsPubkeyHash);
      }
    });
    const ack = fan.ack as OpenTaskAck;
    return {
      ...ack,
      taskId,
      taskHash: built.taskHash,
      context: ctx,
      endpointsTried: endpoints.length,
    };
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

  async cancelOrder(sessionId: string, orderSequence: bigint): Promise<CancelOrderResult> {
    const ownerSignature = await signCancelOrder(
      this.cfg.chainId,
      this.cfg.userAddress,
      sessionId,
      orderSequence,
      this.cfg.signer,
    );
    return this.cfg.chain.cancelOrder({ sessionId, orderSequence, ownerSignature });
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
   * Retrieve the OUTPUT body (the data plane from contract §3.5/§3.6):
   * GetTaskDataMetadata gets size / chunk_lengths / output_leaf_count ->
   * FetchTaskData fetches the bytes -> re-split into chunks per chunk_lengths -> compute the MMR
   * root and compare it against the receipt's output_hash.
   *
   * **The verification criterion changed after ADR-0017**: output_hash is no longer a whole-object
   * sha256, it is the MMR root of the ordered chunk list under TRUEOPEN_OUTPUT_MMR_V1. Chunk
   * boundaries are part of the commitment, so re-splitting must follow chunk_lengths exactly --
   * merging or re-segmenting chunks yourself produces a different root for the same underlying bytes.
   *
   * The caller must first obtain output_hash from the on-chain InferReceipt: it is both the
   * verification target and the object_ref.content_hash (retrieval is content-addressed, so
   * without it the object can't even be located).
   *
   * builderAddress must be the operator address of the Builder being queried (nexus compares it
   * against its own configuration); expiresAtHeight is a block height, supplied by the caller as
   * current height plus a window.
   */
  async fetchTaskOutput(p: {
    sessionId: string;
    taskId: string;
    /** Canonical lowercase 64-hex, the on-chain accepted_task_hash. */
    taskHash: string;
    /** Canonical lowercase 64-hex, the on-chain InferReceipt.output_hash (= MMR root). */
    outputHash: string;
    builderAddress: string;
    expiresAtHeight: bigint;
  }): Promise<{
    bytes: Uint8Array;
    text: string;
    outputHash: string;
    chunks: Uint8Array[];
    sizeBytes: bigint;
    mediaType: string;
  }> {
    const objectRef = {
      taskHash: p.taskHash,
      sessionId: p.sessionId,
      taskId: p.taskId,
      objectKind: TASK_DATA_OBJECT_KIND.OUTPUT,
      contentHash: p.outputHash,
    };
    const req = { objectRef, builderAddress: p.builderAddress, expiresAtHeight: p.expiresAtHeight };

    const meta = await this.ingress.getTaskDataMetadata(req);
    if (!meta) {
      throw dataError('DATA_OUTPUT_NOT_FOUND', `no OUTPUT object for task ${p.taskId}`);
    }
    const bytes = await this.ingress.fetchTaskData(req);
    if (BigInt(bytes.length) !== meta.sizeBytes) {
      throw dataError('DATA_OUTPUT_SIZE_MISMATCH', `fetched ${bytes.length} bytes, metadata says ${meta.sizeBytes}`);
    }

    const chunks = splitByChunkLengths(bytes, meta.chunkLengths);
    if (meta.outputLeafCount !== BigInt(chunks.length)) {
      throw dataError(
        'DATA_OUTPUT_LEAF_COUNT_MISMATCH',
        `chunk_lengths has ${chunks.length} entries but output_leaf_count is ${meta.outputLeafCount}`,
      );
    }
    const got = toHex(outputMmrRoot(chunks));
    if (got !== p.outputHash.toLowerCase()) {
      throw dataError(
        'DATA_OUTPUT_HASH_MISMATCH',
        `MMR root of ${chunks.length} chunks = ${got}, receipt output_hash = ${p.outputHash}`,
      );
    }

    return {
      bytes,
      text: new TextDecoder().decode(bytes),
      outputHash: got,
      chunks,
      sizeBytes: meta.sizeBytes,
      mediaType: meta.mediaType,
    };
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
   * Subscribe to output as a stream (ADR-0017 / contract §3.5). Yields verified text segments frame by frame.
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
   * OutputFinV1 carries no signature -- the authoritative final commitment is the on-chain
   * InferReceipt.output_hash, and the root in fin only lets the receiver catch a discrepancy
   * earlier. So this only raises an error when fin disagrees with the locally computed root; it is
   * never treated as the commitment itself.
   */
  async *streamOutput(p: StreamOutputParams): AsyncIterable<OutputStreamEvent> {
    const verifier = new OutputStreamVerifier({
      chainId: this.cfg.chainId,
      taskHash: fromHex(p.taskHash),
      workerServicePubKey: p.workerServicePubKey,
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
    // One decoder for the whole streamOutput call, fed with `stream: true`, because a frame
    // boundary is chosen by the Worker and can fall inside a multi-byte UTF-8 sequence -- a CJK
    // character split across two frames decodes to two replacement characters if each frame is
    // decoded on its own.
    //
    // In-call reconnect and Builder rotation (lines 647-699) reuse this decoder unchanged, so
    // bytes held back mid-sequence remain the correct UTF-8 prefix to the next frame. Duplicates
    // are dropped before reaching the decoder (line 680), so no byte is fed twice. Concatenating
    // chunk.text reproduces the committed text for valid UTF-8 within a single call.
    //
    // For checkpoint-resumed calls (caller-supplied StreamOutputParams.checkpoint), a new
    // streamOutput invocation creates a new decoder at this line with no memory of the prior
    // call. If the prior decoder held trailing bytes of a multi-byte character, those bytes are
    // orphaned: OutputStreamVerifierCheckpoint carries raw bytes and MMR but not TextDecoder
    // state, and resumeAfterSeq prevents the frame holding them from being redelivered. The new
    // decoder thus receives orphaned continuation bytes that are not a valid sequence start,
    // emitting a replacement character (U+FFFD) at the seam. This corrupts only the live
    // chunk.text stream; OutputStreamVerifier.text() reconstructs from the full checkpoint.chunks
    // and is authoritative for exact reconstruction.
    const decoder = new TextDecoder();
    let finSource: OutputStreamSource | undefined;
    // The termination reason declared by a signature-verified Fin; stays undefined if the peer never sends a signed Fin.
    let finishReason: number | undefined;
    for (let attempt = 0; attempt < maxAttempts && finSource === undefined; attempt += 1) {
      const source = sources[attempt % sources.length]!;
      const cursor = verifier.leafCount > 0n ? verifier.resumeAfterSeq : undefined;
      // A fresh AbortController per subscription: abandoning this stream must actually cut the
      // underlying request. iterator.return() only stops reading -- connect-node does not close
      // the HTTP connection because of it. If the Builder being asked isn't the dispatching one,
      // it has no frame to push, and that connection just hangs waiting for a response, keeping
      // the event loop referenced and preventing the caller's process from exiting (nexus#102:
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
              text: decoder.decode(c.text, { stream: true }),
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
            // As of wire v0.4.3 (wire#35), Fin carries finish_reason + worker_signature.
            // If present it must verify; if absent, finSignaturePolicy decides whether to accept or reject.
            const policy = p.finSignaturePolicy ?? 'accept-unsigned';
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
                taskHash: fromHex(p.taskHash),
                finalSeq: f.finalSeq,
                outputMmrRoot: Uint8Array.from(f.outputMmrRoot),
                finishReason: Number(f.finishReason),
              };
              if (!verifyOutputFinSignature(finFields, f.workerSignature, p.workerServicePubKey)) {
                throw dataError(
                  'DATA_OUTPUT_FIN_SIGNATURE_INVALID',
                  `fin signature for task ${p.taskId} did not verify (finish_reason=${f.finishReason})`,
                );
              }
              finishReason = Number(f.finishReason);
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
    if (p.ack !== false && verifier.leafCount > 0n) {
      await finSource.ingress.ackOutput({ sessionId: p.sessionId, taskId: p.taskId, lastSeq: verifier.resumeAfterSeq });
    }
    // After the ack, not before: `break`ing on the fin event runs the generator's cleanup
    // path, so anything left after the yield never executes. Acking first makes the caller's
    // loop shape irrelevant to whether delivery progress is reported.
    yield { kind: 'fin', finishReason };
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
   */
  async *streamAssistantMessage(
    p: StreamOutputParams & DerivedViewOptions,
  ): AsyncIterable<AssistantStreamEvent> {
    yield* deriveAssistantStream(this.streamOutput(p), p);
  }

  /**
   * The derived-view counterpart of `confirmOutput` (design S4.1, S5).
   *
   * Synchronous and receipt-taking for the same reason `confirmOutput` is: the chain read
   * belongs to the caller, which is what lets the stream run against a Builder while the caller
   * decides when to reach the node.
   */
  confirmAssistantMessage(p: ConfirmOutputParams & DerivedViewOptions): ConfirmedAssistantMessage {
    return confirmAssistantMessageWithReceipt({ chainId: this.cfg.chainId, ...p }, p);
  }

  /**
   * The derived-view counterpart of `fetchTaskOutput` (design S4.4).
   *
   * No provisional stage: retrieval is content-addressed against the on-chain
   * `InferReceipt.output_hash`, so the bytes are already reconciled when they arrive.
   */
  async fetchAssistantMessage(
    p: Parameters<TrueOpenClient['fetchTaskOutput']>[0] & DerivedViewOptions,
  ): Promise<DerivedAssistantMessage> {
    const got = await this.fetchTaskOutput(p);
    return deriveAssistantMessage(got.text, p);
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

  /** File an on-chain UserChallenge: sign challenger_signature and submit MsgUserChallenge. */
  async challenge(params: ChallengeParams): Promise<UserChallengeResult> {
    const challengerSignature = await signUserChallenge(
      {
        chainId: this.cfg.chainId,
        sessionId: params.sessionId,
        taskId: params.taskId,
        settlementId: params.settlementId,
        challengeKind: params.kind,
        evidenceDigest: params.evidenceDigest,
        bondAmount: params.bondAmount,
        requestedEvidence: [],
      },
      this.cfg.signer,
    );
    return this.cfg.chain.userChallenge({
      sessionId: params.sessionId,
      taskId: params.taskId,
      settlementId: params.settlementId,
      kind: params.kind,
      evidenceDigest: params.evidenceDigest,
      bondAmount: params.bondAmount,
      challengerSignature,
    });
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
