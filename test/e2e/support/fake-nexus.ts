/**
 * A fake nexus IngressAPI for one Builder: Connect over HTTPS on localhost, with the self-signed
 * test certificate whose SPKI hash the fake chain registers as the Builder's tls_pubkey_hash, so
 * the SDK's pinned transport is exercised as in production.
 *
 * It implements the five RPCs the SDK's user flow calls and verifies every request with the
 * SDK-independent checks in independent.ts: the EIP-712 request envelope and its five-step
 * check order (format, session method set, session grant, request signature, expiry and
 * replay), the body digests, task id derivation and task_hash recomputed from the order, Task
 * Builder selection, the input commitment, and the EIP-712 Task data request auth.
 * Behaviour can be degraded per instance to simulate faults.
 */
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha256';
import { bech32 } from '@scure/base';
import { ConnectError, Code } from '@connectrpc/connect';
import type { ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { create, fromBinary } from '@bufbuild/protobuf';
import {
  IngressAPI,
  TaskDataObjectMetadataV1Schema,
  TaskDataObjectReadinessV1,
} from '../../../src/gen/nexus/v1/ingress_pb.js';
import type {
  OpenTaskRequest,
  SubscribeOutputRequest,
  SubscribeOutputResponse,
  AckOutputRequest,
  GetTaskDataMetadataRequest,
  FetchTaskDataRequest,
  FetchTaskDataResponse,
  TaskDataObjectRefV1,
  TaskDataRequestAuthV1,
} from '../../../src/gen/nexus/v1/ingress_pb.js';
import { SignedOrderV2Schema } from '../../../src/gen/task/v1/msg_assignment_pb.js';
import * as v from './independent';
import type { FakeNode } from './fake-node';
import * as w from './world';

const TLS_DIR = new URL('../../helpers/tls/', import.meta.url);
export const TLS_CERT = readFileSync(new URL('cert.pem', TLS_DIR));
export const TLS_KEY = readFileSync(new URL('key.pem', TLS_DIR));
/** sha256(SPKI) of the test certificate: what the fake chain registers as tls_pubkey_hash. */
export const TLS_PUBKEY_HASH = readFileSync(new URL('pubkey_sha256.txt', TLS_DIR), 'utf8').trim();

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const unhex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));
const MAX_CHUNK_BYTES = 256 * 1024;
/** Request window for height expiries (the Builder's request TTL in blocks). */
const REQUEST_TTL_BLOCKS = 20n;
/** max_session_grant_blocks: off-chain Builder configuration, the same on every Builder. */
export const MAX_SESSION_GRANT_BLOCKS = 400n;

/** One task's OUTPUT as a Worker produced it (see fixtures/output-stream.json). */
export interface OutputStreamFixture {
  readonly chain_id: string;
  readonly session_id: string;
  readonly task_id: string;
  readonly task_hash: string;
  readonly worker_pubkey_hex: string;
  readonly frames: readonly { seq: number; text_b64: string; root_hex: string; sig_hex: string }[];
  readonly fin: { final_seq: number; root_hex: string; finish_reason: number; sig_hex: string };
  readonly chunk_lengths: readonly number[];
  readonly output_b64: string;
  readonly output_hash: string;
  readonly output_size_bytes: number;
  readonly output_leaf_count: number;
}

export function loadStream(file: string): OutputStreamFixture {
  return JSON.parse(readFileSync(new URL(`../fixtures/${file}`, import.meta.url), 'utf8')) as OutputStreamFixture;
}

export type StreamBehaviour =
  /** Every frame, then the signed Fin. */
  | 'full'
  /** All but the last frame, then an unsigned Fin that claims the prefix is complete. */
  | 'truncate-unsigned-fin'
  /** Frames up to and including `seq`, then the connection is cut. */
  | { dropAfterSeq: number }
  /** The Builder does not have the task. */
  | 'not-found';

export interface OpenTaskRecord {
  readonly taskId: string;
  readonly requester: string;
  readonly idempotencyKey: string;
  readonly chunkCount: number;
  readonly payload: Uint8Array;
}

