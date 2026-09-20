import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  eip712EncodeType,
  eip712TypeHash,
  eip712HashStruct,
  eip712DomainSeparator,
  eip712SigningDigest,
} from '../../src/codec/eip712';
import type { Eip712Types } from '../../src/codec/eip712';
import { toHex, fromHex } from '../../src/util/bytes';

/**
 * Anchor: wire v0.4.1's testdata/v1/shared/account_signing_v1.json.
 * This file is published byte-for-byte by wire per the monorepo's "Account and Signing
 * Protocol" doc, and is a cross-language vector shared by all three parties.
 * This test **reads that file directly from the submodule** rather than copying it into a
 * local constant - copying it would create a second source of truth.
 */
const VECTOR_PATH = 'third_party/wire/testdata/v1/shared/account_signing_v1.json';
const v = JSON.parse(readFileSync(VECTOR_PATH, 'utf8'));

/** Domain without verifyingContract / salt (shared by orders and data-retrieval requests). */
const SHORT_DOMAIN: Eip712Types = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
  ],
};

/** Domain for on-chain tx: verifyingContract and salt are declared as string, not address/bytes32. */
const TX_DOMAIN: Eip712Types = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'string' },
    { name: 'salt', type: 'string' },
  ],
};

describe('EIP712Domain', () => {
  it('short-domain encode_type and type_hash (shared by the order and the data-retrieval request)', () => {
    expect(eip712EncodeType('EIP712Domain', SHORT_DOMAIN)).toBe(v.task_order.domain.encode_type);
    expect(toHex(eip712TypeHash('EIP712Domain', SHORT_DOMAIN))).toBe(v.task_order.domain.type_hash);
    // The same encode_type must yield the same type_hash - the vector writes it out in both places, so this asserts they match.
    expect(v.task_data_request.domain.type_hash).toBe(v.task_order.domain.type_hash);
  });

  it('tx-domain encode_type and type_hash', () => {
    expect(eip712EncodeType('EIP712Domain', TX_DOMAIN)).toBe(v.transaction_domain.encode_type);
    expect(toHex(eip712TypeHash('EIP712Domain', TX_DOMAIN))).toBe(v.transaction_domain.type_hash);
  });

  it('tx domain separator', () => {
    const d = v.transaction_domain;
    expect(
      toHex(
        eip712DomainSeparator(TX_DOMAIN, {
          name: d.name,
          version: d.version,
          chainId: d.chain_id,
          verifyingContract: d.verifying_contract,
          salt: d.salt,
        }),
      ),
    ).toBe(d.domain_separator);
  });

  it('order domain separator', () => {
    const d = v.task_order.domain;
    expect(toHex(eip712DomainSeparator(SHORT_DOMAIN, { name: d.name, version: d.version, chainId: d.chain_id }))).toBe(
      d.domain_separator,
    );
  });

  it('data-retrieval request domain separator', () => {
    const d = v.task_data_request.domain;
    expect(toHex(eip712DomainSeparator(SHORT_DOMAIN, { name: d.name, version: d.version, chainId: d.chain_id }))).toBe(
      d.domain_separator,
    );
  });
});

describe('TrueOpen Task Order', () => {
  const TYPES: Eip712Types = {
    ...SHORT_DOMAIN,
    TaskOrder: [
      { name: 'chainId', type: 'string' },
      { name: 'user', type: 'string' },
      { name: 'sessionId', type: 'bytes32' },
      { name: 'orderSequence', type: 'uint64' },
      { name: 'modelId', type: 'string' },
      { name: 'profileVersion', type: 'uint32' },
      { name: 'maxFee', type: 'string' },
      { name: 'feeDenom', type: 'string' },
      { name: 'earliestSubmitHeight', type: 'uint64' },
      { name: 'orderExpireHeight', type: 'uint64' },
      { name: 'taskHash', type: 'bytes32' },
    ],
  };
  const m = v.task_order.message;
  const message = {
    chainId: m.chainId,
    user: m.user,
    sessionId: fromHex(m.sessionId),
    orderSequence: m.orderSequence,
    modelId: m.modelId,
    profileVersion: m.profileVersion,
    maxFee: m.maxFee,
    feeDenom: m.feeDenom,
    earliestSubmitHeight: m.earliestSubmitHeight,
    orderExpireHeight: m.orderExpireHeight,
    taskHash: fromHex(m.taskHash),
  };

  it('encode_type', () => expect(eip712EncodeType('TaskOrder', TYPES)).toBe(v.task_order.encode_type));
  it('type_hash', () => expect(toHex(eip712TypeHash('TaskOrder', TYPES))).toBe(v.task_order.type_hash));
  it('hash_struct', () => expect(toHex(eip712HashStruct('TaskOrder', TYPES, message))).toBe(v.task_order.hash_struct));
  it('signing_digest', () => {
    const d = v.task_order.domain;
    const sep = eip712DomainSeparator(SHORT_DOMAIN, { name: d.name, version: d.version, chainId: d.chain_id });
    expect(toHex(eip712SigningDigest(sep, eip712HashStruct('TaskOrder', TYPES, message)))).toBe(
      v.task_order.signing_digest,
    );
  });
});

