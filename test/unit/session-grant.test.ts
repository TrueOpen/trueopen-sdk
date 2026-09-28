import { describe, it, expect } from 'vitest';
import { createRouterTransport, ConnectError, Code } from '@connectrpc/connect';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import type { AckOutputRequest, SubscribeOutputRequest } from '../../src/gen/nexus/v1/ingress_pb.js';
import {
  SESSION_GRANT_EIP712_TYPES,
  SessionKeyManager,
  sessionGrantHash,
  sessionGrantMessage,
  sessionGrantTypedData,
} from '../../src/session/session-grant';
import type { ActiveSession, SignedSessionGrant } from '../../src/session/session-grant';
import { signSdkRequestEnvelope, sdkRequestEip712Digest, sdkRequestEip712Domain } from '../../src/transport/sdk-request-envelope';
import type { SdkRequestFields } from '../../src/transport/sdk-request-envelope';
import { IngressClient } from '../../src/transport/ingress-client';
import type { IngressAuth } from '../../src/transport/ingress-client';
import { eip712DomainSeparator, eip712EncodeType, eip712TypeHash } from '../../src/codec/eip712';
import { privateKeyTypedDataSigner, typedDataDigest } from '../../src/signer/typed-data-signer';
import type { TypedData, TypedDataSigner } from '../../src/signer/typed-data-signer';
import { recoverEip712PubKey, ethAddressBytes } from '../../src/signer/eth-secp256k1';
import { fromHex, toHex } from '../../src/util/bytes';
import { ACCOUNT_SIGNING, fixtureKey, fixtureTypedData, section } from '../helpers/account-signing';

const G = section('session_grant');
const R = section('sdk_request_session');
const EVM = BigInt(G.domain.chain_id);
const USER = ACCOUNT_SIGNING.account.account_bech32 as string;
const wallet = privateKeyTypedDataSigner(fixtureKey('account'));
const T = ACCOUNT_SIGNING.session_grant.transport;

const grantFields = {
  chainId: T.chain_id as string,
  user: T.user as string,
  sessionKey: fromHex(T.session_key_hex),
  expiryHeight: BigInt(T.expiry_height),
  grantNonce: fromHex(T.grant_nonce_hex),
};
const grant: SignedSessionGrant = { ...grantFields, userSignature: fromHex(G.signature_65) };
const fixtureSession: ActiveSession = {
  grant,
  grantHash: fromHex(G.hash_struct),
  key: privateKeyTypedDataSigner(fixtureKey('session_key')),
};

const reqFields: SdkRequestFields = {
  chainId: R.message.chainId!,
  method: R.message.method!,
  sessionId: R.message.sessionId!,
  taskId: R.message.taskId!,
  requestNonce: fromHex(R.message.requestNonce!),
  expiryHeightOrTime: BigInt(R.message.expiryHeightOrTime!),
  bodyDigest: fromHex(R.message.bodyDigest!),
};

const recover = (digest: string, sig: string): string => toHex(ethAddressBytes(recoverEip712PubKey(fromHex(digest), fromHex(sig))));

describe('SessionGrant EIP-712 (account_signing_v1.json session_grant)', () => {
  it('signed under the SDK Request domain', () => {
    expect(G.domain.name).toBe('TrueOpen SDK Request');
    expect(toHex(eip712DomainSeparator(SESSION_GRANT_EIP712_TYPES, sdkRequestEip712Domain(EVM)))).toBe(G.domain.domain_separator);
  });

  it('encode_type, type_hash, hash_struct and signing digest', () => {
    expect(eip712EncodeType('SessionGrant', SESSION_GRANT_EIP712_TYPES)).toBe(G.encode_type);
    expect(toHex(eip712TypeHash('SessionGrant', SESSION_GRANT_EIP712_TYPES))).toBe(G.type_hash);
    expect(toHex(sessionGrantHash(grantFields))).toBe(G.hash_struct);
    expect(toHex(typedDataDigest(sessionGrantTypedData(grantFields, EVM)))).toBe(G.signing_digest);
  });

  it('the wallet signs the exact fixture signature, recovering to the user', async () => {
    const sig = await wallet.signTypedData(sessionGrantTypedData(grantFields, EVM));
    expect(toHex(sig)).toBe(G.signature_65);
    expect(recover(G.signing_digest, G.signature_65)).toBe(G.recovered_address);
  });

  it('SessionGrantV1 on the wire carries the transport columns', () => {
    const m = sessionGrantMessage(grant);
    expect(m).toMatchObject({ chainId: T.chain_id, user: T.user, expiryHeight: BigInt(T.expiry_height) });
    expect(toHex(m.sessionKey)).toBe(T.session_key_hex);
    expect(toHex(m.grantNonce)).toBe(T.grant_nonce_hex);
    expect(toHex(m.userSignature)).toBe(G.signature_65);
  });
});

