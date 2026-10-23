import { describe, it, expect } from 'vitest';
import { createRouterTransport, ConnectError, Code } from '@connectrpc/connect';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import type { AckOutputRequest, FetchTaskDataRequest, GetTaskDataMetadataRequest, GetTaskEventsRequest } from '../../src/gen/nexus/v1/ingress_pb.js';
import { IngressClient } from '../../src/transport/ingress-client';
import type { IngressAuth } from '../../src/transport/ingress-client';
import { TASK_DATA_OBJECT_KIND } from '../../src/transport/task-data-signbytes';
import { privateKeyTypedDataSigner } from '../../src/signer/typed-data-signer';
import {
  registeredSessionKey,
  RegisteredSessionKeys,
  MAX_SESSION_KEY_CACHE_TTL_BLOCKS,
  DEFAULT_KEY_CHANGE_RETRY_ATTEMPTS,
} from '../../src/session/registered-session-key';
import { TrueOpenError } from '../../src/errors/errors';
import { toHex } from '../../src/util/bytes';
import { ACCOUNT_SIGNING, fixtureKey, section } from '../helpers/account-signing';

const EVM = BigInt(section('task_data_request').domain.chain_id);
const USER = ACCOUNT_SIGNING.account.account_bech32 as string;
const wallet = privateKeyTypedDataSigner(fixtureKey('account'));
const S = '0x77625100ba4faa1306ae6eaf5a872a661443aa94f87c5530c4b178614e3d62f7';
const T = '0xbce966ae829f212a35982bcd85aaea77d8893539afa04f32ea540c46ff8323b0';
const BUILDER = 'trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man';
const KEY = registeredSessionKey(S, new Uint8Array(32).fill(0x41));
const OUTPUT_REF = { taskHash: `0x${'58'.repeat(32)}`, sessionId: S, taskId: T, objectKind: TASK_DATA_OBJECT_KIND.OUTPUT, contentHash: `0x${'22'.repeat(32)}` };

const err = (code: string, _connect: Code): TrueOpenError => new TrueOpenError('SDK_AUTH', code, code, { retriable: code.endsWith('GRANT_EXPIRED') });

describe('RegisteredSessionKeys.retryAfterKeyChange', () => {
  function keys(latest: { h: bigint }, opts: { attempts?: number } = {}) {
    const slept: number[] = [];
    let t = 0;
    const k = new RegisteredSessionKeys({
      latestHeight: async () => latest.h, heightMaxAgeMs: 0, now: () => (t += 10), keyChangeRetryDelayMs: 7,
      ...(opts.attempts !== undefined ? { keyChangeRetryAttempts: opts.attempts } : {}),
      sleep: async (ms) => { slept.push(ms); },
    });
    return { k, slept };
  }

  it('MAX_SESSION_KEY_CACHE_TTL_BLOCKS is nexus MaxSessionKeyCacheTTLBlocks (10)', () => {
    expect(MAX_SESSION_KEY_CACHE_TTL_BLOCKS).toBe(10n);
  });

  it('true for the lag answers while latest < change + 10, after sleeping the delay', async () => {
    const latest = { h: 1_009n };
    const { k, slept } = keys(latest);
    k.set(KEY, 2_000n, 1_000n);
    for (const code of ['SDK_AUTH_INVALID_SIGNATURE', 'DATA_ACCESS_INVALID_SIGNATURE', 'SDK_AUTH_SESSION_GRANT_EXPIRED', 'DATA_ACCESS_SESSION_GRANT_EXPIRED']) {
      expect(await k.retryAfterKeyChange(S, err(code, Code.Unauthenticated), 0)).toBe(true);
    }
    expect(slept).toEqual([7, 7, 7, 7]);
    latest.h = 1_010n;
    expect(await k.retryAfterKeyChange(S, err('SDK_AUTH_INVALID_SIGNATURE', Code.Unauthenticated), 0)).toBe(false);
    expect(slept).toHaveLength(4);
  });

  it('false for any other answer, past the attempt bound, without a change height or a height reader', async () => {
    const latest = { h: 1_001n };
    const { k } = keys(latest, { attempts: 2 });
    k.set(KEY, 2_000n, 1_000n);
    expect(await k.retryAfterKeyChange(S, err('SDK_AUTH_REPLAY', Code.Unauthenticated), 0)).toBe(false);
    expect(await k.retryAfterKeyChange(S, new Error('SDK_AUTH_INVALID_SIGNATURE'), 0)).toBe(false);
    expect(await k.retryAfterKeyChange(S, err('SDK_AUTH_INVALID_SIGNATURE', Code.Unauthenticated), 1)).toBe(true);
    expect(await k.retryAfterKeyChange(S, err('SDK_AUTH_INVALID_SIGNATURE', Code.Unauthenticated), 2)).toBe(false);
    k.set(KEY, 2_000n);
    expect(await k.retryAfterKeyChange(S, err('SDK_AUTH_INVALID_SIGNATURE', Code.Unauthenticated), 0)).toBe(false);
    const noReader = new RegisteredSessionKeys({ sleep: async () => undefined });
    noReader.set(KEY, 2_000n, 1_000n);
    expect(await noReader.retryAfterKeyChange(S, err('SDK_AUTH_INVALID_SIGNATURE', Code.Unauthenticated), 0)).toBe(false);
  });

  it('a failed height read is final', async () => {
    const k = new RegisteredSessionKeys({ latestHeight: async () => { throw new Error('down'); }, heightMaxAgeMs: 0, sleep: async () => undefined });
    k.set(KEY, 2_000n, 1_000n);
    expect(await k.retryAfterKeyChange(S, err('SDK_AUTH_INVALID_SIGNATURE', Code.Unauthenticated), 0)).toBe(false);
  });

  it('noteKeyChange and refreshExpiry(setHeight) only move the change height forward', () => {
    const k = new RegisteredSessionKeys();
    k.noteKeyChange(S, 5n); // nothing loaded: ignored
    k.set(KEY, 2_000n, 1_000n);
    k.noteKeyChange(S, 900n);
    expect(k.keyChangeHeight(S)).toBe(1_000n);
    k.noteKeyChange(S, 1_005n);
    expect(k.keyChangeHeight(S)).toBe(1_005n);
    k.refreshExpiry(S, KEY.address, 3_000n, 1_002n);
    expect(k.keyChangeHeight(S)).toBe(1_005n);
    k.refreshExpiry(S, KEY.address, 3_000n, 1_020n);
    expect(k.keyChangeHeight(S)).toBe(1_020n);
    expect(k.expiryHeight(S)).toBe(3_000n);
  });

  it('rejects a bad delay or attempt bound', () => {
    expect(() => new RegisteredSessionKeys({ keyChangeRetryDelayMs: Number.NaN })).toThrow(/keyChangeRetryDelayMs/);
    expect(() => new RegisteredSessionKeys({ keyChangeRetryAttempts: -1 })).toThrow(/keyChangeRetryAttempts/);
  });
});

