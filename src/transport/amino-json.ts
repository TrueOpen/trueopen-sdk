import type { StdFee } from '@cosmjs/stargate';
import { strictHash32 } from '../codec/hash32';
import { TrueOpenError } from '../errors/errors';
import { TYPE_URL, sessionKeyAction, validateGrant } from './task-msgs';
import type { MsgCancelOrder, MsgCreateSession, MsgUpdateSessionKey, SessionKeyGrant } from './task-msgs';

/**
 * Legacy Amino JSON for the task.v1 user Msgs and the canonical StdSignDoc the node signs
 * over on its Web3 path (SIGN_MODE_LEGACY_AMINO_JSON + ExtensionOptionsWeb3Tx).
 *
 * The node builds the sign doc in app/account_ante.go canonicalAminoSignDoc: each Msg is
 * `amino.MarshalJSON(msg)` under the amino.name registered in x/task/types/codec.go, the
 * document is `{account_number, chain_id, fee{amount[{amount,denom}], gas}, memo, msgs,
 * sequence}` with every integer as a decimal string, and `sdk.SortJSON` re-encodes the result
 * with Go's encoding/json: keys sorted, no whitespace, and `<`, `>`, `&`, U+2028 and U+2029
 * escaped as \u003c, \u003e, \u0026, \u2028 and \u2029. The encoder below reproduces that byte for byte (wire
 * testdata/v1/task/session_key_amino_v1.json and the msg_create_session_transaction block of
 * testdata/v1/shared/account_signing_v1.json freeze it).
 *
 * Amino JSON follows the Go struct tags: `omitempty` drops an empty string, a zero uint64 and
 * empty bytes; uint64 is a decimal string and bytes are standard (padded) Base64.
 */

/** A JSON value as Amino produces it for these Msgs: no numbers, no null. */
export type AminoJsonValue = string | boolean | readonly AminoJsonValue[] | { readonly [key: string]: AminoJsonValue };

/** One Amino Msg: `{ type: amino.name, value }`. */
export interface AminoMsg {
  readonly type: string;
  readonly value: { readonly [key: string]: AminoJsonValue };
}

/** The amino.name of each task user Msg, as node x/task/types/codec.go registers it. */
export const AMINO_NAME = {
  createSession: 'trueopen/x/task/MsgCreateSession',
  updateSessionKey: 'trueopen/x/task/MsgUpdateSessionKey',
  cancelOrder: 'trueopen/x/task/MsgCancelOrder',
} as const;

