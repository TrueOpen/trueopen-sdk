import { describe, it, expect } from 'vitest';
import { ConnectError, Code, createRouterTransport } from '@connectrpc/connect';
import { BroadcastTxError } from '@cosmjs/stargate';
import type { IndexedTx } from '@cosmjs/stargate';
import { classifyNexusError, classifyBroadcastError, nexusErrorCode } from '../../src/errors/classify';
import { TrueOpenError, dataError } from '../../src/errors/errors';
import { IngressClient } from '../../src/transport/ingress-client';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import { CosmjsChainWriter } from '../../src/transport/cosmjs-chain-writer';
import { nexusIngressTransport } from '../../src/transport/nexus-tls';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const classify = (e: unknown): TrueOpenError => {
  const c = classifyNexusError(e);
  expect(c).toBeInstanceOf(TrueOpenError);
  return c as TrueOpenError;
};

describe('dataError', () => {
  it('means "switch source", not "retry the same one"', () => {
    const e = dataError('DATA_OUTPUT_HASH_MISMATCH', 'bad root');
    expect(e.retriable).toBe(false);
    expect(e.switchSource).toBe(true);
    expect(e.category).toBe('data-corrupt');
  });
});

describe('classifyNexusError', () => {
  it('reads the nexus code from the message and maps it to a category', () => {
    const cases: [ConnectError, string, string, boolean, boolean][] = [
      [new ConnectError('SDK_AUTH_INVALID_SIGNATURE: bad sig', Code.Unauthenticated), 'SDK_AUTH_INVALID_SIGNATURE', 'auth', false, false],
      [new ConnectError('NEXUS_DATA_EXPIRED: request height', Code.DeadlineExceeded), 'NEXUS_DATA_EXPIRED', 'expired', true, false],
      [new ConnectError('NEXUS_DATA_NOT_FOUND: no object', Code.NotFound), 'NEXUS_DATA_NOT_FOUND', 'not-found', false, true],
      [new ConnectError('NEXUS_DATA_NOT_READY: object is STORED', Code.Unavailable), 'NEXUS_DATA_NOT_READY', 'data-unavailable', true, false],
      [new ConnectError('NEXUS_DATA_CAPACITY: disk', Code.ResourceExhausted), 'NEXUS_DATA_CAPACITY', 'capacity', true, true],
      [new ConnectError('NEXUS_DATA_RANGE_INVALID', Code.OutOfRange), 'NEXUS_DATA_RANGE_INVALID', 'invalid', false, false],
      [new ConnectError('NEXUS_DATA_CONFLICT: object key already committed', Code.AlreadyExists), 'NEXUS_DATA_CONFLICT', 'conflict', false, false],
      [new ConnectError('NEXUS_INGRESS_NOT_SELECTED_BUILDER', Code.PermissionDenied), 'NEXUS_INGRESS_NOT_SELECTED_BUILDER', 'not-found', false, true],
      // Session grants and the Task data auth path.
      [new ConnectError('SDK_AUTH_SESSION_GRANT_INVALID: user signature', Code.Unauthenticated), 'SDK_AUTH_SESSION_GRANT_INVALID', 'auth', false, false],
      [new ConnectError('SDK_AUTH_SESSION_GRANT_EXPIRED: window', Code.Unauthenticated), 'SDK_AUTH_SESSION_GRANT_EXPIRED', 'expired', true, false],
      [new ConnectError('SDK_AUTH_SESSION_METHOD_NOT_ALLOWED: OpenTask', Code.PermissionDenied), 'SDK_AUTH_SESSION_METHOD_NOT_ALLOWED', 'auth', false, false],
      [new ConnectError('DATA_ACCESS_INVALID_SIGNATURE: recovered', Code.Unauthenticated), 'DATA_ACCESS_INVALID_SIGNATURE', 'auth', false, false],
      [new ConnectError('DATA_ACCESS_SESSION_GRANT_INVALID: chain', Code.Unauthenticated), 'DATA_ACCESS_SESSION_GRANT_INVALID', 'auth', false, false],
      [new ConnectError('DATA_ACCESS_SESSION_GRANT_EXPIRED: window', Code.Unauthenticated), 'DATA_ACCESS_SESSION_GRANT_EXPIRED', 'expired', true, false],
      [new ConnectError('DATA_ACCESS_SESSION_METHOD_NOT_ALLOWED: INPUT', Code.PermissionDenied), 'DATA_ACCESS_SESSION_METHOD_NOT_ALLOWED', 'auth', false, false],
      [new ConnectError('NEXUS_INGRESS_CONTRACT_NOT_FROZEN: ConfirmOpenTask', Code.FailedPrecondition), 'NEXUS_INGRESS_CONTRACT_NOT_FROZEN', 'invalid', false, false],
      [new ConnectError('NEXUS_INGRESS_METHOD_RETIRED: SubmitOrder', Code.Unimplemented), 'NEXUS_INGRESS_METHOD_RETIRED', 'invalid', false, false],
      // Another version of the task is already held: no retry, and no other Builder either.
      [new ConnectError('NEXUS_INGRESS_ORDER_REPLACEMENT_UNSUPPORTED: tracked', Code.FailedPrecondition), 'NEXUS_INGRESS_ORDER_REPLACEMENT_UNSUPPORTED', 'conflict', false, false],
      [new ConnectError('NEXUS_INGRESS_TASK_TERMINAL: finished', Code.FailedPrecondition), 'NEXUS_INGRESS_TASK_TERMINAL', 'conflict', false, false],
      [new ConnectError('NEXUS_INGRESS_ORDER_EXPIRED: height 501 is past order_expire_height 500', Code.FailedPrecondition), 'NEXUS_INGRESS_ORDER_EXPIRED', 'expired', false, false],
    ];
    for (const [err, code, category, retriable, switchSource] of cases) {
      const c = classify(err);
      expect({ code: c.code, category: c.category, retriable: c.retriable, switchSource: c.switchSource }, code)
        .toEqual({ code, category, retriable, switchSource });
      expect(c.cause).toBe(err);
    }
    expect(classify(new ConnectError('SDK_AUTH_INVALID_SIGNATURE: x', Code.Unauthenticated)).family).toBe('SDK_AUTH');
  });

  it('falls back to the Connect code when the message carries no nexus code', () => {
    const c = classify(new ConnectError('upstream went away', Code.Unavailable));
    expect(c).toMatchObject({ code: 'NEXUS_CONNECT_UNAVAILABLE', category: 'transport', retriable: true });
    expect(classify(new ConnectError('nope', Code.InvalidArgument))).toMatchObject({ code: 'NEXUS_CONNECT_INVALID_ARGUMENT', category: 'invalid', retriable: false });
    expect(classify(new ConnectError('boom', Code.Internal))).toMatchObject({ category: 'internal', retriable: false, switchSource: true });
  });

  it('treats a local failure as transport and never reads a code from its message', () => {
    const socket = Object.assign(new Error('NEXUS_DATA_NOT_FOUND read ECONNRESET'), { code: 'ECONNRESET' });
    const c = classify(new ConnectError('NEXUS_DATA_NOT_FOUND read ECONNRESET', Code.Unknown, undefined, undefined, socket));
    expect(c).toMatchObject({ code: 'NEXUS_TRANSPORT_FAILED', category: 'transport', retriable: true });
    // A deliberate local refusal (for example a certificate pin mismatch) is not worth repeating.
    const pin = new TrueOpenError('NEXUS_INGRESS', 'NEXUS_TLS_PUBKEY_MISMATCH', 'pin');
    expect(classify(new ConnectError('pin', Code.Unknown, undefined, undefined, pin))).toMatchObject({ retriable: false, switchSource: true });
  });

  it('treats an Unavailable caused by a socket error as a local transport failure', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED', syscall: 'connect' });
    expect(classify(new ConnectError('NEXUS_DATA_NOT_READY connect ECONNREFUSED', Code.Unavailable, undefined, undefined, refused)))
      .toMatchObject({ code: 'NEXUS_TRANSPORT_FAILED', category: 'transport', retriable: true, switchSource: true });
    // A server-sent Unavailable carries no cause and keeps its own code.
    expect(classify(new ConnectError('NEXUS_DATA_NOT_READY: x', Code.Unavailable))).toMatchObject({ code: 'NEXUS_DATA_NOT_READY' });
  });

  it('classifies a real refused connection (connect-node) as NEXUS_TRANSPORT_FAILED', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const ingress = new IngressClient(nexusIngressTransport(`http://127.0.0.1:${port}`, '', { allowInsecureHttp: true, warn: () => undefined }));
    await expect(ingress.getTaskStatus('s', 't'))
      .rejects.toMatchObject({ code: 'NEXUS_TRANSPORT_FAILED', category: 'transport', retriable: true, switchSource: true });
  });

  it('leaves TrueOpenErrors and non-Connect errors alone', () => {
    const t = new TrueOpenError('SDK_LOCAL', 'X', 'x');
    expect(classifyNexusError(t)).toBe(t);
    const plain = new Error('plain');
    expect(classifyNexusError(plain)).toBe(plain);
    expect(nexusErrorCode('[not_found] NEXUS_DATA_NOT_FOUND: x')).toBe('NEXUS_DATA_NOT_FOUND');
    expect(nexusErrorCode('something else')).toBeUndefined();
    expect(nexusErrorCode('DATA_ACCESS_SESSION_GRANT_EXPIRED: x')).toBe('DATA_ACCESS_SESSION_GRANT_EXPIRED');
    expect(nexusErrorCode('DATA_ACCESS_DENIED')).toBe('DATA_ACCESS_DENIED');
  });

  it('IngressClient throws classified errors for unary and streaming calls', async () => {
    const transport = createRouterTransport(({ service }) => {
      service(IngressAPI, {
        getTaskStatus() { throw new ConnectError('NEXUS_DATA_NOT_FOUND: task', Code.NotFound); },
        // eslint-disable-next-line require-yield
        async *getTaskEvents() { throw new ConnectError('NEXUS_DATA_EXPIRED: window', Code.DeadlineExceeded); },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    });
    const ingress = new IngressClient(transport);
    await expect(ingress.raw.getTaskStatus({ sessionId: 's', taskId: 't' })).rejects.toMatchObject({ code: 'NEXUS_DATA_NOT_FOUND', category: 'not-found' });
    const it = ingress.raw.getTaskEvents({ sessionId: 's', taskId: 't' })[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toMatchObject({ code: 'NEXUS_DATA_EXPIRED', category: 'expired', retriable: true });
  });
});

describe('classifyBroadcastError', () => {
  it('turns a CheckTx failure into CHAIN_TX_REJECTED with code and log', () => {
    const c = classifyBroadcastError(new BroadcastTxError(13, 'sdk', 'insufficient fee')) as TrueOpenError;
    expect(c).toMatchObject({ family: 'CHAIN_REJECT', code: 'CHAIN_TX_REJECTED', category: 'chain-rejected', retriable: false });
    expect(c.details).toEqual({ codespace: 'sdk', code: 13, log: 'insufficient fee' });
    // Sequence mismatch never entered the mempool: re-signing is safe.
    expect((classifyBroadcastError(new BroadcastTxError(32, 'sdk', 'account sequence mismatch')) as TrueOpenError).retriable).toBe(true);
    const other = new Error('socket');
    expect(classifyBroadcastError(other)).toBe(other);
  });

  /**
   * CosmJS never sets `this.name`, so the only name a test could match is `constructor.name`,
   * and a bundler renames that whenever it minifies class names -- which would hold here and
   * quietly stop holding in a consumer's build. Recognition is by shape, so a structurally
   * identical error classifies the same however it was built.
   */
  it('recognizes a CheckTx failure whose class name a bundler renamed', () => {
    const renamed = class extends Error {
      code = 32;
      codespace = 'sdk';
      log = 'account sequence mismatch';
    };
    Object.defineProperty(renamed, 'name', { value: 'n' });
    const c = classifyBroadcastError(new renamed('broadcast failed')) as TrueOpenError;
    expect(c).toMatchObject({ code: 'CHAIN_TX_REJECTED', retriable: true });
    expect(c.details).toEqual({ codespace: 'sdk', code: 32, log: 'account sequence mismatch' });
  });

  it('leaves an error that only looks similar alone', () => {
    // A Connect-style error carries a numeric code but no codespace.
    const connectish = Object.assign(new Error('unavailable'), { code: 14 });
    expect(classifyBroadcastError(connectish)).toBe(connectish);
  });

  it('CosmjsChainWriter reports a CheckTx rejection as CHAIN_TX_REJECTED', async () => {
    const writer = new CosmjsChainWriter({
      signerAddress: 'trueopen1u',
      fee: { amount: [], gas: '1' },
      broadcaster: {
        signAndBroadcastSync: async () => { throw new BroadcastTxError(5, 'sdk', 'insufficient funds'); },
        getTx: async (): Promise<IndexedTx | null> => null,
      },
    });
    await expect(writer.createSession()).rejects.toMatchObject({
      code: 'CHAIN_TX_REJECTED',
      details: { codespace: 'sdk', code: 5, log: 'insufficient funds' },
    });
  });
});
