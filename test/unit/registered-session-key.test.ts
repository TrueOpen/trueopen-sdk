import { describe, it, expect } from 'vitest';
import {
  generateSessionKey,
  sessionKeyFromPrivateKey,
  registeredSessionKey,
  RegisteredSessionKeys,
  sessionKeyAddressHex,
} from '../../src/session/registered-session-key';
import { signAndEncodeOrder, taskOrderTypedData, decodeSignedOrder } from '../../src/order/signed-order';
import { taskOrderHash } from '../../src/order/task-order';
import { signSdkRequestEnvelope, sdkRequestTypedData, SDK_REQUEST_EIP712_TYPES } from '../../src/transport/sdk-request-envelope';
import type { SdkRequestFields } from '../../src/transport/sdk-request-envelope';
import { openTaskBodyDigest } from '../../src/transport/sdk-request-body';
import {
  taskDataRequestTypedData,
  taskDataMetadataBodyDigest,
  TASK_DATA_EIP712_TYPES,
  TASK_DATA_OBJECT_KIND,
} from '../../src/transport/task-data-signbytes';
import type { TaskDataRequestAuthFields } from '../../src/transport/task-data-signbytes';
import { eip712HashStruct } from '../../src/codec/eip712';
import { privateKeyTypedDataSigner, signTypedDataAs, typedDataDigest } from '../../src/signer/typed-data-signer';
import { recoverEip712PubKey, ethAddressBytes } from '../../src/signer/eth-secp256k1';
import { fromHex, toHex } from '../../src/util/bytes';
import { fixtureTypedData } from '../helpers/account-signing';
import { SESSION_KEY_AUTH, fixtureOrder, skAddress, skKey, skSection } from '../helpers/session-key-authorization';

/**
 * Registered session keys (ADR-0037) against wire session_key_authorization_v1.json: the order
 * and both request kinds are signed by the session key, which the fixture's signatures and
 * recovered addresses pin. RFC 6979 makes the signatures deterministic, so they compare byte
 * for byte.
 */

const recover = (digest: Uint8Array, sig: Uint8Array): string => toHex(ethAddressBytes(recoverEip712PubKey(digest, sig)));
const ZERO32 = '00'.repeat(32);
const USER = SESSION_KEY_AUTH.account.account_bech32 as string;
const SESSION = `0x${SESSION_KEY_AUTH.registered_sdk_request.message.sessionId as string}`;
const KEY = registeredSessionKey(SESSION, skKey('session_key'));

describe('session_key_authorization_v1.json: delegated_order', () => {
  const D = skSection('delegated_order');
  const W = skSection('wallet_order');
  const order = fixtureOrder();
  const ctx = { signatureChainId: BigInt(D.signature_chain_id!), feeDenom: D.message.feeDenom! };

  it('order_payload lifts to the order whose task_hash the typed message binds', () => {
    expect(toHex(taskOrderHash(order))).toBe(SESSION_KEY_AUTH.order_payload.digest_hex);
    expect(D.message.taskHash).toBe(SESSION_KEY_AUTH.order_payload.digest_hex);
  });

  it('the session key signs the same digest as the wallet; only the recovered address differs', async () => {
    const enc = await signAndEncodeOrder(order, ctx, KEY.signer, { expectedSigner: KEY.address });
    expect(toHex(enc.signingDigest)).toBe(D.signing_digest);
    expect(D.signing_digest).toBe(W.signing_digest);
    expect(toHex(typedDataDigest(fixtureTypedData(D)))).toBe(D.signing_digest);
    expect(toHex(enc.userSignature)).toBe(D.signature_65);
    expect(recover(enc.signingDigest, enc.userSignature)).toBe(D.recovered_address);
    expect(D.recovered_address).toBe(SESSION_KEY_AUTH.session_key.address_bytes);
    expect(D.signer).toBe('session_key');
    // SignedOrderV2 layout is unchanged: the key's signature sits in user_signature.
    expect(toHex(decodeSignedOrder(enc.bytes).userSignature)).toBe(D.signature_65);
  });

  it('the wallet still signs wallet_order, recovering to the account', async () => {
    const enc = await signAndEncodeOrder(order, ctx, privateKeyTypedDataSigner(skKey('account')));
    expect(toHex(enc.userSignature)).toBe(W.signature_65);
    expect(W.recovered_address).toBe(SESSION_KEY_AUTH.account.address_bytes);
  });

  it('expectedSigner defaults to the user: a session-key signature is refused without it', async () => {
    await expect(signAndEncodeOrder(order, ctx, KEY.signer)).rejects.toMatchObject({ code: 'SDK_LOCAL_SIGNER_ADDRESS_MISMATCH' });
    await expect(signAndEncodeOrder(order, ctx, KEY.signer, { expectedSigner: skAddress('wrong_key') })).rejects.toMatchObject({
      code: 'SDK_LOCAL_SIGNER_ADDRESS_MISMATCH',
    });
    expect(toHex(typedDataDigest(taskOrderTypedData(order, ctx)))).toBe(D.signing_digest);
  });
});

