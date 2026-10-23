import { describe, it, expect } from 'vitest';
import {
  SDK_REQUEST_DOMAIN,
  SDK_REQUEST_EIP712_TYPES,
  sdkRequestEip712Domain,
  sdkRequestTypedData,
  sdkRequestEip712Digest,
  signSdkRequestEnvelope,
} from '../../src/transport/sdk-request-envelope';
import type { SdkRequestFields } from '../../src/transport/sdk-request-envelope';
import { eip712DomainSeparator, eip712EncodeType, eip712HashStruct, eip712TypeHash } from '../../src/codec/eip712';
import { privateKeyTypedDataSigner, typedDataDigest } from '../../src/signer/typed-data-signer';
import { recoverEip712PubKey, ethAddressBytes } from '../../src/signer/eth-secp256k1';
import { fromHex, toHex } from '../../src/util/bytes';
import { TrueOpenError } from '../../src/errors/errors';
import { ACCOUNT_SIGNING, fixtureKey, fixtureTypedData, section } from '../helpers/account-signing';
import { registeredSessionKey } from '../../src/session/registered-session-key';
import { sessionGrantHash } from '../../src/session/session-grant';
import type { ActiveSession } from '../../src/session/session-grant';
import { secp256k1 } from '@noble/curves/secp256k1';

const V = section('sdk_request');
const EVM = BigInt(V.domain.chain_id);
const USER = ACCOUNT_SIGNING.account.account_bech32 as string;
const wallet = privateKeyTypedDataSigner(fixtureKey('account'));

const fields: SdkRequestFields = {
  chainId: V.message.chainId!,
  method: V.message.method!,
  // The typed message carries bytes32 (bare hex is the fixture's file encoding); the SDK takes
  // the transport spelling, 0x + 64 lowercase hex (ADR-0034).
  sessionId: `0x${V.message.sessionId!}`,
  taskId: `0x${V.message.taskId!}`,
  requestNonce: fromHex(V.message.requestNonce!),
  expiryHeightOrTime: BigInt(V.message.expiryHeightOrTime!),
  bodyDigest: fromHex(V.message.bodyDigest!),
};

const recover = (digest: string, sig: string): string => toHex(ethAddressBytes(recoverEip712PubKey(fromHex(digest), fromHex(sig))));

describe('SDKRequest EIP-712 (account_signing_v1.json sdk_request)', () => {
  it('domain: encode_type, type_hash and domain separator', () => {
    expect(eip712EncodeType('EIP712Domain', SDK_REQUEST_EIP712_TYPES)).toBe(V.domain.encode_type);
    expect(toHex(eip712TypeHash('EIP712Domain', SDK_REQUEST_EIP712_TYPES))).toBe(V.domain.type_hash);
    expect(toHex(eip712DomainSeparator(SDK_REQUEST_EIP712_TYPES, sdkRequestEip712Domain(EVM)))).toBe(V.domain.domain_separator);
  });

  it('SDKRequest encode_type, type_hash and hash_struct', () => {
    expect(eip712EncodeType('SDKRequest', SDK_REQUEST_EIP712_TYPES)).toBe(V.encode_type);
    expect(toHex(eip712TypeHash('SDKRequest', SDK_REQUEST_EIP712_TYPES))).toBe(V.type_hash);
    const data = sdkRequestTypedData(fields, EVM);
    expect(toHex(eip712HashStruct('SDKRequest', SDK_REQUEST_EIP712_TYPES, data.message))).toBe(V.hash_struct);
  });

  it('the SDK projection equals the fixture typed data', () => {
    expect(toHex(sdkRequestEip712Digest(fields, EVM))).toBe(V.signing_digest);
    expect(toHex(typedDataDigest(fixtureTypedData(V)))).toBe(V.signing_digest);
  });

  it('signs the exact fixture signature, which recovers to the account', async () => {
    const env = await signSdkRequestEnvelope(fields, { signerAddress: USER, signer: wallet, signatureChainId: EVM });
    expect(env.signatureChainId).toBe(EVM);
    expect(toHex(env.signature)).toBe(V.signature_65);
    expect(recover(V.signing_digest, V.signature_65)).toBe(V.recovered_address);
    expect(env.requestDomain).toBe(SDK_REQUEST_DOMAIN);
    expect(env.requestDomain).toBe(ACCOUNT_SIGNING.sdk_request.envelope.request_domain);
    expect(env.endpoint).toBe(V.message.endpoint);
    expect(env.signerAddress).toBe(ACCOUNT_SIGNING.sdk_request.envelope.signer_address);
    expect('signerPubKey' in env).toBe(false);
  });

  it('refuses to sign as an address the wallet does not hold', async () => {
    const other = privateKeyTypedDataSigner(fixtureKey('wrong_key'));
    await expect(signSdkRequestEnvelope(fields, { signerAddress: USER, signer: other, signatureChainId: EVM })).rejects.toMatchObject({
      code: 'SDK_LOCAL_SIGNER_ADDRESS_MISMATCH',
    });
  });
});

