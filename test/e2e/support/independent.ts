/**
 * SDK-independent re-implementations of what a Task Builder (Ingress) and node check.
 *
 * Nothing here imports SDK code: the fakes use these to verify what the SDK sends, so an SDK bug
 * cannot hide behind the same bug on the verifying side. The request authentication follows the
 * public wire contract (proto/nexus/v1/ingress.proto comments on SDKRequestEnvelopeV2,
 * SessionGrantV1 and TaskDataRequestAuthV1, registry/v1/domains.json and the
 * testdata/v1 vectors), written from those texts rather than from the SDK: the EIP-712 type
 * strings are the literal encodeType lines of the contract, and hashStruct is spelled out per
 * struct. node's ante handler check for ethsecp256k1 DIRECT signatures is kept as before.
 */
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bech32 } from '@scure/base';
import { TxRaw, AuthInfo, SignDoc } from 'cosmjs-types/cosmos/tx/v1beta1/tx';

const enc = new TextEncoder();
const utf8 = (s: string): Uint8Array => enc.encode(s);
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const unhex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));

/** A check failed; `code` is the error code the real service would answer with. */
export class VerifyError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function u32be(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v);
  return b;
}
function i32be(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v);
  return b;
}
export function u64be(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v);
  return b;
}

/** FRAME_V1 list: fields with an 8-byte big-endian length prefix. */
export function frame8(...fields: Uint8Array[]): Uint8Array {
  return concat(fields.flatMap((f) => [u64be(BigInt(f.length)), f]));
}
/** H_FIELDS_V1(domain, fields...) = SHA256(FRAME_V1(domain, fields...)). */
export function hFields(domain: string, ...fields: Uint8Array[]): Uint8Array {
  return sha256(frame8(utf8(domain), ...fields));
}
/** OPTIONAL_V1: 00 absent, 01 || FRAME_V1(value) present. */
function optional(value: Uint8Array | undefined): Uint8Array {
  return value === undefined ? new Uint8Array([0]) : concat([new Uint8Array([1]), frame8(value)]);
}
function raw32(field: string, value: string, code = 'NEXUS_INGRESS_MALFORMED'): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new VerifyError(code, `${field} is not 64-character lowercase hex`);
  return unhex(value);
}
/** The chain's account prefix: every account address the contract signs uses it. */
export const ACCOUNT_PREFIX = 'trueopen';

/** The 20 address bytes of a canonical lowercase Bech32 account address with the account prefix. */
export function addressBytes(field: string, address: string, code = 'NEXUS_INGRESS_MALFORMED'): Uint8Array {
  try {
    const d = bech32.decode(address as `${string}1${string}`);
    const raw = Uint8Array.from(bech32.fromWords(d.words));
    if (d.prefix !== ACCOUNT_PREFIX || bech32.encode(d.prefix, bech32.toWords(raw)) !== address || raw.length !== 20) throw new Error('not canonical');
    return raw;
  } catch {
    throw new VerifyError(code, `${field} is not a canonical ${ACCOUNT_PREFIX} account address`);
  }
}

/** signer.AddressFromPubKey: bech32(prefix, keccak256(uncompressed XY)[12:]). */
export function addressFromPubKey(prefix: string, pubCompressed: Uint8Array): string {
  const xy = secp256k1.ProjectivePoint.fromHex(pubCompressed).toRawBytes(false).subarray(1);
  return bech32.encode(prefix, bech32.toWords(keccak_256(xy).subarray(12)));
}

