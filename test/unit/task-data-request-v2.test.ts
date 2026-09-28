import { describe, it, expect } from 'vitest';
import { createRouterTransport, ConnectError, Code } from '@connectrpc/connect';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import type { GetTaskDataMetadataRequest, FetchTaskDataRequest } from '../../src/gen/nexus/v1/ingress_pb.js';
import {
  taskDataRequestEip712Digest,
  taskDataRequestTypedData,
  TASK_DATA_OBJECT_KIND,
} from '../../src/transport/task-data-signbytes';
import type { TaskDataRequestAuthFields } from '../../src/transport/task-data-signbytes';
import { SessionKeyManager, sessionGrantHash } from '../../src/session/session-grant';
import type { ActiveSession } from '../../src/session/session-grant';
import { IngressClient } from '../../src/transport/ingress-client';
import type { IngressAuth } from '../../src/transport/ingress-client';
import { privateKeyTypedDataSigner, typedDataDigest } from '../../src/signer/typed-data-signer';
import { recoverEip712PubKey, ethAddressBytes } from '../../src/signer/eth-secp256k1';
import { fromHex, toHex } from '../../src/util/bytes';
import { ACCOUNT_SIGNING, fixtureKey, fixtureTypedData, section } from '../helpers/account-signing';

const D = section('task_data_request');
const DS = section('task_data_request_session');
const EVM = BigInt(D.domain.chain_id);
const USER = ACCOUNT_SIGNING.account.account_bech32 as string;
const wallet = privateKeyTypedDataSigner(fixtureKey('account'));

const fieldsOf = (m: Record<string, string>): TaskDataRequestAuthFields => ({
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
});

const recover = (digest: string, sig: string): string => toHex(ethAddressBytes(recoverEip712PubKey(fromHex(digest), fromHex(sig))));

describe('TaskDataRequest version 2 (USER path)', () => {
  it('task_data_request: wallet-signed, sessionGrantHash 32 zero bytes, exact signature', async () => {
    const data = taskDataRequestTypedData(fieldsOf(D.message), EVM);
    expect(toHex(typedDataDigest(data))).toBe(D.signing_digest);
    expect(toHex(await wallet.signTypedData(data))).toBe(D.signature_65);
    expect(recover(D.signing_digest, D.signature_65)).toBe(D.recovered_address);
  });

  it('task_data_request_session: session-key-signed under the session_grant hash, exact signature', async () => {
    const grantHash = fromHex(DS.message.sessionGrantHash!);
    expect(DS.message.sessionGrantHash).toBe(section('session_grant').hash_struct);
    const data = taskDataRequestTypedData(fieldsOf(DS.message), EVM, grantHash);
    expect(toHex(typedDataDigest(data))).toBe(DS.signing_digest);
    expect(toHex(await privateKeyTypedDataSigner(fixtureKey('session_key')).signTypedData(data))).toBe(DS.signature_65);
    expect(recover(DS.signing_digest, DS.signature_65)).toBe(ACCOUNT_SIGNING.session_key.address_bytes);
  });

  type Row = {
    name: string;
    base: string;
    error?: string;
    signed?: { signer?: string; message?: Record<string, string> };
    verified?: { message?: Record<string, string>; domain?: { chain_id?: string; version?: string } };
    signing_digest?: string;
    signature_65?: string;
    recovered_address?: string;
  };
  const rows = (ACCOUNT_SIGNING.request_auth_negative_cases as Row[]).filter((r) => r.base.startsWith('task_data_request'));

  it('covers the Task data rows', () => {
    expect(rows.map((r) => r.name).sort()).toEqual([
      'task_data_input_object_with_session_grant',
      'task_data_request_domain_version_1',
      'task_data_request_other_evm_chain_id',
      'task_data_upload_with_session_grant',
    ]);
  });

  for (const r of rows.filter((x) => x.signing_digest !== undefined)) {
    it(`${r.name}: signature, verifier digest and recovery`, async () => {
      const base = section(r.base);
      if (r.signed !== undefined) {
        const data = fixtureTypedData(base, { message: r.signed.message ?? {} });
        expect(toHex(await privateKeyTypedDataSigner(fixtureKey(r.signed.signer ?? 'account')).signTypedData(data))).toBe(r.signature_65);
      }
      const verified = fixtureTypedData(base, { message: r.verified?.message ?? {}, domain: r.verified?.domain ?? {} });
      expect(toHex(typedDataDigest(verified))).toBe(r.signing_digest);
      expect(recover(r.signing_digest!, r.signature_65 ?? base.signature_65)).toBe(r.recovered_address);
    });
  }

  it('the SDK always signs domain version 2, so a version 1 digest never matches', () => {
    expect(toHex(taskDataRequestEip712Digest(fieldsOf(D.message), EVM))).not.toBe(ACCOUNT_SIGNING.task_data_request_v1_obsolete.signing_digest);
  });
});

