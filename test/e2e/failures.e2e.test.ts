/**
 * Failure scenarios on the simulated network (see full-flow.e2e.test.ts for the setup). Each test
 * starts its own network, so a degraded Builder or a changed chain fact never leaks into another.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Code } from '@connectrpc/connect';
import type { OutputStreamEvent, OutputStreamSource, TrueOpenClient } from '../../src/client';
import { TrueOpenError } from '../../src/errors/errors';
import { TASK_DATA_OBJECT_KIND } from '../../src/transport/task-data-signbytes';
import type { OpenTaskInput } from '../../src/transport/ingress-client';
import { resolveTaskOrderContext, buildTaskOrder } from '../../src/order/task-order-input';
import { buildOpenTaskRequest } from '../../src/order/build-open-task';
import { privKeySecp256k1Signer } from '../../src/signer/secp256k1';
import { privKeyEip712Signer } from '../../src/signer/eth-secp256k1';
import { startWorld, acceptOnChain, drawWinner, landReceipt, outputText, STREAM, REFERENCE_STREAM } from './support/harness';
import type { World } from './support/harness';
import * as w from './support/world';

let world: World;
let sessionId: string;
beforeEach(async () => {
  world = await startWorld();
  sessionId = world.node.seedSession(w.USER.address);
});
afterEach(async () => { await world.close(); });

async function caught(p: Promise<unknown> | (() => Promise<unknown>)): Promise<TrueOpenError> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(TrueOpenError);
    return e as TrueOpenError;
  }
  throw new Error('expected a TrueOpenError, got success');
}

async function drain(it: AsyncIterable<OutputStreamEvent>): Promise<OutputStreamEvent[]> {
  const out: OutputStreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const open = (client: TrueOpenClient = world.client()) =>
  client.openTask({ sessionId, idempotencyKey: `${sessionId}:0`, order: w.orderIntent() });

const stream = (sources: OutputStreamSource[], extra: { maxAttempts?: number } = {}) =>
  drain(world.client().streamOutput({ sessionId, taskId: STREAM.task_id, sources, ...extra }));

const text = (events: OutputStreamEvent[]): string => events.flatMap((e) => (e.kind === 'chunk' ? [e.text] : [])).join('');

describe('e2e failures: Builders', () => {
  it('one Builder down: openTask succeeds and reports that Builder\'s transport error', async () => {
    await world.nexus[2]!.close();
    const res = await open();
    expect(res.accepted).toBe(true);
    const byAddr = new Map(res.builders.map((b) => [b.address, b]));
    const down = byAddr.get(w.BUILDERS[2]!.address)!;
    expect(down.ack).toBeUndefined();
    expect(down.error).toBeInstanceOf(TrueOpenError);
    expect(down.error).toMatchObject({ code: 'NEXUS_TRANSPORT_FAILED', category: 'transport', retriable: true, switchSource: true });
    for (const i of [0, 1]) expect(byAddr.get(w.BUILDERS[i]!.address)!.ack?.accepted).toBe(true);
    // Ranks are the 1-based selection ranks.
    expect(res.builders.map((b) => b.rank).sort()).toEqual([1, 2, 3]);

    // Streaming from the down Builder first moves on to the next one.
    acceptOnChain(world);
    drawWinner(world);
    const events = await stream(world.sources([2, 0]));
    expect(text(events)).toBe(outputText(STREAM));
    expect(world.nexus[0]!.acks).toHaveLength(1);
  });

  it('a Builder whose certificate does not match the chain pin is refused before any request byte', async () => {
    world.node.descriptors.set(w.BUILDERS[1]!.address, { uri: world.nexus[1]!.url, tlsPubkeyHash: 'ab'.repeat(32) });
    const res = await open();
    expect(res.accepted).toBe(true);
    const pinned = res.builders.find((b) => b.address === w.BUILDERS[1]!.address)!;
    expect(pinned.error).toMatchObject({ category: 'transport', retriable: false, switchSource: true });
    expect(world.nexus[1]!.calls).toEqual([]);
  });

  it('a Builder that truncates with an unsigned Fin is left for another; delivery resumes without duplicates', async () => {
    acceptOnChain(world);
    drawWinner(world);
    world.nexus[0]!.stream = 'truncate-unsigned-fin';
    const events = await stream(world.sources([0, 1]));
    expect(events.filter((e) => e.kind === 'chunk').map((e) => e.kind === 'chunk' && e.seq)).toEqual([0n, 1n, 2n, 3n]);
    expect(text(events)).toBe(outputText(STREAM));
    expect(events.at(-1)).toMatchObject({ kind: 'fin', attested: true });
    // The second Builder was asked to resume after the verified prefix, and only it was acked.
    expect(world.nexus[1]!.subscribes).toEqual([{ resumeAfterSeq: 2n }]);
    expect(world.nexus[0]!.acks).toEqual([]);
    expect(world.nexus[1]!.acks).toEqual([{ lastSeq: 3n, outputId: '' }]);
  });

  it('a truncating Builder alone is never accepted as complete', async () => {
    acceptOnChain(world);
    drawWinner(world);
    world.nexus[0]!.stream = 'truncate-unsigned-fin';
    const e = await caught(stream(world.sources([0]), { maxAttempts: 2 }));
    expect(e.code).toBe('DATA_OUTPUT_STREAM_RETRIES_EXHAUSTED');
    expect(e.message).toContain('carries no worker_signature');
    expect(world.nexus[0]!.acks).toEqual([]);
  });

  it('a stream cut mid-way resumes on the next Builder', async () => {
    acceptOnChain(world);
    drawWinner(world);
    world.nexus[0]!.stream = { dropAfterSeq: 1 };
    const events = await stream(world.sources([0, 1]));
    expect(text(events)).toBe(outputText(STREAM));
    expect(world.nexus[1]!.subscribes).toEqual([{ resumeAfterSeq: 1n }]);
  });

  it('a Builder serving tampered bytes on ranged fetch is refused; the next Builder serves the output', async () => {
    acceptOnChain(world);
    drawWinner(world);
    landReceipt(world);
    world.nexus[0]!.tamperFetch = true;
    const anchors = await world.client().resolveOutputTrustAnchors(STREAM.task_id);
    // What examples/fetch-output.mjs does: one client per Builder, move on when told to.
    const errors: TrueOpenError[] = [];
    let text: string | undefined;
    for (const i of [0, 1, 2]) {
      try {
        const out = await world.client(i).fetchTaskOutput({ sessionId, taskId: STREAM.task_id, anchors, builderAddress: w.BUILDERS[i]!.address, maxRangeBytes: 8 });
        text = out.text;
        break;
      } catch (e) {
        expect(e).toBeInstanceOf(TrueOpenError);
        errors.push(e as TrueOpenError);
        if (!(e as TrueOpenError).switchSource) throw e;
      }
    }
    expect(errors.map((e) => [e.family, e.code, e.category, e.switchSource])).toEqual([['DATA', 'DATA_OUTPUT_HASH_MISMATCH', 'data-corrupt', true]]);
    expect(text).toBe(outputText(STREAM));
    expect(world.nexus[1]!.fetches.length).toBeGreaterThan(0);
  });
});

describe('e2e failures: chain facts', () => {
  it('fee denom override that disagrees with the chain is refused before anything is signed or sent', async () => {
    const e = await caught(open(world.client(0, { feeDenom: 'uatom' })));
    expect(e).toMatchObject({ family: 'SDK_LOCAL', code: 'SDK_LOCAL_FEE_DENOM_MISMATCH' });
    for (const n of world.nexus) expect(n.calls).toEqual([]);

    // Without an override the chain value is signed, and it is re-read on every order.
    world.node.businessDenom = 'uother';
    expect((await open()).feeDenom).toBe('uother');
  });

  it('profile pricing is enforced locally before signing', async () => {
    const low = await caught(world.client().openTask({
      sessionId, idempotencyKey: 'k', order: w.orderIntent({ amounts: { ...w.orderIntent().amounts, priceBid: { atomicUnits: '10000' } } }),
    }));
    expect(low.code).toBe('SDK_LOCAL_ORDER_VALUE_BELOW_PROFILE_MIN');
    const fee = await caught(world.client().openTask({
      sessionId, idempotencyKey: 'k', order: w.orderIntent({ amounts: { ...w.orderIntent().amounts, maxFee: { atomicUnits: '50' } } }),
    }));
    expect(fee.code).toBe('SDK_LOCAL_MAX_FEE_TOO_LOW');
    for (const n of world.nexus) expect(n.calls).toEqual([]);
  });

  it('Builder set changed between anchor and latest: the order signs and routes by the anchor-height set', async () => {
    world.node.builderSets = [w.SET_A, w.SET_B];
    expect((await world.hub.getActiveBuilderSet()).builderSetId).toBe(w.SET_B.id);
    const res = await open();
    expect(res.context.builderSetId).toBe(w.SET_A.id);
    expect(res.context.builderSetHash).toBe(w.SET_A.hash);
    expect(res.builders.map((b) => b.address).sort()).toEqual([...w.SET_A.members].sort());
    expect(res.builders.every((b) => b.ack?.accepted === true)).toBe(true);
    for (const n of world.nexus.slice(3)) expect(n.calls).toEqual([]);
    // Same order and task as without the change.
    expect(res.taskHash).toBe(STREAM.task_hash);
  });

  it('winner, then receipt, not on chain yet: OUTPUT_TRUST_ANCHOR_PENDING until they appear', async () => {
    acceptOnChain(world);
    const client = world.client();
    const noWinner = await caught(stream(world.sources([0])));
    expect(noWinner).toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_PENDING', retriable: true });
    expect(world.nexus[0]!.calls).toEqual([]);

    drawWinner(world);
    expect(text(await stream(world.sources([0])))).toBe(outputText(STREAM));

    const noReceipt = await caught(client.fetchTaskOutput({ sessionId, taskId: STREAM.task_id, builderAddress: w.BUILDERS[0]!.address }));
    expect(noReceipt).toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_PENDING', retriable: true });

    landReceipt(world);
    const out = await client.fetchTaskOutput({ sessionId, taskId: STREAM.task_id, builderAddress: w.BUILDERS[0]!.address });
    expect(out.text).toBe(outputText(STREAM));
  });

  // Right after openTask node answers the task query with 404: a state to poll on.
  it('task not on chain yet: OUTPUT_TRUST_ANCHOR_PENDING (retriable), not a final not-found', async () => {
    const e = await caught(world.client().resolveOutputTrustAnchors(STREAM.task_id));
    expect(e).toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_PENDING', retriable: true });
  });

  it('winner Worker key not ACTIVE: refused', async () => {
    acceptOnChain(world);
    drawWinner(world);
    world.node.serviceKeys.get(w.WORKER_OPERATOR)!.status = 'SERVICE_KEY_STATUS_REVOKED';
    const e = await caught(world.client().resolveOutputTrustAnchors(STREAM.task_id, { withReceipt: false }));
    expect(e.code).toBe('OUTPUT_TRUST_ANCHOR_WORKER_KEY_INACTIVE');
  });
});

describe('e2e failures: nexus error codes map to typed categories', () => {
  const objectRef = () => ({
    taskHash: STREAM.task_hash, sessionId, taskId: STREAM.task_id, objectKind: TASK_DATA_OBJECT_KIND.OUTPUT, contentHash: STREAM.output_hash,
  });

  const cases: {
    name: string;
    method: string;
    code: Code;
    message: string;
    want: Partial<TrueOpenError>;
  }[] = [
    { name: 'expired window', method: 'OpenTask', code: Code.DeadlineExceeded, message: 'NEXUS_DATA_EXPIRED: expiry outside the request window',
      want: { family: 'NEXUS_INGRESS', code: 'NEXUS_DATA_EXPIRED', category: 'expired', retriable: true, switchSource: false } },
    { name: 'not a selected Builder', method: 'OpenTask', code: Code.NotFound, message: 'NEXUS_INGRESS_NOT_SELECTED_BUILDER: not selected',
      want: { family: 'NEXUS_INGRESS', code: 'NEXUS_INGRESS_NOT_SELECTED_BUILDER', category: 'not-found', retriable: false, switchSource: true } },
    { name: 'not the task owner', method: 'AckOutput', code: Code.PermissionDenied, message: 'NEXUS_OUTPUT_UNAUTHORIZED: only the task owner may ack',
      want: { family: 'SDK_AUTH', code: 'NEXUS_OUTPUT_UNAUTHORIZED', category: 'auth', retriable: false, switchSource: false } },
    { name: 'replayed nonce', method: 'AckOutput', code: Code.Unauthenticated, message: 'SDK_AUTH_REPLAY: nonce replayed',
      want: { family: 'SDK_AUTH', code: 'SDK_AUTH_REPLAY', category: 'auth', retriable: true } },
    { name: 'object not ready', method: 'GetTaskDataMetadata', code: Code.Unavailable, message: 'NEXUS_DATA_NOT_READY: output still streaming',
      want: { family: 'NEXUS_INGRESS', code: 'NEXUS_DATA_NOT_READY', category: 'data-unavailable', retriable: true, switchSource: false } },
    { name: 'out of capacity', method: 'FetchTaskData', code: Code.ResourceExhausted, message: 'NEXUS_DATA_CAPACITY: too many readers',
      want: { family: 'NEXUS_INGRESS', code: 'NEXUS_DATA_CAPACITY', category: 'capacity', retriable: true, switchSource: true } },
    { name: 'stored bytes corrupt', method: 'FetchTaskData', code: Code.DataLoss, message: 'NEXUS_DATA_HASH_MISMATCH: stored object does not hash',
      want: { family: 'DATA', code: 'NEXUS_DATA_HASH_MISMATCH', category: 'data-corrupt', retriable: false, switchSource: true } },
    { name: 'uncoded internal failure', method: 'GetTaskDataMetadata', code: Code.Internal, message: 'database is locked',
      want: { family: 'NEXUS_INGRESS', code: 'NEXUS_CONNECT_INTERNAL', category: 'internal', retriable: false, switchSource: true } },
  ];

  for (const c of cases) {
    it(`${c.method}: ${c.name}`, async () => {
      acceptOnChain(world);
      drawWinner(world);
      landReceipt(world);
      world.nexus[0]!.inject.set(c.method, [{ code: c.code, message: c.message }]);
      const client = world.client(0);
      let err: unknown;
      switch (c.method) {
        case 'OpenTask': {
          const res = await open(client);
          err = res.builders.find((b) => b.address === w.BUILDERS[0]!.address)?.error;
          break;
        }
        case 'AckOutput':
          err = await caught(client.ingress.ackOutput({ sessionId, taskId: STREAM.task_id, lastSeq: 3n }));
          break;
        case 'GetTaskDataMetadata':
          err = await caught(client.ingress.getTaskDataMetadata({ objectRef: objectRef(), builderAddress: w.BUILDERS[0]!.address, expiresAtHeight: w.LATEST_HEIGHT + 5n }));
          break;
        case 'FetchTaskData':
          err = await caught(client.ingress.fetchTaskDataRange({ objectRef: objectRef(), builderAddress: w.BUILDERS[0]!.address, expiresAtHeight: w.LATEST_HEIGHT + 5n, range: { offset: 0n, length: 4n } }));
          break;
      }
      expect(err).toBeInstanceOf(TrueOpenError);
      expect(err).toMatchObject(c.want);
    });
  }

  it('a real nexus-side rejection: an envelope whose signer address does not match its key', async () => {
    acceptOnChain(world);
    // Without addressPrefix the SDK does not catch the mismatch locally; nexus does.
    const client = world.client(0, { addressPrefix: undefined, sdkSignerAddress: w.BUILDERS[5]!.address } as never);
    const e = await caught(client.ingress.ackOutput({ sessionId, taskId: STREAM.task_id, lastSeq: 0n }));
    expect(e).toMatchObject({ family: 'SDK_AUTH', code: 'SDK_AUTH_INVALID_SIGNATURE', category: 'auth', retriable: false });
    expect(world.nexus[0]!.verifications.at(-1)?.outcome).toContain('signer_address does not match');
  });

  it('a real nexus-side rejection: an expired envelope', async () => {
    acceptOnChain(world);
    const client = world.client(0, { expiry: () => BigInt(Date.now() - 60_000) });
    const e = await caught(client.ingress.ackOutput({ sessionId, taskId: STREAM.task_id, lastSeq: 0n }));
    expect(e).toMatchObject({ code: 'SDK_AUTH_EXPIRED', category: 'expired', retriable: true });
  });

  it('fetchTaskOutput repeats a range that failed on transport, on the same Builder', async () => {
    acceptOnChain(world);
    drawWinner(world);
    landReceipt(world);
    world.nexus[0]!.inject.set('FetchTaskData', [{ code: Code.Unavailable, message: 'NEXUS_DATA_STREAM_INTERRUPTED: reset' }]);
    const out = await world.client(0).fetchTaskOutput({ sessionId, taskId: STREAM.task_id, builderAddress: w.BUILDERS[0]!.address, maxRangeBytes: 16 });
    expect(out.text).toBe(outputText(STREAM));
    expect(world.nexus[0]!.calls.filter((m) => m === 'FetchTaskData')).toHaveLength(4);
  });
});

describe('e2e: a stream captured from a real Worker', () => {
  it('streams and fetches through the fake nexus and verifies with explicit anchors', async () => {
    const ref = REFERENCE_STREAM;
    world.outputs.set(ref.task_id, ref);
    world.node.sessions.set(ref.session_id, { owner: w.USER.address, nextExpectedSequence: 0n, openPendingCount: 0 });
    const workerServicePubKey = Uint8Array.from(Buffer.from(ref.worker_pubkey_hex, 'hex'));
    const client = world.client(1);
    const events = await drain(client.streamOutput({ sessionId: ref.session_id, taskId: ref.task_id, taskHash: ref.task_hash, workerServicePubKey }));
    expect(text(events)).toBe(outputText(ref));
    expect(events.at(-1)).toMatchObject({ kind: 'fin', attested: true });

    const out = await client.fetchTaskOutput({
      sessionId: ref.session_id, taskId: ref.task_id, taskHash: ref.task_hash, outputHash: ref.output_hash,
      builderAddress: w.BUILDERS[1]!.address, maxRangeBytes: 16,
    });
    expect(out.text).toBe(outputText(ref));
  });
});

describe('e2e: the fake nexus checks are not vacuous', () => {
  /** A correctly signed OpenTask input for the flow's order, built with the SDK's own builder. */
  async function signedInput() {
    const ctx = await resolveTaskOrderContext(world.hub, w.CHAIN_ID);
    const order = buildTaskOrder(ctx, { ...w.orderIntent(), userAddress: w.USER.address, sessionId, orderSequence: 0n }, undefined);
    const built = await buildOpenTaskRequest({
      order, payload: w.PAYLOAD, sessionId, taskId: STREAM.task_id, expiryHeight: ctx.latestHeight + 10n,
      requestNonce: new Uint8Array(16).fill(7), idempotencyKey: 'k',
      orderSigner: privKeyEip712Signer(w.USER.privKey), orderEip712: { evmChainId: w.EVM_CHAIN_ID, feeDenom: w.BUSINESS_DENOM },
      signer: privKeySecp256k1Signer(w.USER.privKey), signerPubKey: w.USER.pubKey,
    });
    return built.input;
  }

  it('accepts the untouched request', async () => {
    const ack = await world.client(0).ingress.openTask(await signedInput());
    expect(ack.accepted).toBe(true);
  });

  const tamper: [string, (i: OpenTaskInput) => OpenTaskInput, string][] = [
    ['a header field outside the order (media type)', (i) => ({ ...i, inputMediaType: 'text/plain' }), 'body_digest mismatch'],
    ['the payload bytes', (i) => ({ ...i, payload: Uint8Array.from(i.payload, (b, n) => (n === 0 ? b ^ 1 : b)) }), 'NEXUS_DATA_HASH_MISMATCH'],
    ['the outer order signature', (i) => ({ ...i, signature: Uint8Array.from(i.signature, (b, n) => (n === 5 ? b ^ 1 : b)) }), 'body_digest mismatch'],
    ['the envelope signature', (i) => ({ ...i, requestEnvelope: { ...i.requestEnvelope, signature: Uint8Array.from(i.requestEnvelope.signature, (b, n) => (n === 5 ? b ^ 1 : b)) } }), 'envelope signature'],
  ];
  for (const [what, change, want] of tamper) {
    it(`rejects a request whose ${what} changed after signing`, async () => {
      const e = await caught(world.client(0).ingress.openTask(change(await signedInput())));
      expect(e.message).toContain(want);
    });
  }
});
