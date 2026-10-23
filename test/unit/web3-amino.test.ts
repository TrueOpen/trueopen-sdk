import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha256';
import {
  AMINO_NAME,
  aminoMsgCancelOrder,
  aminoMsgCreateSession,
  aminoMsgUpdateSessionKey,
  canonicalAminoSignDoc,
  canonicalJson,
  web3Fee,
} from '../../src/transport/amino-json';
import type { AminoMsg } from '../../src/transport/amino-json';
import { cosmosWeb3TypedData } from '../../src/codec/cosmos-web3';
import { eip712DomainSeparator, eip712EncodeType, eip712HashStruct, eip712TypeHash } from '../../src/codec/eip712';
import { privateKeyTypedDataSigner, typedDataDigest } from '../../src/signer/typed-data-signer';
import { ethAddressBytes, recoverEip712PubKey } from '../../src/signer/eth-secp256k1';
import { encodeMsgUpdateSessionKey } from '../../src/transport/task-msgs';
import type { MsgUpdateSessionKey } from '../../src/transport/task-msgs';
import { ACCOUNT_SIGNING, fixtureKey } from '../helpers/account-signing';
import { fromHex, toHex } from '../../src/util/bytes';

/**
 * The Web3 transaction signing bytes, proven against the frozen wire vectors:
 * testdata/v1/task/session_key_amino_v1.json (create / set / clear) and the
 * msg_create_session_transaction block of testdata/v1/shared/account_signing_v1.json.
 * Every SDK-side value is built from SDK inputs (no vector bytes are fed back in), and the
 * typed data is derived by the generic WrapTxToTypedData port, not from a hand-written table.
 */
const AMINO = JSON.parse(readFileSync('third_party/wire/testdata/v1/task/session_key_amino_v1.json', 'utf8')) as {
  cases: {
    name: string;
    canonical_amino_json: string;
    sha256: string;
    encode_type: string;
    hash_struct: string;
    domain_separator: string;
    signing_digest: string;
    signature_65: string;
    recovered_address: string;
    message: Record<string, unknown>;
  }[];
  negative_cases: string[];
  typed_data_chain_id: string;
};

const OWNER: string = ACCOUNT_SIGNING.account.account_bech32;
const GRANT = { sessionKey: new Uint8Array(20).fill(3), expiryHeight: 200n, spendCap: '0' };
const SESSION_ID = `0x${'07'.repeat(32)}`;
const FEE = { amount: [{ denom: 'uusdc', amount: '12345' }], gas: '200000' };
const TYPED_CHAIN_ID = BigInt(AMINO.typed_data_chain_id);

function signDoc(msg: AminoMsg, over: { memo?: string; chainId?: string } = {}): string {
  return canonicalAminoSignDoc({
    chainId: over.chainId ?? 'trueopen-golden-1',
    accountNumber: 7n,
    sequence: 9n,
    fee: FEE,
    memo: over.memo ?? '',
    msgs: [msg],
  });
}

const SDK_MSGS: Record<string, AminoMsg> = {
  create: aminoMsgCreateSession({ signer: OWNER, sessionKey: GRANT }),
  set: aminoMsgUpdateSessionKey({ signer: OWNER, sessionId: SESSION_ID, action: { set: GRANT } }),
  clear: aminoMsgUpdateSessionKey({ signer: OWNER, sessionId: SESSION_ID, action: { clear: true } }),
};

