import { secp256k1 } from '@noble/curves/secp256k1';
import { eip712Digest } from '../codec/eip712';
import type { Eip712Struct, Eip712Types, Eip712Value } from '../codec/eip712';
import { privKeyEip712Signer, recoverEip712PubKey, ethAddressBytes } from './eth-secp256k1';
import { bytesEqual, fromHex, toHex } from '../util/bytes';
import { TrueOpenError } from '../errors/errors';

/**
 * One EIP-712 signing request: the type table (with `EIP712Domain`), the primary type, the
 * domain and the message. Values are in SDK form: bytesN / address / bytes as Uint8Array,
 * integers as bigint (or number / decimal string), strings as strings.
 */
export interface TypedData {
  readonly types: Eip712Types;
  readonly primaryType: string;
  readonly domain: Eip712Struct;
  readonly message: Eip712Struct;
}

/**
 * Signs EIP-712 typed data and returns 65 bytes R||S||V, V in {27, 28}, low S: the only form
 * the chain and Builder Ingress accept.
 *
 * One interface covers every signature a user makes: the SignedOrder, the SDK request envelope,
 * the Task data request and the session grant. Three implementations ship with the SDK:
 *  - privateKeyTypedDataSigner: holds a raw key and signs the digest itself (CLI, servers,
 *    the in-memory session key);
 *  - eip1193TypedDataSigner: a browser wallet through `eth_signTypedData_v4`;
 *  - keplrTypedDataSigner: Keplr through `signEthereum(..., EthSignType.EIP712)`.
 * The SDK recovers every wallet signature and checks it against the expected address before
 * sending it, so a wallet that signed with another account or under another chain fails
 * locally with SDK_LOCAL_SIGNER_ADDRESS_MISMATCH instead of at the Builder.
 */
export interface TypedDataSigner {
  signTypedData(data: TypedData): Promise<Uint8Array>;
}

function local(code: string, message: string, cause?: unknown): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', code, message, cause !== undefined ? { cause } : undefined);
}

/** The EIP-712 signing digest of a typed data request. */
export function typedDataDigest(data: TypedData): Uint8Array {
  return eip712Digest(data.types, data.domain, data.primaryType, data.message);
}

/**
 * (a) A signer holding a raw secp256k1 key: computes the EIP-712 digest and signs it once
 * (RFC 6979, low S, V 27/28). Never hashes the digest again and never uses an EIP-191 prefix.
 */
export function privateKeyTypedDataSigner(privKey: Uint8Array): TypedDataSigner {
  const sign = privKeyEip712Signer(privKey);
  return { signTypedData: async (data) => sign(typedDataDigest(data)) };
}

/** Converts one value to its eth_signTypedData_v4 JSON form. */
function jsonValue(type: string, value: Eip712Value, types: Eip712Types): unknown {
  if (type.endsWith(']')) {
    const elem = type.slice(0, type.lastIndexOf('['));
    if (!Array.isArray(value)) throw local('SDK_LOCAL_TYPED_DATA_MALFORMED', `${type} value must be an array`);
    return value.map((v) => jsonValue(elem, v as Eip712Value, types));
  }
  const fields = types[type];
  if (fields !== undefined) return jsonStruct(type, value as Eip712Struct, types);
  if (type === 'address' || type === 'bytes' || /^bytes[0-9]+$/.test(type)) {
    if (!(value instanceof Uint8Array)) throw local('SDK_LOCAL_TYPED_DATA_MALFORMED', `${type} value must be bytes`);
    return `0x${toHex(value)}`;
  }
  if (/^u?int[0-9]*$/.test(type)) {
    // Decimal strings: a uint64 does not fit a JSON number.
    if (typeof value === 'bigint' || typeof value === 'number') return value.toString(10);
    if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) return value;
    throw local('SDK_LOCAL_TYPED_DATA_MALFORMED', `${type} value must be an integer`);
  }
  return value;
}

function jsonStruct(name: string, value: Eip712Struct, types: Eip712Types): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of types[name] ?? []) {
    const v = value[f.name];
    if (v === undefined) throw local('SDK_LOCAL_TYPED_DATA_MALFORMED', `${name}.${f.name} is missing`);
    out[f.name] = jsonValue(f.type, v, types);
  }
  return out;
}

/**
 * The JSON object a wallet signs with eth_signTypedData_v4: bytesN and address as 0x-hex,
 * every integer (including the domain chainId) as a decimal string.
 */
export function typedDataJson(data: TypedData): {
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
} {
  const types: Record<string, { name: string; type: string }[]> = {};
  for (const [k, fields] of Object.entries(data.types)) types[k] = fields.map((f) => ({ name: f.name, type: f.type }));
  return {
    types,
    primaryType: data.primaryType,
    domain: jsonStruct('EIP712Domain', data.domain, data.types),
    message: jsonStruct(data.primaryType, data.message, data.types),
  };
}

