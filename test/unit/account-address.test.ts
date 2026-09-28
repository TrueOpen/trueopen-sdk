import { describe, it, expect } from 'vitest';
import { bech32 } from '@scure/base';
import { canonicalAccountAddressBytes, toAccountAddress, ACCOUNT_ADDRESS_PREFIX } from '../../src/codec/address';
import { signSdkRequestEnvelope } from '../../src/transport/sdk-request-envelope';
import { privateKeyTypedDataSigner } from '../../src/signer/typed-data-signer';
import { classifyNexusError } from '../../src/errors/classify';
import { TrueOpenClient } from '../../src/client';
import { ConnectError, Code, createRouterTransport } from '@connectrpc/connect';
import { toHex } from '../../src/util/bytes';
import { ACCOUNT_SIGNING, fixtureKey } from '../helpers/account-signing';

const USER = ACCOUNT_SIGNING.account.account_bech32 as string;
const ADDR20 = ACCOUNT_SIGNING.account.address_bytes as string;

describe('account addresses: canonical lowercase Bech32, prefix trueopen, 20 bytes', () => {
  it('accepts the account address and returns its 20 bytes', () => {
    expect(ACCOUNT_ADDRESS_PREFIX).toBe('trueopen');
    expect(toHex(canonicalAccountAddressBytes('a', USER))).toBe(ADDR20);
  });

  it('refuses another prefix, uppercase, and a length other than 20', () => {
    const words = bech32.toWords(Buffer.from(ADDR20, 'hex'));
    for (const bad of [
      bech32.encode('trueopenvaloper', words),
      bech32.encode('cosmos', words),
      USER.toUpperCase(),
      bech32.encode('trueopen', bech32.toWords(new Uint8Array(32).fill(1))),
    ]) {
      expect(() => canonicalAccountAddressBytes('a', bad), bad).toThrow(expect.objectContaining({ code: 'SDK_LOCAL_ADDRESS_NOT_CANONICAL' }));
    }
  });

  it('converts a wallet 0x address (any case) to the Bech32 account address', () => {
    expect(toAccountAddress(ACCOUNT_SIGNING.account.address_0x)).toBe(USER);
    expect(toAccountAddress(`0x${ADDR20.toUpperCase()}`)).toBe(USER);
    expect(toAccountAddress(USER)).toBe(USER);
    expect(() => toAccountAddress('0x1234')).toThrow();
  });

  it('the client converts a 0x userAddress and refuses a non-account prefix', () => {
    const base = { chainId: 'trueopen-golden-1', wallet: privateKeyTypedDataSigner(fixtureKey('account')), evmChainId: 424242n, chain: {} as never, ingressTransport: createRouterTransport(() => {}) };
    const client = new TrueOpenClient({ ...base, userAddress: ACCOUNT_SIGNING.account.address_0x });
    expect(client.ingressAuth().userAddress).toBe(USER);
    expect(() => new TrueOpenClient({ ...base, userAddress: ACCOUNT_SIGNING.account.operator_bech32 })).toThrow(/account prefix/);
  });

  it('signSdkRequestEnvelope refuses a signer_address with another prefix and a chain_id that is not the configured chain', async () => {
    const fields = {
      chainId: 'trueopen-golden-1', method: 'AckOutput', sessionId: '77'.repeat(32), taskId: 'bc'.repeat(32),
      requestNonce: new Uint8Array(32), expiryHeightOrTime: 1_790_000_000_000n, bodyDigest: new Uint8Array(32),
    };
    const signer = privateKeyTypedDataSigner(fixtureKey('account'));
    await expect(signSdkRequestEnvelope(fields, { signerAddress: ACCOUNT_SIGNING.account.operator_bech32, signer, evmChainId: 424242n }))
      .rejects.toMatchObject({ code: 'SDK_LOCAL_ADDRESS_NOT_CANONICAL' });
    await expect(signSdkRequestEnvelope({ ...fields, chainId: 'trueopen-golden-2' }, { signerAddress: USER, signer, evmChainId: 424242n, chainId: 'trueopen-golden-1' }))
      .rejects.toMatchObject({ code: 'SDK_LOCAL_CHAIN_ID_MISMATCH' });
    await expect(signSdkRequestEnvelope(fields, { signerAddress: USER, signer, evmChainId: 424242n, chainId: 'trueopen-golden-1' })).resolves.toBeDefined();
  });
});

describe('expiry error codes', () => {
  it('NEXUS_DATA_EXPIRED (request expiry) re-signs on the same Builder; DATA_EXPIRED (retention) switches Builder', () => {
    expect(classifyNexusError(new ConnectError('NEXUS_DATA_EXPIRED: request height', Code.DeadlineExceeded)))
      .toMatchObject({ code: 'NEXUS_DATA_EXPIRED', category: 'expired', retriable: true, switchSource: false });
    expect(classifyNexusError(new ConnectError('DATA_EXPIRED: retention passed', Code.NotFound)))
      .toMatchObject({ code: 'DATA_EXPIRED', retriable: false, switchSource: true });
  });
});