describe('session_key_amino_v1 cases', () => {
  expect(AMINO.cases.map((c) => c.name)).toEqual(['create', 'set', 'clear']);
  for (const c of AMINO.cases) {
    describe(c.name, () => {
      const doc = signDoc(SDK_MSGS[c.name]!);
      const typed = cosmosWeb3TypedData(TYPED_CHAIN_ID, doc);

      it('canonical_amino_json byte for byte, and its sha256', () => {
        expect(doc).toBe(c.canonical_amino_json);
        expect(toHex(sha256(new TextEncoder().encode(doc)))).toBe(c.sha256);
      });
      it('typed data message is the flattened sign doc', () => {
        expect(typed.message).toEqual(c.message);
      });
      it('encode_type, hash_struct, domain_separator, signing_digest', () => {
        expect(eip712EncodeType('Tx', typed.types)).toBe(c.encode_type);
        expect(toHex(eip712HashStruct('Tx', typed.types, typed.message))).toBe(c.hash_struct);
        expect(toHex(eip712DomainSeparator(typed.types, typed.domain))).toBe(c.domain_separator);
        expect(toHex(typedDataDigest(typed))).toBe(c.signing_digest);
      });
      it('the fixture account key reproduces signature_65 and recovered_address', async () => {
        const sig = await privateKeyTypedDataSigner(fixtureKey('account')).signTypedData(typed);
        expect(toHex(sig)).toBe(c.signature_65);
        expect(toHex(ethAddressBytes(recoverEip712PubKey(typedDataDigest(typed), sig)))).toBe(c.recovered_address);
      });
    });
  }

  describe('negative_cases are refused by the builders', () => {
    const inputs: Record<string, unknown> = {
      missing_action: {},
      both_actions: { set: GRANT, clear: true },
      null_set: { set: null },
      null_clear: { clear: null },
      clear_false: { clear: false },
      clear_empty_object: { clear: {} },
    };
    it('covers every vector negative case', () => {
      expect(Object.keys(inputs).sort()).toEqual([...AMINO.negative_cases].sort());
    });
    for (const name of AMINO.negative_cases) {
      it(name, () => {
        const m = { signer: OWNER, sessionId: SESSION_ID, action: inputs[name] } as unknown as MsgUpdateSessionKey;
        expect(() => aminoMsgUpdateSessionKey(m)).toThrow(expect.objectContaining({ code: 'SDK_LOCAL_SESSION_KEY_INVALID' }));
        // The protobuf encoder shares the check, so DIRECT cannot commit the ambiguous action either.
        expect(() => encodeMsgUpdateSessionKey(m)).toThrow(expect.objectContaining({ code: 'SDK_LOCAL_SESSION_KEY_INVALID' }));
      });
    }
  });
});

describe('account_signing_v1 msg_create_session_transaction (Cosmos Web3)', () => {
  const t = ACCOUNT_SIGNING.msg_create_session_transaction;
  const d = ACCOUNT_SIGNING.transaction_domain;
  const msg = aminoMsgCreateSession({ signer: t.signer_address });
  const doc = canonicalAminoSignDoc({
    chainId: t.cosmos_chain_id,
    accountNumber: BigInt(t.account_number),
    sequence: BigInt(t.sequence),
    fee: { amount: [{ denom: t.fee_denom, amount: t.fee_amount }], gas: t.gas },
    memo: t.memo,
    msgs: [msg],
  });
  const typed = cosmosWeb3TypedData(BigInt(t.typed_data_chain_id), doc);

  it('amino name, and no session_key without a grant', () => {
    expect(msg).toEqual({ type: t.amino_name, value: { signer_address: t.signer_address } });
    expect(AMINO_NAME.createSession).toBe(t.amino_name);
  });
  it('canonical_amino_json', () => expect(doc).toBe(t.canonical_amino_json));
  it('encode_type, type_hash and every type_graph line', () => {
    expect(eip712EncodeType('Tx', typed.types)).toBe(t.encode_type);
    expect(toHex(eip712TypeHash('Tx', typed.types))).toBe(t.type_hash);
    for (const line of t.type_graph as string[]) expect(t.encode_type).toContain(line);
  });
  it('domain: encode_type, type_hash, domain_separator', () => {
    expect(eip712EncodeType('EIP712Domain', typed.types)).toBe(d.encode_type);
    expect(toHex(eip712TypeHash('EIP712Domain', typed.types))).toBe(d.type_hash);
    expect(toHex(eip712DomainSeparator(typed.types, typed.domain))).toBe(d.domain_separator);
    expect(typed.domain).toEqual({ name: d.name, version: d.version, chainId: BigInt(d.chain_id), verifyingContract: d.verifying_contract, salt: d.salt });
  });
  it('hash_struct, signing_digest, signature_65', async () => {
    expect(toHex(eip712HashStruct('Tx', typed.types, typed.message))).toBe(t.hash_struct);
    expect(toHex(typedDataDigest(typed))).toBe(t.signing_digest);
    expect(toHex(await privateKeyTypedDataSigner(fixtureKey('account')).signTypedData(typed))).toBe(t.signature_65);
  });
});