function local(code: string, message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', code, message);
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** SessionKeyGrantV1: session_key and expiry_height are omitempty, spend_cap is not. */
function aminoGrant(g: SessionKeyGrant): { [key: string]: AminoJsonValue } {
  validateGrant(g);
  // validateGrant guarantees a 20-byte key, a non-zero expiry and a non-empty cap, so no
  // omitempty field is dropped here.
  return {
    session_key: base64(g.sessionKey),
    expiry_height: g.expiryHeight.toString(10),
    spend_cap: { atomic_units: g.spendCap },
  };
}

/** `trueopen/x/task/MsgCreateSession`: `{signer_address, session_key?}`; no grant, no key. */
export function aminoMsgCreateSession(m: MsgCreateSession): AminoMsg {
  const value: { [key: string]: AminoJsonValue } = {};
  if (m.signer !== '') value.signer_address = m.signer;
  if (m.sessionKey !== undefined) value.session_key = aminoGrant(m.sessionKey);
  return { type: AMINO_NAME.createSession, value };
}

/**
 * `trueopen/x/task/MsgUpdateSessionKey`: the node's SessionKeyUpdateAmino view
 * (x/task/types/session_key_amino.go), `{signer_address, session_id, set}` or
 * `{signer_address, session_id, clear: true}`. signer_address and session_id carry no
 * omitempty in that view.
 */
export function aminoMsgUpdateSessionKey(m: MsgUpdateSessionKey): AminoMsg {
  const action = sessionKeyAction(m.action);
  const value: { [key: string]: AminoJsonValue } = {
    signer_address: m.signer,
    session_id: base64(strictHash32('session_id', m.sessionId)),
  };
  if (action.set !== undefined) value.set = aminoGrant(action.set);
  else value.clear = true;
  return { type: AMINO_NAME.updateSessionKey, value };
}

/**
 * `trueopen/x/task/MsgCancelOrder`: `{session_id, order_sequence, signer_address}`, every field
 * omitempty, so order_sequence 0 is absent (checked against the node's own encoder).
 */
export function aminoMsgCancelOrder(m: MsgCancelOrder): AminoMsg {
  if (m.orderSequence < 0n || m.orderSequence >= 1n << 64n) {
    throw local('SDK_LOCAL_TX_MSG_INVALID', `order_sequence must fit a u64, got ${m.orderSequence}`);
  }
  const value: { [key: string]: AminoJsonValue } = {
    session_id: base64(strictHash32('session_id', m.sessionId)),
  };
  if (m.orderSequence !== 0n) value.order_sequence = m.orderSequence.toString(10);
  if (m.signer !== '') value.signer_address = m.signer;
  return { type: AMINO_NAME.cancelOrder, value };
}

/** The Amino form of a task user Msg given as a CosmJS EncodeObject (the writer's Msg shape). */
export function aminoMsgFromEncodeObject(msg: { readonly typeUrl: string; readonly value: unknown }): AminoMsg {
  switch (msg.typeUrl) {
    case TYPE_URL.createSession:
      return aminoMsgCreateSession(msg.value as MsgCreateSession);
    case TYPE_URL.updateSessionKey:
      return aminoMsgUpdateSessionKey(msg.value as MsgUpdateSessionKey);
    case TYPE_URL.cancelOrder:
      return aminoMsgCancelOrder(msg.value as MsgCancelOrder);
    default:
      throw local('SDK_LOCAL_TX_MSG_UNSUPPORTED', `no Amino JSON form for ${msg.typeUrl} on the Web3 path`);
  }
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const U64_MAX = (1n << 64n) - 1n;

/**
 * Checks a fee for the Web3 path: explicit (the node only simulates DIRECT transactions, so
 * 'auto' cannot be estimated), canonical decimal amounts and gas, and no payer or granter (the
 * node refuses fee delegation on this path).
 */
export function web3Fee(fee: StdFee | 'auto'): StdFee {
  if (fee === 'auto') {
    throw local('SDK_LOCAL_TX_FEE_AUTO', "the Web3 path needs an explicit fee: the node cannot simulate it, so fee 'auto' is not supported");
  }
  if (fee.payer !== undefined && fee.payer !== '') throw local('SDK_LOCAL_TX_FEE_INVALID', 'the Web3 path does not support a fee payer');
  if (fee.granter !== undefined && fee.granter !== '') throw local('SDK_LOCAL_TX_FEE_INVALID', 'the Web3 path does not support a fee granter');
  if (!DECIMAL.test(fee.gas) || BigInt(fee.gas) > U64_MAX) {
    throw local('SDK_LOCAL_TX_FEE_INVALID', `fee gas must be a canonical u64 decimal, got ${JSON.stringify(fee.gas)}`);
  }
  for (const coin of fee.amount) {
    if (!DECIMAL.test(coin.amount)) {
      throw local('SDK_LOCAL_TX_FEE_INVALID', `fee amount must be a canonical decimal, got ${JSON.stringify(coin.amount)}`);
    }
    if (coin.denom === '') throw local('SDK_LOCAL_TX_FEE_INVALID', 'fee denom must not be empty');
  }
  return fee;
}

export interface AminoSignDocInput {
  /** The Cosmos chain-id string (not the EIP-712 domain chainId). */
  readonly chainId: string;
  readonly accountNumber: bigint;
  readonly sequence: bigint;
  readonly fee: StdFee;
  readonly memo: string;
  readonly msgs: readonly AminoMsg[];
}

/** The canonical (key-sorted, Go-escaped) Amino StdSignDoc bytes, as a string. */
export function canonicalAminoSignDoc(input: AminoSignDocInput): string {
  const fee = web3Fee(input.fee);
  return canonicalJson({
    account_number: u64Text('account_number', input.accountNumber),
    chain_id: input.chainId,
    fee: { amount: fee.amount.map((c) => ({ amount: c.amount, denom: c.denom })), gas: fee.gas },
    memo: input.memo,
    msgs: input.msgs.map((m) => ({ type: m.type, value: m.value })),
    sequence: u64Text('sequence', input.sequence),
  });
}

function u64Text(field: string, v: bigint): string {
  if (v < 0n || v > U64_MAX) throw local('SDK_LOCAL_TX_MSG_INVALID', `${field} must fit a u64, got ${v}`);
  return v.toString(10);
}

/** Go's json key order: byte-wise on UTF-8, which is code point order. */
function compareKeys(a: string, b: string): number {
  const ca = Array.from(a);
  const cb = Array.from(b);
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    const d = ca[i]!.codePointAt(0)! - cb[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return ca.length - cb.length;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A string as Go's encoding/json writes it (HTML-safe, U+2028/U+2029 escaped). */
function goJsonString(s: string): string {
  // Go would replace a lone surrogate with U+FFFD and sign something other than the input.
  if (LONE_SURROGATE.test(s)) throw local('SDK_LOCAL_TX_MSG_INVALID', 'a signed string is not well-formed UTF-16');
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20 || ch === '<' || ch === '>' || ch === '&' || c === 0x2028 || c === 0x2029) {
      out += `\\u${c.toString(16).padStart(4, '0')}`;
    } else out += ch;
  }
  return `${out}"`;
}

/**
 * The canonical JSON of an Amino value: Go `sdk.SortJSON` output. Numbers and null are refused:
 * Amino writes 64-bit integers as strings and these Msgs carry neither.
 */
export function canonicalJson(value: AminoJsonValue): string {
  if (typeof value === 'string') return goJsonString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${(value as readonly AminoJsonValue[]).map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array)) {
    const obj = value as { readonly [key: string]: AminoJsonValue };
    const keys = Object.keys(obj).sort(compareKeys);
    return `{${keys.map((k) => `${goJsonString(k)}:${canonicalJson(obj[k]!)}`).join(',')}}`;
  }
  throw local('SDK_LOCAL_TX_MSG_INVALID', `Amino JSON supports strings, booleans, arrays and objects, got ${typeof value}`);
}