export class FakeNexus {
  url = '';
  private server: Server | undefined;
  stream: StreamBehaviour = 'full';
  /** Flip one byte of every ranged FetchTaskData body. */
  tamperFetch = false;
  /** Largest range a single FetchTaskData may ask for (nexus: task_data.max_range_bytes). */
  maxRangeBytes = 8 << 20;
  /** Errors to answer instead of doing the work, consumed one per call. */
  readonly inject = new Map<string, { code: Code; message: string }[]>();

  readonly opened: OpenTaskRecord[] = [];
  readonly subscribes: { resumeAfterSeq?: bigint }[] = [];
  readonly acks: { lastSeq: bigint; outputId: string }[] = [];
  readonly metadataCalls: number[] = [];
  readonly fetches: { offset: bigint; length: bigint }[] = [];
  /** Every RPC this instance served, including rejected ones. */
  readonly calls: string[] = [];
  /** Each request's independent verification outcome ("ok" or the failure). */
  readonly verifications: { method: string; outcome: string }[] = [];
  /** Who signed each accepted request: the wallet, or a session key (its 0x-less hex). */
  readonly signers: { method: string; sessionKey?: string }[] = [];
  /** task_hash recomputed from each accepted OpenTask order. */
  readonly taskHashes: string[] = [];
  /** How far this Builder's view of the chain is ahead of the node the SDK reads. */
  heightAhead = 0n;
  maxSessionGrantBlocks = MAX_SESSION_GRANT_BLOCKS;
  private readonly nonces = new Set<string>();

  constructor(
    readonly builder: w.Identity,
    private readonly node: FakeNode,
    private readonly outputs: Map<string, OutputStreamFixture>,
  ) {}

