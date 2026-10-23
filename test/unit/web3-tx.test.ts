import { describe, it, expect } from 'vitest';
import { AuthInfo, TxBody, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { SignMode } from 'cosmjs-types/cosmos/tx/signing/v1beta1/signing';
import type { Account, IndexedTx } from '@cosmjs/stargate';
import { BroadcastTxError } from '@cosmjs/stargate';
import {
  WEB3_EXTENSION_TYPE_URL,
  Web3TxBroadcaster,
  signWeb3Tx,
} from '../../src/transport/web3-tx';
import type { Web3ChainRpc } from '../../src/transport/web3-tx';
import { createTrueOpenWeb3ChainClient } from '../../src/transport/trueopen-chain-client';
import { ETH_SECP256K1_PUBKEY_TYPE_URL } from '../../src/signer/eth-direct-signer';
import { privateKeyTypedDataSigner, typedDataDigest } from '../../src/signer/typed-data-signer';
import type { TypedDataSigner } from '../../src/signer/typed-data-signer';
import { ethAddressBytes, recoverEip712PubKey } from '../../src/signer/eth-secp256k1';
import { ProtoReader, ProtoWriter } from '../../src/codec/protobuf';
import { TYPE_URL } from '../../src/transport/task-msgs';
import { ACCOUNT_SIGNING, fixtureKey } from '../helpers/account-signing';
import { fromHex, toHex } from '../../src/util/bytes';

const OWNER: string = ACCOUNT_SIGNING.account.account_bech32;
const OWNER_PUB = fromHex(ACCOUNT_SIGNING.account.pub_compressed);
const WRONG_PUB = fromHex(ACCOUNT_SIGNING.wrong_key.pub_compressed);
const GRANT = { sessionKey: new Uint8Array(20).fill(3), expiryHeight: 200n, spendCap: '0' };
const SESSION_ID = `0x${'07'.repeat(32)}`;
const FEE = { amount: [{ denom: 'uusdc', amount: '12345' }], gas: '200000' };
const CREATE = { typeUrl: TYPE_URL.createSession, value: { signer: OWNER, sessionKey: GRANT } };
const wallet = privateKeyTypedDataSigner(fixtureKey('account'));

/** Counts calls so a test can tell the wallet was never asked to sign. */
function countingWallet(inner: TypedDataSigner): TypedDataSigner & { calls: number } {
  const w = { calls: 0, signTypedData: async (d: Parameters<TypedDataSigner['signTypedData']>[0]) => { w.calls += 1; return inner.signTypedData(d); } };
  return w;
}

function base(over: Partial<Parameters<typeof signWeb3Tx>[0]> = {}): Parameters<typeof signWeb3Tx>[0] {
  return {
    wallet, signerAddress: OWNER, chainId: 'trueopen-golden-1', accountNumber: 7n, sequence: 9n,
    fee: FEE, typedDataChainId: 424242n, msg: CREATE, ...over,
  };
}

/** ExtensionOptionsWeb3Tx { uint64 typed_data_chain_id = 1; string fee_payer = 2; bytes fee_payer_sig = 3 }. */
function decodeWeb3Extension(value: Uint8Array): { chainId: bigint; fields: number[] } {
  const r = new ProtoReader(value);
  const fields: number[] = [];
  let chainId = 0n;
  while (!r.eof) {
    const { field, wire } = r.tag();
    fields.push(field);
    if (field === 1) chainId = r.uint64();
    else r.skip(wire);
  }
  return { chainId, fields };
}

/**
 * Exact TxRaw bytes the deployed node's full ante handler (TrueOpen/node 8ea59f3, app
 * AnteHandler on chain "node-simapp") accepted: MsgCreateSession with a grant, account number 1,
 * sequence 0, an account with no stored public key (so SetPubKeyDecorator stored the recovered
 * one and the strict Web3 verifier passed). Built by signWeb3Tx with the fixture account key.
 */
const NODE_ACCEPTED_CREATE =
  '0aa7010a6e0a192f7461736b2e76312e4d736743726561746553657373696f6e12510a2f747275656f70656e3172666a7a3772337538743635746561766835757471756a336b7776736a39383370336a636c7a121e0a14030303030303030303030303030303030303030310c8011a030a0130fa3f340a2c2f636f736d6f732e65766d2e6569703731322e76312e457874656e73696f6e4f7074696f6e73576562335478120408b2f21912700a580a500a292f636f736d6f732e65766d2e63727970746f2e76312e657468736563703235366b312e5075624b657912230a21031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f12040a02087f12140a0e0a0575757364631205313233343510c09a0c1a4102c9e91f0e3d9984ce57f7898592b48105075cec309ca39349edb70c47c5d73019c14f22244417b38b02643f0ee410691a6abe2c906ec61c52f3b350cca3e5661b';

describe('signWeb3Tx: TxRaw layout', () => {
  it('body, critical Web3 extension, auth info, LEGACY_AMINO_JSON, pubkey and 65-byte signature', async () => {
    const signed = await signWeb3Tx(base({ memo: 'hello' }));
    const raw = TxRaw.decode(signed.txBytes);
    const body = TxBody.decode(raw.bodyBytes);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.typeUrl).toBe(TYPE_URL.createSession);
    expect(body.memo).toBe('hello');
    expect(body.timeoutHeight).toBe(0n);
    expect(body.nonCriticalExtensionOptions).toEqual([]);
    expect(body.extensionOptions).toHaveLength(1);
    expect(body.extensionOptions[0]!.typeUrl).toBe(WEB3_EXTENSION_TYPE_URL);
    // Only typed_data_chain_id: fee_payer and fee_payer_sig stay empty.
    expect(decodeWeb3Extension(body.extensionOptions[0]!.value)).toEqual({ chainId: 424242n, fields: [1] });

    const auth = AuthInfo.decode(raw.authInfoBytes);
    expect(auth.signerInfos).toHaveLength(1);
    const si = auth.signerInfos[0]!;
    expect(si.publicKey!.typeUrl).toBe(ETH_SECP256K1_PUBKEY_TYPE_URL);
    expect(toHex(si.publicKey!.value)).toBe(ACCOUNT_SIGNING.direct_sign_mode_transaction.pubkey_any_value_hex);
    expect(si.modeInfo!.single!.mode).toBe(SignMode.SIGN_MODE_LEGACY_AMINO_JSON);
    expect(si.sequence).toBe(9n);
    expect(auth.fee!.amount).toEqual(FEE.amount);
    expect(auth.fee!.gasLimit).toBe(200000n);
    expect(auth.fee!.payer).toBe('');
    expect(auth.fee!.granter).toBe('');

    expect(raw.signatures).toHaveLength(1);
    const sig = raw.signatures[0]!;
    expect(sig).toHaveLength(65);
    expect([27, 28]).toContain(sig[64]);
    expect(toHex(sig)).toBe(toHex(signed.signature));
    expect(toHex(ethAddressBytes(recoverEip712PubKey(typedDataDigest(signed.typedData), sig)))).toBe(ACCOUNT_SIGNING.account.address_bytes);
  });

  it('the create transaction signs the session_key_amino_v1 create digest', async () => {
    const signed = await signWeb3Tx(base());
    // Same sign doc, chain ids and key as the wire "create" case.
    expect(toHex(signed.signature)).toBe(
      'dbe0c0328d81acd808efed34516a7dbb57863aea44d08583e6b34fc8e745cd10459fdbd673f23435580150cc094b7538a711f8b0c2fc9e586c45bcd9abb7494e1b',
    );
  });

  it('reproduces bytes the node ante handler accepted', async () => {
    const signed = await signWeb3Tx(base({ chainId: 'node-simapp', accountNumber: 1n, sequence: 0n }));
    expect(toHex(signed.txBytes)).toBe(NODE_ACCEPTED_CREATE);
  });

  it('recovers the public key when the chain account has none', async () => {
    const signed = await signWeb3Tx(base());
    expect(toHex(signed.pubKey)).toBe(ACCOUNT_SIGNING.account.pub_compressed);
  });

  it('uses and checks a stored public key', async () => {
    const signed = await signWeb3Tx(base({ accountPubKey: OWNER_PUB }));
    expect(toHex(signed.pubKey)).toBe(ACCOUNT_SIGNING.account.pub_compressed);
  });

  it('refuses a stored public key of another account before asking the wallet', async () => {
    const w = countingWallet(wallet);
    await expect(signWeb3Tx(base({ wallet: w, accountPubKey: WRONG_PUB }))).rejects.toMatchObject({ code: 'SDK_LOCAL_TX_PUBKEY_MISMATCH' });
    await expect(signWeb3Tx(base({ wallet: w, accountPubKey: OWNER_PUB.subarray(1) }))).rejects.toMatchObject({ code: 'SDK_LOCAL_TX_PUBKEY_MISMATCH' });
    expect(w.calls).toBe(0);
  });

  it('refuses a wallet signing with another key or under another domain chainId', async () => {
    const other = privateKeyTypedDataSigner(fixtureKey('wrong_key'));
    await expect(signWeb3Tx(base({ wallet: other }))).rejects.toMatchObject({ code: 'SDK_LOCAL_SIGNER_ADDRESS_MISMATCH' });
    const otherChain: TypedDataSigner = {
      signTypedData: (d) => wallet.signTypedData({ ...d, domain: { ...d.domain, chainId: 1n } }),
    };
    await expect(signWeb3Tx(base({ wallet: otherChain }))).rejects.toMatchObject({ code: 'SDK_LOCAL_SIGNER_ADDRESS_MISMATCH' });
  });

  it("refuses fee 'auto', fee delegation, a typed-data chain id outside 1..MaxInt64 and a foreign Msg signer", async () => {
    await expect(signWeb3Tx(base({ fee: 'auto' as never }))).rejects.toMatchObject({ code: 'SDK_LOCAL_TX_FEE_AUTO' });
    await expect(signWeb3Tx(base({ fee: { ...FEE, granter: OWNER } }))).rejects.toMatchObject({ code: 'SDK_LOCAL_TX_FEE_INVALID' });
    await expect(signWeb3Tx(base({ typedDataChainId: 0n }))).rejects.toMatchObject({ code: 'SDK_LOCAL_SIGNATURE_CHAIN_ID_INVALID' });
    await expect(signWeb3Tx(base({ typedDataChainId: 1n << 63n }))).rejects.toMatchObject({ code: 'SDK_LOCAL_SIGNATURE_CHAIN_ID_INVALID' });
    const foreign = { typeUrl: TYPE_URL.createSession, value: { signer: 'trueopen1someoneelse' } };
    await expect(signWeb3Tx(base({ msg: foreign }))).rejects.toMatchObject({ code: 'SDK_LOCAL_TX_SIGNER_MISMATCH' });
    await expect(signWeb3Tx(base({ msg: { typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: { signer: OWNER } } }))).rejects.toMatchObject({
      code: 'SDK_LOCAL_TX_MSG_UNSUPPORTED',
    });
  });
});

