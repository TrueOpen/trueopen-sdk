import { TrueOpenError } from '../errors/errors';
import type { Eip712Field, Eip712Struct, Eip712Value } from './eip712';
import type { TypedData } from '../signer/typed-data-signer';

/**
 * The EIP-712 typed data of a Cosmos Web3 transaction, as the node derives it (app/account_ante.go
 * buildWeb3TypedData): cosmos-evm v0.6.3 `eip712.WrapTxToTypedData` over the canonical Amino sign
 * doc, then TrueOpen's rename of first-occurrence `Type...0` names to `Type...`.
 *
 * WrapTxToTypedData (ethereum/eip712/{eip712,message,types,domain}.go):
 *  - the message is the sign doc with `msgs` replaced by `msg0..msgN-1`;
 *  - Tx / Fee / Coin are fixed tables, each Msg adds `msg{i}` to Tx;
 *  - a Msg's types are inferred from its JSON: the root is `Type` + the last `/` segment of its
 *    amino type, a nested object at path `_.a.b_c` is `TypeABC` (each `.` / `_` part title-cased),
 *    fields are listed in **descending** key order, an array takes the type of its first element
 *    (`string[]` when empty), booleans are `bool`, numbers `int64`, strings `string`;
 *  - every type name is stored with a duplicate index (`TypeValue0`, then `TypeValue1` for a
 *    differently shaped object at the same path), and an identical re-definition reuses its name;
 *  - the domain is {name "Cosmos Web3", version "1.0.0", chainId, verifyingContract "cosmos",
 *    salt "0"}, verifyingContract and salt typed `string`.
 * TrueOpen then drops the trailing `0` of every `Type...0` name (and of each reference to it).
 */

const ROOT_PREFIX = '_';
const TYPE_PREFIX = 'Type';
const MAX_DUPLICATE_TYPE_DEFS = 1000;

type Types = Record<string, Eip712Field[]>;
type Json = string | boolean | number | null | Json[] | { [key: string]: Json };

function malformed(why: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_WEB3_TYPED_DATA_INVALID', `Cosmos Web3 typed data: ${why}`);
}

function isObject(v: Json | undefined): v is { [key: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Keys this encoder can title-case exactly as Go's `cases.Title(language.English, cases.NoLower)`
 * does: ASCII snake_case, every part starting with a lowercase letter. Amino field names are
 * proto field names, which always fit.
 */
const FIELD_NAME = /^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)*$/;

/** `_.foo_bar.baz` -> `TypeFooBarBaz` (types.go sanitizeTypedef). */
function sanitizeTypedef(path: string): string {
  let out = '';
  for (const part of path.split('.')) {
    if (part === ROOT_PREFIX) {
      out += TYPE_PREFIX;
      continue;
    }
    for (const sub of part.split('_')) out += sub.charAt(0).toUpperCase() + sub.slice(1);
  }
  return out;
}

function typesEqual(a: readonly Eip712Field[], b: readonly Eip712Field[]): boolean {
  return a.length === b.length && a.every((f, i) => f.name === b[i]!.name && f.type === b[i]!.type);
}

/** types.go addTypesToRoot: stores under `typeDef{n}`, reusing an identical definition. */
function addTypesToRoot(types: Types, typeDef: string, fields: Eip712Field[]): string {
  for (let index = 0; index < MAX_DUPLICATE_TYPE_DEFS; index++) {
    const name = `${typeDef}${index}`;
    const existing = types[name];
    if (existing === undefined) {
      types[name] = fields;
      return name;
    }
    if (typesEqual(fields, existing)) return name;
  }
  throw malformed('exceeded the maximum number of duplicates for a single type definition');
}

/** Go strings.Compare order (byte-wise UTF-8 = code point order), descending. */
function descending(a: string, b: string): number {
  if (a === b) return 0;
  const ca = Array.from(a).map((c) => c.codePointAt(0)!);
  const cb = Array.from(b).map((c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    if (ca[i] !== cb[i]) return cb[i]! - ca[i]!;
  }
  return cb.length - ca.length;
}

function primitiveType(v: Json): string {
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return 'string';
  // Amino writes 64-bit integers as strings; a JSON number would go through Go float64 and
  // geth's int64 parsing, which this encoder does not reproduce.
  if (typeof v === 'number') throw malformed('JSON numbers are not supported in a signed Msg');
  return '';
}

/** types.go recursivelyAddTypesToRoot. */
function addObjectTypes(types: Types, rootType: string, prefix: string, payload: { [key: string]: Json }): string {
  // geth trims a trailing comma when it writes an encodeType, so an empty struct becomes "Name)"
  // where the EIP-712 rule (and this code) gives "Name()": the digests would differ. No user Msg
  // produces one; refuse it rather than sign something the node computes differently.
  if (Object.keys(payload).length === 0) throw malformed(`object ${JSON.stringify(prefix)} is empty`);
  const fields: Eip712Field[] = [];
  for (const name of Object.keys(payload).sort(descending)) {
    if (!FIELD_NAME.test(name)) throw malformed(`field name ${JSON.stringify(name)} is not snake_case`);
    let field = payload[name]!;
    let collection = false;
    if (Array.isArray(field)) {
      if (field.length === 0) {
        fields.push({ name, type: 'string[]' });
        continue;
      }
      const first = field[0]!;
      // geth encodes every element with the first one's type, so mixed arrays cannot sign.
      const shape = (v: Json): string => (isObject(v) ? `{${Object.keys(v).sort().join(',')}}` : Array.isArray(v) ? '[]' : typeof v);
      if (field.some((e) => shape(e) !== shape(first))) throw malformed(`array ${name} mixes element shapes`);
      field = first;
      collection = true;
    }
    if (field === null) throw malformed(`field ${name} is null`);
    if (Array.isArray(field)) throw malformed(`nested array ${name} is not supported by EIP-712`);
    const primitive = primitiveType(field);
    if (primitive !== '') {
      fields.push({ name, type: collection ? `${primitive}[]` : primitive });
      continue;
    }
    const nested = sanitizeTypedef(addObjectTypes(types, rootType, `${prefix}.${name}`, field as { [key: string]: Json }));
    fields.push({ name, type: collection ? `${nested}[]` : nested });
  }
  return addTypesToRoot(types, prefix === ROOT_PREFIX ? rootType : sanitizeTypedef(prefix), fields);
}

/** buildWeb3TypedData's rename: `Type...0` -> `Type...`, refusing a name that already exists. */
function renameFirstOccurrences(types: Types): Types {
  const renames = new Map<string, string>();
  for (const name of Object.keys(types)) {
    if (name.startsWith(TYPE_PREFIX) && name.endsWith('0')) {
      const base = name.slice(0, -1);
      if (types[base] !== undefined) throw malformed(`ambiguous EIP-712 type names ${name} and ${base}`);
      renames.set(name, base);
    }
  }
  const out: Types = {};
  for (const [name, fields] of Object.entries(types)) {
    out[renames.get(name) ?? name] = fields.map((f) => {
      const array = f.type.endsWith('[]');
      const base = array ? f.type.slice(0, -2) : f.type;
      const renamed = renames.get(base);
      return renamed === undefined ? f : { name: f.name, type: array ? `${renamed}[]` : renamed };
    });
  }
  return out;
}

/** The fixed tables of createEIP712Types (types.go). */
function baseTypes(): Types {
  return {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'string' },
      { name: 'salt', type: 'string' },
    ],
    Tx: [
      { name: 'account_number', type: 'string' },
      { name: 'chain_id', type: 'string' },
      { name: 'fee', type: 'Fee' },
      { name: 'memo', type: 'string' },
      { name: 'sequence', type: 'string' },
    ],
    Fee: [
      { name: 'amount', type: 'Coin[]' },
      { name: 'gas', type: 'string' },
    ],
    Coin: [
      { name: 'denom', type: 'string' },
      { name: 'amount', type: 'string' },
    ],
  };
}