  async start(): Promise<this> {
    const handler = connectNodeAdapter({ routes: (router: ConnectRouter) => this.routes(router) });
    this.server = createServer({ cert: TLS_CERT, key: TLS_KEY }, handler);
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `https://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  /** Stops the server: the Builder is down, its descriptor still points here. */
  async close(): Promise<void> {
    const s = this.server;
    if (s === undefined) return;
    this.server = undefined;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private fail(method: string, code: Code, message: string): never {
    this.verifications.push({ method, outcome: message });
    throw new ConnectError(message, code);
  }

  private injected(method: string): void {
    const q = this.inject.get(method);
    const e = q?.shift();
    if (e !== undefined) this.fail(method, e.code, e.message);
  }

  /** Runs an independent check, turning a VerifyError into the error it stands for. */
  private check<T>(method: string, run: () => T): T {
    try {
      return run();
    } catch (e) {
      if (!(e instanceof v.VerifyError)) throw e;
      const c = e.code;
      const code = c.endsWith('_EXPIRED') ? Code.DeadlineExceeded
        : c.endsWith('_METHOD_NOT_ALLOWED') || c === 'DATA_ACCESS_DENIED' || c.endsWith('_UNAUTHORIZED') ? Code.PermissionDenied
        : c.startsWith('SDK_AUTH') || c.startsWith('DATA_ACCESS') ? Code.Unauthenticated
        : c === 'NEXUS_INGRESS_CONTRACT_NOT_FROZEN' ? Code.FailedPrecondition
        : Code.InvalidArgument;
      return this.fail(method, code, e.message);
    }
  }

  /** What this Builder knows: the chain facts, its own height view and its replay records. */
  private ctx(): v.AuthContext {
    return {
      chainId: w.CHAIN_ID,
      evmChainId: w.EVM_CHAIN_ID,
      height: this.node.height + this.heightAhead,
      nowMs: BigInt(Date.now()),
      maxSessionGrantBlocks: this.maxSessionGrantBlocks,
      requestTtlBlocks: REQUEST_TTL_BLOCKS,
      accountPubKey: (address) => this.node.accounts.get(address)?.pubKey,
      seenNonces: this.nonces,
    };
  }

  private accepted(method: string, grant: { sessionKey: Uint8Array } | undefined): void {
    this.verifications.push({ method, outcome: 'ok' });
    this.signers.push(grant === undefined ? { method } : { method, sessionKey: hex(grant.sessionKey) });
  }

  private routes(router: ConnectRouter): void {
    router.service(IngressAPI, {
      openTask: async (reqs: AsyncIterable<OpenTaskRequest>) => this.openTask(reqs),
      confirmOpenTask: () => this.fail('ConfirmOpenTask', Code.FailedPrecondition, 'NEXUS_INGRESS_CONTRACT_NOT_FROZEN: ConfirmOpenTask is not callable in V1'),
      subscribeOutput: (req: SubscribeOutputRequest) => this.subscribeOutput(req),
      ackOutput: async (req: AckOutputRequest) => this.ackOutput(req),
      getTaskDataMetadata: async (req: GetTaskDataMetadataRequest) => this.getTaskDataMetadata(req),
      fetchTaskData: (req: FetchTaskDataRequest) => this.fetchTaskData(req),
    });
  }

  // ------------------------------------------------------------------ OpenTask

  private async openTask(reqs: AsyncIterable<OpenTaskRequest>) {
    const M = 'OpenTask';
    this.calls.push(M);
    const it = reqs[Symbol.asyncIterator]();
    const first = await it.next();
    if (first.done === true || first.value.frame.case !== 'header') this.fail(M, Code.InvalidArgument, 'NEXUS_DATA_MALFORMED: first OpenTask frame must be header');
    const h = first.value.frame.value;
    const chunks: Uint8Array[] = [];
    for (let n = await it.next(); n.done !== true; n = await it.next()) {
      const f = n.value.frame;
      if (f.case !== 'chunk' || f.value.length === 0 || f.value.length > MAX_CHUNK_BYTES) this.fail(M, Code.InvalidArgument, 'NEXUS_DATA_MALFORMED: OpenTask chunk frame');
      chunks.push(f.value);
    }
    this.injected(M);

    // No outer order signature exists: both deprecated fields must be empty.
    if (h.signature.length !== 0 || h.signatureScheme !== '') this.fail(M, Code.InvalidArgument, 'NEXUS_INGRESS_MALFORMED: OpenTask signature and signature_scheme must be empty');
    if (h.sessionId === '' || h.userAddress === '' || h.inputSizeBytes === 0n || h.inputHash === '' || h.inputMediaType === '' ||
      h.orderEnvelope.length === 0) {
      this.fail(M, Code.InvalidArgument, 'NEXUS_INGRESS_MALFORMED: OpenTask header');
    }
    const signed = fromBinary(SignedOrderV2Schema, h.orderEnvelope);
    const order = signed.order;
    if (order === undefined) return this.fail(M, Code.InvalidArgument, 'NEXUS_INGRESS_MALFORMED: order envelope has no order');
    // The order and the header must describe the same task.
    if (order.chainId !== w.CHAIN_ID || order.userAddress !== h.userAddress || hex(order.sessionId) !== h.sessionId ||
      order.orderSequence !== h.orderSequence || hex(order.inputHash) !== h.inputHash || order.inputSizeBytes !== h.inputSizeBytes) {
      this.fail(M, Code.InvalidArgument, 'NEXUS_INGRESS_MALFORMED: order envelope disagrees with the header');
    }
    // payload_ref is not signed, but it must be derived from the signed input_hash.
    if (h.payloadRef !== `nexus://sha256/${h.inputHash}`) this.fail(M, Code.InvalidArgument, 'NEXUS_INGRESS_MALFORMED: OpenTask payload_ref');
    // task_hash is recomputed from the order, never taken from the caller.
    const taskHash = this.check(M, () => v.taskOrderHash(order));
    const env = h.requestEnvelope;
    const taskId = env?.taskId ?? '';
    const requester = this.check(M, () => v.verifySdkRequest(env, {
      method: M, sessionId: h.sessionId, taskId, body: () => v.openTaskBody(h, taskHash), openTaskSequence: h.orderSequence,
    }, this.ctx()));
    if (requester !== h.userAddress) this.fail(M, Code.PermissionDenied, 'SDK_AUTH_INVALID_SIGNATURE: the request signer is not the order user');

    // The order's anchor must be real, and this Builder must be one the order selects.
    const anchor = order.sessionAnchorHeight;
    const set = this.node.builderSetAt(anchor);
    if (hex(order.sessionAnchorBlockHash) !== w.beaconBlockHash(anchor) || set === undefined ||
      hex(order.builderSetHash) !== set.hash || order.builderSetId !== set.id) {
      this.fail(M, Code.FailedPrecondition, 'NEXUS_INGRESS_STAGE1_MISMATCH: order anchor or builder set is not the one in effect at its anchor height');
    }
    if (!selectedBuilders(w.CHAIN_ID, taskId, set!, hex(order.sessionAnchorBlockHash)).includes(this.builder.address)) {
      this.fail(M, Code.NotFound, 'NEXUS_INGRESS_NOT_SELECTED_BUILDER: this Builder is not selected for the task');
    }

    const payload = Buffer.concat(chunks);
    if (BigInt(payload.length) !== h.inputSizeBytes || hex(sha256(payload)) !== h.inputHash) {
      this.fail(M, Code.DataLoss, 'NEXUS_DATA_HASH_MISMATCH: OpenTask input does not match its commitment');
    }
    this.accepted(M, undefined);
    this.taskHashes.push(hex(taskHash));
    this.opened.push({ taskId, requester, idempotencyKey: h.idempotencyKey, chunkCount: chunks.length, payload: Uint8Array.from(payload) });
    return {
      sessionId: h.sessionId,
      taskId,
      accepted: true,
      reason: '',
      inputMetadata: create(TaskDataObjectMetadataV1Schema, {
        sizeBytes: h.inputSizeBytes,
        mediaType: h.inputMediaType,
        readiness: TaskDataObjectReadinessV1.READY,
      }),
    };
  }

