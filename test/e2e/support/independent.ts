/**
 * SDK-independent re-implementations of what nexus and node check.
 *
 * Nothing here imports SDK code: the fakes use these to verify what the SDK sends, so an SDK bug
 * cannot hide behind the same bug on the verifying side. Each function mirrors the Go source it
 * is named after (nexus internal/sdkauth, internal/ingress, internal/taskdata, internal/nodecontract;
 * node's ante handler for ethsecp256k1 DIRECT signatures), written from that source rather than
 * from the SDK.
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

/** A check failed; `code` is the nexus error code the real service would answer with. */
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
export function u64be(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v);
  return b;
}
function i64be(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, v);
  return b;
}

/** sdkauth: fields with a 4-byte big-endian length prefix. */
export function frame4(...fields: Uint8Array[]): Uint8Array {
  return concat(fields.flatMap((f) => [u32be(f.length), f]));
}
/** nodecontract.CanonicalFrameBytes: fields with an 8-byte big-endian length prefix. */
export function frame8(...fields: Uint8Array[]): Uint8Array {
  return concat(fields.flatMap((f) => [u64be(BigInt(f.length)), f]));
}
/** H_FIELDS_V1(domain, fields...). */
export function hFields(domain: string, ...fields: Uint8Array[]): Uint8Array {
  return sha256(frame8(utf8(domain), ...fields));
}
function raw32(field: string, value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new VerifyError('NEXUS_DATA_MALFORMED', `${field} is not canonical Hash32`);
  return unhex(value);
}

/** signer.AddressFromPubKey: bech32(prefix, keccak256(uncompressed XY)[12:]). */
export function addressFromPubKey(prefix: string, pubCompressed: Uint8Array): string {
  const xy = secp256k1.ProjectivePoint.fromHex(pubCompressed).toRawBytes(false).subarray(1);
  return bech32.encode(prefix, bech32.toWords(keccak_256(xy).subarray(12)));
}

/** signer.VerifySig: 64-byte low-S R||S over sha256(msg). */
export function verifySha256Sig(pubCompressed: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  if (sig.length !== 64) return false;
  try {
    return secp256k1.verify(sig, sha256(msg), pubCompressed, { lowS: true, prehash: false });
  } catch {
    return false;
  }
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
  readonly signerPubkey: Uint8Array;
}

export const HEIGHT_EXPIRY_THRESHOLD = 1_000_000_000_000n;

/** sdkauth.SignBytes. */
export function sdkSignBytes(e: EnvelopeLike): Uint8Array {
  return frame4(
    utf8('TRUEOPEN_SDK_REQUEST_V1'),
    utf8(e.chainId),
    utf8(e.method),
    utf8(e.endpoint),
    utf8(e.sessionId),
    utf8(e.taskId),
    e.requestNonce,
    i64be(e.expiryHeightOrTime),
    e.bodyDigest,
  );
}

/** sdkauth.BodyDigest. */
export function sdkBodyDigest(...fields: Uint8Array[]): Uint8Array {
  return sha256(frame4(...fields));
}

/**
 * sdkauth.Verify plus ingress checkRequiredTaskEnvelope: structure, chain, method, expiry,
 * body digest, signature, address, then the endpoint/session/task binding. Returns the signer.
 */