/**
 * A wallet signature in the only accepted shape: 65 bytes, V 27/28 (a wallet answering 0/1 is
 * moved to 27/28, which is the same signature), low S (a high-S signature is refused: the
 * Builder rejects it).
 */
export function normalizeWalletSignature(sig: Uint8Array): Uint8Array {
  if (sig.length !== 65) throw local('SDK_LOCAL_BAD_SIGNATURE_LEN', `wallet signature must be 65 bytes, got ${sig.length}`);
  const out = Uint8Array.from(sig);
  if (out[64] === 0 || out[64] === 1) out[64] = out[64]! + 27;
  if (out[64] !== 27 && out[64] !== 28) throw local('SDK_LOCAL_BAD_SIGNATURE_V', `wallet signature V must be 27 or 28, got ${sig[64]}`);
  let parsed: ReturnType<typeof secp256k1.Signature.fromCompact>;
  try {
    // Refuses r or s of 0 or not below the curve order.
    parsed = secp256k1.Signature.fromCompact(out.subarray(0, 64));
  } catch (cause) {
    throw local('SDK_LOCAL_BAD_SIGNATURE', 'wallet signature R||S is not a valid secp256k1 signature', cause);
  }
  if (parsed.hasHighS()) throw local('SDK_LOCAL_BAD_SIGNATURE_HIGH_S', 'wallet signature has a high S value');
  return out;
}

/** The part of an EIP-1193 provider the adapter uses. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/**
 * (b) A browser wallet through EIP-1193 `eth_signTypedData_v4`.
 *
 * `address` is the 0x account that signs (the EVM form of the user's Bech32 address). The
 * wallet's active network must have chain ID equal to the chain's `evm_chain_id`: a wallet such
 * as MetaMask refuses to sign typed data whose domain chainId differs from its active chain.
 * That means adding a network whose RPC answers `eth_chainId` with the TrueOpen EVM chain ID.
 */
export function eip1193TypedDataSigner(opts: { readonly provider: Eip1193Provider; readonly address: string }): TypedDataSigner {
  if (!/^0x[0-9a-fA-F]{40}$/.test(opts.address)) {
    throw local('SDK_LOCAL_BAD_ADDRESS', `EIP-1193 signer address must be a 0x-prefixed 20-byte address, got ${JSON.stringify(opts.address)}`);
  }
  return {
    async signTypedData(data) {
      const result = await opts.provider.request({
        method: 'eth_signTypedData_v4',
        params: [opts.address, JSON.stringify(typedDataJson(data))],
      });
      if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(result)) {
        throw local('SDK_LOCAL_BAD_SIGNATURE_LEN', 'eth_signTypedData_v4 did not return a 65-byte hex signature');
      }
      return normalizeWalletSignature(fromHex(result.slice(2).toLowerCase()));
    },
  };
}

/** The part of the Keplr API the adapter uses (`window.keplr`). */
export interface KeplrEthereumSigner {
  signEthereum(chainId: string, signer: string, data: string | Uint8Array, type: 'eip-712'): Promise<Uint8Array>;
}

/**
 * (c) Keplr through `signEthereum(chainId, signer, JSON, EthSignType.EIP712)`.
 *
 * `chainId` is the Cosmos chain ID Keplr knows the chain by and `signer` the user's Bech32
 * address. Keplr signs with the account key of that chain directly, so no EVM network needs
 * to be configured in the wallet.
 */
export function keplrTypedDataSigner(opts: {
  readonly keplr: KeplrEthereumSigner;
  readonly chainId: string;
  readonly signer: string;
}): TypedDataSigner {
  return {
    async signTypedData(data) {
      const sig = await opts.keplr.signEthereum(opts.chainId, opts.signer, JSON.stringify(typedDataJson(data)), 'eip-712');
      return normalizeWalletSignature(Uint8Array.from(sig));
    },
  };
}

/**
 * Signs and checks the result: 65 bytes, V 27/28, low S, and recovering to `expected` (the
 * 20 address bytes of the account that must have signed).
 */
export async function signTypedDataAs(
  signer: TypedDataSigner,
  data: TypedData,
  expected: Uint8Array,
): Promise<Uint8Array> {
  const sig = normalizeWalletSignature(await signer.signTypedData(data));
  let recovered: Uint8Array;
  try {
    recovered = ethAddressBytes(recoverEip712PubKey(typedDataDigest(data), sig));
  } catch (cause) {
    throw local('SDK_LOCAL_SIGNER_ADDRESS_MISMATCH', 'the signature does not recover to any key', cause);
  }
  if (!bytesEqual(recovered, expected)) {
    throw local(
      'SDK_LOCAL_SIGNER_ADDRESS_MISMATCH',
      `the ${data.primaryType} signature recovers to 0x${toHex(recovered)}, expected 0x${toHex(expected)} ` +
        '(wrong account selected, or a wallet signing under another chain ID)',
    );
  }
  return sig;
}
