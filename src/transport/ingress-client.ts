import { createClient } from '@connectrpc/connect';
import { classifyNexusError } from '../errors/classify';
import type { Client, Transport } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import {
  IngressAPI,
  OpenTaskHeaderSchema,
  OpenTaskRequestSchema,
  SDKRequestEnvelopeV2Schema,
  GetTaskStatusRequestSchema,
  PrepareChallengeRequestSchema,
  GetTaskEventsRequestSchema,
  SubscribeOutputRequestSchema,
  AckOutputRequestSchema,
  GetTaskDataMetadataRequestSchema,
  FetchTaskDataRequestSchema,
  TaskDataRequestAuthV1Schema,
  TaskDataObjectRefV1Schema,
  ByteRangeV1Schema,
} from '../gen/nexus/v1/ingress_pb.js';
import type {
  OpenTaskRequest,
  TaskDataObjectMetadataV1,
  PrepareChallengeResponse,
  GetTaskEventsResponse,
  SubscribeOutputResponse,
  AckOutputResponse,
} from '../gen/nexus/v1/ingress_pb.js';
import { TrueOpenError } from '../errors/errors';
import type { TypedDataSigner } from '../signer/typed-data-signer';
import { signTypedDataAs } from '../signer/typed-data-signer';
import { canonicalOperatorAddressBytes } from '../codec/address';
import { signSdkRequestEnvelope, HEIGHT_EXPIRY_THRESHOLD } from './sdk-request-envelope';
import {
  getTaskEventsBodyDigest,
  prepareChallengeBodyDigest,
  subscribeOutputBodyDigest,
  ackOutputBodyDigest,
} from './sdk-request-body';
import type { SignedSdkRequestEnvelope } from './sdk-request-envelope';
import {
  taskDataRequestTypedData,
  taskDataMetadataBodyDigest,
  taskDataFetchBodyDigest,
  bodyDigestHex,
  TASK_DATA_RPC_METHOD,
  TASK_DATA_REQUESTER_KIND,
  EVIDENCE_PRODUCER_KIND,
} from './task-data-signbytes';
import type { TaskDataObjectRef, ByteRange } from './task-data-signbytes';

/**
 * Default chunk size for OpenTask. nexus only enforces an upper bound (256 KiB by default,
 * see nexus internal/config chunk_size_bytes, overridable via NEXUS_TASK_DATA_CHUNK_SIZE_BYTES),
 * so the SDK just needs a conservative value here; callers can raise it if needed.
 */
export const DEFAULT_OPEN_TASK_CHUNK_BYTES = 64 * 1024;

/** OpenTask request (header fields plus the input body to be chunked). */
export interface OpenTaskInput {
  /** Protobuf bytes of the frozen SignedOrderV2. */
  readonly orderEnvelope: Uint8Array;
  readonly payloadRef: string;
  /** The outer user order signature, 64 raw bytes. */
  readonly signature: Uint8Array;
  readonly requestEnvelope: SignedSdkRequestEnvelope;
  readonly sessionId: string;
  readonly orderSequence: bigint;
  readonly userAddress: string;
  readonly signatureScheme: string;
  /** Canonical lowercase 64-hex = hex(sha256(payload)). */
  readonly inputHash: string;
  readonly inputMediaType: string;
  /** Required: must stay the same across retries. */
  readonly idempotencyKey: string;
  /** Plaintext input body; this method sends it chunked according to chunkSizeBytes. */
  readonly payload: Uint8Array;
  readonly chunkSizeBytes?: number;
}

/** OpenTask accept response. */
export interface OpenTaskAck {
  readonly taskId: string;
  readonly accepted: boolean;
  readonly reason: string;
  readonly sessionId: string;
  readonly inputMetadata?: TaskDataObjectMetadataV1;
}

/** Snapshot of nexus's local FSM (GetTaskStatus). The on-chain state is still authoritative via chain query. */
export interface TaskStatusView {
  readonly state: string;
  readonly stage: string;
  readonly setId: string;
  readonly taskPhase: string;
  readonly updatedAt: bigint;
}

/**
 * Signing context for the requests the user signs: every method except GetTaskStatus and
 * OpenTask (whose envelope is signed while the order is built, see buildOpenTaskRequest).
 */
