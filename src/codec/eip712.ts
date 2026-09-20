import { keccak_256 } from '@noble/hashes/sha3';
import { concatBytes } from '../util/bytes';
import { TrueOpenError } from '../errors/errors';

/**
 * EIP-712 typed-data encoding (as of wire v0.4.1, accounts, orders, and retrieval-credential
 * requests are all signed against this digest scheme).
 *
 * wire publishes a full vector for all three domains (testdata/v1/shared/account_signing_v1.json),
 * each one giving type_hash / domain_separator / hash_struct / signing_digest / signature_65:
 *   - "Cosmos Web3"  v1.0.0  on-chain tx (amino JSON + ExtensionOptionsWeb3Tx)
 *   - "TrueOpen Task Order"  v2  SignedOrderV2.user_signature
 *   - "TrueOpen Task Data Request"  v1  the USER branch of TaskDataRequestAuthV1
 *
 * This module implements only the EIP-712 standard itself (encodeType / hashStruct / signing
 * digest); it carries no TrueOpen-specific semantics -- the caller passes in the domain and
 * message types as declared by the contract.
 *
 * Note the distinction from H_FIELDS_V1 (codec/domain-hash.ts): that scheme is sha256 plus an
 * 8-byte length-prefixed frame, whereas this one is keccak256 plus a 32-byte fixed-width word.
 * Both coexist in v0.4.1, and signing with the wrong one will always fail on-chain verification.
 */

const enc = new TextEncoder();

/** The declaration of one struct field, corresponding to EIP-712's `{ name, type }`. */
export interface Eip712Field {
  readonly name: string;
  readonly type: string;
}

/** Type table: struct name -> list of field declarations. The domain type is keyed by "EIP712Domain". */
export type Eip712Types = Readonly<Record<string, readonly Eip712Field[]>>;

/** A message value; an integer can be a bigint / number / decimal string, and bytes use Uint8Array. */
export type Eip712Value =
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
  | readonly Eip712Value[]
  | { readonly [key: string]: Eip712Value };

export type Eip712Struct = { readonly [key: string]: Eip712Value };

function malformed(what: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'EIP712_MALFORMED', `EIP-712: ${what}`);
}

/** Strips the array suffix and returns the element type; `Coin[]` -> `Coin`, `uint8[3]` -> `uint8`. */
function arrayElementType(type: string): string | undefined {
  const at = type.lastIndexOf('[');
  if (at === -1 || !type.endsWith(']')) return undefined;
  return type.slice(0, at);
}

/**
 * Collects every struct name that primaryType references, directly or indirectly
 * (excluding itself).
 * EIP-712 requires that in encodeType, referenced types are listed after the primary
 * type in **lexicographic order by name**.
 */
function referencedStructs(primaryType: string, types: Eip712Types): string[] {
  const found = new Set<string>();
  const walk = (name: string): void => {
    const fields = types[name];
    if (fields === undefined) throw malformed(`type ${name} is not declared`);
    for (const f of fields) {
      const base = arrayElementType(f.type) ?? f.type;
      if (types[base] === undefined || base === primaryType || found.has(base)) continue;
      found.add(base);
      walk(base);
    }
  };
  walk(primaryType);
  return [...found].sort();
}

/** `Tx(string account_number,...)Coin(string denom,string amount)Fee(Coin[] amount,string gas)…` */
export function eip712EncodeType(primaryType: string, types: Eip712Types): string {
  const one = (name: string): string => {
    const fields = types[name];
    if (fields === undefined) throw malformed(`type ${name} is not declared`);
    return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
  };
  return one(primaryType) + referencedStructs(primaryType, types).map(one).join('');
}

/** keccak256(encodeType). */
export function eip712TypeHash(primaryType: string, types: Eip712Types): Uint8Array {
  return keccak_256(enc.encode(eip712EncodeType(primaryType, types)));
}

/** Writes an integer as a 32-byte big-endian word in two's complement (EIP-712's fixed-width encoding). */
function word(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  if (v < 0n) v += 1n << 256n;
  if (v < 0n || v >= 1n << 256n) throw malformed(`integer out of 256-bit range: ${value}`);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function toBigInt(value: Eip712Value, type: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw malformed(`${type} value must be an integer, got ${value}`);
    return BigInt(value);
  }
  // Integers in the vectors are decimal strings ("424242" / "7"); parse them per the declared type instead of hashing them as text.
  if (typeof value === 'string') {
    if (!/^-?[0-9]+$/.test(value)) throw malformed(`${type} value must be decimal, got ${JSON.stringify(value)}`);
    return BigInt(value);
  }
  throw malformed(`${type} value must be an integer`);
}