/** A chain RPC fake: an account, a broadcast that records the bytes, and an inclusion lookup. */
class FakeRpc implements Web3ChainRpc {
  broadcasts: Uint8Array[] = [];
  lookups = 0;
  constructor(
    private readonly account: Account | null,
    private readonly response?: { typeUrl: string; value: Uint8Array },
    private readonly broadcastError?: Error,
  ) {}
  async getChainId(): Promise<string> {
    return 'trueopen-golden-1';
  }
  async getAccount(): Promise<Account | null> {
    return this.account;
  }
  async broadcastTxSync(tx: Uint8Array): Promise<string> {
    if (this.broadcastError) throw this.broadcastError;
    this.broadcasts.push(tx);
    return 'TXHASH';
  }
  async getTx(): Promise<IndexedTx | null> {
    this.lookups += 1;
    if (this.lookups === 1) return null;
    return {
      code: 0, height: 1, txIndex: 0, hash: 'TXHASH', events: [], rawLog: '', tx: new Uint8Array(),
      gasUsed: 1n, gasWanted: 1n, msgResponses: this.response ? [this.response] : [],
    } as unknown as IndexedTx;
  }
}

const account = (pubkey: Account['pubkey']): Account => ({ address: OWNER, pubkey, accountNumber: 7, sequence: 9 });
const stored = { type: 'tendermint/PubKeySecp256k1', value: Buffer.from(OWNER_PUB).toString('base64') };
const instant = { attempts: 5, intervalMs: 0, sleep: async () => {} };