export interface IngressAuth {
  readonly chainId: string;
  /** The user's canonical Bech32 address: signer_address, requester_address. */
  readonly userAddress: string;
  /** The user's wallet: signs EIP-712 typed data (65 bytes R||S||V) as userAddress. */
  readonly wallet: TypedDataSigner;
  /**
   * The chain's EVM chain ID (`params.phase0.evm_chain_id`), the chainId of every EIP-712
   * domain. A function is called for each request, so the caller decides how to cache it.
   */
  readonly evmChainId: bigint | (() => Promise<bigint>);
  /** Exactly 32 bytes from a CSPRNG per call. */
  readonly nonce: () => Uint8Array;
  /** Request expiry as Unix milliseconds (at or above 10^12). */
  readonly expiry: () => bigint;
}

async function resolveEvmChainId(auth: IngressAuth): Promise<bigint> {
  return typeof auth.evmChainId === 'function' ? auth.evmChainId() : auth.evmChainId;
}

function nonce32(auth: IngressAuth): Uint8Array {
  const n = auth.nonce();
  if (n.length !== 32) {
    throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_REQUEST_MALFORMED', `request nonce must be exactly 32 bytes, got ${n.length}`);
  }
  return n;
}

/**
 * nexus IngressAPI client (Connect RPC, generated from ingress.proto).
 * The transport is injected by the caller; auth is optional, and methods that need a
 * signature throw if it's absent.
 */
export class IngressClient {
  private readonly client: Client<typeof IngressAPI>;
  private readonly auth?: IngressAuth;

  constructor(transport: Transport, auth?: IngressAuth) {
    this.client = classifyingClient(createClient(IngressAPI, transport));
    if (auth) this.auth = auth;
  }

  /** The generated Connect client. Its errors are classified the same way as this class's. */
  get raw(): Client<typeof IngressAPI> {
    return this.client;
  }

  /**
   * OpenTask (the order-placement entry point):
   * client-streaming, sends 1 header frame followed by N chunk frames (N >= 1, each chunk
   * non-empty and within the server's chunk size cap, 256 KiB by default -- see nexus
   * internal/config chunk_size_bytes).
   *
   * Key differences from the deprecated SubmitOrder:
   *  - order_envelope must be the frozen SignedOrderV2 protobuf bytes (no longer canonical JSON);
   *  - the input body goes over chunk frames and is not part of body_digest;
   *  - request_envelope's expiry **must be a block height** (nexus taskdata.go:221-224
   *    requires 0 < expiry < 1e12; anything above that is treated as a unix millisecond
   *    timestamp and rejected). Callers must pass expiryHeight.
   */
  async openTask(req: OpenTaskInput): Promise<OpenTaskAck> {
    const chunkSize = req.chunkSizeBytes ?? DEFAULT_OPEN_TASK_CHUNK_BYTES;
    if (chunkSize <= 0) {
      throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_CHUNK_SIZE_INVALID', 'chunkSizeBytes must be positive');
    }
    if (req.payload.length === 0) {
      throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_PAYLOAD_EMPTY', 'OpenTask requires at least one non-empty chunk');
    }
    const header = create(OpenTaskHeaderSchema, {
      orderEnvelope: req.orderEnvelope,
      payloadRef: req.payloadRef,
      signature: req.signature,
      requestEnvelope: this.envelopeMsg(req.requestEnvelope),
      sessionId: req.sessionId,
      orderSequence: req.orderSequence,
      userAddress: req.userAddress,
      signatureScheme: req.signatureScheme,
      inputSizeBytes: BigInt(req.payload.length),
      inputHash: req.inputHash,
      inputMediaType: req.inputMediaType,
      idempotencyKey: req.idempotencyKey,
    });

    const payload = req.payload;
    async function* frames(): AsyncGenerator<OpenTaskRequest> {
      yield create(OpenTaskRequestSchema, { frame: { case: 'header', value: header } });
      for (let off = 0; off < payload.length; off += chunkSize) {
        yield create(OpenTaskRequestSchema, {
          frame: { case: 'chunk', value: payload.subarray(off, Math.min(off + chunkSize, payload.length)) },
        });
      }
    }

    const res = await this.client.openTask(frames());
    return {
      taskId: res.taskId,
      accepted: res.accepted,
      reason: res.reason,
      sessionId: res.sessionId,
      ...(res.inputMetadata !== undefined ? { inputMetadata: res.inputMetadata } : {}),
    };
  }

