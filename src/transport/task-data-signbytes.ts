import { canonicalFrameBytes, canonicalHashBytes, optionalV1, uint32BE, uint64BE, enumBE } from '../codec/domain-hash';
import { canonicalOperatorAddressBytes } from '../codec/address';
import { typedDataDigest } from '../signer/typed-data-signer';
import type { TypedData } from '../signer/typed-data-signer';
import type { Eip712Types, Eip712Struct } from '../codec/eip712';
import { fromHex, toHex } from '../util/bytes';
import { TrueOpenError } from '../errors/errors';

/**
 * Authentication for the nexus task data plane.
 *
 * Everything changed relative to an earlier revision: SignedTaskDataRangeV1 was removed,
 * TaskDataRequestAuthV1 went from 7 plain strings to an 11-field typed
 * message, and authentication now splits into **two layers**:
 *
 *   1. body digest -- each RPC is bound to its own body domain (one of five),
 *      via H_FIELDS_V1 (sha256 over an 8-byte length-prefixed frame). The SDK
 *      only ever uses METADATA and FETCH.
 *   2. outer signature -- **routed by requester_kind, never sniffed by
 *      length**:
 *        USER            EIP-712 "TrueOpen Task Data Request" v1, exactly 65 bytes R‖S‖V
 *        CORTEX_SERVICE  the H_FIELDS_V1 digest of TRUEOPEN_TASK_DATA_REQUEST_V1, exactly 64 bytes
 *      USER must also carry service_authorization_nonce = 0.
 *
 * Cross-language anchors: wire testdata/v1/task/task_data_auth_v1.json (body
 * digest) and the task_data_request block of shared/account_signing_v1.json
 * (the full USER EIP-712 path).
 */

const enc = new TextEncoder();
const HASH32 = 32;

/**
 * Five body domains, each bound to one RPC. The SDK, acting as a User, only ever uses the last two.
 * All five are V2: the object ref frame gained evidence_kind as its ninth field.
 */
export const TASK_DATA_BODY_DOMAIN = {
  UPLOAD: 'TRUEOPEN_TASK_DATA_UPLOAD_BODY_V2',
  FINALIZE_RESULT: 'TRUEOPEN_TASK_DATA_FINALIZE_RESULT_BODY_V2',
  FINALIZE_VERIFIER: 'TRUEOPEN_TASK_DATA_FINALIZE_VERIFIER_BODY_V2',
  METADATA: 'TRUEOPEN_TASK_DATA_METADATA_BODY_V2',
  FETCH: 'TRUEOPEN_TASK_DATA_FETCH_BODY_V2',
} as const;

/** The outer signature domain for the CORTEX_SERVICE branch; the USER branch doesn't use it (it uses EIP-712 instead). */
export const TASK_DATA_REQUEST_DOMAIN = 'TRUEOPEN_TASK_DATA_REQUEST_V1';

/** EIP-712 domain for the USER branch; the values are frozen by account_signing_v1.json. */
export const TASK_DATA_EIP712_DOMAIN_NAME = 'TrueOpen Task Data Request';
export const TASK_DATA_EIP712_DOMAIN_VERSION = '1';

/** rpc_method must be byte-for-byte equal to the fully qualified name of the actual call, not a bare method name. */
export const TASK_DATA_RPC_METHOD = {
  UploadTaskResultObject: '/nexus.v1.IngressAPI/UploadTaskResultObject',
  UploadTaskOutputStream: '/nexus.v1.IngressAPI/UploadTaskOutputStream',
  GetTaskDataMetadata: '/nexus.v1.IngressAPI/GetTaskDataMetadata',
  FetchTaskData: '/nexus.v1.IngressAPI/FetchTaskData',
  FinalizeTaskResult: '/nexus.v1.IngressAPI/FinalizeTaskResult',
  FinalizeVerifierEvidence: '/nexus.v1.IngressAPI/FinalizeVerifierEvidence',
} as const;

/** nexus.v1.TaskDataObjectKind. */
export const TASK_DATA_OBJECT_KIND = {
  UNSPECIFIED: 0,
  INPUT: 1,
  OUTPUT: 2,
  EVIDENCE_MANIFEST: 3,
  EVIDENCE_ARTIFACT: 4,
} as const;