  // ------------------------------------------------------------------ output stream

  private owner(sessionId: string): string | undefined {
    return this.node.sessions.get(sessionId)?.owner;
  }

  private async *subscribeOutput(req: SubscribeOutputRequest): AsyncGenerator<SubscribeOutputResponse> {
    const M = 'SubscribeOutput';
    this.calls.push(M);
    this.subscribes.push(req.resumeAfterSeq !== undefined ? { resumeAfterSeq: req.resumeAfterSeq } : {});
    const requester = this.check(M, () => v.verifySdkRequest(req.requestEnvelope, {
      method: M, sessionId: req.sessionId, taskId: req.taskId,
      body: () => v.subscribeOutputBody(req.sessionId, req.taskId, req.resumeAfterSeq),
    }, this.ctx()));
    this.injected(M);
    if (requester !== this.owner(req.sessionId)) this.fail(M, Code.PermissionDenied, 'NEXUS_OUTPUT_UNAUTHORIZED: only the task owner may subscribe');
    const out = this.outputs.get(req.taskId);
    if (out === undefined || this.stream === 'not-found') this.fail(M, Code.NotFound, 'task not found');
    this.accepted(M, req.requestEnvelope?.sessionGrant);

    const after = req.resumeAfterSeq;
    const chunk = (f: OutputStreamFixture['frames'][number]): SubscribeOutputResponse => ({
      frame: { case: 'chunk', value: { seq: BigInt(f.seq), text: Buffer.from(f.text_b64, 'base64'), mmrRoot: unhex(f.root_hex), workerSignature: unhex(f.sig_hex) } },
    }) as unknown as SubscribeOutputResponse;
    const frames = out!.frames.filter((f) => after === undefined || BigInt(f.seq) > after);
    if (this.stream === 'truncate-unsigned-fin') {
      const kept = out!.frames.slice(0, -1);
      for (const f of kept.filter((f) => after === undefined || BigInt(f.seq) > after)) yield chunk(f);
      const last = kept[kept.length - 1]!;
      yield { frame: { case: 'fin', value: { finalSeq: BigInt(last.seq), outputMmrRoot: unhex(last.root_hex), finishReason: 0, workerSignature: new Uint8Array() } } } as unknown as SubscribeOutputResponse;
      return;
    }
    if (typeof this.stream === 'object') {
      const cut = this.stream.dropAfterSeq;
      for (const f of frames.filter((f) => f.seq <= cut)) yield chunk(f);
      throw new ConnectError('NEXUS_DATA_STREAM_INTERRUPTED: upstream Worker connection lost', Code.Unavailable);
    }
    for (const f of frames) yield chunk(f);
    const fin = out!.fin;
    yield { frame: { case: 'fin', value: { finalSeq: BigInt(fin.final_seq), outputMmrRoot: unhex(fin.root_hex), finishReason: fin.finish_reason, workerSignature: unhex(fin.sig_hex) } } } as unknown as SubscribeOutputResponse;
  }