function client(rpc: Web3ChainRpc, w: TypedDataSigner = wallet) {
  return createTrueOpenWeb3ChainClient({
    restUrl: 'http://rest.invalid', rpc, wallet: w, signerAddress: OWNER, typedDataChainId: 424242n, fee: FEE,
    fetch: async () => { throw new Error('no reads in this test'); }, inclusion: instant,
  });
}

describe('Web3 chain client (CosmjsChainWriter + Web3TxBroadcaster)', () => {
  it('createSession: one broadcast of a Web3 TxRaw, then polls for inclusion and decodes the response', async () => {
    const resp = new ProtoWriter().bytes(1, fromHex('33'.repeat(32))).uint64(2, 4n).uint64(3, 1n).finish();
    const rpc = new FakeRpc(account(null), { typeUrl: TYPE_URL.createSession, value: resp });
    const r = await client(rpc).createSession({ sessionKey: GRANT });
    expect(r).toEqual({ sessionId: `0x${'33'.repeat(32)}`, owner: OWNER, nonce: 4n, status: 'MUTATION_STATUS_V1_APPLIED' });
    expect(rpc.broadcasts).toHaveLength(1);
    expect(rpc.lookups).toBe(2);
    const tx = TxRaw.decode(rpc.broadcasts[0]!);
    expect(TxBody.decode(tx.bodyBytes).extensionOptions[0]!.typeUrl).toBe(WEB3_EXTENSION_TYPE_URL);
    expect(toHex(tx.signatures[0]!)).toBe(
      'dbe0c0328d81acd808efed34516a7dbb57863aea44d08583e6b34fc8e745cd10459fdbd673f23435580150cc094b7538a711f8b0c2fc9e586c45bcd9abb7494e1b',
    );
  });

  it('updateSessionKey (set / clear) and cancelOrder go through the composed ChainClient', async () => {
    const amt = (v: string) => new ProtoWriter().string(1, v).finish();
    const keyResp = new ProtoWriter().bytes(1, GRANT.sessionKey).uint64(2, 200n).message(3, amt('0')).message(4, amt('0')).uint64(5, 10n).uint64(6, 1n).finish();
    for (const action of [{ set: GRANT }, { clear: true as const }]) {
      const rpc = new FakeRpc(account(stored), { typeUrl: TYPE_URL.updateSessionKey, value: keyResp });
      const r = await client(rpc).updateSessionKey({ sessionId: SESSION_ID, action });
      expect(r.status).toBe('MUTATION_STATUS_V1_APPLIED');
      const body = TxBody.decode(TxRaw.decode(rpc.broadcasts[0]!).bodyBytes);
      expect(body.messages[0]!.typeUrl).toBe(TYPE_URL.updateSessionKey);
    }
    const cancelResp = new ProtoWriter().bytes(1, fromHex('0c'.repeat(32))).uint64(2, 3n).uint64(3, 4n).uint64(4, 1n).finish();
    const rpc = new FakeRpc(account(stored), { typeUrl: TYPE_URL.cancelOrder, value: cancelResp });
    const r = await client(rpc).cancelOrder({ sessionId: SESSION_ID, orderSequence: 3n });
    expect(r).toEqual({ taskId: `0x${'0c'.repeat(32)}`, cancelledSequence: 3n, nextExpectedSequence: 4n, status: 'MUTATION_STATUS_V1_APPLIED' });
    const auth = AuthInfo.decode(TxRaw.decode(rpc.broadcasts[0]!).authInfoBytes);
    expect(auth.signerInfos[0]!.sequence).toBe(9n);
  });

  it('an account missing on chain is CHAIN_ACCOUNT_NOT_FOUND and nothing is signed or sent', async () => {
    const rpc = new FakeRpc(null);
    const w = countingWallet(wallet);
    await expect(client(rpc, w).createSession()).rejects.toMatchObject({ code: 'CHAIN_ACCOUNT_NOT_FOUND' });
    expect(w.calls).toBe(0);
    expect(rpc.broadcasts).toHaveLength(0);
  });

  it('a stored key of another account is refused locally', async () => {
    const rpc = new FakeRpc(account({ type: 'tendermint/PubKeySecp256k1', value: Buffer.from(WRONG_PUB).toString('base64') }));
    await expect(client(rpc).createSession()).rejects.toMatchObject({ code: 'SDK_LOCAL_TX_PUBKEY_MISMATCH' });
    expect(rpc.broadcasts).toHaveLength(0);
  });

  it('a CheckTx rejection is classified like the DIRECT path', async () => {
    const rpc = new FakeRpc(account(stored), undefined, new BroadcastTxError(4, 'sdk', 'signature verification failed'));
    await expect(client(rpc).createSession()).rejects.toMatchObject({ code: 'CHAIN_TX_REJECTED' });
  });

  it("fee 'auto' is refused when the client is built and by the broadcaster", async () => {
    expect(() =>
      createTrueOpenWeb3ChainClient({
        restUrl: 'http://rest.invalid', rpc: new FakeRpc(null), wallet, signerAddress: OWNER, typedDataChainId: 1n, fee: 'auto' as never,
      }),
    ).toThrow(expect.objectContaining({ code: 'SDK_LOCAL_TX_FEE_AUTO' }));
    const b = new Web3TxBroadcaster({ rpc: new FakeRpc(account(null)), wallet, typedDataChainId: 1n });
    await expect(b.signAndBroadcastSync(OWNER, [CREATE], 'auto')).rejects.toMatchObject({ code: 'SDK_LOCAL_TX_FEE_AUTO' });
    await expect(b.signAndBroadcastSync(OWNER, [CREATE, CREATE], FEE)).rejects.toMatchObject({ code: 'SDK_LOCAL_TX_MSG_UNSUPPORTED' });
  });

  it('accepts a 0x signer address and refuses a typed-data chain id of 0', () => {
    expect(() => createTrueOpenWeb3ChainClient({
      restUrl: 'http://rest.invalid', rpc: new FakeRpc(null), wallet, signerAddress: ACCOUNT_SIGNING.account.address_0x, typedDataChainId: 1n, fee: FEE,
    })).not.toThrow();
    expect(() => new Web3TxBroadcaster({ rpc: new FakeRpc(null), wallet, typedDataChainId: 0n })).toThrow(
      expect.objectContaining({ code: 'SDK_LOCAL_SIGNATURE_CHAIN_ID_INVALID' }),
    );
  });
});