/** Direct-digest verification (Worker frames): 64-byte low-S R||S over the digest itself. */
export function verifyDigestSig(pubCompressed: Uint8Array, digest: Uint8Array, sig: Uint8Array): boolean {
  if (sig.length !== 64) return false;
  try {
    return secp256k1.verify(sig, digest, pubCompressed, { lowS: true, prehash: false });
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ EIP-712

const keccakText = (s: string): Uint8Array => keccak_256(utf8(s));
/** A uint word: 32 bytes big-endian. */
function word(v: bigint): Uint8Array {
  const b = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}
function addressWord(a20: Uint8Array): Uint8Array {
  const b = new Uint8Array(32);
  b.set(a20, 12);
  return b;
}

/** domain_separator = hashStruct(EIP712Domain(string name,string version,uint256 chainId)). */
export function domainSeparator(name: string, version: string, evmChainId: bigint): Uint8Array {
  return keccak_256(concat([
    keccakText('EIP712Domain(string name,string version,uint256 chainId)'),
    keccakText(name),
    keccakText(version),
    word(evmChainId),
  ]));
}
function signingDigest(domain: Uint8Array, struct: Uint8Array): Uint8Array {
  return keccak_256(concat([new Uint8Array([0x19, 0x01]), domain, struct]));
}

export const SDK_REQUEST_DOMAIN_NAME = 'TrueOpen SDK Request';

/** The typed SDKRequest fields, already projected. */
export interface SdkRequestTyped {
  readonly chainId: string;
  readonly method: string;
  readonly endpoint: string;
  readonly sessionId: Uint8Array;
  readonly taskId: Uint8Array;
  readonly requestNonce: Uint8Array;
  readonly expiryHeightOrTime: bigint;
  readonly bodyDigest: Uint8Array;
  readonly sessionGrantHash: Uint8Array;
}

export function sdkRequestDigest(m: SdkRequestTyped, evmChainId: bigint): Uint8Array {
  const struct = keccak_256(concat([
    keccakText(
      'SDKRequest(string chainId,string method,string endpoint,bytes32 sessionId,bytes32 taskId,' +
        'bytes32 requestNonce,uint64 expiryHeightOrTime,bytes32 bodyDigest,bytes32 sessionGrantHash)',
    ),
    keccakText(m.chainId),
    keccakText(m.method),
    keccakText(m.endpoint),
    m.sessionId,
    m.taskId,
    m.requestNonce,
    word(m.expiryHeightOrTime),
    m.bodyDigest,
    m.sessionGrantHash,
  ]));
  return signingDigest(domainSeparator(SDK_REQUEST_DOMAIN_NAME, '1', evmChainId), struct);
}

/** nexus.v1.SessionGrantV1 as the fakes see it. */
export interface GrantLike {
  readonly chainId: string;
  readonly user: string;
  readonly sessionKey: Uint8Array;
  readonly expiryHeight: bigint;
  readonly grantNonce: Uint8Array;
  readonly userSignature: Uint8Array;
}

/** hashStruct(SessionGrant(string chainId,string user,address sessionKey,uint64 expiryHeight,bytes32 grantNonce)). */
export function sessionGrantHashStruct(g: GrantLike): Uint8Array {
  return keccak_256(concat([
    keccakText('SessionGrant(string chainId,string user,address sessionKey,uint64 expiryHeight,bytes32 grantNonce)'),
    keccakText(g.chainId),
    keccakText(g.user),
    addressWord(g.sessionKey),
    word(g.expiryHeight),
    g.grantNonce,
  ]));
}

/** A grant is always signed under the SDK Request domain. */
export function sessionGrantDigest(g: GrantLike, evmChainId: bigint): Uint8Array {
  return signingDigest(domainSeparator(SDK_REQUEST_DOMAIN_NAME, '1', evmChainId), sessionGrantHashStruct(g));
}

/**
 * Recovers a 65-byte R||S||V signature (V 27/28, low S) over a digest; undefined for any other
 * shape or a signature that recovers to nothing.
 */
export function recover65(digest: Uint8Array, sig: Uint8Array): { address20: Uint8Array; pub: Uint8Array } | undefined {
  if (sig.length !== 65) return undefined;
  const v = sig[64]!;
  if (v !== 27 && v !== 28) return undefined;
  try {
    const s = secp256k1.Signature.fromCompact(sig.subarray(0, 64));
    if (s.hasHighS()) return undefined;
    const point = s.addRecoveryBit(v - 27).recoverPublicKey(digest);
    return { address20: keccak_256(point.toRawBytes(false).subarray(1)).subarray(12), pub: point.toRawBytes(true) };
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ request bodies

export const BODY = {
  OpenTask: 'TRUEOPEN_SDK_BODY_OPEN_TASK_V1',
  SubscribeOutput: 'TRUEOPEN_SDK_BODY_SUBSCRIBE_OUTPUT_V1',
  AckOutput: 'TRUEOPEN_SDK_BODY_ACK_OUTPUT_V1',
  GetTaskEvents: 'TRUEOPEN_SDK_BODY_GET_TASK_EVENTS_V1',
  PrepareChallenge: 'TRUEOPEN_SDK_BODY_PREPARE_CHALLENGE_V1',
} as const;

export interface OpenTaskHeaderLike {
  readonly payloadRef: string;
  readonly signature: Uint8Array;
  readonly signatureScheme: string;
  readonly sessionId: string;
  readonly orderSequence: bigint;
  readonly userAddress: string;
  readonly inputSizeBytes: bigint;
  readonly inputHash: string;
  readonly inputMediaType: string;
  readonly idempotencyKey: string;
}

/** TRUEOPEN_SDK_BODY_OPEN_TASK_V1, with task_hash recomputed from the order. */
export function openTaskBody(h: OpenTaskHeaderLike, taskHash: Uint8Array): Uint8Array {
  return hFields(
    BODY.OpenTask,
    taskHash,
    raw32('session_id', h.sessionId),
    u64be(h.orderSequence),
    addressBytes('user_address', h.userAddress),
    u64be(h.inputSizeBytes),
    raw32('input_hash', h.inputHash),
    utf8(h.inputMediaType),
    utf8(h.idempotencyKey),
  );
}
export function subscribeOutputBody(sessionId: string, taskId: string, resumeAfterSeq: bigint | undefined): Uint8Array {
  return hFields(BODY.SubscribeOutput, raw32('session_id', sessionId), raw32('task_id', taskId), optional(resumeAfterSeq === undefined ? undefined : u64be(resumeAfterSeq)));
}
export function ackOutputBody(sessionId: string, taskId: string, lastSeq: bigint): Uint8Array {
  return hFields(BODY.AckOutput, raw32('session_id', sessionId), raw32('task_id', taskId), u64be(lastSeq));
}
export function getTaskEventsBody(sessionId: string, taskId: string, fromCursor: string): Uint8Array {
  let cursor: Uint8Array | undefined;
  if (fromCursor !== '') {
    if (!/^(0|[1-9][0-9]*)$/.test(fromCursor) || BigInt(fromCursor) >= 1n << 64n) {
      throw new VerifyError('NEXUS_INGRESS_MALFORMED', 'from_cursor is not canonical uint64 decimal');
    }
    cursor = u64be(BigInt(fromCursor));
  }
  return hFields(BODY.GetTaskEvents, raw32('session_id', sessionId), raw32('task_id', taskId), optional(cursor));
}
export function prepareChallengeBody(sessionId: string, taskId: string, kind: string, localEvidence: Uint8Array): Uint8Array {
  if (localEvidence.length !== 0 && localEvidence.length !== 32) {
    throw new VerifyError('NEXUS_INGRESS_MALFORMED', 'local_evidence_digest must be empty or 32 bytes');
  }
  return hFields(BODY.PrepareChallenge, raw32('session_id', sessionId), raw32('task_id', taskId), utf8(kind), optional(localEvidence.length === 0 ? undefined : localEvidence));
}

/** TRUEOPEN_TASK_ID_V1(raw32(session_id), u64be(order_sequence)). */
export function deriveTaskId(sessionId: string, seq: bigint): string {
  return hex(hFields('TRUEOPEN_TASK_ID_V1', raw32('session_id', sessionId), u64be(seq)));
}

/** task.v1.TaskOrderV3 as decoded from the SignedOrderV2 protobuf. */
export interface TaskOrderLike {
  readonly schemaVersion: number;
  readonly chainId: string;
  readonly userAddress: string;
  readonly sessionId: Uint8Array;
  readonly orderSequence: bigint;
  readonly modelId: Uint8Array;
  readonly profileVersion: number;
  readonly taskType: number;
  readonly inputHash: Uint8Array;
  readonly inputSizeBytes: bigint;
  readonly inputBucket: number;
  readonly outputBudgetBucket: number;
  readonly generationParams?: undefined | {
    readonly generationParamsSchemaVersion: number;
    readonly maxOutputTokens: bigint;
    readonly maxOutputDuration: bigint;
    readonly decodingParams?: undefined | {
      readonly samplingEnabled: boolean;
      readonly temperatureMilli: number;
      readonly topPPpm: number;
      readonly topK: number;
      readonly seed: bigint;
      readonly presencePenaltyMilli: number;
      readonly frequencyPenaltyMilli: number;
      readonly repetitionPenaltyPpm: number;
      readonly stopSequences: readonly string[];
      readonly stopTokenIds: readonly number[];
    };
  };
  readonly priceBid?: undefined | { readonly atomicUnits: string };
  readonly maxFee?: undefined | { readonly atomicUnits: string };
  readonly assignmentPriorityFee?: undefined | { readonly atomicUnits: string };
  readonly txFeeReserve?: undefined | { readonly atomicUnits: string };
  readonly earliestSubmitHeight: bigint;
  readonly orderExpireHeight: bigint;
  readonly deadlinePolicy?: undefined | { readonly latencyClass: number };
  readonly timeoutBucketVersion: bigint;
  readonly sessionAnchorHeight: bigint;
  readonly sessionAnchorBlockHash: Uint8Array;
  readonly builderSetId: string;
  readonly builderSetHash: Uint8Array;
  readonly payloadMode: number;
  readonly inputKeyCommitment: Uint8Array;
  readonly userRecipientPubkey: Uint8Array;
}

/**
 * TRUEOPEN_TASK_ORDER_V3 over the 28 fields, nested messages as their own frames
 * (testdata/v1/task/task_order_v3.json typed fields): the verifier recomputes the OpenTask
 * task_hash from the order instead of taking it from the caller.
 */
export function taskOrderHash(o: TaskOrderLike): Uint8Array {
  const g = o.generationParams;
  const d = g?.decodingParams;
  if (g === undefined || d === undefined) throw new VerifyError('NEXUS_INGRESS_MALFORMED', 'order has no generation params');
  const amount = (a: { atomicUnits: string } | undefined): Uint8Array => frame8(utf8(a?.atomicUnits ?? ''));
  const generation = frame8(
    u32be(g.generationParamsSchemaVersion),
    u64be(g.maxOutputTokens),
    u64be(g.maxOutputDuration),
    frame8(
      new Uint8Array([d.samplingEnabled ? 1 : 0]),
      u32be(d.temperatureMilli),
      u32be(d.topPPpm),
      u32be(d.topK),
      u64be(d.seed),
      i32be(d.presencePenaltyMilli),
      i32be(d.frequencyPenaltyMilli),
      u32be(d.repetitionPenaltyPpm),
      frame8(u32be(d.stopSequences.length), ...d.stopSequences.map(utf8)),
      frame8(u32be(d.stopTokenIds.length), ...d.stopTokenIds.map(u32be)),
    ),
  );
  return hFields(
    'TRUEOPEN_TASK_ORDER_V3',
    u32be(o.schemaVersion),
    utf8(o.chainId),
    addressBytes('order user_address', o.userAddress),
    o.sessionId,
    u64be(o.orderSequence),
    o.modelId,
    u32be(o.profileVersion),
    u32be(o.taskType),
    o.inputHash,
    u64be(o.inputSizeBytes),
    u32be(o.inputBucket),
    u32be(o.outputBudgetBucket),
    generation,
    amount(o.priceBid),
    amount(o.maxFee),
    amount(o.assignmentPriorityFee),
    amount(o.txFeeReserve),
    u64be(o.earliestSubmitHeight),
    u64be(o.orderExpireHeight),
    frame8(u32be(o.deadlinePolicy?.latencyClass ?? 0)),
    u64be(o.timeoutBucketVersion),
    u64be(o.sessionAnchorHeight),
    o.sessionAnchorBlockHash,
    utf8(o.builderSetId),
    o.builderSetHash,
    u32be(o.payloadMode),
    o.inputKeyCommitment,
    o.userRecipientPubkey,
  );
}

// ------------------------------------------------------------------ request authentication

export interface EnvelopeLike {
  readonly requestDomain: string;
  readonly chainId: string;
  readonly method: string;
  readonly endpoint: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly requestNonce: Uint8Array;
  readonly expiryHeightOrTime: bigint;
  readonly bodyDigest: Uint8Array;
  readonly signerAddress: string;
  readonly signature: Uint8Array;
  readonly sessionGrant?: GrantLike | undefined;
}

/** What the verifier knows about the chain and itself. */
export interface AuthContext {
  readonly chainId: string;
  readonly evmChainId: bigint;
  readonly height: bigint;
  readonly nowMs: bigint;
  readonly maxSessionGrantBlocks: bigint;
  /** OpenTask's height-expiry window above the current height. */
  readonly requestTtlBlocks: bigint;
  /** The compressed public key stored on the account, undefined when there is none. */
  readonly accountPubKey: (address: string) => Uint8Array | undefined;
  readonly seenNonces: Set<string>;
}

export const HEIGHT_EXPIRY_THRESHOLD = 1_000_000_000_000n;
const SESSION_SDK_METHODS = ['SubscribeOutput', 'AckOutput', 'GetTaskEvents', 'PrepareChallenge'];
const SESSION_DATA_METHODS = ['/nexus.v1.IngressAPI/GetTaskDataMetadata', '/nexus.v1.IngressAPI/FetchTaskData'];
const zero32 = new Uint8Array(32);

/**
 * SessionGrantV1 checks (step 3): chain, user, user signature, stored account key, then the
 * height window. `prefix` names the codes: SDK_AUTH or DATA_ACCESS.
 */
function verifyGrant(g: GrantLike, user: string, requestChainId: string, ctx: AuthContext, prefix: 'SDK_AUTH' | 'DATA_ACCESS'): void {
  const invalid = (why: string): never => { throw new VerifyError(`${prefix}_SESSION_GRANT_INVALID`, why); };
  if (g.chainId !== requestChainId || g.chainId !== ctx.chainId) invalid('grant chain_id is not this chain');
  if (g.user !== user) invalid('grant user is not the request signer');
  if (g.sessionKey.length !== 20 || g.grantNonce.length !== 32) invalid('grant fields have the wrong length');
  const rec = recover65(sessionGrantDigest(g, ctx.evmChainId), g.userSignature);
  if (rec === undefined || hex(rec.address20) !== hex(addressBytes('grant user', g.user, `${prefix}_SESSION_GRANT_INVALID`))) {
    invalid('user_signature does not recover to user');
  }
  const stored = ctx.accountPubKey(g.user);
  if (stored === undefined || hex(stored) !== hex(rec!.pub)) invalid('user has no stored account key, or another one');
  if (!(ctx.height <= g.expiryHeight && g.expiryHeight <= ctx.height + ctx.maxSessionGrantBlocks)) {
    throw new VerifyError(`${prefix}_SESSION_GRANT_EXPIRED`, `grant expiry ${g.expiryHeight} outside [${ctx.height}, ${ctx.height + ctx.maxSessionGrantBlocks}]`);
  }
}

/**
 * SDKRequestEnvelopeV2 verification, the five steps in order: format, session method set,
 * grant, request signature, expiry and replay. `body` recomputes the body digest from the
 * request (it throws NEXUS_INGRESS_MALFORMED when the body does not project). Returns the
 * signer address (the granting user for a session-key request).
 */
export function verifySdkRequest(
  e: EnvelopeLike | undefined,
  want: { method: string; sessionId: string; taskId: string; body: () => Uint8Array; openTaskSequence?: bigint },
  ctx: AuthContext,
): string {
  const malformed = (why: string): never => { throw new VerifyError('NEXUS_INGRESS_MALFORMED', why); };
  // 1. Format.
  if (e === undefined) return malformed('request_envelope required');
  if (e.requestDomain !== 'TRUEOPEN_SDK_REQUEST_V2') malformed('request_domain');
  if (e.method !== want.method || e.endpoint !== `/nexus.v1.IngressAPI/${e.method}`) malformed('method/endpoint');
  const sessionId = raw32('session_id', e.sessionId);
  const taskId = raw32('task_id', e.taskId);
  if (e.sessionId !== want.sessionId || e.taskId !== want.taskId) malformed('envelope session/task is not the request');
  if (e.requestNonce.length !== 32) malformed('request_nonce must be 32 bytes');
  if (e.expiryHeightOrTime <= 0n) malformed('expiry must be above zero');
  const heightExpiry = e.expiryHeightOrTime < HEIGHT_EXPIRY_THRESHOLD;
  if (heightExpiry && want.openTaskSequence === undefined) malformed('a height expiry is accepted only for OpenTask');
  if (!heightExpiry && want.openTaskSequence !== undefined) malformed('OpenTask expiry must be a chain height, not Unix milliseconds');
  if (want.openTaskSequence !== undefined && e.taskId !== deriveTaskId(e.sessionId, want.openTaskSequence)) malformed('OpenTask task_id is not derived');
  addressBytes('signer_address', e.signerAddress);
  const body = want.body();
  // 2. Session method set.
  const g = e.sessionGrant;
  if (g !== undefined && !SESSION_SDK_METHODS.includes(e.method)) {
    throw new VerifyError('SDK_AUTH_SESSION_METHOD_NOT_ALLOWED', `${e.method} does not accept a session grant`);
  }
  // 3. Grant.
  if (g !== undefined) verifyGrant(g, e.signerAddress, e.chainId, ctx, 'SDK_AUTH');
  // 4. Request signature, over the digest rebuilt with this chain and the derived grant hash.
  const digest = sdkRequestDigest({
    chainId: ctx.chainId, method: e.method, endpoint: e.endpoint, sessionId, taskId, requestNonce: e.requestNonce,
    expiryHeightOrTime: e.expiryHeightOrTime, bodyDigest: body, sessionGrantHash: g === undefined ? zero32 : sessionGrantHashStruct(g),
  }, ctx.evmChainId);
  const rec = recover65(digest, e.signature);
  const bad = (why: string): never => { throw new VerifyError('SDK_AUTH_INVALID_SIGNATURE', why); };
  if (rec === undefined) bad('signature is not 65 bytes, V 27/28, low S');
  if (g !== undefined) {
    if (hex(rec!.address20) !== hex(g.sessionKey)) bad('request signature does not recover to the grant session_key');
  } else {
    if (hex(rec!.address20) !== hex(addressBytes('signer_address', e.signerAddress))) bad('request signature does not recover to signer_address');
    const stored = ctx.accountPubKey(e.signerAddress);
    if (stored === undefined || hex(stored) !== hex(rec!.pub)) bad('signer has no stored account key, or another one');
  }
  // 5. Expiry, then replay.
  if (heightExpiry) {
    if (e.expiryHeightOrTime < ctx.height || e.expiryHeightOrTime > ctx.height + ctx.requestTtlBlocks) {
      throw new VerifyError('SDK_AUTH_EXPIRED', 'height expiry outside the request window');
    }
  } else if (e.expiryHeightOrTime < ctx.nowMs) {
    throw new VerifyError('SDK_AUTH_EXPIRED', 'envelope expired');
  }
  const key = `${e.requestDomain}\u0000${e.chainId}\u0000${e.signerAddress}\u0000${hex(e.requestNonce)}`;
  if (ctx.seenNonces.has(key)) throw new VerifyError('SDK_AUTH_REPLAY', 'nonce replayed');
  ctx.seenNonces.add(key);
  return e.signerAddress;
}

/** nexus.v1.TaskDataObjectRefV1 as the fakes see it. */
export interface ObjectRefLike {
  readonly taskHash: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly objectKind: number;
  readonly contentHash: string;
  readonly evidenceProducerKind: number;
  readonly verifyRound: number;
  readonly producerOperator: string;
  readonly evidenceKind: number;
}

/** The canonical object reference frame, for non-evidence objects (the only ones a user reads). */
export function objectRefFrame(ref: ObjectRefLike): Uint8Array {
  if (ref.objectKind === 0) throw new VerifyError('NEXUS_INGRESS_MALFORMED', 'object_kind');
  if (ref.evidenceProducerKind !== 0 || ref.verifyRound !== 0 || ref.producerOperator !== '' || ref.evidenceKind !== 0) {
    throw new VerifyError('NEXUS_INGRESS_MALFORMED', 'non-evidence object must not carry producer fields');
  }
  return frame8(
    raw32('task_hash', ref.taskHash),
    raw32('session_id', ref.sessionId),
    raw32('task_id', ref.taskId),
    u32be(ref.objectKind),
    raw32('content_hash', ref.contentHash),
    u32be(0),
    u32be(0),
    optional(undefined),
    u32be(0),
  );
}

export function metadataBodyDigest(ref: ObjectRefLike): Uint8Array {
  return hFields('TRUEOPEN_TASK_DATA_METADATA_BODY_V2', objectRefFrame(ref));
}

export function fetchBodyDigest(ref: ObjectRefLike, range: { offset: bigint; length: bigint } | undefined): Uint8Array {
  return hFields('TRUEOPEN_TASK_DATA_FETCH_BODY_V2', objectRefFrame(ref), optional(range === undefined ? undefined : frame8(u64be(range.offset), u64be(range.length))));
}

export interface RequestAuthLike {
  readonly schemaVersion: number;
  readonly chainId: string;
  readonly builderOperatorAddress: string;
  readonly rpcMethod: string;
  readonly bodyDigest: string;
  readonly requesterKind: number;
  readonly requesterAddress: string;
  readonly serviceAuthorizationNonce: bigint;
  readonly requestNonce: Uint8Array;
  readonly expiryHeight: bigint;
  readonly signature: Uint8Array;
  readonly sessionGrant?: GrantLike | undefined;
}

/** The USER TaskDataRequest digest, EIP-712 "TrueOpen Task Data Request" version 2. */
export function userTaskDataDigest(a: RequestAuthLike, chainId: string, evmChainId: bigint, sessionGrantHash: Uint8Array): Uint8Array {
  const struct = keccak_256(concat([
    keccakText(
      'TaskDataRequest(uint32 schemaVersion,string chainId,string builderOperatorAddress,string rpcMethod,' +
        'bytes32 bodyDigest,uint32 requesterKind,string requesterAddress,uint64 serviceAuthorizationNonce,' +
        'bytes32 requestNonce,uint64 expiryHeight,bytes32 sessionGrantHash)',
    ),
    word(BigInt(a.schemaVersion)),
    keccakText(chainId),
    keccakText(a.builderOperatorAddress),
    keccakText(a.rpcMethod),
    raw32('body_digest', a.bodyDigest),
    word(BigInt(a.requesterKind)),
    keccakText(a.requesterAddress),
    word(a.serviceAuthorizationNonce),
    a.requestNonce,
    word(a.expiryHeight),
    sessionGrantHash,
  ]));
  return signingDigest(domainSeparator('TrueOpen Task Data Request', '2', evmChainId), struct);
}

/**
 * TaskDataRequestAuthV1, USER path, in the five steps: format (NEXUS_INGRESS_MALFORMED), session
 * method and object set, grant, request signature (DATA_ACCESS_INVALID_SIGNATURE), then expiry
 * (NEXUS_DATA_EXPIRED) and replay. Returns the requester address.
 */
export function verifyUserTaskDataAuth(
  a: RequestAuthLike | undefined,
  want: { builder: string; rpcMethod: string; body: Uint8Array; objectKind: number; maxServiceMaterialExpiryBlocks: bigint },
  ctx: AuthContext,
): string {
  const malformed = (why: string): never => { throw new VerifyError('NEXUS_INGRESS_MALFORMED', why); };
  if (a === undefined) return malformed('request_auth required');
  if (a.schemaVersion !== 1 || a.rpcMethod !== want.rpcMethod) malformed('request_auth fields');
  if (a.requesterKind !== 1 || a.serviceAuthorizationNonce !== 0n) malformed('USER branch');
  if (a.requestNonce.length !== 32) malformed('request_nonce must be 32 bytes');
  if (a.bodyDigest !== hex(want.body)) malformed('body_digest mismatch');
  addressBytes('requester_address', a.requesterAddress);
  if (a.builderOperatorAddress !== want.builder) throw new VerifyError('DATA_ACCESS_DENIED', 'builder address is not this Builder');
  const g = a.sessionGrant;
  if (g !== undefined && (!SESSION_DATA_METHODS.includes(a.rpcMethod) || want.objectKind !== 2)) {
    throw new VerifyError('DATA_ACCESS_SESSION_METHOD_NOT_ALLOWED', 'a session key may read only an OUTPUT object');
  }
  if (g !== undefined) verifyGrant(g, a.requesterAddress, a.chainId, ctx, 'DATA_ACCESS');
  const digest = userTaskDataDigest(a, ctx.chainId, ctx.evmChainId, g === undefined ? zero32 : sessionGrantHashStruct(g));
  const rec = recover65(digest, a.signature);
  const expected = g === undefined ? addressBytes('requester_address', a.requesterAddress) : g.sessionKey;
  if (rec === undefined || hex(rec.address20) !== hex(expected)) {
    throw new VerifyError('DATA_ACCESS_INVALID_SIGNATURE', 'the signature does not recover to the expected signer');
  }
  // The Task data window is max_service_material_expiry_blocks, not OpenTask's request TTL.
  if (a.expiryHeight < ctx.height || a.expiryHeight > ctx.height + want.maxServiceMaterialExpiryBlocks) {
    throw new VerifyError('NEXUS_DATA_EXPIRED', 'expiry height outside window');
  }
  const key = `task-data\u0000${a.chainId}\u0000${a.builderOperatorAddress}\u0000${a.requesterAddress}\u0000${hex(a.requestNonce)}`;
  if (ctx.seenNonces.has(key)) throw new VerifyError('NEXUS_DATA_REPLAY', 'nonce replayed');
  ctx.seenNonces.add(key);
  return a.requesterAddress;
}

/** nodecontract.OutputChunkSigningDigest. */
export function outputChunkDigest(chainId: string, taskHash: Uint8Array, seq: bigint, root: Uint8Array): Uint8Array {
  return hFields('TRUEOPEN_OUTPUT_CHUNK_V1', utf8(chainId), taskHash, u64be(seq), root);
}

/** nodecontract.OutputFinSigningDigest. */
export function outputFinDigest(chainId: string, taskHash: Uint8Array, finalSeq: bigint, root: Uint8Array, reason: number): Uint8Array {
  return hFields('TRUEOPEN_OUTPUT_FIN_V1', utf8(chainId), taskHash, u64be(finalSeq), root, u32be(reason));
}

export interface DecodedTx {
  readonly hash: string;
  readonly bodyBytes: Uint8Array;
  readonly messages: readonly { typeUrl: string; value: Uint8Array }[];
  readonly signerPubKey: Uint8Array;
  readonly pubKeyTypeUrl: string;
  readonly sequence: bigint;
  readonly feeDenoms: readonly string[];
  readonly signatureValid: boolean;
}

/**
 * Decodes a broadcast TxRaw and checks its single signature the way node's ante handler does for
 * an ethsecp256k1 account in SIGN_MODE_DIRECT: keccak256(SignDoc) signed by the key in AuthInfo.
 */
export function decodeAndVerifyTx(txBytes: Uint8Array, chainId: string, accountNumber: bigint): DecodedTx {
  const raw = TxRaw.decode(txBytes);
  const authInfo = AuthInfo.decode(raw.authInfoBytes);
  const signerInfo = authInfo.signerInfos[0];
  if (signerInfo?.publicKey === undefined || raw.signatures.length !== 1) throw new Error('tx must carry exactly one signer with a public key');
  // ethsecp256k1.PubKey { bytes key = 1 }: tag 0x0a, length 33.
  const pkAny = signerInfo.publicKey.value;
  const signerPubKey = pkAny.subarray(2);
  const signDoc = SignDoc.encode({ bodyBytes: raw.bodyBytes, authInfoBytes: raw.authInfoBytes, chainId, accountNumber }).finish();
  const sig = raw.signatures[0]!;
  let signatureValid = false;
  try {
    signatureValid = sig.length === 64 && secp256k1.verify(sig, keccak_256(signDoc), signerPubKey, { lowS: true, prehash: false });
  } catch {
    signatureValid = false;
  }
  // The body's messages, read without a registry: TxBody { repeated Any messages = 1 }.
  const messages: { typeUrl: string; value: Uint8Array }[] = [];
  const body = raw.bodyBytes;
  for (let i = 0; i < body.length; ) {
    const [key, afterKey] = varint(body, i);
    const [len, afterLen] = varint(body, afterKey);
    const end = afterLen + Number(len);
    if (Number(key >> 3n) === 1) messages.push(decodeAny(body.subarray(afterLen, end)));
    i = end;
  }
  return {
    hash: hex(sha256(txBytes)).toUpperCase(),
    bodyBytes: raw.bodyBytes,
    messages,
    signerPubKey,
    pubKeyTypeUrl: signerInfo.publicKey.typeUrl,
    sequence: signerInfo.sequence,
    feeDenoms: authInfo.fee?.amount.map((c) => c.denom) ?? [],
    signatureValid,
  };
}

function varint(buf: Uint8Array, start: number): [bigint, number] {
  let out = 0n;
  let shift = 0n;
  let i = start;
  for (;;) {
    const b = buf[i++]!;
    out |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [out, i];
    shift += 7n;
  }
}

function decodeAny(bytes: Uint8Array): { typeUrl: string; value: Uint8Array } {
  let typeUrl = '';
  let value: Uint8Array = new Uint8Array();
  for (let i = 0; i < bytes.length; ) {
    const [key, afterKey] = varint(bytes, i);
    const [len, afterLen] = varint(bytes, afterKey);
    const end = afterLen + Number(len);
    const field = Number(key >> 3n);
    if (field === 1) typeUrl = new TextDecoder().decode(bytes.subarray(afterLen, end));
    if (field === 2) value = bytes.subarray(afterLen, end);
    i = end;
  }
  return { typeUrl, value };
}
