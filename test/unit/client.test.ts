import { describe, it, expect } from 'vitest';
import { createRouterTransport } from '@connectrpc/connect';
import type { Transport } from '@connectrpc/connect';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import type {
  SubmitOrderRequest as GenSubmitOrderRequest,
  FetchOutputRefRequest,
  PrepareChallengeRequest,
  GetTaskEventsRequest,
  SubscribeOutputRequest,
  AckOutputRequest,
} from '../../src/gen/nexus/v1/ingress_pb.js';
import { FinishReasonV1 } from '../../src/gen/task/v1/evidence_pb.js';
import { ethSecp256k1Address } from '../../src/signer/eth-secp256k1';
import { privateKeyTypedDataSigner } from '../../src/signer/typed-data-signer';
import { TrueOpenClient } from '../../src/client';
import { sha256 } from '../../src/codec/hash';
import type { ChainClient } from '../../src/transport/chain-client';
import { secp256k1 } from '@noble/curves/secp256k1';
import { secp256k1PublicKey } from '../../src/signer/secp256k1';
import { mmrPrefixRoot } from '../../src/codec/mmr';
import { OUTPUT_MMR_DOMAIN, OutputStreamVerifier, outputChunkSigningDigest, outputFinSigningDigest } from '../../src/output/output-commitment';
import { fromHex, toHex } from '../../src/util/bytes';
import { TrueOpenError } from '../../src/errors/errors';

// deriveTaskId requires canonical 64-hex (raw Hash32 goes into the preimage).
const SESSION = 'b793a05ff8441795fca46a890b906b0c81af9d8d7a4d53e82de53a1c917b9883';
/** Request bodies decode task_id strictly as a lowercase Hash32. */
const TASK = 'e4'.repeat(32);

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const pub = secp256k1PublicKey(PRIV);

const wallet = privateKeyTypedDataSigner(PRIV);
const USER = ethSecp256k1Address(pub, 'trueopen');

const PAYLOAD = new TextEncoder().encode('trueopen-input');

function fakeChain(cap: { cancel?: unknown } = {}): ChainClient {
  return {
    async querySession(id) {
      return { sessionId: id, owner: 'trueopen1u', nextExpectedSequence: 0n, lastActiveHeight: 0n, openPendingCount: 0n, status: 'ACTIVE' };
    },
    async querySessionNonce() { return { nextSessionNonce: 0n }; },
    async createSession() { return { sessionId: SESSION, owner: 'trueopen1u', nonce: 0n, status: 'MUTATION_STATUS_V1_APPLIED' }; },
    async cancelOrder(i) { cap.cancel = i; return { taskId: TASK, cancelledSequence: i.orderSequence, nextExpectedSequence: i.orderSequence + 1n, status: 'MUTATION_STATUS_V1_APPLIED' }; },
  };
}

