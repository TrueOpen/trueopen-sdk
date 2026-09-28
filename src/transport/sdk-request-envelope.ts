import type { Eip712Types } from '../codec/eip712';
import type { TypedData, TypedDataSigner } from '../signer/typed-data-signer';
import { signTypedDataAs, typedDataDigest } from '../signer/typed-data-signer';
import { canonicalOperatorAddressBytes } from '../codec/address';
import { fromHex } from '../util/bytes';
import { TrueOpenError } from '../errors/errors';

/**
 * SDKRequestEnvelopeV2: how a user request to Builder Ingress is authenticated (OpenTask,
 * SubscribeOutput, AckOutput, GetTaskEvents, PrepareChallenge).
 *
 * The signature is EIP-712 typed data under the domain
 *   EIP712Domain(string name,string version,uint256 chainId)
 *   name "TrueOpen SDK Request", version "1", chainId = the chain's evm_chain_id
 * over
 *   SDKRequest(string chainId,string method,string endpoint,bytes32 sessionId,bytes32 taskId,
 *     bytes32 requestNonce,uint64 expiryHeightOrTime,bytes32 bodyDigest,bytes32 sessionGrantHash)
 * and is 65 bytes R||S||V (V 27/28, low S). The verifier recovers the signer; no public key
 * travels with the request. request_domain, signer_address and the signature itself are not
 * typed fields. sessionGrantHash is 32 zero bytes for a request the wallet signs directly.
 *
 * Vectors: wire testdata/v1/shared/account_signing_v1.json sdk_request.
 */

/** request_domain: checked by the Builder and used in its replay key, but not signed. */
export const SDK_REQUEST_DOMAIN = 'TRUEOPEN_SDK_REQUEST_V2';
export const SDK_REQUEST_EIP712_DOMAIN_NAME = 'TrueOpen SDK Request';
export const SDK_REQUEST_EIP712_DOMAIN_VERSION = '1';

/** The service every endpoint belongs to: endpoint = `${INGRESS_SERVICE_PATH}/<Method>`. */
export const INGRESS_SERVICE_PATH = '/nexus.v1.IngressAPI';

/** Values of 10^12 and above are Unix milliseconds; smaller values are a chain height (OpenTask only). */
export const HEIGHT_EXPIRY_THRESHOLD = 1_000_000_000_000n;
const INT64_MAX = (1n << 63n) - 1n;

const EIP712_DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
] as const;

export const SDK_REQUEST_EIP712_TYPES: Eip712Types = {
  EIP712Domain: EIP712_DOMAIN_TYPE,
  SDKRequest: [
    { name: 'chainId', type: 'string' },
    { name: 'method', type: 'string' },
    { name: 'endpoint', type: 'string' },
    { name: 'sessionId', type: 'bytes32' },
    { name: 'taskId', type: 'bytes32' },
    { name: 'requestNonce', type: 'bytes32' },
    { name: 'expiryHeightOrTime', type: 'uint64' },
    { name: 'bodyDigest', type: 'bytes32' },
    { name: 'sessionGrantHash', type: 'bytes32' },
  ],
};

/** The SDK Request EIP-712 domain for an EVM chain ID. */
export function sdkRequestEip712Domain(evmChainId: bigint): { name: string; version: string; chainId: bigint } {
  return { name: SDK_REQUEST_EIP712_DOMAIN_NAME, version: SDK_REQUEST_EIP712_DOMAIN_VERSION, chainId: evmChainId };
}

/** The signed fields of an SDK request, in transport form. */
export interface SdkRequestFields {
  readonly chainId: string;
  /** The bare method name, such as "SubscribeOutput". The endpoint is derived from it. */
  readonly method: string;
  /** 64-character lowercase hex. */
  readonly sessionId: string;
  /** 64-character lowercase hex. */
  readonly taskId: string;
  /** Exactly 32 bytes from a CSPRNG, unique per signer. */
  readonly requestNonce: Uint8Array;
  /** Above zero: Unix milliseconds (>= 10^12), or a chain height (OpenTask only). */
  readonly expiryHeightOrTime: bigint;
  /** 32 bytes: the body digest of the method (see sdk-request-body.ts). */
  readonly bodyDigest: Uint8Array;
}

