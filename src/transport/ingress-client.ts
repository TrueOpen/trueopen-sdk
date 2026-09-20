import { createClient } from '@connectrpc/connect';
import type { Client, Transport } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import {
  IngressAPI,
  OpenTaskHeaderSchema,
  OpenTaskRequestSchema,
  SubmitOrderRequestSchema,
  SDKRequestEnvelopeV1Schema,
  GetTaskStatusRequestSchema,
  FetchOutputRefRequestSchema,
  RefreshCredentialRequestSchema,
  PrepareChallengeRequestSchema,
  GetTaskEventsRequestSchema,
  SubscribeOutputRequestSchema,
  AckOutputRequestSchema,
  GetTaskDataMetadataRequestSchema,
  FetchTaskDataRequestSchema,
  TaskDataRequestAuthV1Schema,
  TaskDataObjectRefV1Schema,
  ByteRangeV1Schema,
  AccessLevel,
} from '../gen/nexus/v1/ingress_pb.js';
import type {
  OpenTaskRequest,
  TaskDataObjectMetadataV1,
  CredentialV1,
  FetchOutputRefResponse,
  RefreshCredentialResponse,
  PrepareChallengeResponse,
  GetTaskEventsResponse,
  SubscribeOutputResponse,
  AckOutputResponse,
} from '../gen/nexus/v1/ingress_pb.js';
import { TrueOpenError } from '../errors/errors';
import type { CosmosSecp256k1Signer } from '../signer/secp256k1';
import type { Eip712Signer } from '../signer/eth-secp256k1';
import { sha256 } from '../codec/hash';
import {
  signSdkRequestEnvelope,
  fetchOutputRefBodyDigest,
  getTaskEventsBodyDigest,
  refreshCredentialBodyDigest,
  prepareChallengeBodyDigest,
  subscribeOutputBodyDigest,
  ackOutputBodyDigest,
} from './sdk-request-envelope';
import type { AccessLevelName, SignedSdkRequestEnvelope } from './sdk-request-envelope';
import {
  taskDataRequestEip712Digest,
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
  /** Protobuf bytes of the frozen SignedOrderV1. */
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
  /** Required by contract Section 3.1: must stay the same across retries. */
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

/**
 * SubmitOrder request (kept for raw RPC access).
 * @deprecated The contract has moved the order-placement entry point to OpenTask; SubmitOrder
 * is also marked deprecated in the nexus proto. Note that order_envelope must now be the
 * frozen SignedOrderV1 protobuf bytes -- the old canonical JSON envelope can't produce a
 * canonical task_hash and can never be broadcast on chain
 * (nexus internal/coordinator/taskfsm.go:151). New code should use openTask().
 */
export interface SubmitOrderRequest {
  readonly orderEnvelope: Uint8Array;
  readonly payloadRef: string;
  readonly signature: Uint8Array;
  readonly requestEnvelope: SignedSdkRequestEnvelope;
  readonly sessionId: string;
  readonly orderSequence: bigint;
  readonly userAddress: string;
  readonly signatureScheme: string;
  readonly payload: Uint8Array;
}

/** SubmitOrder's local accept response (not the on-chain accepted status; see implementation design Section 2.5). */
export interface SubmitOrderAck {
  readonly taskId: string;
  readonly accepted: boolean;
  readonly reason: string;
  readonly sessionId: string;
}

/** Snapshot of nexus's local FSM (GetTaskStatus). The on-chain state is still authoritative via chain query. */
export interface TaskStatusView {
  readonly state: string;
  readonly stage: string;
  readonly setId: string;
  readonly taskPhase: string;
  readonly updatedAt: bigint;
}

/** Signing context: methods that need an SDKRequestEnvelope (all except GetTaskStatus) sign internally with this. */
export interface IngressAuth {
  readonly chainId: string;
  readonly userAddress: string;
  readonly signerPubKey: Uint8Array;
  readonly signer: CosmosSecp256k1Signer;
  readonly nonce: () => Uint8Array;
  readonly expiry: () => bigint;
  /**
   * EIP-712 signer for the task data plane (USER branch), producing a 65-byte R||S||V
   * signature. Not interchangeable with `signer`: that one produces a 64-byte Cosmos
   * signature over a sha256 digest.
   */
  readonly eip712Signer?: Eip712Signer;
  /** The numeric EVM chain ID used in the EIP-712 domain; distinct from the cosmos chainId string. */
  readonly evmChainId?: bigint | number | string;
}

/**
 * nexus IngressAPI client (Connect RPC, generated from ingress.proto).
 * The transport is injected by the caller; auth is optional, and methods that need a
 * signature throw if it's absent. SubmitOrder takes a pre-assembled request
 * (buildSubmitOrderRequest, which carries both the order signature and the request signature).
 */
export class IngressClient {
  private readonly client: Client<typeof IngressAPI>;
  private readonly auth?: IngressAuth;

  constructor(transport: Transport, auth?: IngressAuth) {
    this.client = createClient(IngressAPI, transport);
    if (auth) this.auth = auth;
  }

  get raw(): Client<typeof IngressAPI> {
    return this.client;
  }

  async submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderAck> {
    const msg = create(SubmitOrderRequestSchema, {
      orderEnvelope: req.orderEnvelope,
      payloadRef: req.payloadRef,
      signature: req.signature,
      requestEnvelope: this.envelopeMsg(req.requestEnvelope),
      sessionId: req.sessionId,
      orderSequence: req.orderSequence,
      userAddress: req.userAddress,
      signatureScheme: req.signatureScheme,
      payload: req.payload,
    });
    const res = await this.client.submitOrder(msg);
    return { taskId: res.taskId, accepted: res.accepted, reason: res.reason, sessionId: res.sessionId };
  }

  /**
   * OpenTask (contract Section 3.1, the target-state order-placement entry point):
   * client-streaming, sends 1 header frame followed by N chunk frames (N >= 1, each chunk
   * non-empty and within the server's chunk size cap, 256 KiB by default -- see nexus
   * internal/config chunk_size_bytes).
   *
   * Key differences from the deprecated SubmitOrder:
   *  - order_envelope must be the frozen SignedOrderV1 protobuf bytes (no longer canonical JSON);
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

  /** Snapshot of nexus's local FSM (no application-level signature required, v1.5 Section 4.1). */
  async getTaskStatus(sessionId: string, taskId: string): Promise<TaskStatusView> {
    const res = await this.client.getTaskStatus(create(GetTaskStatusRequestSchema, { sessionId, taskId }));
    return { state: res.state, stage: res.stage, setId: res.setId, taskPhase: res.taskPhase, updatedAt: res.updatedAt };
  }

  /**
   * Fetches a retrieval credential (SDK envelope path; the Verifier-role signing path is not
   * wrapped here).
   * @deprecated Contract Sections 3.3/3.4 replace the retrieval-credential flow with
   * GetTaskDataMetadata + FetchTaskData: "on-chain role implies authorization", so V1 no
   * longer issues separate retrieval credentials. Kept until the team decides on a removal
   * date (mapping table Section 5.2).
   */
  async fetchOutputRef(p: {
    sessionId: string;
    taskId: string;
    requester: string;
    accessLevel: AccessLevelName;
    usage: string;
  }): Promise<FetchOutputRefResponse> {
    const bd = fetchOutputRefBodyDigest(p.sessionId, p.taskId, p.requester, p.accessLevel, p.usage);
    const env = await this.signEnvelope('FetchOutputRef', p.sessionId, p.taskId, bd);
    return this.client.fetchOutputRef(
      create(FetchOutputRefRequestSchema, {
        taskId: p.taskId,
        requester: p.requester,
        sessionId: p.sessionId,
        accessLevel: p.accessLevel === 'SEALED_KEY' ? AccessLevel.SEALED_KEY : AccessLevel.PACKAGE_UNSPECIFIED,
        usage: p.usage,
        requestEnvelope: this.envelopeMsg(env),
      }),
    );
  }

  /**
   * Refreshes a retrieval credential (exchanges the original credential, held by the escrow,
   * for a new one).
   * @deprecated There's no corresponding method in the contract: the CredentialV1 flow is
   * entirely replaced by Sections 3.3/3.4, and V1 doesn't refresh separate download
   * credentials (mapping table Section 5.3). Kept until the team decides on a removal date.
   */
  async refreshCredential(p: {
    credential: CredentialV1;
    sessionId: string;
    taskId: string;
    recipient: string;
    usage: string;
    requestedValidUntil: bigint;
  }): Promise<RefreshCredentialResponse> {
    const bd = refreshCredentialBodyDigest(
      p.credential.credentialId,
      p.sessionId,
      p.taskId,
      p.recipient,
      p.usage,
      p.requestedValidUntil,
    );
    const env = await this.signEnvelope('RefreshCredential', p.sessionId, p.taskId, bd);
    return this.client.refreshCredential(
      create(RefreshCredentialRequestSchema, {
        credential: p.credential,
        sessionId: p.sessionId,
        taskId: p.taskId,
        recipient: p.recipient,
        usage: p.usage,
        requestedValidUntil: p.requestedValidUntil,
        requestEnvelope: this.envelopeMsg(env),
      }),
    );
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
   * Subscribes to chunked output (interface list Section 4.7, server streaming). Forwards
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
     * preventing the process from exiting (observed in nexus#102).
     */
    signal?: AbortSignal;
  }): AsyncIterable<SubscribeOutputResponse> {
    const bd = subscribeOutputBodyDigest(p.sessionId, p.taskId);
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
   * Fetches task data metadata (contract Section 3.3). Unlike the other methods, this one
   * doesn't take an SDKRequestEnvelope -- it takes a TaskDataRequestAuthV1 instead, domain
   * TRUEOPEN_TASK_DATA_REQUEST_V1, signing bytes defined in task-data-signbytes.ts. nexus
   * hashes with sha256 before verifying, so use an auth.signer that hashes first.
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
   * Streams the task data body (contract Section 3.6). The response is a frame oneof: one
   * FetchTaskDataHeaderV1 first (echoing the actual returned range and media type), then
   * some number of FetchTaskDataChunkV1 frames, until eof.
   *
   * An unset range means read the whole object -- **don't** rewrite this as an explicit
   * offset=0/length=size form, since the two produce different body digests and the
   * signature won't verify.
   *
   * Callers are responsible for validating the content after fetching (post ADR-0017 this
   * means re-chunking by chunk_lengths and computing the MMR root, no longer a whole-object
   * sha256) -- this method only fetches the bytes.
   */
  async fetchTaskData(p: {
    objectRef: TaskDataObjectRef;
    builderAddress: string;
    expiresAtHeight: bigint;
    range?: ByteRange;
  }): Promise<Uint8Array> {
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

    const chunks: Uint8Array[] = [];
    let total = 0;
    let sawHeader = false;
    for await (const msg of stream) {
      const frame = msg.frame;
      if (frame.case === 'header') {
        sawHeader = true;
        continue;
      }
      if (frame.case !== 'chunk') continue;
      // The contract requires the header to arrive before any chunk; if the order is
      // reversed, the peer is violating the contract, so don't silently accept it.
      if (!sawHeader) {
        throw new TrueOpenError(
          'NEXUS_INGRESS',
          'NEXUS_FETCH_TASK_DATA_NO_HEADER',
          'FetchTaskData sent a chunk before its header',
        );
      }
      const data = frame.value.data;
      if (data.length > 0) {
        chunks.push(data);
        total += data.length;
      }
      if (frame.value.eof) break;
    }
    if (!sawHeader) {
      throw new TrueOpenError(
        'NEXUS_INGRESS',
        'NEXUS_FETCH_TASK_DATA_EMPTY',
        'FetchTaskData stream ended without a header frame',
      );
    }

    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  /**
   * Assembles and signs the USER branch of TaskDataRequestAuthV1.
   *
   * The contract is explicit that "signature length is not sniffed, and the caller's public
   * key is not trusted": requester_kind alone determines the verification path, and USER
   * always means EIP-712 plus a 65-byte signature, with service_authorization_nonce fixed
   * at 0. So there is no fallback to `signer` here -- if eip712Signer isn't configured, this
   * throws immediately rather than producing a 64-byte signature that would be silently
   * rejected.
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
    if (auth.eip712Signer === undefined || auth.evmChainId === undefined) {
      throw new TrueOpenError(
        'SDK_AUTH',
        'SDK_AUTH_NO_EIP712_SIGNER',
        'the USER branch of the task data plane requires IngressAuth.eip712Signer and evmChainId (EIP-712, 65-byte signature)',
      );
    }
    const fields = {
      schemaVersion: TASK_DATA_AUTH_SCHEMA_VERSION,
      chainId: auth.chainId,
      builderOperatorAddress: p.builderAddress,
      rpcMethod: p.rpcMethod,
      bodyDigest: p.bodyDigest,
      requesterKind: TASK_DATA_REQUESTER_KIND.USER,
      requesterAddress: auth.userAddress,
      serviceAuthorizationNonce: 0n,
      requestNonce: requestNonce32(auth.nonce()),
      expiryHeight: p.expiresAtHeight,
    };
    const signature = await auth.eip712Signer(taskDataRequestEip712Digest(fields, auth.evmChainId));
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
    const bd = ackOutputBodyDigest(p.sessionId, p.taskId);
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
    if (!this.auth) {
      throw new TrueOpenError('SDK_AUTH', 'SDK_AUTH_NO_SIGNER', `${method} requires IngressClient auth context`);
    }
    const a = this.auth;
    return signSdkRequestEnvelope(
      {
        chainId: a.chainId,
        method,
        endpoint: `/nexus.v1.IngressAPI/${method}`,
        sessionId,
        taskId,
        requestNonce: a.nonce(),
        expiryHeightOrTime: a.expiry(),
        bodyDigest,
      },
      a.userAddress,
      a.signerPubKey,
      a.signer,
    );
  }

  private envelopeMsg(e: SignedSdkRequestEnvelope) {
    return create(SDKRequestEnvelopeV1Schema, {
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
      signerPubkey: e.signerPubKey,
    });
  }
}

/** The only value currently accepted for TaskDataRequestAuthV1.schema_version. */
const TASK_DATA_AUTH_SCHEMA_VERSION = 1;

/**
 * request_nonce must be **exactly 32 bytes** as of v0.4.1 (v0.1.2 only required >= 16).
 * IngressAuth.nonce() is a generic nonce source whose length isn't guaranteed to comply,
 * so this normalizes it to 32 bytes: if it's shorter, pad it out with sha256 (preserving
 * entropy rather than truncating); if it's longer, also collapse it with sha256.
 */
function requestNonce32(nonce: Uint8Array): Uint8Array {
  return nonce.length === 32 ? nonce : sha256(nonce);
}

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
  });
}

/** nexus only accepts a 64-byte R||S; the signer may return 65 bytes (with a recovery id). */
async function sig64(signer: CosmosSecp256k1Signer, bytes: Uint8Array): Promise<Uint8Array> {
  const full = await signer(bytes);
  const sig = full.length === 65 ? full.subarray(0, 64) : full;
  if (sig.length !== 64) {
    throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_BAD_SIGNATURE_LEN', `signature must be 64 bytes R||S, got ${sig.length}`);
  }
  return sig;
}