/** The Cosmos Web3 EIP-712 domain (domain.go createEIP712Domain). */
export function cosmosWeb3Domain(typedDataChainId: bigint): Eip712Struct {
  return { name: 'Cosmos Web3', version: '1.0.0', chainId: typedDataChainId, verifyingContract: 'cosmos', salt: '0' };
}

const TYPE_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * Builds the typed data the node verifies a Web3 transaction against, from the exact canonical
 * Amino sign doc bytes that the transaction commits to.
 */
export function cosmosWeb3TypedData(typedDataChainId: bigint, signDoc: string): TypedData {
  if (typedDataChainId < 1n || typedDataChainId > (1n << 63n) - 1n) {
    throw malformed(`typed_data_chain_id ${typedDataChainId} is outside 1..MaxInt64`);
  }
  let payload: Json;
  try {
    payload = JSON.parse(signDoc) as Json;
  } catch {
    throw malformed('the sign doc is not valid JSON');
  }
  if (!isObject(payload)) throw malformed('the sign doc is not a JSON object');
  const rawMsgs = payload.msgs;
  if (rawMsgs === undefined) throw malformed('no messages found in the sign doc');
  const msgs = rawMsgs === null ? [] : rawMsgs;
  if (!Array.isArray(msgs)) throw malformed('msgs is not an array');

  // message.go FlattenPayloadMessages: msgs[i] -> msg{i}, then drop msgs.
  const message: { [key: string]: Json } = {};
  for (const [k, v] of Object.entries(payload)) if (k !== 'msgs') message[k] = v;
  const types = baseTypes();
  msgs.forEach((msg, i) => {
    const field = `msg${i}`;
    if (field in payload) throw malformed(`did not expect to find key ${field}`);
    if (!isObject(msg)) throw malformed(`msg at index ${i} is not a JSON object`);
    message[field] = msg;
    // types.go msgRootType: cosmos-sdk/MsgSend -> TypeMsgSend.
    const msgType = msg.type;
    if (typeof msgType !== 'string' || msgType === '') throw malformed('malformed message type value, expected type string');
    const segments = msgType.split('/');
    const rootType = `${TYPE_PREFIX}${segments[segments.length - 1]}`;
    types.Tx!.push({ name: field, type: addObjectTypes(types, rootType, ROOT_PREFIX, msg) });
  });

  // geth refuses a struct value with more keys than its type declares.
  if (Object.keys(message).length !== types.Tx!.length) throw malformed('the sign doc has fields outside the Tx type');
  const renamed = renameFirstOccurrences(types);
  for (const name of Object.keys(renamed)) if (!TYPE_NAME.test(name)) throw malformed(`type name ${JSON.stringify(name)} is not valid`);
  return {
    types: renamed,
    primaryType: 'Tx',
    domain: cosmosWeb3Domain(typedDataChainId),
    message: message as unknown as { [key: string]: Eip712Value },
  };
}