  /** Snapshot of nexus's local FSM (no application-level signature required). */
  async getTaskStatus(sessionId: string, taskId: string): Promise<TaskStatusView> {
    const res = await this.client.getTaskStatus(create(GetTaskStatusRequestSchema, { sessionId, taskId }));
    return { state: res.state, stage: res.stage, setId: res.setId, taskPhase: res.taskPhase, updatedAt: res.updatedAt };
  }

  /** Prepares challenge material (does not submit a verdict). */
  async prepareChallenge(p: {
    sessionId: string;
    taskId: string;
    challengeKind: string;
    localEvidenceDigest?: Uint8Array;
  }): Promise<PrepareChallengeResponse> {
    const led = p.localEvidenceDigest ?? new Uint8Array();
    const bd = prepareChallengeBodyDigest(p.sessionId, p.taskId, p.challengeKind, led);
    const env = await this.signEnvelope('PrepareChallenge', p.sessionId, p.taskId, bd);
    return this.client.prepareChallenge(
      create(PrepareChallengeRequestSchema, {
        sessionId: p.sessionId,
        taskId: p.taskId,
        challengeKind: p.challengeKind,
        localEvidenceDigest: led,
        requestEnvelope: this.envelopeMsg(env),
      }),
    );
  }

  /** Subscribes to the task event stream (server streaming). Events are informational only; the chain query remains authoritative. */
  async *getTaskEvents(p: {
    sessionId: string;
    taskId: string;
    fromCursor?: string;
  }): AsyncIterable<GetTaskEventsResponse> {
    const cursor = p.fromCursor ?? '';
    const bd = getTaskEventsBodyDigest(p.sessionId, p.taskId, cursor);
    const env = await this.signEnvelope('GetTaskEvents', p.sessionId, p.taskId, bd);
    const stream = this.client.getTaskEvents(
      create(GetTaskEventsRequestSchema, {
        sessionId: p.sessionId,
        taskId: p.taskId,
        fromCursor: cursor,
        requestEnvelope: this.envelopeMsg(env),
      }),
    );
    for await (const ev of stream) yield ev;
  }

  /**
   * Subscribes to chunked output (server streaming). Forwards
   * each Worker-signed OutputChunkV1 as-is, then forwards the final OutputFinV1; signature
   * verification, MMR checks, deduplication, and resubscription are handled by TrueOpenClient.
   */
  async *subscribeOutput(p: {
    sessionId: string;
    taskId: string;
    /** Resume point: only replays frames with seq greater than this value. Leave unset on the first subscription, starting from seq = 0. */
    resumeAfterSeq?: bigint;
    /**
     * Abort signal. **You must abort when giving up on a stream**: merely stopping reads
     * (`iterator.return()`) does not tear down the underlying HTTP request -- if the queried
     * Builder isn't the one the task was routed to, it has no frames to push, and the
     * connection stays open waiting for a response, keeping the event loop alive and
     * preventing the process from exiting.
     */
    signal?: AbortSignal;
  }): AsyncIterable<SubscribeOutputResponse> {
    const bd = subscribeOutputBodyDigest(p.sessionId, p.taskId, p.resumeAfterSeq);
    const env = await this.signEnvelope('SubscribeOutput', p.sessionId, p.taskId, bd);
    const stream = this.client.subscribeOutput(
      create(SubscribeOutputRequestSchema, {
        sessionId: p.sessionId,
        taskId: p.taskId,
        requestEnvelope: this.envelopeMsg(env),
        ...(p.resumeAfterSeq !== undefined ? { resumeAfterSeq: p.resumeAfterSeq } : {}),
      }),
      p.signal !== undefined ? { signal: p.signal } : undefined,
    );
    for await (const msg of stream) yield msg;
  }