export function verifySdkEnvelope(
  e: EnvelopeLike | undefined,
  want: {
    chainId: string;
    method: string;
    sessionId: string;
    taskId: string;
    body: Uint8Array;
    prefix: string;
    allowHeightExpiry: boolean;
    nowMs: bigint;
    seenNonces?: Set<string>;
  },
): string {
  if (e === undefined) throw new VerifyError('SDK_AUTH_INVALID_SIGNATURE', 'request_envelope required');
  if (
    e.requestDomain !== 'TRUEOPEN_SDK_REQUEST_V1' || e.signerAddress === '' || e.signature.length === 0 ||
    e.signerPubkey.length === 0 || e.requestNonce.length === 0
  ) {
    throw new VerifyError('NEXUS_INGRESS_MALFORMED', 'envelope structure');
  }
  if (e.chainId !== want.chainId || e.method !== want.method) throw new VerifyError('NEXUS_INGRESS_MALFORMED', 'chain/method');
  if (e.expiryHeightOrTime < HEIGHT_EXPIRY_THRESHOLD) {
    if (!want.allowHeightExpiry) throw new VerifyError('NEXUS_INGRESS_MALFORMED', 'height expiry on a timestamp method');
  } else if (e.expiryHeightOrTime < want.nowMs) {
    throw new VerifyError('SDK_AUTH_EXPIRED', 'envelope expired');
  }
  if (hex(e.bodyDigest) !== hex(want.body)) throw new VerifyError('NEXUS_INGRESS_MALFORMED', 'body_digest mismatch');
  if (!verifySha256Sig(e.signerPubkey, sdkSignBytes(e), e.signature)) {
    throw new VerifyError('SDK_AUTH_INVALID_SIGNATURE', 'envelope signature');
  }
  if (addressFromPubKey(want.prefix, e.signerPubkey) !== e.signerAddress) {
    throw new VerifyError('SDK_AUTH_INVALID_SIGNATURE', 'signer_address does not match signer_pubkey');
  }
  if (want.seenNonces !== undefined) {
    const key = `${e.chainId}|${e.signerAddress}|${hex(e.requestNonce)}`;
    if (want.seenNonces.has(key)) throw new VerifyError('SDK_AUTH_REPLAY', 'nonce replayed');
    want.seenNonces.add(key);
  }
  if (e.endpoint !== `/nexus.v1.IngressAPI/${want.method}` || e.sessionId !== want.sessionId || e.taskId !== want.taskId) {
    throw new VerifyError('NEXUS_INGRESS_MALFORMED', 'envelope binding mismatch');
  }
  return e.signerAddress;
}

export interface OpenTaskHeaderLike {
  readonly orderEnvelope: Uint8Array;
  readonly payloadRef: string;
  readonly signature: Uint8Array;
  readonly sessionId: string;
  readonly orderSequence: bigint;
  readonly userAddress: string;
  readonly signatureScheme: string;
  readonly inputSizeBytes: bigint;
  readonly inputHash: string;
  readonly inputMediaType: string;
}

/** ingress openTaskBodyDigest. */
export function openTaskBodyDigest(h: OpenTaskHeaderLike): Uint8Array {
  return sdkBodyDigest(
    h.orderEnvelope,
    utf8(h.payloadRef),
    h.signature,
    utf8(h.sessionId),
    u64be(h.orderSequence),
    utf8(h.userAddress),
    utf8(h.signatureScheme),
    u64be(h.inputSizeBytes),
    utf8(h.inputHash),
    utf8(h.inputMediaType),
  );
}

/** nodecontract.CurrentOrderSigningBytes: sha256 over 8-byte-prefixed text fields. */
export function orderSigningBytes(chainId: string, owner: string, sessionId: string, seq: bigint, orderEnvelopeHex: string): Uint8Array {
  return sha256(frame8(...['TRUEOPEN_ORDER_V1', chainId, owner, sessionId, seq.toString(10), orderEnvelopeHex].map(utf8)));
}