describe('IngressClient Task data requests with a session', () => {
  const S = '77625100ba4faa1306ae6eaf5a872a661443aa94f87c5530c4b178614e3d62f7';
  const T = 'bce966ae829f212a35982bcd85aaea77d8893539afa04f32ea540c46ff8323b0';
  const BUILDER = 'trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man';
  const ref = (objectKind: number) => ({ taskHash: '58'.repeat(32), sessionId: S, taskId: T, objectKind, contentHash: '22'.repeat(32) });

  function setup(expiredOnce = false) {
    const meta: GetTaskDataMetadataRequest[] = [];
    const fetches: FetchTaskDataRequest[] = [];
    let failMeta = expiredOnce;
    let failFetch = expiredOnce;
    const transport = createRouterTransport(({ service }) => {
      service(IngressAPI, {
        getTaskDataMetadata(req: GetTaskDataMetadataRequest) {
          meta.push(req);
          if (failMeta) { failMeta = false; throw new ConnectError('DATA_ACCESS_SESSION_GRANT_EXPIRED: window', Code.PermissionDenied); }
          return {};
        },
        async *fetchTaskData(req: FetchTaskDataRequest) {
          fetches.push(req);
          if (failFetch) { failFetch = false; throw new ConnectError('DATA_ACCESS_SESSION_GRANT_EXPIRED: window', Code.PermissionDenied); }
          yield { frame: { case: 'header', value: { totalSizeBytes: 1n, mediaType: 'x', servedRange: { offset: 0n, length: 1n } } } };
          yield { frame: { case: 'chunk', value: { offset: 0n, data: new Uint8Array([7]), eof: true } } };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    });
    const session = new SessionKeyManager({
      chainId: 'trueopen-golden-1', userAddress: USER, wallet, evmChainId: async () => EVM,
      latestHeight: async () => 1000n, maxGrantBlocks: 400,
    });
    const auth: IngressAuth = {
      chainId: 'trueopen-golden-1', userAddress: USER, wallet, evmChainId: EVM,
      nonce: () => new Uint8Array(32).fill(9), expiry: () => 1_790_000_000_000n, session,
    };
    return { client: new IngressClient(transport, auth), meta, fetches };
  }

  const recoversTo = (a: NonNullable<GetTaskDataMetadataRequest['requestAuth']>, grant?: ActiveSession['grant']): string => {
    const f: TaskDataRequestAuthFields = {
      schemaVersion: a.schemaVersion, chainId: a.chainId, builderOperatorAddress: a.builderOperatorAddress, rpcMethod: a.rpcMethod,
      bodyDigest: fromHex(a.bodyDigest), requesterKind: a.requesterKind, requesterAddress: a.requesterAddress,
      serviceAuthorizationNonce: a.serviceAuthorizationNonce, requestNonce: a.requestNonce, expiryHeight: a.expiryHeight,
    };
    const digest = taskDataRequestEip712Digest(f, EVM, grant !== undefined ? sessionGrantHash(grant) : undefined);
    return toHex(ethAddressBytes(recoverEip712PubKey(digest, a.signature)));
  };

  it('an OUTPUT object is session-signed and carries the grant in field 12', async () => {
    const { client, meta, fetches } = setup();
    await client.getTaskDataMetadata({ objectRef: ref(TASK_DATA_OBJECT_KIND.OUTPUT), builderAddress: BUILDER, expiresAtHeight: 1010n });
    await client.fetchTaskDataRange({ objectRef: ref(TASK_DATA_OBJECT_KIND.OUTPUT), builderAddress: BUILDER, expiresAtHeight: 1010n, range: { offset: 0n, length: 1n } });
    for (const a of [meta[0]!.requestAuth!, fetches[0]!.requestAuth!]) {
      const g = a.sessionGrant!;
      expect(g).toBeDefined();
      expect(a.requesterAddress).toBe(USER);
      const grant = { chainId: g.chainId, user: g.user, sessionKey: g.sessionKey, expiryHeight: g.expiryHeight, grantNonce: g.grantNonce, userSignature: g.userSignature };
      expect(recoversTo(a, grant)).toBe(toHex(g.sessionKey));
    }
  });

  it('an INPUT object is wallet-signed without a grant, even with a session', async () => {
    const { client, meta } = setup();
    await client.getTaskDataMetadata({ objectRef: ref(TASK_DATA_OBJECT_KIND.INPUT), builderAddress: BUILDER, expiresAtHeight: 1010n });
    const a = meta[0]!.requestAuth!;
    expect(a.sessionGrant).toBeUndefined();
    expect(recoversTo(a)).toBe(ACCOUNT_SIGNING.account.address_bytes);
  });

  it('an expired grant is renewed and the request sent once more (unary and stream)', async () => {
    const { client, meta, fetches } = setup(true);
    await client.getTaskDataMetadata({ objectRef: ref(TASK_DATA_OBJECT_KIND.OUTPUT), builderAddress: BUILDER, expiresAtHeight: 1010n });
    expect(meta).toHaveLength(2);
    expect(toHex(meta[1]!.requestAuth!.sessionGrant!.sessionKey)).not.toBe(toHex(meta[0]!.requestAuth!.sessionGrant!.sessionKey));
    const got = await client.fetchTaskDataRange({ objectRef: ref(TASK_DATA_OBJECT_KIND.OUTPUT), builderAddress: BUILDER, expiresAtHeight: 1010n, range: { offset: 0n, length: 1n } });
    expect(Array.from(got.bytes)).toEqual([7]);
    expect(fetches).toHaveLength(2);
  });

  it('refuses a session grant whose user is not the requester', async () => {
    // The session key manager is bound to USER; the auth context claims a different user. The
    // grant must be rejected before anything is signed, mirroring signSdkRequestEnvelope.
    const session = new SessionKeyManager({
      chainId: 'trueopen-golden-1', userAddress: USER, wallet, evmChainId: async () => EVM,
      latestHeight: async () => 1000n, maxGrantBlocks: 400,
    });
    const auth: IngressAuth = {
      chainId: 'trueopen-golden-1', userAddress: 'trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man', wallet, evmChainId: EVM,
      nonce: () => new Uint8Array(32).fill(9), expiry: () => 1_790_000_000_000n, session,
    };
    const transport = createRouterTransport(({ service }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      service(IngressAPI, { getTaskDataMetadata: () => ({}) } as any);
    });
    const client = new IngressClient(transport, auth);
    await expect(
      client.getTaskDataMetadata({ objectRef: ref(TASK_DATA_OBJECT_KIND.OUTPUT), builderAddress: BUILDER, expiresAtHeight: 1010n }),
    ).rejects.toMatchObject({ code: 'SDK_LOCAL_REQUEST_MALFORMED' });
  });
});