  /**
   * Fetches task data metadata. Unlike the other methods, this one
   * doesn't take an SDKRequestEnvelope -- it takes a TaskDataRequestAuthV1 instead: the USER
   * branch, EIP-712 typed data under the "TrueOpen Task Data Request" domain
   * (task-data-signbytes.ts), signed by the wallet.
   *
   * builderAddress must be the operator address of **the specific Builder being queried**:
   * nexus compares it byte-for-byte against its own configuration, and a mismatch is an
   * immediate unauthorized (authorizer.go verifyRequest). The order placer is only
   * authorized for OUTPUT on their own task (canInspect: user && kind == OUTPUT).
   */
  async getTaskDataMetadata(p: {
    objectRef: TaskDataObjectRef;
    builderAddress: string;
    expiresAtHeight: bigint;
  }): Promise<TaskDataObjectMetadataV1 | undefined> {
    const auth = this.requireAuth('GetTaskDataMetadata');
    const requestAuth = await this.signTaskDataRequest(auth, {
      builderAddress: p.builderAddress,
      expiresAtHeight: p.expiresAtHeight,
      rpcMethod: TASK_DATA_RPC_METHOD.GetTaskDataMetadata,
      bodyDigest: taskDataMetadataBodyDigest(p.objectRef),
    });
    const res = await this.client.getTaskDataMetadata(
      create(GetTaskDataMetadataRequestSchema, {
        objectRef: toProtoObjectRef(p.objectRef),
        requestAuth,
      }),
    );
    return res.metadata;
  }

  /**
   * Streams the task data body. The response is a frame oneof: one
   * FetchTaskDataHeaderV1 first (echoing the actual returned range and media type), then
   * some number of FetchTaskDataChunkV1 frames, until eof.
   *
   * An unset range means read the whole object. nexus refuses a whole-object read of an
   * object larger than its max range, so callers fetching output should use
   * `TrueOpenClient.fetchTaskOutput`, which splits the object into ranges.
   *
   * Callers are responsible for validating the content after fetching (this
   * means re-chunking by chunk_lengths and computing the MMR root, no longer a whole-object
   * sha256) -- this method only fetches the bytes.
   */
  async fetchTaskData(p: {
    objectRef: TaskDataObjectRef;
    builderAddress: string;
    expiresAtHeight: bigint;
    range?: ByteRange;
  }): Promise<Uint8Array> {
    return (await this.fetchTaskDataRange(p)).bytes;
  }

  /**
   * Same as fetchTaskData, but also returns the header, and checks that the bytes are the
   * ones asked for:
   *  - the header's `served_range` equals the requested range (or the whole object when no
   *    range was requested) and lies inside `total_size_bytes`;
   *  - every chunk's absolute `offset` continues exactly where the previous one ended;
   *  - the bytes received add up to exactly `served_range.length`, never more.
   * A peer that answers with a different slice would otherwise be spliced into the wrong
   * place and only caught much later by the MMR root, with a far less useful error.
   */
  async fetchTaskDataRange(p: {
    objectRef: TaskDataObjectRef;
    builderAddress: string;
    expiresAtHeight: bigint;
    range?: ByteRange;
  }): Promise<{ bytes: Uint8Array; totalSizeBytes: bigint; servedRange: ByteRange; mediaType: string }> {
    const auth = this.requireAuth('FetchTaskData');
    const requestAuth = await this.signTaskDataRequest(auth, {
      builderAddress: p.builderAddress,
      expiresAtHeight: p.expiresAtHeight,
      rpcMethod: TASK_DATA_RPC_METHOD.FetchTaskData,
      bodyDigest: taskDataFetchBodyDigest(p.objectRef, p.range),
    });
    const stream = this.client.fetchTaskData(
      create(FetchTaskDataRequestSchema, {
        objectRef: toProtoObjectRef(p.objectRef),
        ...(p.range !== undefined
          ? { range: create(ByteRangeV1Schema, { offset: p.range.offset, length: p.range.length }) }
          : {}),
        requestAuth,
      }),
    );

    // The peer answered with bytes other than the ones asked for: do not trust it again.
    const bad = (message: string): TrueOpenError =>
      new TrueOpenError('NEXUS_INGRESS', 'NEXUS_FETCH_TASK_DATA_RANGE_INVALID', message, { switchSource: true, category: 'data-corrupt' });
    const chunks: Uint8Array[] = [];
    let header: { totalSizeBytes: bigint; servedRange: ByteRange; mediaType: string } | undefined;
    let next = 0n; // absolute offset the next chunk must start at
    let received = 0n;
    let sawEof = false;
    for await (const msg of stream) {
      const frame = msg.frame;
      if (frame.case === 'header') {
        if (header !== undefined) throw bad('FetchTaskData sent a second header');
        const h = frame.value;
        const served = h.servedRange;
        if (served === undefined) throw bad('FetchTaskData header carries no served_range');
        const want = p.range ?? { offset: 0n, length: h.totalSizeBytes };
        if (served.offset !== want.offset || served.length !== want.length) {
          throw bad(
            `FetchTaskData served [${served.offset}, +${served.length}) but [${want.offset}, +${want.length}) was requested`,
          );
        }
        if (served.offset + served.length > h.totalSizeBytes) {
          throw bad(`served range [${served.offset}, +${served.length}) exceeds total_size_bytes ${h.totalSizeBytes}`);
        }
        header = {
          totalSizeBytes: h.totalSizeBytes,
          servedRange: { offset: served.offset, length: served.length },
          mediaType: h.mediaType,
        };
        next = served.offset;
        continue;
      }
      if (frame.case !== 'chunk') continue;
      // The contract requires the header to arrive before any chunk; if the order is
      // reversed, the peer is violating the contract, so don't silently accept it.
      if (header === undefined) {
        throw new TrueOpenError(
          'NEXUS_INGRESS',
          'NEXUS_FETCH_TASK_DATA_NO_HEADER',
          'FetchTaskData sent a chunk before its header',
        );
      }
      if (sawEof) throw bad('FetchTaskData sent a chunk after eof');
      const c = frame.value;
      if (c.offset !== next) throw bad(`chunk offset ${c.offset}, expected ${next}`);
      const len = BigInt(c.data.length);
      if (received + len > header.servedRange.length) {
        throw bad(`FetchTaskData sent more than the served length ${header.servedRange.length}`);
      }
      if (c.data.length > 0) chunks.push(c.data);
      received += len;
      next += len;
      if (c.eof) sawEof = true;
    }
    if (header === undefined) {
      throw new TrueOpenError(
        'NEXUS_INGRESS',
        'NEXUS_FETCH_TASK_DATA_EMPTY',
        'FetchTaskData stream ended without a header frame',
      );
    }
    if (received !== header.servedRange.length) {
      throw new TrueOpenError(
        'NEXUS_INGRESS',
        'NEXUS_FETCH_TASK_DATA_SHORT',
        `FetchTaskData ended after ${received} of ${header.servedRange.length} bytes`,
        { retriable: true },
      );
    }

    const out = new Uint8Array(Number(received));
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return { bytes: out, ...header };
  }

