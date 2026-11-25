import { create, toBinary } from '@bufbuild/protobuf';
import { canonicalHashBytes, uint32BE, uint64BE } from '../codec/domain-hash';
import type { Eip712Types } from '../codec/eip712';
import { TrueOpenError } from '../errors/errors';
import { OrderInputTokensAttestationV1Schema } from '../gen/task/v1/msg_assignment_pb';
import type { OrderInputTokensAttestationV1 } from '../gen/task/v1/msg_assignment_pb';
import { signatureChainIdBigInt } from '../signature-chain-id';
import { signTypedDataAs } from '../signer/typed-data-signer';
import type { TypedData, TypedDataSigner } from '../signer/typed-data-signer';
import { SIGNATURE_SCHEME } from './signed-order';

/**
 * The user's signed statement of how many input tokens an order has (wire
 * `task.v1.OrderInputTokensAttestationV1`).
 *
 * TaskOrderV3 is a closed signed field list, so the count is not an order field: it is a second
 * statement bound to the order by its digest (the order's task_hash), signed by the same signer
 * and scheme as the order, and sent beside it in `OpenTaskHeader.input_tokens_attestation`. A
 * chain whose `input_token_tolerance` is zero ignores it; an order without one is unchanged.
 */

/** Domain of the attestation digest (wire testdata/v1/task/order_input_tokens_v1.json). */
export const ORDER_INPUT_TOKENS_DOMAIN = 'TRUEOPEN_ORDER_INPUT_TOKENS_V1';

/** OrderInputTokensAttestationV1.schema_version: always 1. */
export const ORDER_INPUT_TOKENS_SCHEMA_VERSION = 1;

/** EIP-712 domain of the attestation signature. */
export const ORDER_INPUT_TOKENS_EIP712_DOMAIN_NAME = 'TrueOpen Order Input Tokens';
export const ORDER_INPUT_TOKENS_EIP712_DOMAIN_VERSION = '1';

/**
 * Type table of the attestation's EIP-712 payload. As with the order, the wallet sees the
 * readable values and `attestationDigest` binds the canonical digest into the same signature.
 */
export const ORDER_INPUT_TOKENS_EIP712_TYPES: Eip712Types = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
  ],
  OrderInputTokens: [
    { name: 'chainId', type: 'string' },
    { name: 'orderDigest', type: 'bytes32' },
    { name: 'inputTokenCount', type: 'uint64' },
    { name: 'attestationDigest', type: 'bytes32' },
  ],
};

const enc = new TextEncoder();
const MAX_UINT64 = (1n << 64n) - 1n;

function local(code: string, message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', code, message);
}

export interface OrderInputTokensFields {
  /** The order's chain_id (the cosmos string chain ID). */
  readonly chainId: string;
  /** The order's task_hash (taskOrderHash), raw 32 bytes. */
  readonly orderDigest: Uint8Array;
  /** Number of input tokens after the Profile's tokenizer and chat template; at least 1. */
  readonly inputTokenCount: bigint;
}

function checkFields(f: OrderInputTokensFields): void {
  if (f.chainId === '') throw local('SDK_LOCAL_INPUT_TOKENS_INVALID', 'input token attestation: chain_id is empty');
  if (f.orderDigest.length !== 32) {
    throw local('SDK_LOCAL_INPUT_TOKENS_INVALID', `input token attestation: order_digest must be 32 bytes, got ${f.orderDigest.length}`);
  }
  if (typeof f.inputTokenCount !== 'bigint' || f.inputTokenCount < 1n || f.inputTokenCount > MAX_UINT64) {
    throw local('SDK_LOCAL_INPUT_TOKENS_INVALID', `input token attestation: input_token_count must be an integer in 1..2^64-1, got ${String(f.inputTokenCount)}`);
  }
}

/**
 * H_FIELDS_V1("TRUEOPEN_ORDER_INPUT_TOKENS_V1", u32be(schema_version), chain_id, raw32(order_digest),
 * u64be(input_token_count)); raw 32 bytes.
 */
export function orderInputTokensDigest(f: OrderInputTokensFields): Uint8Array {
  checkFields(f);
  return canonicalHashBytes(
    enc.encode(ORDER_INPUT_TOKENS_DOMAIN),
    uint32BE(ORDER_INPUT_TOKENS_SCHEMA_VERSION),
    enc.encode(f.chainId),
    f.orderDigest,
    uint64BE(f.inputTokenCount),
  );
}

/** The attestation's EIP-712 typed data, as a wallet signs it. */
export function orderInputTokensTypedData(f: OrderInputTokensFields, signatureChainId: bigint | number | string): TypedData {
  return {
    types: ORDER_INPUT_TOKENS_EIP712_TYPES,
    primaryType: 'OrderInputTokens',
    domain: {
      name: ORDER_INPUT_TOKENS_EIP712_DOMAIN_NAME,
      version: ORDER_INPUT_TOKENS_EIP712_DOMAIN_VERSION,
      chainId: signatureChainIdBigInt(signatureChainId),
    },
    message: {
      chainId: f.chainId,
      orderDigest: f.orderDigest,
      inputTokenCount: f.inputTokenCount,
      attestationDigest: orderInputTokensDigest(f),
    },
  };
}

