/**
 * The fake Builder's verifier (support/independent.ts) against the wire fixtures: every positive
 * request section is accepted, and every row of request_auth_negative_cases that a verifier can
 * decide is rejected with the published code. This is what makes the e2e fakes trustworthy: they
 * enforce the contract as published, not as the SDK implements it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as v from './support/independent';

const F = JSON.parse(readFileSync('third_party/wire/testdata/v1/shared/account_signing_v1.json', 'utf8'));
const unhex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));

const ACCOUNT = F.account.account_bech32 as string;
const ACCOUNT_PUB = unhex(F.account.pub_compressed);

function ctx(over: Partial<v.AuthContext> = {}): v.AuthContext {
  return {
    chainId: 'trueopen-golden-1',
    evmChainId: 424242n,
    height: 1200n,
    // The session vector's expiry is Unix ms 1790000000000; the verifier's clock is before it.
    nowMs: 1_700_000_000_000n,
    maxSessionGrantBlocks: 400n,
    requestTtlBlocks: 20n,
    accountPubKey: (a) => (a === ACCOUNT ? ACCOUNT_PUB : undefined),
    seenNonces: new Set(),
    ...over,
  };
}

const T = F.session_grant.transport;
const grant = (over: Partial<v.GrantLike> = {}): v.GrantLike => ({
  chainId: T.chain_id, user: T.user, sessionKey: unhex(T.session_key_hex), expiryHeight: BigInt(T.expiry_height),
  grantNonce: unhex(T.grant_nonce_hex), userSignature: unhex(F.session_grant.signature_65), ...over,
});

/** The envelope of a request section, with transport overrides. */
function envelope(name: 'sdk_request' | 'sdk_request_session', over: Partial<v.EnvelopeLike> = {}): v.EnvelopeLike {
  const s = F[name];
  const m = s.message;
  return {
    requestDomain: s.envelope.request_domain, chainId: m.chainId, method: m.method, endpoint: m.endpoint,
    sessionId: m.sessionId, taskId: m.taskId, requestNonce: unhex(m.requestNonce), expiryHeightOrTime: BigInt(m.expiryHeightOrTime),
    bodyDigest: unhex(m.bodyDigest), signerAddress: s.envelope.signer_address, signature: unhex(s.signature_65),
    ...(name === 'sdk_request_session' ? { sessionGrant: grant() } : {}),
    ...over,
  };
}

function verifyRequest(e: v.EnvelopeLike, c: v.AuthContext, body?: Uint8Array): string {
  const isOpenTask = e.method === 'OpenTask';
  return v.verifySdkRequest(e, {
    method: F[isOpenTask ? 'sdk_request' : 'sdk_request_session'].message.method,
    sessionId: e.sessionId, taskId: e.taskId, body: () => body ?? e.bodyDigest,
    ...(isOpenTask ? { openTaskSequence: 7n } : {}),
  }, c);
}

const code = (run: () => unknown): string => {
  try {
    run();
  } catch (e) {
    if (e instanceof v.VerifyError) return e.code;
    throw e;
  }
  return 'accepted';
};

describe('independent verifier: positive sections', () => {
  it('sdk_request (OpenTask, wallet) is accepted at height 1000', () => {
    expect(code(() => verifyRequest(envelope('sdk_request'), ctx({ height: 1000n })))).toBe('accepted');
  });
  it('sdk_request_session (SubscribeOutput, session key) is accepted', () => {
    expect(code(() => verifyRequest(envelope('sdk_request_session'), ctx()))).toBe('accepted');
  });
  it('replaying the same nonce is SDK_AUTH_REPLAY', () => {
    const c = ctx();
    verifyRequest(envelope('sdk_request_session'), c);
    expect(code(() => verifyRequest(envelope('sdk_request_session'), c))).toBe('SDK_AUTH_REPLAY');
  });
  it('the grant hash and digests match the fixture', () => {
    expect(Buffer.from(v.sessionGrantHashStruct(grant())).toString('hex')).toBe(F.session_grant.hash_struct);
    expect(Buffer.from(v.sessionGrantDigest(grant(), 424242n)).toString('hex')).toBe(F.session_grant.signing_digest);
  });
});

type Row = {
  name: string;
  base: string;
  error?: string;
  expect: string;
  signed?: { signer?: string; message?: Record<string, string> };
  verified?: { message?: Record<string, string>; domain?: { chain_id?: string; version?: string } };
  signature_65?: string;
  transport?: Record<string, string>;
  verification_context?: { current_height: string; max_session_grant_blocks: string };
};
const ROWS: Row[] = F.request_auth_negative_cases;