/** nexus.v1.EvidenceProducerKindV1. Fixed to UNSPECIFIED for non-evidence objects. */
export const EVIDENCE_PRODUCER_KIND = { UNSPECIFIED: 0, WORKER: 1, VERIFIER: 2 } as const;

/** shared.v1.EvidenceKind. UNSPECIFIED for INPUT and OUTPUT objects; required for evidence objects. */
export const EVIDENCE_KIND = {
  UNSPECIFIED: 0,
  WORKER_VALUE_OPENING: 1,
  VERIFIER_VALUE_OPENING: 2,
  SETTLEMENT_ROOT_OPENING: 3,
  WORKER_TOKEN_OPENING: 4,
} as const;

/** nexus.v1.TaskDataRequesterKindV1. */
export const TASK_DATA_REQUESTER_KIND = { UNSPECIFIED: 0, USER: 1, CORTEX_SERVICE: 2 } as const;

function malformed(what: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'TASK_DATA_REQUEST_MALFORMED', `task data request: ${what}`);
}

/** The transport layer represents Hash32 as lowercase hex, but the preimage always uses raw32. */
function hash32(field: string, hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw malformed(`${field} must be canonical lowercase 64-hex Hash32, got ${JSON.stringify(hex)}`);
  }
  return fromHex(hex);
}

/** SDK view of nexus.v1.TaskDataObjectRefV1 (Hash32 as canonical lowercase hex). */
export interface TaskDataObjectRef {
  readonly taskHash: string;
  readonly sessionId: string;
  readonly taskId: string;
  /** See TASK_DATA_OBJECT_KIND. */
  readonly objectKind: number;
  readonly contentHash: string;
  /** See EVIDENCE_PRODUCER_KIND; UNSPECIFIED for non-evidence objects. */
  readonly evidenceProducerKind?: number;
  /** 0 for non-evidence objects. */
  readonly verifyRound?: number;
  /**
   * Canonical Bech32 operator address; must be absent for non-evidence objects.
   * The preimage carries the address codec bytes, not the text.
   */
  readonly producerOperator?: string;
  /** See EVIDENCE_KIND; UNSPECIFIED (the default) for non-evidence objects. */
  readonly evidenceKind?: number;
}

const EVIDENCE_OBJECT_KINDS: readonly number[] = [
  TASK_DATA_OBJECT_KIND.EVIDENCE_MANIFEST,
  TASK_DATA_OBJECT_KIND.EVIDENCE_ARTIFACT,
];

/** Data-plane evidence kinds each producer may carry. The settlement root opening is never a data-plane object. */
const EVIDENCE_KINDS_BY_PRODUCER: Readonly<Record<number, readonly number[]>> = {
  [EVIDENCE_PRODUCER_KIND.WORKER]: [EVIDENCE_KIND.WORKER_VALUE_OPENING, EVIDENCE_KIND.WORKER_TOKEN_OPENING],
  [EVIDENCE_PRODUCER_KIND.VERIFIER]: [EVIDENCE_KIND.VERIFIER_VALUE_OPENING],
};

/**
 * Refuses an object_kind / evidence_kind combination the contract makes illegal, before
 * any digest is computed: INPUT and OUTPUT carry EVIDENCE_KIND_UNSPECIFIED, and an
 * evidence object carries a kind its producer can produce (Worker: value or token
 * opening; Verifier: value opening).
 */
function validateEvidenceKind(ref: TaskDataObjectRef): void {
  const kind = ref.evidenceKind ?? EVIDENCE_KIND.UNSPECIFIED;
  if (!EVIDENCE_OBJECT_KINDS.includes(ref.objectKind)) {
    if (kind !== EVIDENCE_KIND.UNSPECIFIED) {
      throw malformed(`evidence_kind ${kind} is not allowed on non-evidence object_kind ${ref.objectKind}`);
    }
    return;
  }
  const producer = ref.evidenceProducerKind ?? EVIDENCE_PRODUCER_KIND.UNSPECIFIED;
  const allowed = EVIDENCE_KINDS_BY_PRODUCER[producer];
  // Reported separately: "no producer kind" and "wrong kind for this producer" are
  // different mistakes, and folding them together yields the unhelpful
  // "evidence_kind 0 is not a data-plane evidence kind for producer kind 0".
  if (allowed === undefined) {
    throw malformed(
      `object_kind ${ref.objectKind} is an evidence object and needs evidence_producer_kind WORKER or VERIFIER`,
    );
  }
  if (!allowed.includes(kind)) {
    throw malformed(`evidence_kind ${kind} is not a data-plane evidence kind for producer kind ${producer}`);
  }
}