/** Negative rows based on sdk_request: every published digest, signature and recovery. */
describe('request_auth_negative_cases on sdk_request', () => {
  type Row = {
    name: string;
    base: string;
    error?: string;
    signed?: { signer?: string; message?: Record<string, string>; domain?: { chain_id?: string; version?: string } };
    verified?: { message?: Record<string, string>; domain?: { chain_id?: string; version?: string } };
    signing_digest?: string;
    signature_65?: string;
    recovered_address?: string;
    transport?: Record<string, string>;
  };
  const rows = (ACCOUNT_SIGNING.request_auth_negative_cases as Row[]).filter((r) => r.base === 'sdk_request');

  it('the rows this file covers', () => {
    expect(rows.map((r) => r.name).sort()).toEqual([
      'expiry_negative',
      'open_task_task_id_not_derived',
      'sdk_request_expiry_zero',
      'sdk_request_grant_hash_without_grant',
      'sdk_request_other_chain_id',
      'sdk_request_signed_by_wrong_key',
      'sdk_request_signed_under_other_signature_chain_id',
      'sdk_request_tampered_signature_chain_id',
      'sdk_request_wallet_network_signature_chain_id',
      'signature_chain_id_above_max_int64',
      'signature_chain_id_zero',
    ]);
  });

  for (const r of rows.filter((x) => x.signing_digest !== undefined)) {
    it(`${r.name}: signature and verifier digest`, async () => {
      if (r.signed !== undefined) {
        const signedData = fixtureTypedData(V, { message: r.signed.message ?? {}, domain: r.signed.domain ?? {} });
        const sig = await privateKeyTypedDataSigner(fixtureKey(r.signed.signer ?? 'account')).signTypedData(signedData);
        expect(toHex(sig)).toBe(r.signature_65);
      }
      const verified = fixtureTypedData(V, { message: r.verified?.message ?? {}, domain: r.verified?.domain ?? {} });
      expect(toHex(typedDataDigest(verified))).toBe(r.signing_digest);
      expect(recover(r.signing_digest!, r.signature_65 ?? V.signature_65)).toBe(r.recovered_address);
    });
  }

  const refuse = (change: Partial<SdkRequestFields>): void => {
    expect(() => sdkRequestTypedData({ ...fields, ...change }, EVM)).toThrow(TrueOpenError);
  };

  it('sdk_request_expiry_zero and expiry_negative: the SDK refuses to build them', () => {
    refuse({ expiryHeightOrTime: 0n });
    refuse({ expiryHeightOrTime: -1n });
    refuse({ expiryHeightOrTime: 1n << 63n });
  });

  it('the transport rows of sdk_request_session: the SDK refuses to build them', () => {
    const transport = (name: string): Record<string, string> => {
      const row = (ACCOUNT_SIGNING.request_auth_negative_cases as Row[]).find((x) => x.name === name);
      expect(row?.error).toBe('NEXUS_INGRESS_MALFORMED');
      return row!.transport!;
    };
    // 0x followed by uppercase hex, and a bare 64-hex task_id without the 0x prefix.
    refuse({ sessionId: transport('session_id_uppercase_hex')['session_id']! });
    refuse({ taskId: transport('task_id_bare_hex')['task_id']! });
    refuse({ sessionId: V.message.sessionId! });
    refuse({ taskId: `0X${V.message.taskId!}` });
    refuse({ requestNonce: fromHex('202122232425262728292a2b2c2d2e2f') });
  });

  it('sdk_request_grant_hash_without_grant: the SDK signs 32 zero bytes without a grant', () => {
    expect(toHex(sdkRequestTypedData(fields, EVM).message['sessionGrantHash'] as Uint8Array)).toBe('00'.repeat(32));
  });

  it('method and endpoint cannot disagree: the endpoint is derived', () => {
    expect(sdkRequestTypedData({ ...fields, method: 'AckOutput' }, EVM).message['endpoint']).toBe('/nexus.v1.IngressAPI/AckOutput');
    expect(() => sdkRequestTypedData({ ...fields, method: '/nexus.v1.IngressAPI/OpenTask' }, EVM)).toThrow(TrueOpenError);
  });
});