/** Each row as the verifier sees it; the prose-only ConfirmOpenTask row is checked by the fake Builder's route. */
function decide(r: Row): string {
  const sig = r.signature_65 !== undefined ? { signature: unhex(r.signature_65) } : {};
  const sm = r.signed?.message ?? {};
  const vm = r.verified?.message ?? {};
  switch (r.base) {
    case 'sdk_request': {
      const c = ctx({
        height: 1000n,
        ...(vm['chainId'] !== undefined ? { chainId: vm['chainId'] } : {}),
        ...(r.verified?.domain?.chain_id !== undefined ? { evmChainId: BigInt(r.verified.domain.chain_id) } : {}),
      });
      const over: { -readonly [K in keyof v.EnvelopeLike]?: v.EnvelopeLike[K] } = { ...sig };
      if (sm['taskId'] !== undefined) over.taskId = sm['taskId'];
      if (sm['expiryHeightOrTime'] !== undefined) over.expiryHeightOrTime = BigInt(sm['expiryHeightOrTime']);
      if (r.transport?.['expiry_height_or_time'] !== undefined) over.expiryHeightOrTime = BigInt(r.transport['expiry_height_or_time']);
      if (r.name === 'open_task_with_session_grant') over.sessionGrant = grant();
      return code(() => verifyRequest(envelope('sdk_request', over), c));
    }
    case 'sdk_request_session': {
      const over: { -readonly [K in keyof v.EnvelopeLike]?: v.EnvelopeLike[K] } = { ...sig };
      if (sm['endpoint'] !== undefined) over.endpoint = sm['endpoint'];
      if (r.transport?.['session_id'] !== undefined) over.sessionId = r.transport['session_id'];
      if (r.transport?.['task_id'] !== undefined) over.taskId = r.transport['task_id'];
      if (r.transport?.['request_nonce_hex'] !== undefined) over.requestNonce = unhex(r.transport['request_nonce_hex']);
      const body = vm['bodyDigest'] !== undefined ? unhex(vm['bodyDigest']) : undefined;
      return code(() => verifyRequest(envelope('sdk_request_session', over), ctx(), body));
    }
    case 'session_grant': {
      const vc = r.verification_context;
      const c = vc !== undefined ? ctx({ height: BigInt(vc.current_height), maxSessionGrantBlocks: BigInt(vc.max_session_grant_blocks) }) : ctx();
      const g = grant({ ...(sm['chainId'] !== undefined ? { chainId: sm['chainId'] } : {}), ...(r.signature_65 !== undefined ? { userSignature: unhex(r.signature_65) } : {}) });
      return code(() => verifyRequest(envelope('sdk_request_session', { sessionGrant: g }), c));
    }
    default:
      return decideTaskData(r);
  }
}

function taskAuth(name: 'task_data_request' | 'task_data_request_session', over: Partial<v.RequestAuthLike> = {}): v.RequestAuthLike {
  const s = F[name];
  const m = s.message;
  return {
    schemaVersion: Number(m.schemaVersion), chainId: m.chainId, builderOperatorAddress: m.builderOperatorAddress, rpcMethod: m.rpcMethod,
    bodyDigest: m.bodyDigest, requesterKind: Number(m.requesterKind), requesterAddress: m.requesterAddress,
    serviceAuthorizationNonce: BigInt(m.serviceAuthorizationNonce), requestNonce: unhex(m.requestNonce), expiryHeight: BigInt(m.expiryHeight),
    signature: unhex(s.signature_65), ...(name === 'task_data_request_session' ? { sessionGrant: grant() } : {}), ...over,
  };
}

function verifyTaskData(a: v.RequestAuthLike, c: v.AuthContext, objectKind = 2): string {
  return v.verifyUserTaskDataAuth(a, {
    builder: a.builderOperatorAddress, rpcMethod: a.rpcMethod, body: unhex(a.bodyDigest), objectKind, requestTtlBlocks: 1000n,
  }, c);
}

function decideTaskData(r: Row): string {
  const sig = r.signature_65 !== undefined ? { signature: unhex(r.signature_65) } : {};
  const sm = r.signed?.message ?? {};
  switch (r.name) {
    case 'task_data_request_other_evm_chain_id':
      return code(() => verifyTaskData(taskAuth('task_data_request'), ctx({ evmChainId: 424243n })));
    case 'task_data_request_domain_version_1':
      // The verifier only knows version 2; the version 1 signature of the same request fails.
      return code(() => verifyTaskData(taskAuth('task_data_request', { signature: unhex(F.task_data_request_v1_obsolete.signature_65) }), ctx()));
    case 'task_data_upload_with_session_grant':
      return code(() => verifyTaskData(taskAuth('task_data_request_session', { ...sig, rpcMethod: sm['rpcMethod']!, bodyDigest: sm['bodyDigest']! }), ctx()));
    case 'task_data_input_object_with_session_grant':
      return code(() => verifyTaskData(taskAuth('task_data_request_session'), ctx(), 1));
    default:
      throw new Error(`unhandled row ${r.name}`);
  }
}

describe('independent verifier: request_auth_negative_cases', () => {
  for (const r of ROWS.filter((x) => x.name !== 'confirm_open_task_not_callable')) {
    it(`${r.name} -> ${r.expect === 'accept' ? 'accepted' : r.error}`, () => {
      expect(decide(r)).toBe(r.expect === 'accept' ? 'accepted' : r.error);
    });
  }

  it('task_data_request and task_data_request_session are accepted', () => {
    expect(code(() => verifyTaskData(taskAuth('task_data_request'), ctx({ height: 1990n })))).toBe('accepted');
    expect(code(() => verifyTaskData(taskAuth('task_data_request_session'), ctx()))).toBe('accepted');
  });
});