describe('session-signed SDKRequest (account_signing_v1.json sdk_request_session)', () => {
  it('the session key signs the exact fixture signature with sessionGrantHash = hashStruct(grant)', async () => {
    const env = await signSdkRequestEnvelope(reqFields, { signerAddress: USER, signer: wallet, evmChainId: EVM, session: fixtureSession });
    expect(toHex(sdkRequestEip712Digest(reqFields, EVM, fixtureSession.grantHash))).toBe(R.signing_digest);
    expect(R.message.sessionGrantHash).toBe(G.hash_struct);
    expect(toHex(env.signature)).toBe(R.signature_65);
    expect(recover(R.signing_digest, R.signature_65)).toBe(R.recovered_address);
    expect(R.recovered_address).toBe(ACCOUNT_SIGNING.session_key.address_bytes);
    // signer_address stays the granting user; the grant travels with the request.
    expect(env.signerAddress).toBe(USER);
    expect(env.sessionGrant).toBe(grant);
  });

  it('refuses to session-sign OpenTask or a grant for another user', async () => {
    await expect(
      signSdkRequestEnvelope({ ...reqFields, method: 'OpenTask' }, { signerAddress: USER, signer: wallet, evmChainId: EVM, session: fixtureSession }),
    ).rejects.toMatchObject({ code: 'SDK_LOCAL_REQUEST_MALFORMED' });
    await expect(
      signSdkRequestEnvelope(reqFields, {
        signerAddress: 'trueopen15zs69gay5kn2029f4246etdw47ctrv4ns6facc', signer: wallet, evmChainId: EVM, session: fixtureSession,
      }),
    ).rejects.toMatchObject({ code: 'SDK_LOCAL_REQUEST_MALFORMED' });
  });
});

describe('request_auth_negative_cases on session_grant and sdk_request_session', () => {
  type Row = {
    name: string;
    base: string;
    signed?: { signer?: string; message?: Record<string, string> };
    verified?: { message?: Record<string, string> };
    signing_digest?: string;
    signature_65?: string;
    recovered_address?: string;
  };
  const rows = (ACCOUNT_SIGNING.request_auth_negative_cases as Row[]).filter(
    (r) => (r.base === 'session_grant' || r.base === 'sdk_request_session') && r.signing_digest !== undefined,
  );

  it('covers the signed rows', () => {
    expect(rows.map((r) => r.name).sort()).toEqual([
      'sdk_request_session_method_endpoint_mismatch',
      'sdk_request_session_signed_by_wrong_key',
      'sdk_request_session_signed_without_grant_hash',
      'sdk_request_session_tampered_body_digest',
      'session_grant_other_chain',
      'session_grant_signed_by_wrong_key',
    ]);
  });

  for (const r of rows) {
    it(`${r.name}: signature, verifier digest and recovery`, async () => {
      const base = section(r.base);
      if (r.signed !== undefined) {
        const data = fixtureTypedData(base, { message: r.signed.message ?? {} });
        const sig = await privateKeyTypedDataSigner(fixtureKey(r.signed.signer ?? 'account')).signTypedData(data);
        expect(toHex(sig)).toBe(r.signature_65);
      }
      const verified = fixtureTypedData(base, { message: r.verified?.message ?? {} });
      expect(toHex(typedDataDigest(verified))).toBe(r.signing_digest);
      expect(recover(r.signing_digest!, r.signature_65 ?? base.signature_65)).toBe(r.recovered_address);
    });
  }
});