describe('session_key_authorization_v1.json: registered_sdk_request', () => {
  const R = skSection('registered_sdk_request');
  const envelope = SESSION_KEY_AUTH.registered_sdk_request.envelope as Record<string, string>;
  const EVM = BigInt(R.signature_chain_id!);
  const fields: SdkRequestFields = {
    chainId: R.message.chainId!,
    method: R.message.method!,
    sessionId: `0x${R.message.sessionId!}`,
    taskId: `0x${R.message.taskId!}`,
    requestNonce: fromHex(R.message.requestNonce!),
    expiryHeightOrTime: BigInt(R.message.expiryHeightOrTime!),
    bodyDigest: fromHex(R.message.bodyDigest!),
  };

  it('the body digest is registered_open_task_body', () => {
    const B = SESSION_KEY_AUTH.registered_open_task_body;
    const field = (n: string) => (B.fields as { name: string; hex?: string; utf8?: string; value?: number; bech32?: string }[]).find((f) => f.name === n)!;
    const digest = openTaskBodyDigest({
      taskHash: fromHex(field('task_hash').hex!),
      sessionId: `0x${field('session_id').hex!}`,
      orderSequence: BigInt(field('order_sequence').value!),
      userAddress: field('user_address').bech32!,
      inputSizeBytes: BigInt(field('input_size_bytes').value!),
      inputHash: `0x${field('input_hash').hex!}`,
      inputMediaType: field('input_media_type').utf8!,
      idempotencyKey: field('idempotency_key').utf8!,
    });
    expect(toHex(digest)).toBe(B.digest_hex);
    expect(R.message.bodyDigest).toBe(B.digest_hex);
  });

  it('zero sessionGrantHash, hash_struct and signing digest', () => {
    expect(R.message.sessionGrantHash).toBe(ZERO32);
    const data = sdkRequestTypedData(fields, EVM);
    expect(toHex(data.message['sessionGrantHash'] as Uint8Array)).toBe(ZERO32);
    expect(toHex(eip712HashStruct('SDKRequest', SDK_REQUEST_EIP712_TYPES, data.message))).toBe(R.hash_struct);
    expect(toHex(typedDataDigest(data))).toBe(R.signing_digest);
  });

  it('the registered key signs the exact fixture signature; signer_address is the user and no grant travels', async () => {
    const env = await signSdkRequestEnvelope(fields, {
      signerAddress: USER,
      signer: { signTypedData: () => Promise.reject(new Error('the wallet must not sign')) },
      signatureChainId: EVM,
      registeredKey: KEY,
    });
    expect(toHex(env.signature)).toBe(R.signature_65);
    expect(recover(fromHex(R.signing_digest), env.signature)).toBe(R.recovered_address);
    expect(R.recovered_address).toBe(SESSION_KEY_AUTH.session_key.address_bytes);
    expect(env.signerAddress).toBe(envelope['signer_address']);
    expect(env.requestDomain).toBe(envelope['request_domain']);
    expect(envelope['session_grant']).toBe('absent');
    expect(env.sessionGrant).toBeUndefined();
    expect('sessionGrant' in env).toBe(false);
  });
});