function malformed(what: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_REQUEST_MALFORMED', `SDK request: ${what}`);
}

/** Strict Hash32 decode: 64 lowercase hex characters, no 0x. Anything else is not projectable. */
export function strictHash32(field: string, hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw malformed(`${field} must be 64-character lowercase hex without 0x, got ${JSON.stringify(hex)}`);
  }
  return fromHex(hex);
}

/** `/nexus.v1.IngressAPI/<Method>` for a bare method name. */
export function ingressEndpoint(method: string): string {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(method)) throw malformed(`method must be a bare method name, got ${JSON.stringify(method)}`);
  return `${INGRESS_SERVICE_PATH}/${method}`;
}

/** The SDKRequest typed data; refuses anything the verifier could not project. */
export function sdkRequestTypedData(f: SdkRequestFields, evmChainId: bigint, sessionGrantHash: Uint8Array = new Uint8Array(32)): TypedData {
  if (f.chainId === '') throw malformed('chain_id must not be empty');
  if (f.requestNonce.length !== 32) throw malformed(`request_nonce must be exactly 32 bytes, got ${f.requestNonce.length}`);
  if (f.expiryHeightOrTime <= 0n || f.expiryHeightOrTime > INT64_MAX) {
    throw malformed(`expiry_height_or_time must be in (0, 2^63-1], got ${f.expiryHeightOrTime}`);
  }
  if (f.bodyDigest.length !== 32) throw malformed(`body_digest must be 32 bytes, got ${f.bodyDigest.length}`);
  if (sessionGrantHash.length !== 32) throw malformed('sessionGrantHash must be 32 bytes');
  return {
    types: SDK_REQUEST_EIP712_TYPES,
    primaryType: 'SDKRequest',
    domain: sdkRequestEip712Domain(evmChainId),
    message: {
      chainId: f.chainId,
      method: f.method,
      endpoint: ingressEndpoint(f.method),
      sessionId: strictHash32('session_id', f.sessionId),
      taskId: strictHash32('task_id', f.taskId),
      requestNonce: f.requestNonce,
      expiryHeightOrTime: f.expiryHeightOrTime,
      bodyDigest: f.bodyDigest,
      sessionGrantHash,
    },
  };
}

/** The 32-byte signing digest keccak256(0x19 0x01 || domainSeparator || hashStruct(SDKRequest)). */
export function sdkRequestEip712Digest(f: SdkRequestFields, evmChainId: bigint, sessionGrantHash?: Uint8Array): Uint8Array {
  return typedDataDigest(sdkRequestTypedData(f, evmChainId, sessionGrantHash));
}

/** A signed SDKRequestEnvelopeV2, ready to put on the wire. */
export interface SignedSdkRequestEnvelope extends SdkRequestFields {
  readonly requestDomain: typeof SDK_REQUEST_DOMAIN;
  readonly endpoint: string;
  /** The user's canonical Bech32 address. */
  readonly signerAddress: string;
  /** 65 bytes R||S||V. */
  readonly signature: Uint8Array;
}

/**
 * Signs an SDK request with the user's wallet (no session grant). The signature must recover to
 * `signerAddress`; that is checked before the envelope is returned.
 */
export async function signSdkRequestEnvelope(
  fields: SdkRequestFields,
  opts: { readonly signerAddress: string; readonly signer: TypedDataSigner; readonly evmChainId: bigint },
): Promise<SignedSdkRequestEnvelope> {
  const data = sdkRequestTypedData(fields, opts.evmChainId);
  const expected = canonicalOperatorAddressBytes('signer_address', opts.signerAddress);
  const signature = await signTypedDataAs(opts.signer, data, expected);
  return {
    requestDomain: SDK_REQUEST_DOMAIN,
    ...fields,
    endpoint: ingressEndpoint(fields.method),
    signerAddress: opts.signerAddress,
    signature,
  };
}
