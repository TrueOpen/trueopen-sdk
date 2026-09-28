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

const V = section('sdk_request');
const EVM = BigInt(V.domain.chain_id);
const USER = ACCOUNT_SIGNING.account.account_bech32 as string;
const wallet = privateKeyTypedDataSigner(fixtureKey('account'));

const fields: SdkRequestFields = {
  chainId: V.message.chainId!,
  method: V.message.method!,
  sessionId: V.message.sessionId!,
  taskId: V.message.taskId!,
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
    const env = await signSdkRequestEnvelope(fields, { signerAddress: USER, signer: wallet, evmChainId: EVM });
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
    await expect(signSdkRequestEnvelope(fields, { signerAddress: USER, signer: other, evmChainId: EVM })).rejects.toMatchObject({
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
    signed?: { signer?: string; message?: Record<string, string> };
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
      'open_task_with_session_grant',
      'sdk_request_expiry_zero',
      'sdk_request_grant_hash_without_grant',
      'sdk_request_other_chain_id',
      'sdk_request_other_evm_chain_id',
      'sdk_request_signed_by_wrong_key',
    ]);
  });

  for (const r of rows.filter((x) => x.signing_digest !== undefined)) {
    it(`${r.name}: signature and verifier digest`, async () => {
      if (r.signed !== undefined) {
        const signedData = fixtureTypedData(V, { message: r.signed.message ?? {} });
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
    refuse({ sessionId: V.message.sessionId!.toUpperCase() });
    refuse({ taskId: `0x${V.message.taskId}` });
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