export interface SignOrderInputTokensInput extends OrderInputTokensFields {
  /** The same EIP-712 chain ID the order was signed under. */
  readonly signatureChainId: bigint | number | string;
  /** The order's signer: the wallet, or the session's registered key. */
  readonly signer: TypedDataSigner;
  /** The 20 address bytes the signature must recover to (the order's signer). */
  readonly expectedSigner: Uint8Array;
}

/** Signs the statement and returns the wire message. */
export async function signOrderInputTokens(input: SignOrderInputTokensInput): Promise<OrderInputTokensAttestationV1> {
  const data = orderInputTokensTypedData(input, input.signatureChainId);
  const userSignature = await signTypedDataAs(input.signer, data, input.expectedSigner);
  return create(OrderInputTokensAttestationV1Schema, {
    schemaVersion: ORDER_INPUT_TOKENS_SCHEMA_VERSION,
    chainId: input.chainId,
    orderDigest: input.orderDigest,
    inputTokenCount: input.inputTokenCount,
    signatureScheme: SIGNATURE_SCHEME,
    userSignature,
    signatureChainId: signatureChainIdBigInt(input.signatureChainId),
  });
}

/** Protobuf bytes of an attestation (what an application stores to resend an order unchanged). */
export function encodeOrderInputTokens(att: OrderInputTokensAttestationV1): Uint8Array {
  return toBinary(OrderInputTokensAttestationV1Schema, att);
}

/**
 * What a token counter is given: the order's plaintext input and the Profile it is for. The
 * counter must apply that Profile's tokenizer and chat template; `tokenizerHash` (when the caller
 * knows it) is the Profile's registered tokenizer, so a counter can refuse to count with another.
 */
export interface InputTokenCountRequest {
  readonly payload: Uint8Array;
  /** `0x` + 64 lowercase hex. */
  readonly modelId: string;
  readonly profileVersion: number;
}

/**
 * Counts the input tokens of an order. The SDK ships no tokenizer: the application supplies one
 * that implements the Profile's tokenizer and chat template. Returning `undefined` means "no
 * statement for this order" and the order is sent without an attestation.
 */
export type InputTokenCounter = (
  req: InputTokenCountRequest,
) => bigint | number | undefined | Promise<bigint | number | undefined>;

/** Normalises a counter's answer; a non-integer, zero or negative count is a local error. */
export function inputTokenCountValue(value: bigint | number | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw local('SDK_LOCAL_INPUT_TOKENS_INVALID', `input token count must be a safe integer, got ${String(value)}`);
    }
    value = BigInt(value);
  }
  if (value < 1n || value > MAX_UINT64) {
    throw local('SDK_LOCAL_INPUT_TOKENS_INVALID', `input token count must be in 1..2^64-1, got ${String(value)}`);
  }
  return value;
}

/** The outcome of comparing the user's attested count with the count the accepted receipt commits to. */
export interface InputTokenCountCheck {
  /** `match`: equal; `mismatch`: they differ; `unavailable`: the receipt gives no valid count. */
  readonly status: 'match' | 'mismatch' | 'unavailable';
  readonly attested: bigint;
  /** The count derived from the receipt; undefined when unavailable. */
  readonly committed?: bigint;
  /** committed − attested (positive: the Worker committed to more input tokens than attested). */
  readonly difference?: bigint;
}

/**
 * The input token count an accepted receipt commits to (wire docs/TOKEN_USAGE_V1.md):
 * `(S − 8) / 4 − G`, with S the encoded size of the receipt's WORKER_TOKEN_OPENING commitment
 * and G its generated_token_count. Undefined when the rule's validity conditions fail; never
 * truncated, clamped or replaced by a Worker-reported usage figure.
 */
export function committedInputTokenCount(tokenOpeningEncodedSizeBytes: bigint, generatedTokenCount: bigint): bigint | undefined {
  const s = tokenOpeningEncodedSizeBytes;
  const g = generatedTokenCount;
  if (s < 8n || g < 0n || (s - 8n) % 4n !== 0n) return undefined;
  const total = (s - 8n) / 4n;
  if (total <= g) return undefined;
  return total - g;
}

/**
 * Compares the attested count with what the accepted receipt commits to. It only reports: a
 * mismatch is for the application to act on (the chain applies its own tolerance rule).
 */
export function checkInputTokenCount(p: {
  readonly attested: bigint;
  readonly tokenOpeningEncodedSizeBytes: bigint;
  readonly generatedTokenCount: bigint;
}): InputTokenCountCheck {
  const committed = committedInputTokenCount(p.tokenOpeningEncodedSizeBytes, p.generatedTokenCount);
  if (committed === undefined) return { status: 'unavailable', attested: p.attested };
  return {
    status: committed === p.attested ? 'match' : 'mismatch',
    attested: p.attested,
    committed,
    difference: committed - p.attested,
  };
}