describe('TrueOpen Task Data Request', () => {
  const TYPES: Eip712Types = {
    ...SHORT_DOMAIN,
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
  const m = v.task_data_request.message;
  const message = {
    schemaVersion: m.schemaVersion,
    chainId: m.chainId,
    builderOperatorAddress: m.builderOperatorAddress,
    rpcMethod: m.rpcMethod,
    bodyDigest: fromHex(m.bodyDigest),
    requesterKind: m.requesterKind,
    requesterAddress: m.requesterAddress,
    serviceAuthorizationNonce: m.serviceAuthorizationNonce,
    requestNonce: fromHex(m.requestNonce),
    expiryHeight: m.expiryHeight,
  };

  it('encode_type', () =>
    expect(eip712EncodeType('TaskDataRequest', TYPES)).toBe(v.task_data_request.encode_type));
  it('type_hash', () =>
    expect(toHex(eip712TypeHash('TaskDataRequest', TYPES))).toBe(v.task_data_request.type_hash));
  it('hash_struct', () =>
    expect(toHex(eip712HashStruct('TaskDataRequest', TYPES, message))).toBe(v.task_data_request.hash_struct));
  it('signing_digest', () => {
    const d = v.task_data_request.domain;
    const sep = eip712DomainSeparator(SHORT_DOMAIN, { name: d.name, version: d.version, chainId: d.chain_id });
    expect(toHex(eip712SigningDigest(sep, eip712HashStruct('TaskDataRequest', TYPES, message)))).toBe(
      v.task_data_request.signing_digest,
    );
  });
});

/**
 * On-chain tx EIP-712: the type graph is **given explicitly** as published in the vector's
 * type_graph, not derived from amino JSON. The derivation rules (promoting nested objects to
 * named types, msgN naming) are currently anchored by a vector for only this one message;
 * extrapolating to other Msgs is unanchored - handle that separately once another message
 * actually needs to be sent.
 */
describe('Cosmos Web3 tx (MsgCreateSession)', () => {
  const TYPES: Eip712Types = {
    ...TX_DOMAIN,
    Tx: [
      { name: 'account_number', type: 'string' },
      { name: 'chain_id', type: 'string' },
      { name: 'fee', type: 'Fee' },
      { name: 'memo', type: 'string' },
      { name: 'sequence', type: 'string' },
      { name: 'msg0', type: 'TypeMsgCreateSession' },
    ],
    Fee: [
      { name: 'amount', type: 'Coin[]' },
      { name: 'gas', type: 'string' },
    ],
    Coin: [
      { name: 'denom', type: 'string' },
      { name: 'amount', type: 'string' },
    ],
    TypeMsgCreateSession: [
      { name: 'value', type: 'TypeValue' },
      { name: 'type', type: 'string' },
    ],
    TypeValue: [{ name: 'signer_address', type: 'string' }],
  };
  const t = v.msg_create_session_transaction;
  const message = {
    account_number: t.account_number,
    chain_id: t.cosmos_chain_id,
    fee: { amount: [{ denom: t.fee_denom, amount: t.fee_amount }], gas: t.gas },
    memo: t.memo,
    sequence: t.sequence,
    msg0: { value: { signer_address: t.signer_address }, type: t.amino_name },
  };

  it('every line of type_graph is reproduced by encode_type', () => {
    // The vector publishes the type graph split into an array; joining them per the EIP-712 concatenation rule should match encode_type.
    const joined: string = t.encode_type;
    for (const line of t.type_graph as string[]) expect(joined).toContain(line);
  });
  it('encode_type', () => expect(eip712EncodeType('Tx', TYPES)).toBe(t.encode_type));
  it('type_hash', () => expect(toHex(eip712TypeHash('Tx', TYPES))).toBe(t.type_hash));
  it('hash_struct', () => expect(toHex(eip712HashStruct('Tx', TYPES, message))).toBe(t.hash_struct));
  it('signing_digest', () => {
    const d = v.transaction_domain;
    const sep = eip712DomainSeparator(TX_DOMAIN, {
      name: d.name,
      version: d.version,
      chainId: d.chain_id,
      verifyingContract: d.verifying_contract,
      salt: d.salt,
    });
    expect(toHex(eip712SigningDigest(sep, eip712HashStruct('Tx', TYPES, message)))).toBe(t.signing_digest);
  });
});

describe('boundaries of the encoding rules', () => {
  const T: Eip712Types = { S: [{ name: 'a', type: 'bytes32' }] };
  it('rejects a bytes32 of the wrong length outright', () => {
    expect(() => eip712HashStruct('S', T, { a: new Uint8Array(31) })).toThrow(/exactly 32 bytes/);
  });
  it('rejects a missing field outright', () => {
    expect(() => eip712HashStruct('S', T, {})).toThrow(/S\.a is missing/);
  });
  it('rejects an undeclared type outright', () => {
    expect(() => eip712EncodeType('Missing', T)).toThrow(/not declared/);
  });
  it('uint does not accept negative numbers', () => {
    const U: Eip712Types = { S: [{ name: 'a', type: 'uint64' }] };
    expect(() => eip712HashStruct('S', U, { a: -1n })).toThrow(/must not be negative/);
  });
});