/**
 * No wire vector covers MsgCancelOrder yet. These sign docs and digests were produced by the
 * node's own canonicalAminoSignDoc + buildWeb3TypedData (TrueOpen/node 8ea59f3, a test run
 * against the deployed tree), with a memo that exercises Go's HTML-safe escaping.
 */
describe('MsgCancelOrder against the node encoder', () => {
  const memo = 'a<b>&c\u2028\u0001"\\é';
  const head = '{"account_number":"7","chain_id":"trueopen-golden-1","fee":{"amount":[{"amount":"12345","denom":"uusdc"}],"gas":"200000"},' +
    '"memo":"a\\u003cb\\u003e\\u0026c\\u2028\\u0001\\"\\\\é","msgs":[{"type":"trueopen/x/task/MsgCancelOrder","value":{';
  const tail = '"session_id":"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=","signer_address":"trueopen1rfjz7r3u8t65teavh5utquj3kwvsj983p3jclz"}}],"sequence":"9"}';
  for (const [seq, prefix, digest] of [
    [5n, '"order_sequence":"5",', 'b17733992a78184fdb97b8f633601f4d30f940b65098b9bfa0a91a3ecfff607f'],
    [0n, '', '8d6e25cb8e93e6526f4cf1b4d89f843c8902461d2ddd4276f93183597fe155bc'],
  ] as const) {
    it(`order_sequence ${seq}${seq === 0n ? ' (omitempty: absent)' : ''}`, () => {
      const doc = signDoc(aminoMsgCancelOrder({ signer: OWNER, sessionId: SESSION_ID, orderSequence: seq }), { memo });
      expect(doc).toBe(head + prefix + tail);
      expect(toHex(typedDataDigest(cosmosWeb3TypedData(TYPED_CHAIN_ID, doc)))).toBe(digest);
    });
  }
  it('typed data types for the cancel Msg', () => {
    const typed = cosmosWeb3TypedData(TYPED_CHAIN_ID, signDoc(aminoMsgCancelOrder({ signer: OWNER, sessionId: SESSION_ID, orderSequence: 5n })));
    expect(eip712EncodeType('TypeMsgCancelOrder', typed.types)).toBe(
      'TypeMsgCancelOrder(TypeValue value,string type)TypeValue(string signer_address,string session_id,string order_sequence)',
    );
  });
});