/** A Builder that refuses the first `refuse` calls of each method with `code`. */
function setup(p: { latest: bigint; changeHeight: bigint | undefined; refuse: number; code: string; connect: Code; registered?: boolean }) {
  const seen = { ack: [] as AckOutputRequest[], events: [] as GetTaskEventsRequest[], meta: [] as GetTaskDataMetadataRequest[], fetch: [] as FetchTaskDataRequest[] };
  const left = { ack: p.refuse, events: p.refuse, meta: p.refuse, fetch: p.refuse };
  const refuse = (m: keyof typeof left): void => {
    if (left[m] > 0) {
      left[m] -= 1;
      throw new ConnectError(`${p.code}: refused`, p.connect);
    }
  };
  const transport = createRouterTransport(({ service }) => {
    service(IngressAPI, {
      ackOutput(req: AckOutputRequest) { seen.ack.push(req); refuse('ack'); return { acked: true }; },
      async *getTaskEvents(req: GetTaskEventsRequest) {
        seen.events.push(req);
        refuse('events');
        yield { cursor: '1', state: '', taskPhase: '', eventCode: 'ORDER_RECEIVED', chainHeight: 0n };
      },
      getTaskDataMetadata(req: GetTaskDataMetadataRequest) { seen.meta.push(req); refuse('meta'); return {}; },
      async *fetchTaskData(req: FetchTaskDataRequest) {
        seen.fetch.push(req);
        refuse('fetch');
        yield { frame: { case: 'header', value: { totalSizeBytes: 1n, mediaType: 'x', servedRange: { offset: 0n, length: 1n } } } };
        yield { frame: { case: 'chunk', value: { offset: 0n, data: new Uint8Array([7]), eof: true } } };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });
  const registeredKeys = new RegisteredSessionKeys({ latestHeight: async () => p.latest, keyChangeRetryDelayMs: 1 });
  if (p.registered !== false) registeredKeys.set(KEY, p.latest + 1_000n, p.changeHeight);
  let n = 0;
  const auth: IngressAuth = {
    chainId: 'trueopen-golden-1', userAddress: USER, wallet, signatureChainId: EVM,
    nonce: () => new Uint8Array(32).fill(++n), expiry: () => 1_790_000_000_000n, registeredKeys,
  };
  return { client: new IngressClient(transport, auth), seen };
}

const drain = async (it: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of it) void _;
};

describe('IngressClient: key-signed requests inside the key-change window', () => {
  const calls = (c: ReturnType<typeof setup>['client']) => ({
    ack: () => c.ackOutput({ sessionId: S, taskId: T, lastSeq: 1n }),
    events: () => drain(c.getTaskEvents({ sessionId: S, taskId: T })),
    meta: () => c.getTaskDataMetadata({ objectRef: OUTPUT_REF, builderAddress: BUILDER, expiresAtHeight: 1_010n }),
    fetch: () => c.fetchTaskDataRange({ objectRef: OUTPUT_REF, builderAddress: BUILDER, expiresAtHeight: 1_010n, range: { offset: 0n, length: 1n } }),
  });
  const nonces = (reqs: readonly { requestEnvelope?: { requestNonce: Uint8Array } | undefined; requestAuth?: { requestNonce: Uint8Array } | undefined }[]) =>
    new Set(reqs.map((r) => toHex((r.requestEnvelope ?? r.requestAuth)!.requestNonce))).size;

  for (const [code, connect, methods] of [
    ['SDK_AUTH_INVALID_SIGNATURE', Code.Unauthenticated, ['ack', 'events']],
    ['SDK_AUTH_SESSION_GRANT_EXPIRED', Code.DeadlineExceeded, ['ack', 'events']],
    ['DATA_ACCESS_INVALID_SIGNATURE', Code.PermissionDenied, ['meta', 'fetch']],
    ['DATA_ACCESS_SESSION_GRANT_EXPIRED', Code.PermissionDenied, ['meta', 'fetch']],
  ] as const) {
    for (const m of methods) {
      it(`${m}: ${code} is re-signed with a fresh nonce and re-sent until the Builder catches up`, async () => {
        const s = setup({ latest: 1_005n, changeHeight: 1_000n, refuse: 2, code, connect });
        await calls(s.client)[m]();
        expect(s.seen[m]).toHaveLength(3);
        expect(nonces(s.seen[m])).toBe(3);
      });

      it(`${m}: ${code} outside the window is final (one call)`, async () => {
        const s = setup({ latest: 1_010n, changeHeight: 1_000n, refuse: 1, code, connect });
        const e = await calls(s.client)[m]().catch((x: unknown) => x);
        expect(e).toMatchObject({ code, retriable: false });
        expect(s.seen[m]).toHaveLength(1);
      });
    }
  }

  it('bounded by DEFAULT_KEY_CHANGE_RETRY_ATTEMPTS inside the window', async () => {
    const s = setup({ latest: 1_001n, changeHeight: 1_000n, refuse: 100, code: 'SDK_AUTH_INVALID_SIGNATURE', connect: Code.Unauthenticated });
    await expect(calls(s.client).ack()).rejects.toMatchObject({ code: 'SDK_AUTH_INVALID_SIGNATURE' });
    expect(s.seen.ack).toHaveLength(1 + DEFAULT_KEY_CHANGE_RETRY_ATTEMPTS);
  });

  it('a wallet-signed request is never retried for it', async () => {
    const s = setup({ latest: 1_001n, changeHeight: 1_000n, refuse: 1, code: 'SDK_AUTH_INVALID_SIGNATURE', connect: Code.Unauthenticated, registered: false });
    await expect(calls(s.client).ack()).rejects.toMatchObject({ code: 'SDK_AUTH_INVALID_SIGNATURE' });
    expect(s.seen.ack).toHaveLength(1);
  });

  it('no known key change: final at once', async () => {
    const s = setup({ latest: 1_001n, changeHeight: undefined, refuse: 1, code: 'SDK_AUTH_INVALID_SIGNATURE', connect: Code.Unauthenticated });
    await expect(calls(s.client).ack()).rejects.toMatchObject({ code: 'SDK_AUTH_INVALID_SIGNATURE' });
    expect(s.seen.ack).toHaveLength(1);
  });
});

describe('IngressClient: final answers to requests without a grant', () => {
  it('a key-signed Task Data DATA_ACCESS_INVALID_SIGNATURE switches source (a Builder without the Task gives it)', async () => {
    const s = setup({ latest: 1_010n, changeHeight: 1_000n, refuse: 1, code: 'DATA_ACCESS_INVALID_SIGNATURE', connect: Code.PermissionDenied });
    for (const run of [
      () => s.client.getTaskDataMetadata({ objectRef: OUTPUT_REF, builderAddress: BUILDER, expiresAtHeight: 1_010n }),
      () => s.client.fetchTaskDataRange({ objectRef: OUTPUT_REF, builderAddress: BUILDER, expiresAtHeight: 1_010n, range: { offset: 0n, length: 1n } }),
    ]) {
      await expect(run()).rejects.toMatchObject({ code: 'DATA_ACCESS_INVALID_SIGNATURE', switchSource: true, retriable: false });
    }
  });

  it('a wallet-signed Task Data DATA_ACCESS_INVALID_SIGNATURE does not', async () => {
    const s = setup({ latest: 1_010n, changeHeight: 1_000n, refuse: 1, code: 'DATA_ACCESS_INVALID_SIGNATURE', connect: Code.PermissionDenied, registered: false });
    await expect(s.client.getTaskDataMetadata({ objectRef: OUTPUT_REF, builderAddress: BUILDER, expiresAtHeight: 1_010n }))
      .rejects.toMatchObject({ code: 'DATA_ACCESS_INVALID_SIGNATURE', switchSource: false });
  });

  it('SDK_AUTH_INVALID_SIGNATURE on an SDK envelope keeps switchSource false', async () => {
    const s = setup({ latest: 1_010n, changeHeight: 1_000n, refuse: 1, code: 'SDK_AUTH_INVALID_SIGNATURE', connect: Code.Unauthenticated });
    await expect(s.client.ackOutput({ sessionId: S, taskId: T, lastSeq: 1n })).rejects.toMatchObject({ switchSource: false });
  });
});