/**
 * The nested nine-field frame of the canonical TaskDataObjectRefV1.
 *
 * Throws on an object_kind / evidence_kind combination the contract makes illegal, before
 * any digest is computed. Note what that means when verifying a ref produced elsewhere: an
 * illegal combination raises rather than yielding a digest that simply fails to match. The
 * SDK's own User-side bodies (FETCH, METADATA) only ever carry INPUT or OUTPUT refs with
 * no evidence_kind, so they never reach it.
 */
export function canonicalObjectRefFrame(ref: TaskDataObjectRef): Uint8Array {
  validateEvidenceKind(ref);
  return canonicalFrameBytes(
    hash32('task_hash', ref.taskHash),
    hash32('session_id', ref.sessionId),
    hash32('task_id', ref.taskId),
    enumBE(ref.objectKind),
    hash32('content_hash', ref.contentHash),
    enumBE(ref.evidenceProducerKind ?? EVIDENCE_PRODUCER_KIND.UNSPECIFIED),
    uint32BE(ref.verifyRound ?? 0),
    optionalV1(
      ref.producerOperator === undefined
        ? undefined
        : canonicalOperatorAddressBytes('producer_operator', ref.producerOperator),
    ),
    enumBE(ref.evidenceKind ?? EVIDENCE_KIND.UNSPECIFIED),
  );
}

/** body digest for GetTaskDataMetadata. */
export function taskDataMetadataBodyDigest(ref: TaskDataObjectRef): Uint8Array {
  return canonicalHashBytes(enc.encode(TASK_DATA_BODY_DOMAIN.METADATA), canonicalObjectRefFrame(ref));
}

/** Retrieval byte range; absent means read the whole object. */
export interface ByteRange {
  readonly offset: bigint;
  readonly length: bigint;
}

/** body digest for FetchTaskData. An absent vs. present range produces two different preimages. */
export function taskDataFetchBodyDigest(ref: TaskDataObjectRef, range?: ByteRange): Uint8Array {
  const rangeField = optionalV1(
    range === undefined ? undefined : canonicalFrameBytes(uint64BE(range.offset), uint64BE(range.length)),
  );
  return canonicalHashBytes(
    enc.encode(TASK_DATA_BODY_DOMAIN.FETCH),
    canonicalObjectRefFrame(ref),
    rangeField,
  );
}

/** The ten signed fields of TaskDataRequestAuthV1 (the signature itself is not part of the signature). */
export interface TaskDataRequestAuthFields {
  readonly schemaVersion: number;
  readonly chainId: string;
  /** operator address of the Builder being queried; nexus compares it against its own config and rejects on a mismatch. */
  readonly builderOperatorAddress: string;
  /** Fully qualified name, see TASK_DATA_RPC_METHOD. */
  readonly rpcMethod: string;
  /** One of the two body digests above (raw 32 bytes). */
  readonly bodyDigest: Uint8Array;
  /** See TASK_DATA_REQUESTER_KIND. */
  readonly requesterKind: number;
  readonly requesterAddress: string;
  /** Must be 0 for USER. */
  readonly serviceAuthorizationNonce: bigint;
  /** Exactly 32 bytes of CSPRNG randomness. */
  readonly requestNonce: Uint8Array;
  readonly expiryHeight: bigint;
}

function validateAuthFields(f: TaskDataRequestAuthFields): void {
  if (f.chainId === '') throw malformed('chain_id must not be empty');
  if (f.builderOperatorAddress === '') throw malformed('builder_operator_address must not be empty');
  if (f.requesterAddress === '') throw malformed('requester_address must not be empty');
  if (f.rpcMethod === '' || !f.rpcMethod.startsWith('/')) {
    throw malformed(`rpc_method must be the fully qualified "/nexus.v1.IngressAPI/<Method>", got ${JSON.stringify(f.rpcMethod)}`);
  }
  if (f.bodyDigest.length !== HASH32) throw malformed(`body_digest must be 32 bytes, got ${f.bodyDigest.length}`);
  if (f.requestNonce.length !== HASH32) throw malformed(`request_nonce must be 32 bytes, got ${f.requestNonce.length}`);
  if (f.expiryHeight === 0n) throw malformed('expiry_height must not be 0');
  if (f.requesterKind === TASK_DATA_REQUESTER_KIND.USER && f.serviceAuthorizationNonce !== 0n) {
    throw malformed('a USER request must carry service_authorization_nonce 0');
  }
}