describe('session_key_authorization_v1.json: registered_data_request', () => {
  const R = skSection('registered_data_request');
  const EVM = BigInt(R.signature_chain_id!);
  const m = R.message;
  const fields: TaskDataRequestAuthFields = {
    schemaVersion: Number(m['schemaVersion']),
    chainId: m['chainId']!,
    builderOperatorAddress: m['builderOperatorAddress']!,
    rpcMethod: m['rpcMethod']!,
    bodyDigest: fromHex(m['bodyDigest']!),
    requesterKind: Number(m['requesterKind']),
    requesterAddress: m['requesterAddress']!,
    serviceAuthorizationNonce: BigInt(m['serviceAuthorizationNonce']!),
    requestNonce: fromHex(m['requestNonce']!),
    expiryHeight: BigInt(m['expiryHeight']!),
  };

  it('the body digest is registered_output_metadata_body (an OUTPUT object)', () => {
    const B = SESSION_KEY_AUTH.registered_output_metadata_body;
    const ref = (B.fields[0].fields as { name: string; hex?: string }[]).reduce<Record<string, string>>((a, f) => {
      if (f.hex !== undefined) a[f.name] = `0x${f.hex}`;
      return a;
    }, {});
    const digest = taskDataMetadataBodyDigest({
      taskHash: ref['task_hash']!,
      sessionId: ref['session_id']!,
      taskId: ref['task_id']!,
      objectKind: TASK_DATA_OBJECT_KIND.OUTPUT,
      contentHash: ref['content_hash']!,
    });
    expect(toHex(digest)).toBe(B.digest_hex);
    expect(m['bodyDigest']).toBe(B.digest_hex);
  });

  it('requester is the user, zero sessionGrantHash, hash_struct and signing digest', () => {
    expect(m['requesterAddress']).toBe(USER);
    expect(m['sessionGrantHash']).toBe(ZERO32);
    const data = taskDataRequestTypedData(fields, EVM);
    expect(toHex(data.message['sessionGrantHash'] as Uint8Array)).toBe(ZERO32);
    expect(toHex(eip712HashStruct('TaskDataRequest', TASK_DATA_EIP712_TYPES, data.message))).toBe(R.hash_struct);
    expect(toHex(typedDataDigest(data))).toBe(R.signing_digest);
  });

  it('the registered key signs the exact fixture signature', async () => {
    const sig = await signTypedDataAs(KEY.signer, taskDataRequestTypedData(fields, EVM), KEY.address);
    expect(toHex(sig)).toBe(R.signature_65);
    expect(recover(fromHex(R.signing_digest), sig)).toBe(R.recovered_address);
    expect(R.signer).toBe('session_key');
  });
});

