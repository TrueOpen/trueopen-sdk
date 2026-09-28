import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  privateKeyTypedDataSigner,
  eip1193TypedDataSigner,
  keplrTypedDataSigner,
  typedDataDigest,
  typedDataJson,
  normalizeWalletSignature,
  signTypedDataAs,
} from '../../src/signer/typed-data-signer';
import { sdkRequestTypedData } from '../../src/transport/sdk-request-envelope';
import { fromHex, toHex } from '../../src/util/bytes';
import { TrueOpenError } from '../../src/errors/errors';
import { ACCOUNT_SIGNING, fixtureKey, fixtureTypedData, section } from '../helpers/account-signing';

const ACCOUNT = fixtureKey('account');
const ACCOUNT_ADDR = fromHex(ACCOUNT_SIGNING.account.address_bytes);
const SDK = section('sdk_request');

/** The OpenTask request of the sdk_request vector, built by the SDK. */
const sdkRequest = sdkRequestTypedData(
  {
    chainId: SDK.message.chainId!,
    method: SDK.message.method!,
    sessionId: SDK.message.sessionId!,
    taskId: SDK.message.taskId!,
    requestNonce: fromHex(SDK.message.requestNonce!),
    expiryHeightOrTime: BigInt(SDK.message.expiryHeightOrTime!),
    bodyDigest: fromHex(SDK.message.bodyDigest!),
  },
  BigInt(SDK.domain.chain_id),
);

describe('privateKeyTypedDataSigner (real signatures)', () => {
  // Every positive section a user or the session key signs, from the fixture's own typed data.
  const cases: [string, Uint8Array][] = [
    ['task_order', ACCOUNT],
    ['sdk_request', ACCOUNT],
    ['sdk_request_session', fixtureKey('session_key')],
    ['session_grant', ACCOUNT],
    ['task_data_request', ACCOUNT],
    ['task_data_request_session', fixtureKey('session_key')],
  ];
  for (const [name, key] of cases) {
    it(`${name}: the exact 65-byte RFC 6979 signature`, async () => {
      const s = section(name);
      const data = fixtureTypedData(s);
      expect(toHex(typedDataDigest(data))).toBe(s.signing_digest);
      const sig = await privateKeyTypedDataSigner(key).signTypedData(data);
      expect(toHex(sig)).toBe(s.signature_65);
      expect([27, 28]).toContain(sig[64]);
      expect(secp256k1.Signature.fromCompact(sig.subarray(0, 64)).hasHighS()).toBe(false);
    });
  }

  it('the SDK-built SDKRequest signs to the fixture signature', async () => {
    expect(toHex(await privateKeyTypedDataSigner(ACCOUNT).signTypedData(sdkRequest))).toBe(SDK.signature_65);
  });
});

describe('typedDataJson (what a wallet is asked to sign)', () => {
  it('bytes32 as 0x-hex, uint64 and the domain chainId as decimal strings', () => {
    expect(typedDataJson(sdkRequest)).toEqual({
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
        ],
        SDKRequest: [
          { name: 'chainId', type: 'string' },
          { name: 'method', type: 'string' },
          { name: 'endpoint', type: 'string' },
          { name: 'sessionId', type: 'bytes32' },
          { name: 'taskId', type: 'bytes32' },
          { name: 'requestNonce', type: 'bytes32' },
          { name: 'expiryHeightOrTime', type: 'uint64' },
          { name: 'bodyDigest', type: 'bytes32' },
          { name: 'sessionGrantHash', type: 'bytes32' },
        ],
      },
      primaryType: 'SDKRequest',
      domain: { name: 'TrueOpen SDK Request', version: '1', chainId: '424242' },
      message: {
        chainId: 'trueopen-golden-1',
        method: 'OpenTask',
        endpoint: '/nexus.v1.IngressAPI/OpenTask',
        sessionId: `0x${SDK.message.sessionId}`,
        taskId: `0x${SDK.message.taskId}`,
        requestNonce: `0x${SDK.message.requestNonce}`,
        expiryHeightOrTime: '1010',
        bodyDigest: `0x${SDK.message.bodyDigest}`,
        sessionGrantHash: `0x${'00'.repeat(32)}`,
      },
    });
  });

  it('an address field is 0x-hex (SessionGrant.sessionKey)', () => {
    const json = typedDataJson(fixtureTypedData(section('session_grant')));
    expect(json.message).toMatchObject({ sessionKey: `0x${ACCOUNT_SIGNING.session_key.address_bytes}`, expiryHeight: '1500' });
  });
});