  private ackOutput(req: AckOutputRequest) {
    const M = 'AckOutput';
    this.calls.push(M);
    // last_seq is in the body; the deprecated output_id is not.
    const requester = this.check(M, () => v.verifySdkRequest(req.requestEnvelope, {
      method: M, sessionId: req.sessionId, taskId: req.taskId,
      body: () => v.ackOutputBody(req.sessionId, req.taskId, req.lastSeq),
    }, this.ctx()));
    this.injected(M);
    if (requester !== this.owner(req.sessionId)) this.fail(M, Code.PermissionDenied, 'NEXUS_OUTPUT_UNAUTHORIZED: only the task owner may ack');
    this.accepted(M, req.requestEnvelope?.sessionGrant);
    this.acks.push({ lastSeq: req.lastSeq, outputId: req.outputId });
    return { acked: true, alreadyAcked: false, ackedAt: BigInt(Date.now()) };
  }

  // ------------------------------------------------------------------ task data plane

  private refOf(ref: TaskDataObjectRefV1 | undefined): v.ObjectRefLike {
    if (ref === undefined) throw new v.VerifyError('NEXUS_INGRESS_MALFORMED', 'object_ref required');
    return {
      taskHash: ref.taskHash, sessionId: ref.sessionId, taskId: ref.taskId, objectKind: ref.objectKind,
      contentHash: ref.contentHash, evidenceProducerKind: ref.evidenceProducerKind, verifyRound: ref.verifyRound,
      producerOperator: ref.producerOperator ?? '', evidenceKind: ref.evidenceKind,
    };
  }

  /** Authorizes a USER read of an OUTPUT object and returns the stored output it names. */
  private authorizeRead(M: string, rpcMethod: string, refPb: TaskDataObjectRefV1 | undefined, body: (ref: v.ObjectRefLike) => Uint8Array, auth: TaskDataRequestAuthV1 | undefined): OutputStreamFixture {
    const ref = this.check(M, () => this.refOf(refPb));
    const requester = this.check(M, () => v.verifyUserTaskDataAuth(auth, {
      builder: this.builder.address, rpcMethod, body: body(ref), objectKind: ref.objectKind, requestTtlBlocks: REQUEST_TTL_BLOCKS,
    }, this.ctx()));
    this.injected(M);
    // A user may read only the OUTPUT of their own task.
    if (ref.objectKind !== 2 || requester !== this.owner(ref.sessionId)) this.fail(M, Code.PermissionDenied, 'DATA_ACCESS_DENIED: user may read only their own OUTPUT');
    const out = this.outputs.get(ref.taskId);
    if (out === undefined || out.task_hash !== ref.taskHash || out.output_hash !== ref.contentHash || out.session_id !== ref.sessionId) {
      this.fail(M, Code.NotFound, 'NEXUS_DATA_NOT_FOUND: no such OUTPUT object');
    }
    this.signers.push(auth?.sessionGrant === undefined ? { method: M } : { method: M, sessionKey: hex(auth.sessionGrant.sessionKey) });
    return out!;
  }