describe('signSdkRequestEnvelope with a registered session key (ADR-0037)', () => {
  const key = registeredSessionKey(fields.sessionId, fixtureKey('session_key'));
  const opts = { signerAddress: USER, signer: wallet, signatureChainId: EVM, registeredKey: key };

  it('signs with the key and a zero grant hash: signer_address is the user, no grant', async () => {
    const env = await signSdkRequestEnvelope(fields, opts);
    expect(recover(toHex(sdkRequestEip712Digest(fields, EVM)), toHex(env.signature))).toBe(toHex(key.address));
    expect(toHex(key.address)).not.toBe(V.recovered_address);
    expect(env.signerAddress).toBe(USER);
    expect('sessionGrant' in env).toBe(false);
  });

  it('refuses a method outside the session-allowed set', async () => {
    await expect(signSdkRequestEnvelope({ ...fields, method: 'GetTaskDataMetadata' }, opts)).rejects.toMatchObject({
      code: 'SDK_LOCAL_REQUEST_MALFORMED',
    });
  });

  it("refuses a key loaded for another session than the request's", async () => {
    const other = registeredSessionKey(`0x${'77'.repeat(32)}`, fixtureKey('session_key'));
    await expect(signSdkRequestEnvelope(fields, { ...opts, registeredKey: other })).rejects.toMatchObject({
      code: 'SDK_LOCAL_REQUEST_MALFORMED',
    });
  });

  it('refuses a session grant and a registered key together', async () => {
    // A well-formed grant for this user and chain: alone, it signs (the control below), so only
    // the exclusivity check can refuse the pair.
    const grantPriv = new Uint8Array(32).fill(0x04);
    const grantFields = {
      chainId: fields.chainId,
      user: USER,
      sessionKey: ethAddressBytes(secp256k1.getPublicKey(grantPriv, true)),
      expiryHeight: 2_000n,
      grantNonce: new Uint8Array(32).fill(0x05),
      signatureChainId: EVM,
    };
    const session: ActiveSession = {
      grant: { ...grantFields, userSignature: new Uint8Array(65).fill(0x06) },
      grantHash: sessionGrantHash(grantFields),
      key: privateKeyTypedDataSigner(grantPriv),
    };
    await expect(signSdkRequestEnvelope(fields, { ...opts, session })).rejects.toMatchObject({
      code: 'SDK_LOCAL_REQUEST_MALFORMED',
      message: expect.stringContaining('exclusive'),
    });
    const { registeredKey: _, ...withoutKey } = opts;
    void _;
    const env = await signSdkRequestEnvelope(fields, { ...withoutKey, session });
    expect(env.sessionGrant).toBeDefined();
  });
});