/** Encodes one field value as a 32-byte word (a dynamic type is hashed first). */
function encodeValue(type: string, value: Eip712Value, types: Eip712Types): Uint8Array {
  const elem = arrayElementType(type);
  if (elem !== undefined) {
    if (!Array.isArray(value)) throw malformed(`${type} value must be an array`);
    return keccak_256(concatBytes(...value.map((v) => encodeValue(elem, v as Eip712Value, types))));
  }

  if (types[type] !== undefined) {
    if (typeof value !== 'object' || value === null || value instanceof Uint8Array || Array.isArray(value)) {
      throw malformed(`${type} value must be a struct`);
    }
    return eip712HashStruct(type, types, value as Eip712Struct);
  }

  if (type === 'string') {
    if (typeof value !== 'string') throw malformed('string value must be a string');
    return keccak_256(enc.encode(value));
  }
  if (type === 'bytes') {
    if (!(value instanceof Uint8Array)) throw malformed('bytes value must be Uint8Array');
    return keccak_256(value);
  }
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw malformed('bool value must be a boolean');
    return word(value ? 1n : 0n);
  }
  if (type === 'address') {
    if (!(value instanceof Uint8Array) || value.length !== 20) throw malformed('address value must be 20 bytes');
    const out = new Uint8Array(32);
    out.set(value, 12);
    return out;
  }

  const fixedBytes = /^bytes([0-9]{1,2})$/.exec(type);
  if (fixedBytes !== null) {
    const n = Number(fixedBytes[1]);
    if (n < 1 || n > 32) throw malformed(`unsupported fixed bytes width ${type}`);
    if (!(value instanceof Uint8Array) || value.length !== n) {
      throw malformed(`${type} value must be exactly ${n} bytes`);
    }
    // bytesN is **left-aligned** with zero padding on the right, the opposite of an integer's right alignment.
    const out = new Uint8Array(32);
    out.set(value, 0);
    return out;
  }

  if (/^uint([0-9]+)$/.test(type)) {
    const v = toBigInt(value, type);
    if (v < 0n) throw malformed(`${type} value must not be negative`);
    return word(v);
  }
  if (/^int([0-9]+)$/.test(type)) return word(toBigInt(value, type));

  throw malformed(`unsupported field type ${type}`);
}

/** keccak256(typeHash || each field's 32-byte word, in order). */
export function eip712HashStruct(
  primaryType: string,
  types: Eip712Types,
  value: Eip712Struct,
): Uint8Array {
  const fields = types[primaryType];
  if (fields === undefined) throw malformed(`type ${primaryType} is not declared`);
  const words = fields.map((f) => {
    const v = value[f.name];
    if (v === undefined) throw malformed(`${primaryType}.${f.name} is missing`);
    return encodeValue(f.type, v, types);
  });
  return keccak_256(concatBytes(eip712TypeHash(primaryType, types), ...words));
}

/**
 * domainSeparator = hashStruct("EIP712Domain", domain).
 * Both forms are determined entirely by the type table itself; there is no branching here:
 *   - EIP712Domain(string name,string version,uint256 chainId)
 *   - EIP712Domain(string name,string version,uint256 chainId,string verifyingContract,string salt)
 * Note that in the tx domain, verifyingContract and salt are declared as **string**, not
 * address/bytes32.
 */
export function eip712DomainSeparator(types: Eip712Types, domain: Eip712Struct): Uint8Array {
  return eip712HashStruct('EIP712Domain', types, domain);
}

/** The final signing digest: keccak256(0x19 0x01 || domainSeparator || hashStruct). */
export function eip712SigningDigest(domainSeparator: Uint8Array, hashStruct: Uint8Array): Uint8Array {
  if (domainSeparator.length !== 32) throw malformed('domain separator must be 32 bytes');
  if (hashStruct.length !== 32) throw malformed('hash struct must be 32 bytes');
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), domainSeparator, hashStruct));
}

/** Computes the signing digest in one step: the domain type and message type share the same type table. */
export function eip712Digest(
  types: Eip712Types,
  domain: Eip712Struct,
  primaryType: string,
  message: Eip712Struct,
): Uint8Array {
  return eip712SigningDigest(
    eip712DomainSeparator(types, domain),
    eip712HashStruct(primaryType, types, message),
  );
}