  /**
   * Assembles and signs the USER branch of TaskDataRequestAuthV1.
   *
   * The contract is explicit that "signature length is not sniffed, and the caller's public
   * key is not trusted": requester_kind alone determines the verification path, and USER
   * always means EIP-712 plus a 65-byte signature, with service_authorization_nonce fixed
   * at 0. The signature is checked to recover to requester_address before it is sent.
   */
  private async signTaskDataRequest(
    auth: IngressAuth,
    p: {
      builderAddress: string;
      expiresAtHeight: bigint;
      rpcMethod: string;
      bodyDigest: Uint8Array;
    },
  ): Promise<ReturnType<typeof create<typeof TaskDataRequestAuthV1Schema>>> {
    const fields = {
      schemaVersion: TASK_DATA_AUTH_SCHEMA_VERSION,
      chainId: auth.chainId,
      builderOperatorAddress: p.builderAddress,
      rpcMethod: p.rpcMethod,
      bodyDigest: p.bodyDigest,
      requesterKind: TASK_DATA_REQUESTER_KIND.USER,
      requesterAddress: auth.userAddress,
      serviceAuthorizationNonce: 0n,
      requestNonce: nonce32(auth),
      expiryHeight: p.expiresAtHeight,
    };
    const data = taskDataRequestTypedData(fields, await resolveEvmChainId(auth));
    const signature = await signTypedDataAs(
      auth.wallet,
      data,
      canonicalOperatorAddressBytes('requester_address', auth.userAddress),
    );
    return create(TaskDataRequestAuthV1Schema, {
      schemaVersion: fields.schemaVersion,
      chainId: fields.chainId,
      builderOperatorAddress: fields.builderOperatorAddress,
      rpcMethod: fields.rpcMethod,
      bodyDigest: bodyDigestHex(fields.bodyDigest),
      requesterKind: TASK_DATA_REQUESTER_KIND.USER,
      requesterAddress: fields.requesterAddress,
      serviceAuthorizationNonce: fields.serviceAuthorizationNonce,
      requestNonce: fields.requestNonce,
      expiryHeight: fields.expiryHeight,
      signature,
    });
  }

  private requireAuth(method: string): IngressAuth {
    if (!this.auth) {
      throw new TrueOpenError('SDK_AUTH', 'SDK_AUTH_NO_SIGNER', `${method} requires IngressClient auth context`);
    }
    return this.auth;
  }