describe('eip1193TypedDataSigner (mock provider)', () => {
  const ADDRESS_0X = ACCOUNT_SIGNING.account.address_0x as string;

  function provider(answer: unknown) {
    const calls: { method: string; params?: unknown[] }[] = [];
    return { calls, provider: { request: async (args: { method: string; params?: unknown[] }) => { calls.push(args); return answer; } } };
  }

  it('calls eth_signTypedData_v4 with [address, JSON] and returns the signature', async () => {
    const p = provider(`0x${SDK.signature_65}`);
    const sig = await eip1193TypedDataSigner({ provider: p.provider, address: ADDRESS_0X }).signTypedData(sdkRequest);
    expect(toHex(sig)).toBe(SDK.signature_65);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.method).toBe('eth_signTypedData_v4');
    expect(p.calls[0]!.params![0]).toBe(ADDRESS_0X);
    expect(JSON.parse(p.calls[0]!.params![1] as string)).toEqual(typedDataJson(sdkRequest));
  });

  it('a V of 0/1 is moved to 27/28; anything malformed is refused', async () => {
    const zeroV = `0x${SDK.signature_65.slice(0, 128)}0${Number.parseInt(SDK.signature_65.slice(128), 16) - 27}`;
    const sig = await eip1193TypedDataSigner({ provider: provider(zeroV).provider, address: ADDRESS_0X }).signTypedData(sdkRequest);
    expect(toHex(sig)).toBe(SDK.signature_65);
    for (const bad of [42, '0x1234', `0x${SDK.signature_65.slice(0, 128)}05`]) {
      await expect(
        eip1193TypedDataSigner({ provider: provider(bad).provider, address: ADDRESS_0X }).signTypedData(sdkRequest),
      ).rejects.toBeInstanceOf(TrueOpenError);
    }
  });

  it('a malformed account address is refused up front', () => {
    expect(() => eip1193TypedDataSigner({ provider: provider('').provider, address: 'trueopen1abc' })).toThrow(TrueOpenError);
  });
});

describe('keplrTypedDataSigner (mock Keplr)', () => {
  it('calls signEthereum(chainId, bech32 signer, JSON, "eip-712")', async () => {
    const calls: unknown[][] = [];
    const keplr = {
      signEthereum: async (...args: unknown[]) => {
        calls.push(args);
        return fromHex(SDK.signature_65);
      },
    };
    const signer = keplrTypedDataSigner({ keplr, chainId: 'trueopen-golden-1', signer: ACCOUNT_SIGNING.account.account_bech32 });
    expect(toHex(await signer.signTypedData(sdkRequest))).toBe(SDK.signature_65);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('trueopen-golden-1');
    expect(calls[0]![1]).toBe(ACCOUNT_SIGNING.account.account_bech32);
    expect(JSON.parse(calls[0]![2] as string)).toEqual(typedDataJson(sdkRequest));
    expect(calls[0]![3]).toBe('eip-712');
  });
});

describe('signature shape and recovery checks', () => {
  it('normalizeWalletSignature refuses high S and wrong lengths', () => {
    const sig = fromHex(SDK.signature_65);
    const parsed = secp256k1.Signature.fromCompact(sig.subarray(0, 64));
    const highS = new secp256k1.Signature(parsed.r, secp256k1.CURVE.n - parsed.s).toCompactRawBytes();
    const flipped = Uint8Array.from([...highS, sig[64] === 27 ? 28 : 27]);
    expect(() => normalizeWalletSignature(flipped)).toThrow(/high S/);
    expect(() => normalizeWalletSignature(sig.subarray(0, 64))).toThrow(/65 bytes/);
    // r = 0 (and s = 0) is not a signature; the parse error surfaces as a typed error.
    const zeroR = Uint8Array.from(sig);
    zeroR.fill(0, 0, 32);
    expect(() => normalizeWalletSignature(zeroR)).toThrow(expect.objectContaining({ code: 'SDK_LOCAL_BAD_SIGNATURE' }));
    const zeroS = Uint8Array.from(sig);
    zeroS.fill(0, 32, 64);
    expect(() => normalizeWalletSignature(zeroS)).toThrow(expect.objectContaining({ code: 'SDK_LOCAL_BAD_SIGNATURE' }));
  });

  it('signTypedDataAs refuses a signature from another account', async () => {
    const other = privateKeyTypedDataSigner(fixtureKey('wrong_key'));
    await expect(signTypedDataAs(other, sdkRequest, ACCOUNT_ADDR)).rejects.toMatchObject({ code: 'SDK_LOCAL_SIGNER_ADDRESS_MISMATCH' });
    const ok = await signTypedDataAs(privateKeyTypedDataSigner(ACCOUNT), sdkRequest, ACCOUNT_ADDR);
    expect(toHex(ok)).toBe(SDK.signature_65);
  });
});