/** nodecontract.DeriveTaskIDFromRawSession. */
export function deriveTaskId(sessionId: string, seq: bigint): string {
  return hex(hFields('TRUEOPEN_TASK_ID_V1', raw32('session_id', sessionId), u64be(seq)));
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

function optional(present: boolean, value: Uint8Array): Uint8Array {
  return present ? concat([new Uint8Array([1]), frame8(value)]) : new Uint8Array([0]);
}

/** taskdata.CanonicalObjectRefFrame, for non-evidence objects (the only ones a user reads). */
export function objectRefFrame(ref: ObjectRefLike): Uint8Array {
  if (ref.objectKind === 0) throw new VerifyError('NEXUS_DATA_MALFORMED', 'object_kind');
  if (ref.evidenceProducerKind !== 0 || ref.verifyRound !== 0 || ref.producerOperator !== '' || ref.evidenceKind !== 0) {
    throw new VerifyError('NEXUS_DATA_MALFORMED', 'non-evidence object must not carry producer fields');
  }
  return frame8(
    raw32('task_hash', ref.taskHash),
    raw32('session_id', ref.sessionId),
    raw32('task_id', ref.taskId),
    u32be(ref.objectKind),
    raw32('content_hash', ref.contentHash),
    u32be(0),
    u32be(0),
    optional(false, new Uint8Array()),
    u32be(0),
  );
}

export function metadataBodyDigest(ref: ObjectRefLike): Uint8Array {
  return hFields('TRUEOPEN_TASK_DATA_METADATA_BODY_V2', objectRefFrame(ref));
}

export function fetchBodyDigest(ref: ObjectRefLike, range: { offset: bigint; length: bigint } | undefined): Uint8Array {
  const inner = range === undefined ? new Uint8Array() : frame8(u64be(range.offset), u64be(range.length));
  return hFields('TRUEOPEN_TASK_DATA_FETCH_BODY_V2', objectRefFrame(ref), optional(range !== undefined, inner));
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
}

const word = (v: bigint): Uint8Array => {
  const b = new Uint8Array(32);
  new DataView(b.buffer).setBigUint64(24, v);
  return b;
};

/** taskdata.UserTaskDataRequestDigest (EIP-712 v4). */
export function userTaskDataDigest(a: RequestAuthLike, evmChainId: bigint): Uint8Array {
  const k = (s: string): Uint8Array => keccak_256(utf8(s));
  const domain = keccak_256(concat([
    k('EIP712Domain(string name,string version,uint256 chainId)'),
    k('TrueOpen Task Data Request'),
    k('1'),
    word(evmChainId),
  ]));
  const typeHash = k(
    'TaskDataRequest(uint32 schemaVersion,string chainId,string builderOperatorAddress,string rpcMethod,' +
      'bytes32 bodyDigest,uint32 requesterKind,string requesterAddress,uint64 serviceAuthorizationNonce,' +
      'bytes32 requestNonce,uint64 expiryHeight)',
  );
  if (a.requestNonce.length !== 32) throw new VerifyError('NEXUS_DATA_MALFORMED', 'request_nonce must be 32 bytes');
  const struct = keccak_256(concat([
    typeHash,
    word(BigInt(a.schemaVersion)),
    k(a.chainId),
    k(a.builderOperatorAddress),
    k(a.rpcMethod),
    raw32('body_digest', a.bodyDigest),
    word(BigInt(a.requesterKind)),
    k(a.requesterAddress),
    word(a.serviceAuthorizationNonce),
    a.requestNonce,
    word(a.expiryHeight),
  ]));
  return keccak_256(concat([new Uint8Array([0x19, 0x01]), domain, struct]));
}

/** taskdata.RecoverUserTaskDataRequester, then the address check against requester_address. */
export function verifyUserTaskDataAuth(
  a: RequestAuthLike | undefined,
  want: { chainId: string; evmChainId: bigint; builder: string; rpcMethod: string; body: Uint8Array; prefix: string; minHeight: bigint; maxHeight: bigint },
): string {
  if (a === undefined) throw new VerifyError('NEXUS_DATA_UNAUTHORIZED', 'request_auth required');
  if (a.schemaVersion !== 1 || a.chainId !== want.chainId || a.rpcMethod !== want.rpcMethod) {
    throw new VerifyError('NEXUS_DATA_MALFORMED', 'request_auth fields');
  }
  if (a.builderOperatorAddress !== want.builder) throw new VerifyError('NEXUS_DATA_UNAUTHORIZED', 'builder address is not this Builder');
  if (a.requesterKind !== 1 || a.serviceAuthorizationNonce !== 0n) throw new VerifyError('NEXUS_DATA_MALFORMED', 'USER branch');
  if (a.bodyDigest !== hex(want.body)) throw new VerifyError('NEXUS_DATA_MALFORMED', 'body_digest mismatch');
  if (a.expiryHeight < want.minHeight || a.expiryHeight > want.maxHeight) throw new VerifyError('NEXUS_DATA_EXPIRED', 'expiry height outside window');
  const sig = a.signature;
  if (sig.length !== 65) throw new VerifyError('NEXUS_DATA_MALFORMED', 'USER signature must be 65 bytes');
  const v = sig[64]!;
  if (v !== 27 && v !== 28) throw new VerifyError('NEXUS_DATA_MALFORMED', 'USER signature V must be 27 or 28');
  const s = secp256k1.Signature.fromCompact(sig.subarray(0, 64));
  if (s.hasHighS()) throw new VerifyError('NEXUS_DATA_MALFORMED', 'USER signature must be low-S');
  const pub = s.addRecoveryBit(v - 27).recoverPublicKey(userTaskDataDigest(a, want.evmChainId));
  const addr = bech32.encode(want.prefix, bech32.toWords(keccak_256(pub.toRawBytes(false).subarray(1)).subarray(12)));
  if (addr !== a.requesterAddress) throw new VerifyError('NEXUS_DATA_UNAUTHORIZED', 'recovered signer is not requester_address');
  return addr;
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
