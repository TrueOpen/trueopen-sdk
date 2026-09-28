import { frame4, i64be } from '../codec/frame';
import type { CosmosSecp256k1Signer } from '../signer/secp256k1';

const enc = new TextEncoder();

/** Fixed domain separator (nexus internal/sdkauth RequestDomain). */
export const SDK_REQUEST_DOMAIN = 'TRUEOPEN_SDK_REQUEST_V1';

/** The fields of SDKRequestEnvelopeV1 that go into the signature (excludes signer_address/signature/pubkey). */
export interface SdkRequestEnvelopeFields {
  readonly chainId: string;
  readonly method: string;
  readonly endpoint: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly requestNonce: Uint8Array;
  readonly expiryHeightOrTime: bigint;
  readonly bodyDigest: Uint8Array;
}

/**
 * Sign bytes (nexus sdkauth.SignBytes): a frame with 4-byte length prefixes,
 * in field order:
 * domain, chain_id, method, endpoint, session_id, task_id, request_nonce, i64be(expiry), body_digest.
 * Request signature = secp256k1(sha256(SignBytes)); the sha256 step is done by CosmosSecp256k1Signer.
 */
export function sdkRequestSignBytes(f: SdkRequestEnvelopeFields): Uint8Array {
  return frame4(
    enc.encode(SDK_REQUEST_DOMAIN),
    enc.encode(f.chainId),
    enc.encode(f.method),
    enc.encode(f.endpoint),
    enc.encode(f.sessionId),
    enc.encode(f.taskId),
    f.requestNonce,
    i64be(f.expiryHeightOrTime),
    f.bodyDigest,
  );
}

/** A signed SDKRequestEnvelopeV1 (maps directly to the proto / Connect-JSON form). */
export interface SignedSdkRequestEnvelope extends SdkRequestEnvelopeFields {
  readonly requestDomain: typeof SDK_REQUEST_DOMAIN;
  readonly signerAddress: string;
  readonly signature: Uint8Array; // 64-byte r||s
  readonly signerPubKey: Uint8Array; // 33-byte compressed public key
}

/** Signs the request envelope and returns the full envelope ready to send. */
export async function signSdkRequestEnvelope(
  fields: SdkRequestEnvelopeFields,
  signerAddress: string,
  signerPubKey: Uint8Array,
  signer: CosmosSecp256k1Signer,
): Promise<SignedSdkRequestEnvelope> {
  const sig = await signer(sdkRequestSignBytes(fields));
  const raw = sig.length === 65 ? sig.subarray(0, 64) : sig;
  return { requestDomain: SDK_REQUEST_DOMAIN, ...fields, signerAddress, signature: raw, signerPubKey };
}