  private getTaskDataMetadata(req: GetTaskDataMetadataRequest) {
    const M = 'GetTaskDataMetadata';
    this.calls.push(M);
    const out = this.authorizeRead(M, '/nexus.v1.IngressAPI/GetTaskDataMetadata', req.objectRef, (r) => v.metadataBodyDigest(r), req.requestAuth);
    this.verifications.push({ method: M, outcome: 'ok' });
    this.metadataCalls.push(1);
    return {
      metadata: create(TaskDataObjectMetadataV1Schema, {
        ...(req.objectRef !== undefined ? { objectRef: req.objectRef } : {}),
        sizeBytes: BigInt(out.output_size_bytes),
        mediaType: 'text/plain; charset=utf-8',
        readiness: TaskDataObjectReadinessV1.READY,
        chunkLengths: [...out.chunk_lengths],
        outputLeafCount: BigInt(out.output_leaf_count),
      }),
      retainUntilHeight: this.node.height + 1000n,
    };
  }

  private async *fetchTaskData(req: FetchTaskDataRequest): AsyncGenerator<FetchTaskDataResponse> {
    const M = 'FetchTaskData';
    this.calls.push(M);
    const range = req.range !== undefined ? { offset: req.range.offset, length: req.range.length } : undefined;
    const out = this.authorizeRead(M, '/nexus.v1.IngressAPI/FetchTaskData', req.objectRef, (r) => v.fetchBodyDigest(r, range), req.requestAuth);
    const bytes = Buffer.from(out.output_b64, 'base64');
    const total = BigInt(bytes.length);
    const served = range ?? { offset: 0n, length: total };
    if (served.length === 0n || served.offset + served.length > total || served.length > BigInt(this.maxRangeBytes)) {
      this.fail(M, Code.OutOfRange, 'NEXUS_DATA_RANGE_INVALID: range outside the object or above the max range');
    }
    this.verifications.push({ method: M, outcome: 'ok' });
    this.fetches.push(served);
    yield { frame: { case: 'header', value: { ...(req.objectRef !== undefined ? { objectRef: req.objectRef } : {}), totalSizeBytes: total, mediaType: 'text/plain; charset=utf-8', servedRange: { offset: served.offset, length: served.length } } } } as unknown as FetchTaskDataResponse;
    const body = Uint8Array.from(bytes.subarray(Number(served.offset), Number(served.offset + served.length)));
    if (this.tamperFetch) body[0] = body[0]! ^ 0x01;
    // Split the served range into small data frames, as nexus does at its chunk size.
    const FRAME = 7;
    for (let off = 0; off < body.length; off += FRAME) {
      const end = Math.min(off + FRAME, body.length);
      yield { frame: { case: 'chunk', value: { offset: served.offset + BigInt(off), data: body.subarray(off, end), eof: end === body.length } } } as unknown as FetchTaskDataResponse;
    }
  }
}

/**
 * Task Builder selection, re-derived from node's rules: seed = H_FIELDS_V1(TASK_BUILDERS_V1,
 * chain_id, task_id, builder_set_hash, anchor_block_hash); rank = H_FIELDS_V1(TASK_BUILDER_RANK_V1,
 * seed, address bytes); lowest three ranks win, ties broken by address bytes.
 */
export function selectedBuilders(chainId: string, taskId: string, set: w.BuilderSetFact, anchorBlockHash: string, perTask = 3): string[] {
  const seed = v.hFields('TRUEOPEN_TASK_BUILDERS_V1', new TextEncoder().encode(chainId), unhex(taskId), unhex(set.hash), unhex(anchorBlockHash));
  const ranked = set.members.map((address) => {
    const bytes = Uint8Array.from(bech32.fromWords(bech32.decode(address as `${string}1${string}`).words));
    return { address, bytes, rank: hex(v.hFields('TRUEOPEN_TASK_BUILDER_RANK_V1', seed, bytes)) };
  });
  ranked.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : Buffer.compare(a.bytes, b.bytes)));
  return ranked.slice(0, perTask).map((r) => r.address);
}