/** A wallet that counts prompts. */
function countingWallet(inner: TypedDataSigner): TypedDataSigner & { prompts: TypedData[] } {
  const prompts: TypedData[] = [];
  return { prompts, signTypedData: async (d) => { prompts.push(d); return inner.signTypedData(d); } };
}

describe('SessionKeyManager', () => {
  const manager = (height: { h: bigint }, w: TypedDataSigner = wallet, extra: Partial<{ grantBlocks: number; renewBeforeBlocks: number }> = {}) =>
    new SessionKeyManager({
      chainId: 'trueopen-golden-1', userAddress: USER, wallet: w, evmChainId: async () => EVM,
      latestHeight: async () => height.h, maxGrantBlocks: 400, ...extra,
    });

  it('grants a fresh in-memory key, expiring within the configured maximum, signed by the wallet', async () => {
    const height = { h: 1200n };
    const w = countingWallet(wallet);
    const s = await manager(height, w).current();
    expect(s.grant.expiryHeight).toBe(1200n + 398n);
    expect(s.grant.expiryHeight - 1200n).toBeLessThanOrEqual(400n);
    expect(s.grant.user).toBe(USER);
    expect(s.grant.grantNonce).toHaveLength(32);
    expect(w.prompts).toHaveLength(1);
    expect(w.prompts[0]!.primaryType).toBe('SessionGrant');
    // The wallet's signature recovers to the user; the key signs as grant.sessionKey.
    const digest = typedDataDigest(sessionGrantTypedData(s.grant, EVM));
    expect(toHex(ethAddressBytes(recoverEip712PubKey(digest, s.grant.userSignature)))).toBe(ACCOUNT_SIGNING.account.address_bytes);
    expect(toHex(s.grantHash)).toBe(toHex(sessionGrantHash(s.grant)));
    const probe = sessionGrantTypedData(s.grant, EVM);
    const keySig = await s.key.signTypedData(probe);
    expect(toHex(ethAddressBytes(recoverEip712PubKey(typedDataDigest(probe), keySig)))).toBe(toHex(s.grant.sessionKey));
  });

  it('reuses the grant, renews it before expiry with a new key, and shares one renewal', async () => {
    const height = { h: 1000n };
    const w = countingWallet(wallet);
    const m = manager(height, w, { grantBlocks: 100, renewBeforeBlocks: 10 });
    const [a, b] = await Promise.all([m.current(), m.current()]);
    expect(a).toBe(b);
    expect(w.prompts).toHaveLength(1);
    height.h = 1089n;
    expect(await m.current()).toBe(a);
    height.h = 1090n;
    const renewed = await m.current();
    expect(renewed).not.toBe(a);
    expect(renewed.grant.expiryHeight).toBe(1190n);
    expect(toHex(renewed.grant.sessionKey)).not.toBe(toHex(a.grant.sessionKey));
    expect(w.prompts).toHaveLength(2);
    m.expired(renewed.grant);
    expect(await m.current()).not.toBe(renewed);
    expect(w.prompts).toHaveLength(3);
  });

  it('two managers never share a key (not derived from any signature)', async () => {
    const [a, b] = await Promise.all([manager({ h: 1n }).current(), manager({ h: 1n }).current()]);
    expect(toHex(a.grant.sessionKey)).not.toBe(toHex(b.grant.sessionKey));
  });

  it('refuses a lifetime above the maximum', () => {
    expect(() => manager({ h: 1n }, wallet, { grantBlocks: 401 })).toThrow(/grantBlocks/);
    expect(() => manager({ h: 1n }, wallet, { grantBlocks: 10, renewBeforeBlocks: 10 })).toThrow(/renewBeforeBlocks/);
  });
});