describe('session key material', () => {
  it('generateSessionKey gives distinct keys with 20-byte addresses', () => {
    const a = generateSessionKey();
    const b = generateSessionKey();
    expect(a.privateKey).toHaveLength(32);
    expect(a.address).toHaveLength(20);
    expect(b.address).toHaveLength(20);
    expect(toHex(a.privateKey)).not.toBe(toHex(b.privateKey));
    expect(toHex(a.address)).not.toBe(toHex(b.address));
    expect(toHex(sessionKeyFromPrivateKey(a.privateKey).address)).toBe(toHex(a.address));
  });

  it('sessionKeyFromPrivateKey reproduces the fixture address', () => {
    const m = sessionKeyFromPrivateKey(skKey('session_key'));
    expect(toHex(m.address)).toBe(SESSION_KEY_AUTH.session_key.address_bytes);
    expect(sessionKeyAddressHex(m.address)).toBe((SESSION_KEY_AUTH.session_key.address_0x as string).toLowerCase());
  });

  it('sessionKeyFromPrivateKey rejects 31 or 33 bytes, zero and the curve order', () => {
    const n = fromHex('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
    for (const bad of [new Uint8Array(31).fill(3), new Uint8Array(33).fill(3), new Uint8Array(32), n]) {
      expect(() => sessionKeyFromPrivateKey(bad)).toThrow(expect.objectContaining({ code: 'SDK_LOCAL_SESSION_KEY_INVALID' }));
    }
  });

  it('registeredSessionKey requires Hash32 text for the session', () => {
    expect(KEY.sessionId).toBe(SESSION);
    expect(toHex(KEY.address)).toBe(SESSION_KEY_AUTH.session_key.address_bytes);
    for (const bad of [SESSION.slice(2), SESSION.toUpperCase(), '0x12']) {
      expect(() => registeredSessionKey(bad, skKey('session_key'))).toThrow(expect.objectContaining({ code: 'SDK_LOCAL_SESSION_KEY_INVALID' }));
    }
  });

  it('RegisteredSessionKeys maps a session to its key', () => {
    const keys = new RegisteredSessionKeys();
    expect(keys.get(SESSION)).toBeUndefined();
    keys.set(KEY);
    expect(keys.get(SESSION)).toBe(KEY);
    keys.delete(SESSION);
    expect(keys.get(SESSION)).toBeUndefined();
  });

  it('forRequest: the key up to its expiry height, then undefined (the caller falls back); orders keep get()', async () => {
    let latest = 1_000n;
    let now = 0;
    let reads = 0;
    const keys = new RegisteredSessionKeys({ latestHeight: async () => { reads += 1; return latest; }, heightMaxAgeMs: 1000, now: () => now });
    keys.set(KEY, 1_002n);
    expect(await keys.forRequest(SESSION)).toBe(KEY); // no height seen yet: read
    expect(reads).toBe(1);
    expect(await keys.forRequest(SESSION)).toBe(KEY); // a recent 1000 < 1002: reused
    expect(reads).toBe(1);
    latest = 1_002n;
    now = 2_000; // stale: read again; latest == expiry still signs
    expect(await keys.forRequest(SESSION)).toBe(KEY);
    expect(reads).toBe(2);
    // A recent height equal to the expiry may lag a block: read, not reused.
    latest = 1_003n;
    expect(await keys.forRequest(SESSION)).toBeUndefined();
    expect(reads).toBe(3);
    // A height past the expiry is final however old: no read.
    now = 10_000;
    expect(await keys.forRequest(SESSION)).toBeUndefined();
    expect(reads).toBe(3);
    expect(keys.get(SESSION)).toBe(KEY);
    // A renew seen on chain moves the expiry; a different key's state does not.
    keys.refreshExpiry(SESSION, new Uint8Array(20).fill(9), 5_000n);
    expect(keys.expiryHeight(SESSION)).toBe(1_002n);
    keys.refreshExpiry(SESSION, KEY.address, 5_000n);
    expect(await keys.forRequest(SESSION)).toBe(KEY);
  });

  it('forRequest without a height source or a known expiry always returns the key', async () => {
    const noHeight = new RegisteredSessionKeys();
    noHeight.set(KEY, 1n);
    expect(await noHeight.forRequest(SESSION)).toBe(KEY);
    const noExpiry = new RegisteredSessionKeys({ latestHeight: async () => 1n << 60n });
    noExpiry.set(KEY);
    expect(await noExpiry.forRequest(SESSION)).toBe(KEY);
    expect(await noExpiry.forRequest(`0x${'00'.repeat(32)}`)).toBeUndefined();
  });

  it('sessionKeyAddressHex refuses anything but 20 bytes', () => {
    expect(() => sessionKeyAddressHex(new Uint8Array(19))).toThrow(expect.objectContaining({ code: 'SDK_LOCAL_SESSION_KEY_INVALID' }));
  });
});