describe('canonical JSON and typed data edge cases', () => {
  it('Go encoding/json escaping', () => {
    expect(canonicalJson({ b: '\b\f\n\r\t\u001f', a: '<>&\u2028\u2029', c: [true, false] })).toBe(
      '{"a":"\\u003c\\u003e\\u0026\\u2028\\u2029","b":"\\b\\f\\n\\r\\t\\u001f","c":[true,false]}',
    );
  });
  it('refuses numbers, null and lone surrogates', () => {
    expect(() => canonicalJson(1 as never)).toThrow(/strings, booleans/);
    expect(() => canonicalJson(null as never)).toThrow(/strings, booleans/);
    expect(() => canonicalJson('\ud800')).toThrow(/well-formed/);
  });
  it('fee: auto, payer, granter and non-canonical amounts are refused', () => {
    expect(() => web3Fee('auto')).toThrow(expect.objectContaining({ code: 'SDK_LOCAL_TX_FEE_AUTO' }));
    expect(() => web3Fee({ ...FEE, payer: OWNER })).toThrow(/fee payer/);
    expect(() => web3Fee({ ...FEE, granter: OWNER })).toThrow(/fee granter/);
    expect(() => web3Fee({ ...FEE, gas: '01' })).toThrow(/gas/);
    expect(() => web3Fee({ ...FEE, amount: [{ denom: 'uusdc', amount: '1.5' }] })).toThrow(/amount/);
  });
  it('repeated object shapes reuse a type; a different shape at the same path gets index 1', () => {
    const doc = (msgs: unknown[]) =>
      JSON.stringify({ account_number: '0', chain_id: 'c', fee: { amount: [], gas: '0' }, memo: '', msgs, sequence: '0' });
    const same = cosmosWeb3TypedData(1n, doc([{ type: 'x/MsgA', value: { a: 'x' } }, { type: 'x/MsgB', value: { a: 'y' } }]));
    expect(same.types.Tx!.slice(5)).toEqual([{ name: 'msg0', type: 'TypeMsgA' }, { name: 'msg1', type: 'TypeMsgB' }]);
    expect(same.types.TypeValue).toEqual([{ name: 'a', type: 'string' }]);
    const differ = cosmosWeb3TypedData(1n, doc([{ type: 'x/MsgA', value: { a: 'x' } }, { type: 'x/MsgB', value: { b: true, l: ['p'], e: [] } }]));
    expect(differ.types.TypeValue1).toEqual([{ name: 'l', type: 'string[]' }, { name: 'e', type: 'string[]' }, { name: 'b', type: 'bool' }]);
    expect(differ.types.TypeMsgB).toEqual([{ name: 'value', type: 'TypeValue1' }, { name: 'type', type: 'string' }]);
  });
  it('arrays of objects take the first element type', () => {
    const doc = JSON.stringify({ account_number: '0', chain_id: 'c', fee: { amount: [], gas: '0' }, memo: '', msgs: [{ type: 'x/M', value: { items: [{ k: 'a' }, { k: 'b' }] } }], sequence: '0' });
    const typed = cosmosWeb3TypedData(1n, doc);
    expect(typed.types.TypeValue).toEqual([{ name: 'items', type: 'TypeValueItems[]' }]);
    expect(typed.types.TypeValueItems).toEqual([{ name: 'k', type: 'string' }]);
  });
  it('refuses what the node would not sign: numbers, null, mixed arrays, extra top-level keys, bad chain id', () => {
    const doc = (value: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ account_number: '0', chain_id: 'c', fee: { amount: [], gas: '0' }, memo: '', msgs: [{ type: 'x/M', value }], sequence: '0', ...extra });
    expect(() => cosmosWeb3TypedData(1n, doc({ n: 1 }))).toThrow(/numbers/);
    expect(() => cosmosWeb3TypedData(1n, doc({ n: null }))).toThrow(/null/);
    expect(() => cosmosWeb3TypedData(1n, doc({ n: ['a', true] }))).toThrow(/mixes/);
    expect(() => cosmosWeb3TypedData(1n, doc({ a: 'x' }, { extra: 'y' }))).toThrow(/outside the Tx type/);
    expect(() => cosmosWeb3TypedData(0n, doc({ a: 'x' }))).toThrow(/MaxInt64/);
    expect(() => cosmosWeb3TypedData(1n << 63n, doc({ a: 'x' }))).toThrow(/MaxInt64/);
  });
  it('a vector fixture chain id other than the carried one changes the digest', () => {
    const doc = signDoc(SDK_MSGS.create!);
    expect(toHex(typedDataDigest(cosmosWeb3TypedData(424243n, doc)))).not.toBe(AMINO.cases[0]!.signing_digest);
    expect(fromHex(AMINO.cases[0]!.signing_digest)).toHaveLength(32);
  });
});