describe('IngressClient with a session', () => {
  const S = R.message.sessionId!;
  const TASK = R.message.taskId!;

  function setup(failures: { ack: number; subscribe: number }) {
    const acks: AckOutputRequest[] = [];
    const subs: SubscribeOutputRequest[] = [];
    const transport = createRouterTransport(({ service }) => {
      service(IngressAPI, {
        ackOutput(req: AckOutputRequest) {
          acks.push(req);
          if (failures.ack-- > 0) throw new ConnectError('SDK_AUTH_SESSION_GRANT_EXPIRED: outside window', Code.Unauthenticated);
          return { acked: true, alreadyAcked: false, ackedAt: 1n };
        },
        async *subscribeOutput(req: SubscribeOutputRequest) {
          subs.push(req);
          if (failures.subscribe-- > 0) throw new ConnectError('SDK_AUTH_SESSION_GRANT_EXPIRED: outside window', Code.Unauthenticated);
          yield { frame: { case: 'fin', value: { finalSeq: 0n, outputMmrRoot: new Uint8Array(32), finishReason: 1, workerSignature: new Uint8Array() } } };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    });
    const height = { h: 1000n };
    const w = countingWallet(wallet);
    const session = new SessionKeyManager({
      chainId: 'trueopen-golden-1', userAddress: USER, wallet: w, evmChainId: async () => EVM,
      latestHeight: async () => height.h, maxGrantBlocks: 400,
    });
    const auth: IngressAuth = {
      chainId: 'trueopen-golden-1', userAddress: USER, wallet: w, evmChainId: EVM,
      nonce: (() => { let n = 0; return () => new Uint8Array(32).fill(++n); })(),
      expiry: () => 1_790_000_000_000n, session,
    };
    return { client: new IngressClient(transport, auth), acks, subs, w };
  }

  it('session-signs an allowed request and attaches the grant; the wallet signs only the grant', async () => {
    const { client, acks, w } = setup({ ack: 0, subscribe: 0 });
    await client.ackOutput({ sessionId: S, taskId: TASK, lastSeq: 3n });
    const env = acks[0]!.requestEnvelope!;
    expect(env.sessionGrant).toBeDefined();
    expect(env.signerAddress).toBe(USER);
    const g = env.sessionGrant!;
    const hash = sessionGrantHash({ chainId: g.chainId, user: g.user, sessionKey: g.sessionKey, expiryHeight: g.expiryHeight, grantNonce: g.grantNonce });
    const digest = sdkRequestEip712Digest(
      { chainId: env.chainId, method: env.method, sessionId: env.sessionId, taskId: env.taskId, requestNonce: env.requestNonce, expiryHeightOrTime: env.expiryHeightOrTime, bodyDigest: env.bodyDigest },
      EVM, hash,
    );
    expect(toHex(ethAddressBytes(recoverEip712PubKey(digest, env.signature)))).toBe(toHex(g.sessionKey));
    expect(w.prompts.map((p) => p.primaryType)).toEqual(['SessionGrant']);
  });

  it('an expired grant is renewed and the request sent once more', async () => {
    const { client, acks, w } = setup({ ack: 1, subscribe: 0 });
    await client.ackOutput({ sessionId: S, taskId: TASK, lastSeq: 3n });
    expect(acks).toHaveLength(2);
    expect(toHex(acks[1]!.requestEnvelope!.sessionGrant!.sessionKey)).not.toBe(toHex(acks[0]!.requestEnvelope!.sessionGrant!.sessionKey));
    expect(w.prompts).toHaveLength(2);
  });

  it('only once: a second expiry is reported', async () => {
    const { client, acks } = setup({ ack: 2, subscribe: 0 });
    await expect(client.ackOutput({ sessionId: S, taskId: TASK, lastSeq: 3n })).rejects.toMatchObject({ code: 'SDK_AUTH_SESSION_GRANT_EXPIRED' });
    expect(acks).toHaveLength(2);
  });

  it('a stream that fails with an expired grant before its first message is re-subscribed once', async () => {
    const { client, subs } = setup({ ack: 0, subscribe: 1 });
    const got = [];
    for await (const m of client.subscribeOutput({ sessionId: S, taskId: TASK })) got.push(m);
    expect(got).toHaveLength(1);
    expect(subs).toHaveLength(2);
  });
});