/** EIP-712 type table for the USER branch. Field names and order are frozen by the contract. */
export const TASK_DATA_EIP712_TYPES: Eip712Types = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
  ],
  TaskDataRequest: [
    { name: 'schemaVersion', type: 'uint32' },
    { name: 'chainId', type: 'string' },
    { name: 'builderOperatorAddress', type: 'string' },
    { name: 'rpcMethod', type: 'string' },
    { name: 'bodyDigest', type: 'bytes32' },
    { name: 'requesterKind', type: 'uint32' },
    { name: 'requesterAddress', type: 'string' },
    { name: 'serviceAuthorizationNonce', type: 'uint64' },
    { name: 'requestNonce', type: 'bytes32' },
    { name: 'expiryHeight', type: 'uint64' },
  ],
};

/**
 * The USER branch as EIP-712 typed data, for a TypedDataSigner (a wallet signs this). evmChainId
 * is the numeric chain ID in the EIP-712 domain, a different thing from the cosmos chain-ID
 * string in fields.chainId.
 */
export function taskDataRequestTypedData(f: TaskDataRequestAuthFields, evmChainId: bigint | number | string): TypedData {
  validateAuthFields(f);
  const message: Eip712Struct = {
    schemaVersion: f.schemaVersion,
    chainId: f.chainId,
    builderOperatorAddress: f.builderOperatorAddress,
    rpcMethod: f.rpcMethod,
    bodyDigest: f.bodyDigest,
    requesterKind: f.requesterKind,
    requesterAddress: f.requesterAddress,
    serviceAuthorizationNonce: f.serviceAuthorizationNonce,
    requestNonce: f.requestNonce,
    expiryHeight: f.expiryHeight,
  };
  return {
    types: TASK_DATA_EIP712_TYPES,
    primaryType: 'TaskDataRequest',
    domain: {
      name: TASK_DATA_EIP712_DOMAIN_NAME,
      version: TASK_DATA_EIP712_DOMAIN_VERSION,
      chainId: BigInt(evmChainId),
    },
    message,
  };
}

/** Signature digest for the USER branch (EIP-712, keccak). The signature is 65 bytes R‖S‖V. */
export function taskDataRequestEip712Digest(
  f: TaskDataRequestAuthFields,
  evmChainId: bigint | number | string,
): Uint8Array {
  return typedDataDigest(taskDataRequestTypedData(f, evmChainId));
}

/**
 * Signature digest for the CORTEX_SERVICE branch (H_FIELDS_V1, sha256). The
 * signature is 64 bytes R‖S. The SDK, acting as a User, never needs this
 * path; it's kept here so both branches can be compared side by side --
 * the contract is explicit that "length is never sniffed, and the caller's
 * public key is never trusted"; requester_kind alone decides the
 * verification path.
 *
 * Warning: the key difference from the USER branch is that here the two
 * address fields are encoded as the **raw 20-byte address codec bytes**
 * (decoded from bech32), whereas the EIP-712 branch uses the bech32 **text**.
 * Same fields, two different encodings -- mixing them up produces a
 * completely wrong digest, so each branch has its own test vectors to check
 * against.
 */
export function taskDataRequestSignBytes(f: TaskDataRequestAuthFields): Uint8Array {
  validateAuthFields(f);
  return canonicalHashBytes(
    enc.encode(TASK_DATA_REQUEST_DOMAIN),
    uint32BE(f.schemaVersion),
    enc.encode(f.chainId),
    canonicalOperatorAddressBytes('builder_operator_address', f.builderOperatorAddress),
    enc.encode(f.rpcMethod),
    f.bodyDigest,
    enumBE(f.requesterKind),
    canonicalOperatorAddressBytes('requester_address', f.requesterAddress),
    uint64BE(f.serviceAuthorizationNonce),
    f.requestNonce,
    uint64BE(f.expiryHeight),
  );
}

/** body_digest is lowercase hex text in the proto, but raw32 in the preimage. */
export function bodyDigestHex(digest: Uint8Array): string {
  if (digest.length !== HASH32) throw malformed(`body_digest must be 32 bytes, got ${digest.length}`);
  return toHex(digest);
}