/** Output is an ordered list of chunks, not one solid block of text. Deliberately split in a way that would be erased if the chunks were merged. */
const OUTPUT_CHUNKS = ['hello ', 'final ', 'output'].map((t) => new TextEncoder().encode(t));
const OUTPUT_TEXT = 'hello final output';
/** Worker service key (a separate key unrelated to the user's identity). */
const WORKER_PRIV = fromHex('0302030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const WORKER_PUB = secp256k1PublicKey(WORKER_PRIV);
const TASK_HASH = 'c'.repeat(64);

/** Builds a sequence of validly signed frames: each frame's mmr_root is the root over the first seq+1 leaves, and the signature is the Worker's raw64. */
function signedFrames(chainId: string, chunks: readonly Uint8Array[] = OUTPUT_CHUNKS) {
  return chunks.map((text, i) => {
    const mmrRoot = mmrPrefixRoot(OUTPUT_MMR_DOMAIN, chunks, i + 1);
    const digest = outputChunkSigningDigest({
      chainId,
      taskHash: fromHex(TASK_HASH),
      seq: BigInt(i),
      mmrRoot,
    });
    return {
      seq: BigInt(i),
      text,
      mmrRoot,
      workerSignature: secp256k1.sign(digest, WORKER_PRIV).toCompactRawBytes(),
      attachment: new Uint8Array(),
      attachmentSignature: new Uint8Array(),
    };
  });
}

/** A Worker-signed Fin for the given last frame (finish_reason defaults to EOS_TOKEN). */
function signFin(chainId: string, last: { seq: bigint; mmrRoot: Uint8Array }, finishReason = 1) {
  return {
    finalSeq: last.seq,
    outputMmrRoot: last.mmrRoot,
    finishReason,
    workerSignature: secp256k1
      .sign(
        outputFinSigningDigest({ chainId, taskHash: fromHex(TASK_HASH), finalSeq: last.seq, outputMmrRoot: last.mmrRoot, finishReason }),
        WORKER_PRIV,
      )
      .toCompactRawBytes(),
  };
}

function fakeTransport(cap: { submitted?: unknown; fetch?: unknown; prepare?: unknown; events?: unknown; subscribe?: unknown; ack?: AckOutputRequest } = {}): Transport {
  return createRouterTransport(({ service }) => {
    service(IngressAPI, {
      submitOrder(req: GenSubmitOrderRequest) {
        cap.submitted = req;
        return { taskId: '', accepted: true, reason: '', sessionId: req.sessionId };
      },
      getTaskStatus() {
        return { state: 'PENDING', stage: 'ASSIGN', setId: 'set-1', updatedAt: 0n, taskPhase: 'ASSIGN_RANDOMNESS_PENDING' };
      },
      fetchOutputRef(req: FetchOutputRefRequest) {
        cap.fetch = req;
        return {
          credential: {
            credentialId: 'cred-1', sessionId: req.sessionId, taskId: req.taskId,
            recipient: req.requester, usage: req.usage, accessLevel: req.accessLevel,
            validUntil: 0n, issuer: 'trueopen1builder', issuerSig: new Uint8Array(),
          },
        };
      },
      prepareChallenge(req: PrepareChallengeRequest) {
        cap.prepare = req;
        return { challengeOpen: true, challengeCloseHeight: 999n, requiredEvidence: [], estimatedBond: { denom: 'utrueopen', amount: '5' }, estimatedGas: 21000n };
      },
      async *getTaskEvents(req: GetTaskEventsRequest) {
        cap.events = req;
        yield { cursor: '1', state: 'VERIFYING', taskPhase: 'OPEN_VERIFY', eventCode: 'OPEN_VERIFY_ACCEPTED', chainHeight: 100n };
      },
      async *subscribeOutput(req: SubscribeOutputRequest) {
        cap.subscribe = req;
        const frames = signedFrames('trueopen-devnet-1');
        // resume_after_seq semantics: only replay frames whose seq is strictly greater than it.
        // v0.2.0 makes the field explicitly optional; absent means replay from the beginning.
        const cursor = req.resumeAfterSeq ?? 0n;
        const replay = cursor > 0n || frames.length === 0 ? frames.filter((f) => f.seq > cursor) : frames;
        for (const f of replay) yield { frame: { case: 'chunk' as const, value: f } };
        const last = frames[frames.length - 1]!;
        yield { frame: { case: 'fin' as const, value: signFin('trueopen-devnet-1', last) } };
      },
      ackOutput(req: AckOutputRequest) {
        cap.ack = req;
        return { acked: true, alreadyAcked: false, ackedAt: 30n };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });
}

function makeClient(chainCap = {}, ingressCap = {}): TrueOpenClient {
  return new TrueOpenClient({
    chainId: 'trueopen-devnet-1', userAddress: USER, wallet, evmChainId: 424242n,
    chain: fakeChain(chainCap), ingressTransport: fakeTransport(ingressCap),
    nonce: () => new Uint8Array(32).fill(1), expiry: () => 1893456000000n,
  });
}

function scriptedStreamTransport(
  // The test script only fills in business fields; the $typeName required by Connect's generated types is handled by the real codec.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  script: (req: SubscribeOutputRequest) => AsyncIterable<any>,
  cap: { subscribes?: SubscribeOutputRequest[]; ack?: AckOutputRequest } = {},
): Transport {
  return createRouterTransport(({ service }) => {
    service(IngressAPI, {
      async *subscribeOutput(req: SubscribeOutputRequest) {
        (cap.subscribes ??= []).push(req);
        yield* script(req);
      },
      ackOutput(req: AckOutputRequest) {
        cap.ack = req;
        return { acked: true, alreadyAcked: false, ackedAt: 30n };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });
}

function makeClientWithTransport(transport: Transport): TrueOpenClient {
  return new TrueOpenClient({
    chainId: 'trueopen-devnet-1', userAddress: USER, wallet, evmChainId: 424242n,
    chain: fakeChain(), ingressTransport: transport,
    nonce: () => new Uint8Array(32).fill(1), expiry: () => 1893456000000n,
  });
}

describe('TrueOpenClient facade', () => {
  it('watchTask streams events', async () => {
    const events = [];
    for await (const ev of makeClient().watchTask(SESSION, TASK, '0')) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventCode).toBe('OPEN_VERIFY_ACCEPTED');
  });

  it('prepareChallenge returns a plan', async () => {
    const res = await makeClient().prepareChallenge(SESSION, TASK, 'USER_REVALIDATION');
    expect(res.challengeOpen).toBe(true);
    expect(res.estimatedBond?.amount).toBe('5');
  });

  it('cancelOrder calls the chain without a detached owner signature', async () => {
    const chainCap: { cancel?: unknown } = {};
    const r = await makeClient(chainCap).cancelOrder(SESSION, 5n);
    expect(r.nextExpectedSequence).toBe(6n);
  });

  it('streamOutput verifies each frame signature + root, and reports progress by default once done', async () => {
    const cap: { subscribe?: SubscribeOutputRequest; ack?: AckOutputRequest } = {};
    const got: string[] = [];
    for await (const f of makeClient({}, cap).streamOutput({
      sessionId: SESSION, taskId: TASK, taskHash: TASK_HASH, workerServicePubKey: WORKER_PUB,
    })) {
      if (f.kind === 'chunk') got.push(f.text);
    }
    expect(got).toEqual(['hello ', 'final ', 'output']);
    expect(got.join('')).toBe(OUTPUT_TEXT);
    expect(cap.subscribe?.taskId).toBe(TASK);
    // last_seq is the sequence number of the last locally verified segment, not the frame count.
    expect(cap.ack?.lastSeq).toBe(2n);
  });

  // ---- Fin carries finish_reason + worker_signature ----
  //
  // An unsigned Fin only proves the prefix received so far is self-consistent, so by default the
  // stream is complete only on a Worker-signed Fin. Accepting unsigned Fins is an explicit opt-in
  // that surfaces the fin as unattested and never acks it. A bad signature is never accepted.

  /** Builds a complete stream; finOverride replaces the terminating frame. */
  function streamWithFin(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    finOverride: (last: { seq: bigint; mmrRoot: Uint8Array }) => any,
    cap: { subscribes?: SubscribeOutputRequest[]; ack?: AckOutputRequest } = {},
  ): Transport {
    return scriptedStreamTransport(async function* () {
      const frames = signedFrames('trueopen-devnet-1');
      for (const f of frames) yield { frame: { case: 'chunk' as const, value: f } };
      const last = frames[frames.length - 1]!;
      yield { frame: { case: 'fin' as const, value: finOverride(last) } };
    }, cap);
  }

  const signedFin = (last: { seq: bigint; mmrRoot: Uint8Array }, finishReason: number) =>
    signFin('trueopen-devnet-1', last, finishReason);

  const drain = async (c: TrueOpenClient, extra: Record<string, unknown> = {}): Promise<string> => {
    let out = '';
    for await (const f of c.streamOutput({
      sessionId: SESSION, taskId: TASK, taskHash: TASK_HASH,
      workerServicePubKey: WORKER_PUB, ack: false, maxAttempts: 1, ...extra,
    })) { if (f.kind === 'chunk') out += f.text; }
    return out;
  };

  it('a truncating unsigned Fin is rejected by default and never acked', async () => {
    // The Builder stops after two of the three verified frames and closes with an unsigned Fin
    // that matches that prefix: self-consistent, but nothing says the output ends there.
    const cap: { ack?: AckOutputRequest } = {};
    const c = makeClientWithTransport(scriptedStreamTransport(async function* () {
      const frames = signedFrames('trueopen-devnet-1').slice(0, 2);
      for (const f of frames) yield { frame: { case: 'chunk' as const, value: f } };
      const last = frames[frames.length - 1]!;
      yield { frame: { case: 'fin' as const, value: { finalSeq: last.seq, outputMmrRoot: last.mmrRoot } } };
    }, cap));
    const kinds: string[] = [];
    await expect((async () => {
      for await (const e of c.streamOutput({
        sessionId: SESSION, taskId: TASK, taskHash: TASK_HASH, workerServicePubKey: WORKER_PUB, maxAttempts: 1,
      })) kinds.push(e.kind);
    })()).rejects.toMatchObject({
      code: 'DATA_OUTPUT_STREAM_RETRIES_EXHAUSTED',
      message: expect.stringContaining('no worker_signature'),
    });
    expect(kinds).not.toContain('fin');
    expect(cap.ack).toBeUndefined();
  });

  it('a valid signed Fin completes the stream as attested and acks it', async () => {
    const cap: { ack?: AckOutputRequest } = {};
    const c = makeClientWithTransport(streamWithFin((last) => signedFin(last, 1), cap));
    const events = [];
    for await (const e of c.streamOutput({
      sessionId: SESSION, taskId: TASK, taskHash: TASK_HASH, workerServicePubKey: WORKER_PUB, maxAttempts: 1,
    })) events.push(e);
    expect(events.at(-1)).toEqual({ kind: 'fin', attested: true, finishReason: 1 });
    expect(cap.ack?.lastSeq).toBe(2n);
  });

  it('a signed Fin from a key other than the Worker service key is rejected', async () => {
    const otherPriv = fromHex('0502030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
    const c = makeClientWithTransport(streamWithFin((last) => ({
      ...signedFin(last, 1),
      workerSignature: secp256k1
        .sign(outputFinSigningDigest({
          chainId: 'trueopen-devnet-1', taskHash: fromHex(TASK_HASH), finalSeq: last.seq, outputMmrRoot: last.mmrRoot, finishReason: 1,
        }), otherPriv)
        .toCompactRawBytes(),
    })));
    await expect(drain(c)).rejects.toMatchObject({ message: expect.stringContaining('did not verify') });
  });

  it("an unsigned Fin is rejected under finSignaturePolicy:'require'", async () => {
    const c = makeClientWithTransport(streamWithFin((last) => ({ finalSeq: last.seq, outputMmrRoot: last.mmrRoot })));
    // A bad Fin is treated as retryable (the Builder is just replaying the Worker's Fin as-is,
    // so trying a different one might work), so the outer error is RETRIES_EXHAUSTED, with the
    // specific reason in the message.
    await expect(drain(c, { finSignaturePolicy: 'require' })).rejects.toMatchObject({
      code: 'DATA_OUTPUT_STREAM_RETRIES_EXHAUSTED',
      message: expect.stringContaining('no worker_signature'),
    });
  });

  it('a signed Fin is accepted under both policies', async () => {
    for (const policy of ['accept-unsigned', 'require'] as const) {
      const c = makeClientWithTransport(streamWithFin((last) => signedFin(last, 1)));
      await expect(drain(c, { finSignaturePolicy: policy })).resolves.toBe(OUTPUT_TEXT);
    }
  });

  it("a Fin with a bad signature is rejected even under the opt-in 'accept-unsigned' policy", async () => {
    const c = makeClientWithTransport(
      streamWithFin((last) => ({ ...signedFin(last, 1), workerSignature: new Uint8Array(64) })),
    );
    await expect(drain(c, { finSignaturePolicy: 'accept-unsigned' })).rejects.toMatchObject({
      code: 'DATA_OUTPUT_STREAM_RETRIES_EXHAUSTED',
      message: expect.stringContaining('did not verify'),
    });
  });

  it('a valid signature but a tampered finish_reason (the signature covers that field) is rejected', async () => {
    const c = makeClientWithTransport(streamWithFin((last) => ({ ...signedFin(last, 1), finishReason: 3 })));
    await expect(drain(c)).rejects.toMatchObject({
      code: 'DATA_OUTPUT_STREAM_RETRIES_EXHAUSTED',
      message: expect.stringContaining('did not verify'),
    });
  });

  it('an invalid finish_reason is rejected even with a signature (UNSPECIFIED / unknown values fail closed)', async () => {
    for (const reason of [0, 5]) {
      const c = makeClientWithTransport(
        streamWithFin((last) => ({ ...signedFin(last, 1), finishReason: reason })),
      );
      await expect(drain(c)).rejects.toMatchObject({
        code: 'DATA_OUTPUT_STREAM_RETRIES_EXHAUSTED',
        message: expect.stringContaining('did not verify'),
      });
    }
  });

  /** Collect the event kinds in order, plus whatever the terminal event carried. */
  const drainEvents = async (
    c: TrueOpenClient,
    extra: Record<string, unknown> = {},
  ): Promise<{ kinds: string[]; finishReason: FinishReasonV1 | undefined; attested: boolean | undefined }> => {
    const kinds: string[] = [];
    let finishReason: FinishReasonV1 | undefined;
    let attested: boolean | undefined;
    for await (const e of c.streamOutput({
      sessionId: SESSION, taskId: TASK, taskHash: TASK_HASH,
      workerServicePubKey: WORKER_PUB, ack: false, maxAttempts: 1, ...extra,
    })) {
      kinds.push(e.kind);
      if (e.kind === 'fin') {
        finishReason = e.finishReason;
        attested = e.attested;
      }
    }
    return { kinds, finishReason, attested };
  };

  it('the stream ends with exactly one fin, after every chunk', async () => {
    const c = makeClientWithTransport(streamWithFin((last) => signedFin(last, 1)));
    const { kinds } = await drainEvents(c);
    expect(kinds).toEqual(['chunk', 'chunk', 'chunk', 'fin']);
  });

  it('a signature-verified Fin surfaces its finish_reason', async () => {
    const c = makeClientWithTransport(streamWithFin((last) => signedFin(last, 1)));
    const { finishReason } = await drainEvents(c);
    expect(finishReason).toBe(1);
  });

  // Under the explicit opt-in an unsigned Fin ends the stream, but it must stay
  // distinguishable from "ended normally" and must never report delivery progress.
  it("under the opt-in 'accept-unsigned', an unsigned Fin surfaces as unattested and is never acked", async () => {
    const cap: { ack?: AckOutputRequest } = {};
    const c = makeClientWithTransport(
      streamWithFin((last) => ({ finalSeq: last.seq, outputMmrRoot: last.mmrRoot }), cap),
    );
    const events = [];
    // ack is left at its default (true): an unattested Fin must still not be acked.
    for await (const e of c.streamOutput({
      sessionId: SESSION, taskId: TASK, taskHash: TASK_HASH, workerServicePubKey: WORKER_PUB,
      maxAttempts: 1, finSignaturePolicy: 'accept-unsigned',
    })) events.push(e);
    expect(events.map((e) => e.kind)).toEqual(['chunk', 'chunk', 'chunk', 'fin']);
    expect(events.at(-1)).toEqual({ kind: 'fin', attested: false, finishReason: undefined });
    expect(cap.ack).toBeUndefined();
  });

  it("under the opt-in 'accept-unsigned', a signed Fin is still attested and acked", async () => {
    const cap: { ack?: AckOutputRequest } = {};
    const c = makeClientWithTransport(streamWithFin((last) => signedFin(last, 2), cap));
    for await (const e of c.streamOutput({
      sessionId: SESSION, taskId: TASK, taskHash: TASK_HASH, workerServicePubKey: WORKER_PUB,
      maxAttempts: 1, finSignaturePolicy: 'accept-unsigned',
    })) {
      if (e.kind === 'fin') expect(e).toEqual({ kind: 'fin', attested: true, finishReason: 2 });
    }
    expect(cap.ack?.lastSeq).toBe(2n);
  });

  // The fin is yielded after ackOutput, so a consumer that breaks on it cannot skip the ack:
  // `break` runs the generator's cleanup path and anything after the yield never executes.
  it('acks before yielding fin, so breaking on fin still reports progress', async () => {
    const cap: { ack?: AckOutputRequest } = {};
    const c = makeClientWithTransport(streamWithFin((last) => signedFin(last, 1), cap));
    for await (const e of c.streamOutput({
      sessionId: SESSION, taskId: TASK, taskHash: TASK_HASH,
      workerServicePubKey: WORKER_PUB, maxAttempts: 1,
    })) {
      if (e.kind === 'fin') break;
    }
    expect(cap.ack?.lastSeq).toBe(2n);
  });

  it('streamOutput does not report progress when ack:false', async () => {
    const cap: { ack?: AckOutputRequest } = {};
    for await (const _ of makeClient({}, cap).streamOutput({
      sessionId: SESSION, taskId: TASK, taskHash: TASK_HASH, workerServicePubKey: WORKER_PUB, ack: false,
    })) { /* just drain */ }
    expect(cap.ack).toBeUndefined();
  });

  it('streamOutput rejects a bare resumeAfterSeq that has no verifier checkpoint', async () => {
    const cap: { subscribe?: SubscribeOutputRequest } = {};
    const iterator = makeClient({}, cap).streamOutput({
      sessionId: SESSION, taskId: TASK, taskHash: TASK_HASH,
      workerServicePubKey: WORKER_PUB, resumeAfterSeq: 1n,
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/checkpoint/);
    expect(cap.subscribe).toBeUndefined();
  });

  it('streamOutput resumes across Builders after a disconnect, strictly dedupes replayed frames, and delivers each only once', async () => {
    const frames = signedFrames('trueopen-devnet-1');
    const capA: { subscribes?: SubscribeOutputRequest[]; ack?: AckOutputRequest } = {};
    const capB: { subscribes?: SubscribeOutputRequest[]; ack?: AckOutputRequest } = {};
    const transportA = scriptedStreamTransport(async function* () {
      yield { frame: { case: 'chunk', value: frames[0]! } };
      throw new Error('connection reset');
    }, capA);
    const transportB = scriptedStreamTransport(async function* () {
      // A bare (implicit-presence) uint64 replays seq=0 on present(0); the SDK must re-verify and dedupe it.
      for (const frame of frames) yield { frame: { case: 'chunk', value: frame } };
      const last = frames[frames.length - 1]!;
      yield { frame: { case: 'fin', value: signFin('trueopen-devnet-1', last) } };
    }, capB);
    const a = makeClientWithTransport(transportA);
    const b = makeClientWithTransport(transportB);
    const checkpoints: bigint[] = [];
    const got: string[] = [];

    for await (const frame of a.streamOutput({
      sessionId: SESSION,
      taskId: TASK,
      taskHash: TASK_HASH,
      workerServicePubKey: WORKER_PUB,
      sources: [{ id: 'builder-a', ingress: a.ingress }, { id: 'builder-b', ingress: b.ingress }],
      maxAttempts: 2,
      onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint.mmr.leafCount); },
    })) { if (frame.kind === 'chunk') got.push(frame.text); }

    expect(got).toEqual(['hello ', 'final ', 'output']);
    expect(checkpoints).toEqual([1n, 2n, 3n]);
    expect(capA.subscribes).toHaveLength(1);
    expect(capB.subscribes).toHaveLength(1);
    expect(capB.subscribes?.[0]?.resumeAfterSeq).toBe(0n);
    expect(capB.ack?.lastSeq).toBe(2n);
    expect(capA.ack).toBeUndefined();
  });

  it('streamOutput does not deliver a bad frame on a gap in sequence numbers, and resumes from the same checkpoint after switching Builders', async () => {
    const frames = signedFrames('trueopen-devnet-1');
    const transportA = scriptedStreamTransport(async function* () {
      yield { frame: { case: 'chunk', value: frames[0]! } };
      yield { frame: { case: 'chunk', value: frames[2]! } };
    });
    const transportB = scriptedStreamTransport(async function* () {
      for (const frame of frames) yield { frame: { case: 'chunk', value: frame } };
      const last = frames[frames.length - 1]!;
      yield { frame: { case: 'fin', value: signFin('trueopen-devnet-1', last) } };
    });
    const a = makeClientWithTransport(transportA);
    const b = makeClientWithTransport(transportB);
    const got: string[] = [];

    for await (const frame of a.streamOutput({
      sessionId: SESSION,
      taskId: TASK,
      taskHash: TASK_HASH,
      workerServicePubKey: WORKER_PUB,
      sources: [{ id: 'gap-builder', ingress: a.ingress }, { id: 'good-builder', ingress: b.ingress }],
      maxAttempts: 2,
      ack: false,
    })) { if (frame.kind === 'chunk') got.push(frame.text); }

    expect(got).toEqual(['hello ', 'final ', 'output']);
  });

  it('streamOutput can resume from a persisted checkpoint, delivering only the frames not yet consumed', async () => {
    const frames = signedFrames('trueopen-devnet-1');
    const verifier = new OutputStreamVerifier({
      chainId: 'trueopen-devnet-1', taskHash: fromHex(TASK_HASH), workerServicePubKey: WORKER_PUB,
    });
    verifier.accept({
      seq: frames[0]!.seq,
      text: frames[0]!.text,
      mmrRoot: frames[0]!.mmrRoot,
      signature: frames[0]!.workerSignature,
    });
    const cap: { subscribes?: SubscribeOutputRequest[] } = {};
    const transport = scriptedStreamTransport(async function* () {
      // Simulates a server with explicit resume_after_seq presence: present(0) only returns seq > 0.
      for (const frame of frames.slice(1)) yield { frame: { case: 'chunk', value: frame } };
      const last = frames[frames.length - 1]!;
      yield { frame: { case: 'fin', value: signFin('trueopen-devnet-1', last) } };
    }, cap);
    const client = makeClientWithTransport(transport);
    const got: string[] = [];
    for await (const frame of client.streamOutput({
      sessionId: SESSION,
      taskId: TASK,
      taskHash: TASK_HASH,
      workerServicePubKey: WORKER_PUB,
      checkpoint: verifier.checkpoint(),
      resumeAfterSeq: 0n,
      ack: false,
    })) { if (frame.kind === 'chunk') got.push(frame.text); }

    expect(got).toEqual(['final ', 'output']);
    expect(cap.subscribes?.[0]?.resumeAfterSeq).toBe(0n);
  });

  it('confirmOutput produces a confirmed event from the on-chain Receipt root/count/size', () => {
    const frames = signedFrames('trueopen-devnet-1');
    const verifier = new OutputStreamVerifier({
      chainId: 'trueopen-devnet-1', taskHash: fromHex(TASK_HASH), workerServicePubKey: WORKER_PUB,
    });
    for (const frame of frames) {
      verifier.accept({
        seq: frame.seq,
        text: frame.text,
        mmrRoot: frame.mmrRoot,
        signature: frame.workerSignature,
      });
    }
    const size = OUTPUT_CHUNKS.reduce((total, chunk) => total + BigInt(chunk.length), 0n);
    const event = makeClient().confirmOutput({
      taskId: TASK,
      taskHash: TASK_HASH,
      checkpoint: verifier.checkpoint(),
      receipt: {
        taskId: TASK,
        winnerWorker: 'trueopen1worker',
        inferReceiptHash: 'd'.repeat(64),
        outputHash: toHex(frames[frames.length - 1]!.mmrRoot),
        outputSizeBytes: size,
        outputLeafCount: BigInt(frames.length),
      },
    });
    expect(event).toMatchObject({
      type: 'confirmed', taskId: TASK, outputLeafCount: 3n, outputSizeBytes: size,
    });
  });

  it('a different Worker public key fails frame signature verification', async () => {
    const other = secp256k1PublicKey(fromHex('0402030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'));
    const it = makeClient({}, {}).streamOutput({
      sessionId: SESSION, taskId: TASK, taskHash: TASK_HASH, workerServicePubKey: other,
    })[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow(/signature invalid/);
  });

  it('flipping one bit in task_hash changes the frame digest and fails signature verification', async () => {
    const it = makeClient({}, {}).streamOutput({
      sessionId: SESSION, taskId: TASK, taskHash: 'd' + TASK_HASH.slice(1), workerServicePubKey: WORKER_PUB,
    })[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow(/signature invalid/);
  });

  it('a wallet that does not hold userAddress is refused before a request is sent', async () => {
    const cap: { ack?: AckOutputRequest } = {};
    const client = new TrueOpenClient({
      chainId: 'trueopen-devnet-1', userAddress: USER, evmChainId: 424242n,
      wallet: privateKeyTypedDataSigner(fromHex('02030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2021')),
      chain: fakeChain(), ingressTransport: scriptedStreamTransport(async function* () {}, cap),
      expiry: () => 1893456000000n,
    });
    await expect(client.ingress.ackOutput({ sessionId: SESSION, taskId: TASK, lastSeq: 0n })).rejects.toMatchObject({
      code: 'SDK_LOCAL_SIGNER_ADDRESS_MISMATCH',
    });
    expect(cap.ack).toBeUndefined();
  });
});