  /** Confirms plaintext output has been durably saved (idempotent; only the original order placer). */
  async ackOutput(p: { sessionId: string; taskId: string; lastSeq: bigint }): Promise<AckOutputResponse> {
    const bd = ackOutputBodyDigest(p.sessionId, p.taskId, p.lastSeq);
    const env = await this.signEnvelope('AckOutput', p.sessionId, p.taskId, bd);
    return this.client.ackOutput(
      create(AckOutputRequestSchema, {
        sessionId: p.sessionId,
        taskId: p.taskId,
        lastSeq: p.lastSeq,
        requestEnvelope: this.envelopeMsg(env),
      }),
    );
  }


  private async signEnvelope(
    method: string,
    sessionId: string,
    taskId: string,
    bodyDigest: Uint8Array,
  ): Promise<SignedSdkRequestEnvelope> {
    const a = this.requireAuth(method);
    const expiry = a.expiry();
    // Only OpenTask may use a chain-height expiry; everything else is Unix milliseconds.
    if (expiry < HEIGHT_EXPIRY_THRESHOLD) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'SDK_LOCAL_EXPIRY_NOT_TIME',
        `${method} expiry must be Unix milliseconds (>= ${HEIGHT_EXPIRY_THRESHOLD}), got ${expiry}`,
      );
    }
    return signSdkRequestEnvelope(
      { chainId: a.chainId, method, sessionId, taskId, requestNonce: nonce32(a), expiryHeightOrTime: expiry, bodyDigest },
      { signerAddress: a.userAddress, signer: a.wallet, evmChainId: await resolveEvmChainId(a) },
    );
  }

  private envelopeMsg(e: SignedSdkRequestEnvelope) {
    return envelopeMessage(e);
  }
}

/** SDKRequestEnvelopeV2 on the wire. signer_pubkey (deprecated, ignored) is never sent. */
export function envelopeMessage(e: SignedSdkRequestEnvelope) {
  return create(SDKRequestEnvelopeV2Schema, {
    requestDomain: e.requestDomain,
    chainId: e.chainId,
    method: e.method,
    endpoint: e.endpoint,
    sessionId: e.sessionId,
    taskId: e.taskId,
    requestNonce: e.requestNonce,
    expiryHeightOrTime: e.expiryHeightOrTime,
    bodyDigest: e.bodyDigest,
    signerAddress: e.signerAddress,
    signature: e.signature,
  });
}

/** The only value currently accepted for TaskDataRequestAuthV1.schema_version. */
const TASK_DATA_AUTH_SCHEMA_VERSION = 1;

/** TaskDataObjectRefV1: the SDK view uses canonical lowercase hex, and the proto also uses string. */
function toProtoObjectRef(ref: TaskDataObjectRef): ReturnType<typeof create<typeof TaskDataObjectRefV1Schema>> {
  return create(TaskDataObjectRefV1Schema, {
    taskHash: ref.taskHash,
    sessionId: ref.sessionId,
    taskId: ref.taskId,
    objectKind: ref.objectKind,
    contentHash: ref.contentHash,
    evidenceProducerKind: ref.evidenceProducerKind ?? EVIDENCE_PRODUCER_KIND.UNSPECIFIED,
    verifyRound: ref.verifyRound ?? 0,
    ...(ref.producerOperator !== undefined ? { producerOperator: ref.producerOperator } : {}),
    // Sent and signed as the same value: the body digest binds evidence_kind.
    evidenceKind: ref.evidenceKind ?? 0,
  });
}

/**
 * Wraps every method of the generated client so a Connect error surfaces as a typed
 * TrueOpenError (see classifyNexusError): unary and client-streaming calls reject with it, and
 * server streams throw it from `next()`.
 */
function classifyingClient<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        let out: unknown;
        try {
          out = (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (e) {
          throw classifyNexusError(e);
        }
        if (out instanceof Promise) return out.catch((e: unknown) => { throw classifyNexusError(e); });
        if (out !== null && typeof out === 'object' && Symbol.asyncIterator in out) {
          return classifyingIterable(out as AsyncIterable<unknown>);
        }
        return out;
      };
    },
  });
}

async function* classifyingIterable<T>(source: AsyncIterable<T>): AsyncGenerator<T> {
  try {
    yield* source;
  } catch (e) {
    throw classifyNexusError(e);
  }
}
