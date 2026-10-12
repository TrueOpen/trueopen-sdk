import { describe, it, expect } from 'vitest';
import { createRouterTransport, ConnectError, Code } from '@connectrpc/connect';
import type { Transport } from '@connectrpc/connect';
import { secp256k1 } from '@noble/curves/secp256k1';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import type {
  FetchTaskDataRequest,
  GetTaskDataMetadataRequest,
  SubscribeOutputRequest,
} from '../../src/gen/nexus/v1/ingress_pb.js';
import { TrueOpenClient, stripChatTemplateEos } from '../../src/client';
import { TrueOpenError } from '../../src/errors/errors';
import type { OutputTaskReader } from '../../src/client';
import type { ChainClient } from '../../src/transport/chain-client';
import type { ChainTaskSnapshot, InferReceiptView } from '../../src/types/node';
import type { ServiceKeyBinding } from '../../src/types/hub';
import { secp256k1PublicKey } from '../../src/signer/secp256k1';
import { ethSecp256k1Address } from '../../src/signer/eth-secp256k1';
import { privateKeyTypedDataSigner } from '../../src/signer/typed-data-signer';
import { mmrPrefixRoot } from '../../src/codec/mmr';
import {
  OUTPUT_MMR_DOMAIN,
  outputHash as outputMmrRoot,
  outputChunkSigningDigest,
  outputFinSigningDigest,
} from '../../src/output/output-commitment';
import { fromHex, toHex } from '../../src/util/bytes';
import { createMarkerStreamState } from '../../src/toolcall/stream-state';
import { createToolCallRegistry } from '../../src/toolcall/registry';
import type { ToolCallParser } from '../../src/toolcall/types';
import { hermesParser } from '../../src/toolcall/parsers/hermes';

const CHAIN_ID = 'trueopen-localnet-1';
const SESSION = 'b793a05ff8441795fca46a890b906b0c81af9d8d7a4d53e82de53a1c917b9883';
const TASK = 'd'.repeat(64);
const TASK_HASH = 'c'.repeat(64);
const WINNER = 'trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man';
const BUILDER = 'trueopen1870sqtdru7dj3xgwpzcexry0dwvyz2ku7xv9mg';

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const WORKER_PRIV = fromHex('0302030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const WORKER_PUB = secp256k1PublicKey(WORKER_PRIV);

const enc = new TextEncoder();
const CHUNKS = ['hello ', 'final ', 'output'].map((t) => enc.encode(t));
const BYTES = enc.encode('hello final output');
const ROOT = toHex(outputMmrRoot(CHUNKS));

function receiptFor(root: string, size: bigint, leaves: bigint): InferReceiptView {
  return { taskId: TASK, winnerWorker: WINNER, inferReceiptHash: 'e'.repeat(64), outputHash: root, outputSizeBytes: size, outputLeafCount: leaves };
}

function taskReader(over: { task?: Partial<ChainTaskSnapshot>; receipt?: InferReceiptView | null } = {}): OutputTaskReader & { receiptReads: number } {
  const r = {
    receiptReads: 0,
    async queryTask(taskId: string): Promise<ChainTaskSnapshot> {
      return {
        view: 'active', taskId, acceptedTaskHash: TASK_HASH, acceptedInputHash: 'a'.repeat(64), winnerWorker: WINNER,
        receiptStatus: 'RECEIPT_ACCEPTED', assignmentStatus: 'ASSIGNED', modelId: 'b'.repeat(64), profileVersion: 1n, orderSequence: 0n,
        ...over.task,
      };
    },
    async queryInferReceipt(): Promise<InferReceiptView | undefined> {
      r.receiptReads += 1;
      if (over.receipt === null) return undefined;
      return over.receipt ?? receiptFor(ROOT, BigInt(BYTES.length), 3n);
    },
  };
  return r;
}

function hub(status = 'ACTIVE') {
  const calls = { keys: [] as string[] };
  return {
    calls,
    getLatestHeight: async (): Promise<bigint> => 500n,
    getCurrentServiceKey: async (pt: string, addr: string): Promise<ServiceKeyBinding> => {
      calls.keys.push(`${pt}/${addr}`);
      return { participantType: pt, operatorAddress: addr, serviceAddress: addr, servicePubKey: WORKER_PUB, status, serviceAuthorizationNonce: 0n };
    },
  };
}

const fakeChain: ChainClient = {
  querySession: async () => { throw new Error('unused'); },
  querySessionNonce: async () => ({ nextSessionNonce: 0n }),
  createSession: async () => { throw new Error('unused'); },
  cancelOrder: async () => { throw new Error('unused'); },
};

interface ServeLog {
  ranges: { offset: bigint; length: bigint }[];
  expiries: bigint[];
  fetchCalls: number;
}

/** A nexus that serves `object` from its task-data store, honouring signed ranges like nexus does. */
function dataTransport(
  object: Uint8Array,
  chunkLengths: number[],
  log: ServeLog,
  opts: { failOnce?: bigint; lieServed?: boolean; badOffset?: boolean; leafCount?: bigint; fin?: Record<string, unknown> } = {},
): Transport {
  let failed = false;
  return createRouterTransport(({ service }) => {
    service(IngressAPI, {
      getTaskDataMetadata(req: GetTaskDataMetadataRequest) {
        log.expiries.push(req.requestAuth?.expiryHeight ?? 0n);
        return {
          metadata: {
            objectRef: req.objectRef, sizeBytes: BigInt(object.length), mediaType: 'text/plain; charset=utf-8',
            chunkLengths, outputLeafCount: opts.leafCount ?? BigInt(chunkLengths.length),
            ...(opts.fin !== undefined ? { fin: opts.fin } : {}),
          },
          retainUntilHeight: 1000n,
        };
      },
      async *fetchTaskData(req: FetchTaskDataRequest) {
        log.fetchCalls += 1;
        log.expiries.push(req.requestAuth?.expiryHeight ?? 0n);
        const size = BigInt(object.length);
        const range = req.range ?? { offset: 0n, length: size };
        if (range.offset >= size) throw new ConnectError('range invalid', Code.InvalidArgument);
        log.ranges.push({ offset: range.offset, length: range.length });
        if (opts.failOnce !== undefined && range.offset === opts.failOnce && !failed) {
          failed = true;
          throw new ConnectError('connection reset', Code.Unavailable);
        }
        const served = opts.lieServed ? { offset: range.offset + 1n, length: range.length } : range;
        yield { frame: { case: 'header' as const, value: { objectRef: req.objectRef, totalSizeBytes: size, mediaType: 'text/plain', servedRange: served } } };
        const start = Number(range.offset);
        const end = start + Number(range.length);
        for (let off = start; off < end; off += 4) {
          const data = object.subarray(off, Math.min(off + 4, end));
          yield {
            frame: {
              case: 'chunk' as const,
              value: { offset: BigInt(off) + (opts.badOffset ? 1n : 0n), data, eof: off + 4 >= end },
            },
          };
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });
}

function makeClient(transport: Transport, reader: OutputTaskReader | null = taskReader(), h: unknown = hub()): TrueOpenClient {
  return new TrueOpenClient({
    chainId: CHAIN_ID, userAddress: ethSecp256k1Address(secp256k1PublicKey(PRIV), 'trueopen'),
    wallet: privateKeyTypedDataSigner(PRIV),
    chain: fakeChain, ingressTransport: transport, signatureChainId: 424242n,
    nonce: () => new Uint8Array(32).fill(7),
    ...(reader !== null ? { taskReader: reader } : {}),
    hub: h as never,
  });
}

const newLog = (): ServeLog => ({ ranges: [], expiries: [], fetchCalls: 0 });

describe('resolveOutputTrustAnchors', () => {
  it('derives task_hash, the winner service key and the accepted receipt from chain', async () => {
    const h = hub();
    const a = await makeClient(dataTransport(BYTES, [6, 6, 6], newLog()), taskReader(), h).resolveOutputTrustAnchors(TASK);
    expect(a.taskHash).toBe(TASK_HASH);
    expect(a.winnerWorker).toBe(WINNER);
    expect(a.workerServicePubKey).toEqual(WORKER_PUB);
    expect(a.outputHash).toBe(ROOT);
    expect(a.receipt?.outputSizeBytes).toBe(18n);
    expect(h.calls.keys).toEqual([`PARTICIPANT_TYPE_CORTEX/${WINNER}`]);
  });

  it('is retriable-pending before the winner or the receipt exists', async () => {
    const t = dataTransport(BYTES, [6, 6, 6], newLog());
    await expect(makeClient(t, taskReader({ task: { winnerWorker: '' } })).resolveOutputTrustAnchors(TASK))
      .rejects.toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_PENDING', retriable: true });
    await expect(makeClient(t, taskReader({ receipt: null })).resolveOutputTrustAnchors(TASK))
      .rejects.toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_PENDING', retriable: true });
    // Streaming does not need the receipt, so it is not read at all.
    const reader = taskReader({ receipt: null });
    const a = await makeClient(t, reader).resolveOutputTrustAnchors(TASK, { withReceipt: false });
    expect(a.outputHash).toBeUndefined();
    expect(reader.receiptReads).toBe(0);
  });

  it('is retriable-pending while the task is not on chain yet (node answers 404)', async () => {
    const reader: OutputTaskReader = {
      queryTask: async () => { throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_NOT_FOUND', 'chain query -> HTTP 404'); },
      queryInferReceipt: async () => undefined,
    };
    const e = await makeClient(dataTransport(BYTES, [6, 6, 6], newLog()), reader).resolveOutputTrustAnchors(TASK).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_PENDING', retriable: true });
    expect((e as Error).cause).toMatchObject({ code: 'CHAIN_QUERY_NOT_FOUND' });
    // Any other read failure is passed through unchanged.
    const broken: OutputTaskReader = {
      queryTask: async () => { throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_MALFORMED', 'bad body'); },
      queryInferReceipt: async () => undefined,
    };
    await expect(makeClient(dataTransport(BYTES, [6, 6, 6], newLog()), broken).resolveOutputTrustAnchors(TASK))
      .rejects.toMatchObject({ code: 'CHAIN_QUERY_MALFORMED' });
  });

  it('refuses a revoked Worker key and a receipt from another Worker', async () => {
    const t = dataTransport(BYTES, [6, 6, 6], newLog());
    await expect(makeClient(t, taskReader(), hub('REVOKED')).resolveOutputTrustAnchors(TASK))
      .rejects.toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_WORKER_KEY_INACTIVE' });
    const other = { ...receiptFor(ROOT, 18n, 3n), winnerWorker: BUILDER };
    await expect(makeClient(t, taskReader({ receipt: other })).resolveOutputTrustAnchors(TASK))
      .rejects.toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_INCONSISTENT' });
  });

  it('explains what is missing when not configured', async () => {
    await expect(makeClient(dataTransport(BYTES, [6, 6, 6], newLog()), null).resolveOutputTrustAnchors(TASK))
      .rejects.toMatchObject({ code: 'SDK_LOCAL_TRUST_ANCHORS_UNCONFIGURED' });
  });
});

describe('fetchTaskOutput', () => {
  it('uses chain anchors by default and fetches in ranges no larger than maxRangeBytes', async () => {
    const log = newLog();
    const got = await makeClient(dataTransport(BYTES, [6, 6, 6], log)).fetchTaskOutput({
      sessionId: SESSION, taskId: TASK, builderAddress: BUILDER, maxRangeBytes: 7,
    });
    expect(got.text).toBe('hello final output');
    expect(got.outputHash).toBe(ROOT);
    expect(got.taskHash).toBe(TASK_HASH);
    expect(got.chunks.map((c) => new TextDecoder().decode(c))).toEqual(['hello ', 'final ', 'output']);
    expect(log.ranges).toEqual([
      { offset: 0n, length: 7n },
      { offset: 7n, length: 7n },
      { offset: 14n, length: 4n },
    ]);
    // Expiry is latest height + 10, never the 20-block edge of nexus's window.
    expect(new Set(log.expiries)).toEqual(new Set([510n]));
  });

  it('defaults to nexus max range (8 MiB), so a small object is one range', async () => {
    const log = newLog();
    await makeClient(dataTransport(BYTES, [6, 6, 6], log)).fetchTaskOutput({ sessionId: SESSION, taskId: TASK, builderAddress: BUILDER });
    expect(log.ranges).toEqual([{ offset: 0n, length: 18n }]);
  });

  it('does not fetch a size-0 object and returns it verified as one zero-length leaf', async () => {
    const emptyRoot = toHex(outputMmrRoot([new Uint8Array(0)]));
    const log = newLog();
    const got = await makeClient(
      dataTransport(new Uint8Array(0), [0], log),
      taskReader({ receipt: receiptFor(emptyRoot, 0n, 1n) }),
    ).fetchTaskOutput({ sessionId: SESSION, taskId: TASK, builderAddress: BUILDER });
    expect(got.bytes.length).toBe(0);
    expect(got.text).toBe('');
    expect(got.chunks).toHaveLength(1);
    expect(got.outputHash).toBe(emptyRoot);
    expect(log.fetchCalls).toBe(0);
  });

  it('retries a range that failed on transport without refetching earlier ranges', async () => {
    const log = newLog();
    const started = Date.now();
    const got = await makeClient(dataTransport(BYTES, [6, 6, 6], log, { failOnce: 7n })).fetchTaskOutput({
      sessionId: SESSION, taskId: TASK, builderAddress: BUILDER, maxRangeBytes: 7,
    });
    expect(got.text).toBe('hello final output');
    expect(log.ranges.map((r) => r.offset)).toEqual([0n, 7n, 7n, 14n]);
    // Unavailable and ResourceExhausted mean the peer is already past what it can serve, so the
    // retry waits instead of adding another request to the same overload.
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it('refuses a served_range or chunk offset other than the one requested', async () => {
    await expect(
      makeClient(dataTransport(BYTES, [6, 6, 6], newLog(), { lieServed: true })).fetchTaskOutput({
        sessionId: SESSION, taskId: TASK, builderAddress: BUILDER, maxRangeBytes: 7,
      }),
    ).rejects.toMatchObject({ code: 'NEXUS_FETCH_TASK_DATA_RANGE_INVALID' });
    await expect(
      makeClient(dataTransport(BYTES, [6, 6, 6], newLog(), { badOffset: true })).fetchTaskOutput({
        sessionId: SESSION, taskId: TASK, builderAddress: BUILDER,
      }),
    ).rejects.toMatchObject({ code: 'NEXUS_FETCH_TASK_DATA_RANGE_INVALID' });
  });

  it('refuses metadata whose size disagrees with the accepted receipt, before fetching', async () => {
    const log = newLog();
    await expect(
      makeClient(dataTransport(BYTES, [6, 6, 6], log), taskReader({ receipt: receiptFor(ROOT, 12n, 3n) })).fetchTaskOutput({
        sessionId: SESSION, taskId: TASK, builderAddress: BUILDER,
      }),
    ).rejects.toMatchObject({ code: 'DATA_OUTPUT_SIZE_MISMATCH' });
    expect(log.fetchCalls).toBe(0);
  });

  describe('stored Fin (ADR-0027)', () => {
    /** A Fin for BYTES as the Worker signs it; `over` tampers with what is served after signing. */
    function storedFin(finishReason = 3, over: Record<string, unknown> = {}, signer = WORKER_PRIV) {
      const fields = { chainId: CHAIN_ID, taskHash: fromHex(TASK_HASH), finalSeq: 2n, outputMmrRoot: fromHex(ROOT), finishReason };
      const workerSignature = secp256k1.sign(outputFinSigningDigest(fields), signer).toCompactRawBytes();
      return { finalSeq: 2n, outputMmrRoot: fromHex(ROOT), finishReason, workerSignature, ...over };
    }
    const fetchWith = (fin: Record<string, unknown> | undefined) =>
      makeClient(dataTransport(BYTES, [6, 6, 6], newLog(), fin !== undefined ? { fin } : {}))
        .fetchTaskOutput({ sessionId: SESSION, taskId: TASK, builderAddress: BUILDER });

    it('returns the finish reason of a signed Fin that matches the object', async () => {
      await expect(fetchWith(storedFin(3))).resolves.toMatchObject({ finishReason: 3, text: 'hello final output' });
    });

    it('verifies against an explicitly given service key without a chain read', async () => {
      const got = await makeClient(dataTransport(BYTES, [6, 6, 6], newLog(), { fin: storedFin(1) }), null).fetchTaskOutput({
        sessionId: SESSION, taskId: TASK, taskHash: TASK_HASH, outputHash: ROOT, builderAddress: BUILDER,
        expiresAtHeight: 42n, workerServicePubKey: WORKER_PUB,
      });
      expect(got.finishReason).toBe(1);
    });

    it('leaves the reason unavailable without a Fin or with an unsigned one', async () => {
      expect((await fetchWith(undefined)).finishReason).toBeUndefined();
      expect((await fetchWith(storedFin(1, { workerSignature: new Uint8Array() }))).finishReason).toBeUndefined();
    });

    it('refuses a signed Fin whose signature, root or final_seq does not match', async () => {
      await expect(fetchWith(storedFin(3, {}, PRIV))).rejects.toMatchObject({ code: 'DATA_OUTPUT_FIN_SIGNATURE_INVALID' });
      await expect(fetchWith(storedFin(3, { finishReason: 1 }))).rejects.toMatchObject({ code: 'DATA_OUTPUT_FIN_SIGNATURE_INVALID' });
      await expect(fetchWith(storedFin(3, { outputMmrRoot: new Uint8Array(32) }))).rejects.toMatchObject({ code: 'DATA_OUTPUT_FIN_ROOT_MISMATCH' });
      await expect(fetchWith(storedFin(3, { finalSeq: 1n }))).rejects.toMatchObject({ code: 'DATA_OUTPUT_FIN_SEQ_MISMATCH' });
    });
  });

  it('explicit hashes override the chain and need no chain reads', async () => {
    const log = newLog();
    const got = await makeClient(dataTransport(BYTES, [6, 6, 6], log), null).fetchTaskOutput({
      sessionId: SESSION, taskId: TASK, taskHash: TASK_HASH, outputHash: ROOT, builderAddress: BUILDER, expiresAtHeight: 42n,
    });
    expect(got.text).toBe('hello final output');
    expect(got.receipt).toBeUndefined();
    expect(new Set(log.expiries)).toEqual(new Set([42n]));
  });
});

describe('streamOutput trust anchors', () => {
  it('verifies frames against the chain-derived task_hash and winner key when none are passed', async () => {
    const frames = CHUNKS.map((text, i) => {
      const mmrRoot = mmrPrefixRoot(OUTPUT_MMR_DOMAIN, CHUNKS, i + 1);
      const digest = outputChunkSigningDigest({ chainId: CHAIN_ID, taskHash: fromHex(TASK_HASH), seq: BigInt(i), mmrRoot });
      return {
        seq: BigInt(i), text, mmrRoot, workerSignature: secp256k1.sign(digest, WORKER_PRIV).toCompactRawBytes(),
        attachment: new Uint8Array(), attachmentSignature: new Uint8Array(),
      };
    });
    const last = frames[frames.length - 1]!;
    const finDigest = outputFinSigningDigest({ chainId: CHAIN_ID, taskHash: fromHex(TASK_HASH), finalSeq: last.seq, outputMmrRoot: last.mmrRoot, finishReason: 1 });
    const transport = createRouterTransport(({ service }) => {
      service(IngressAPI, {
        async *subscribeOutput(_req: SubscribeOutputRequest) {
          for (const f of frames) yield { frame: { case: 'chunk' as const, value: f } };
          yield {
            frame: {
              case: 'fin' as const,
              value: { finalSeq: last.seq, outputMmrRoot: last.mmrRoot, finishReason: 1, workerSignature: secp256k1.sign(finDigest, WORKER_PRIV).toCompactRawBytes() },
            },
          };
        },
        ackOutput() { return { acked: true, alreadyAcked: false, ackedAt: 1n }; },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    });
    const reader = taskReader();
    const text: string[] = [];
    let attested = false;
    for await (const e of makeClient(transport, reader).streamOutput({ sessionId: SESSION, taskId: TASK })) {
      if (e.kind === 'chunk') text.push(e.text);
      else attested = e.attested;
    }
    expect(text.join('')).toBe('hello final output');
    expect(attested).toBe(true);
    // The receipt is not needed for streaming.
    expect(reader.receiptReads).toBe(0);
  });
});

describe('stripChatTemplateEos', () => {
  it('strips a trailing <|im_end|> and the template whitespace left before it', () => {
    expect(stripChatTemplateEos('9<|im_end|>')).toBe('9');
    expect(stripChatTemplateEos('答案是 9\n<|im_end|>')).toBe('答案是 9');
  });

  it('leaves text without the marker untouched, including an embedded marker', () => {
    expect(stripChatTemplateEos('答案是 9')).toBe('答案是 9');
    expect(stripChatTemplateEos('a<|im_end|>b')).toBe('a<|im_end|>b'); // not trailing
  });
});

describe('fetchAssistantMessage', () => {
  const parseCall = (inner: string) => {
    const at = inner.indexOf('|');
    return at < 0 ? undefined : { name: inner.slice(0, at), arguments: inner.slice(at + 1) };
  };
  const newState = () => createMarkerStreamState({ startMarker: '<tc>', endMarker: '</tc>', parseCall });
  // Same marker grammar in both directions, so the fetched full text and the parser agree.
  const hermes: ToolCallParser = {
    name: 'hermes',
    version: 1,
    createStreamState: newState,
    parseComplete(text) {
      const state = newState();
      const events = [...state.push(text), ...state.finish()];
      return {
        role: 'assistant',
        content: events.flatMap((e) => (e.kind === 'content' ? [e.text] : [])).join(''),
        toolCalls: events.flatMap((e) => (e.kind === 'tool-call-provisional' ? [e.call] : [])),
      };
    },
  };
  const registry = createToolCallRegistry([{ parser: hermes, conformance: 'vector-verified' }]);
  const TEXT = '<tc>get_weather|{"city":"London"}</tc> done';
  const fetch = (toolCallParser: { name: string; version: number }) => {
    const bytes = enc.encode(TEXT);
    const receipt = receiptFor(toHex(outputMmrRoot([bytes])), BigInt(bytes.length), 1n);
    return makeClient(dataTransport(bytes, [bytes.length], newLog()), taskReader({ receipt })).fetchAssistantMessage({
      sessionId: SESSION,
      taskId: TASK,
      builderAddress: BUILDER,
      expiresAtHeight: 510n,
      toolCallParser,
      registry,
    });
  };

  it('returns the fetched text with no tool calls when the profile pins no parser', async () => {
    expect(await fetch({ name: '', version: 0 })).toMatchObject({ role: 'assistant', content: TEXT, toolCalls: [] });
  });

  it('parses the fetched text when the profile pins a vector-verified parser', async () => {
    expect(await fetch({ name: 'hermes', version: 1 })).toMatchObject({
      role: 'assistant',
      content: ' done',
      toolCalls: [{ name: 'get_weather', arguments: '{"city":"London"}' }],
    });
  });
});

describe('fetchAssistantMessage with a reasoning parser (Manifest S7.3 rule 9)', () => {
  const DRAFT = '<tool_call>\n{"name": "delete_file", "arguments": {"path": "/"}}\n</tool_call>';
  const CALL = '<tool_call>\n{"name": "get_weather", "arguments": {"city": "London"}}\n</tool_call>';
  const OUTPUT = `<think>\nI could run ${DRAFT} but no.\n</think>\n\n${CALL}`;
  const fetch = (toolCallParser: { name: string; version: number }, reasoningParser: { name: string; version: number }) => {
    const bytes = enc.encode(OUTPUT);
    const receipt = receiptFor(toHex(outputMmrRoot([bytes])), BigInt(bytes.length), 1n);
    return makeClient(dataTransport(bytes, [bytes.length], newLog()), taskReader({ receipt })).fetchAssistantMessage({
      sessionId: SESSION,
      taskId: TASK,
      builderAddress: BUILDER,
      expiresAtHeight: 510n,
      toolCallParser,
      reasoningParser,
      registry: createToolCallRegistry([{ parser: hermesParser, conformance: 'unverified' }]),
      allowUnverified: true,
    });
  };
  const NONE = { name: '', version: 0 };
  const HERMES = { name: 'hermes', version: 1 };
  const QWEN3 = { name: 'qwen3', version: 1 };

  it('both: reasoning split first, the call drafted inside it is not a call', async () => {
    const m = await fetch(HERMES, QWEN3);
    expect(m.toolCalls.map((c) => c.name)).toEqual(['get_weather']);
    expect(m.reasoningContent).toBe(`I could run ${DRAFT} but no.`);
    expect(m.content).toBe('');
  });

  it('tool parser only: no separation, so the drafted call is surfaced too', async () => {
    const m = await fetch(HERMES, NONE);
    expect(m.toolCalls.map((c) => c.name)).toEqual(['delete_file', 'get_weather']);
    expect('reasoningContent' in m).toBe(false);
  });

  it('reasoning parser only: the remainder is plain content, with no tool parsing', async () => {
    const m = await fetch(NONE, QWEN3);
    expect(m.toolCalls).toEqual([]);
    expect(m.reasoningContent).toBe(`I could run ${DRAFT} but no.`);
    expect(m.content).toBe(CALL);
  });

  it('neither: the whole output is content', async () => {
    const m = await fetch(NONE, NONE);
    expect(m).toMatchObject({ role: 'assistant', content: OUTPUT, toolCalls: [] });
    expect(m.reasoningContent).toBeUndefined();
  });
});

describe('fetchAssistantMessage confirmation and Builder choice (sdk_详细设计 §5.3, §5.5)', () => {
  const NO_PARSER = { toolCallParser: { name: '', version: 0 } };
  /** A Fin over BYTES (chunks 6/6/6) as the Worker signs it. */
  function storedFin(finishReason: number) {
    const fields = { chainId: CHAIN_ID, taskHash: fromHex(TASK_HASH), finalSeq: 2n, outputMmrRoot: fromHex(ROOT), finishReason };
    return { finalSeq: 2n, outputMmrRoot: fromHex(ROOT), finishReason, workerSignature: secp256k1.sign(outputFinSigningDigest(fields), WORKER_PRIV).toCompactRawBytes() };
  }
  const B1 = 'trueopen1builder0000000000000000000000000001';
  const B2 = 'trueopen1builder0000000000000000000000000002';

  /** A client whose task reader names two Builders, each served by its own transport. */
  function routedClient(transports: Record<string, Transport>, reader = taskReader()) {
    const asked: string[] = [];
    const h = {
      ...hub(),
      getServiceDescriptor: async (address: string) => ({
        endpoints: [{ endpointKind: 'SERVICE_ENDPOINT_KIND_NEXUS_GRPC', uri: `https://${address}`, tlsPubkeyHash: '' }],
      }),
    };
    const client = new TrueOpenClient({
      chainId: CHAIN_ID, userAddress: ethSecp256k1Address(secp256k1PublicKey(PRIV), 'trueopen'),
      wallet: privateKeyTypedDataSigner(PRIV), chain: fakeChain, ingressTransport: dataTransport(BYTES, [6, 6, 6], newLog()),
      signatureChainId: 424242n, nonce: () => new Uint8Array(32).fill(7),
      taskReader: { ...reader, queryTaskBuilders: async () => [B1, B2] },
      hub: h as never,
      ingressTransportFactory: (uri: string) => { const a = uri.slice('https://'.length); asked.push(a); return transports[a]!; },
    });
    return { client, asked };
  }

  it('confirms against the receipt and carries the stored Fin\'s finish reason', async () => {
    const m = await makeClient(dataTransport(BYTES, [6, 6, 6], newLog(), { fin: storedFin(3) })).fetchAssistantMessage({
      sessionId: SESSION, taskId: TASK, builderAddress: BUILDER, ...NO_PARSER,
    });
    expect(m.finishReason).toBe(3);
    expect(m.confirmation).toMatchObject({
      type: 'confirmed', taskId: TASK, taskHash: TASK_HASH, winnerWorker: WINNER, outputHash: ROOT,
      outputLeafCount: 3n, outputSizeBytes: 18n, finishReason: 3,
    });
  });

  it('refuses to confirm without the accepted receipt', async () => {
    const anchors = await makeClient(dataTransport(BYTES, [6, 6, 6], newLog())).resolveOutputTrustAnchors(TASK, { withReceipt: false });
    await expect(makeClient(dataTransport(BYTES, [6, 6, 6], newLog())).fetchAssistantMessage({
      sessionId: SESSION, taskId: TASK, builderAddress: BUILDER, anchors, ...NO_PARSER,
    })).rejects.toMatchObject({ code: 'SDK_LOCAL_RECEIPT_REQUIRED' });
  });

  it('chooses the Builder: skips one without the signed Fin for one that stored it', async () => {
    const { client, asked } = routedClient({
      [B1]: dataTransport(BYTES, [6, 6, 6], newLog()),
      [B2]: dataTransport(BYTES, [6, 6, 6], newLog(), { fin: storedFin(1) }),
    });
    const m = await client.fetchAssistantMessage({ sessionId: SESSION, taskId: TASK, ...NO_PARSER });
    expect(asked).toEqual([B1, B2]);
    expect(m.finishReason).toBe(1);
  });

  it('returns the output with the reason unavailable when no Builder stored the Fin', async () => {
    const { client } = routedClient({
      [B1]: dataTransport(BYTES, [6, 6, 6], newLog()),
      [B2]: dataTransport(BYTES, [6, 6, 6], newLog()),
    });
    const m = await client.fetchAssistantMessage({ sessionId: SESSION, taskId: TASK, ...NO_PARSER });
    expect(m.content).toBe('hello final output');
    expect(m.finishReason).toBeUndefined();
  });

  it('moves past a failing Builder, and reports every failure when all fail', async () => {
    const broken = dataTransport(BYTES, [6, 6, 6], newLog(), { lieServed: true });
    const ok = routedClient({ [B1]: broken, [B2]: dataTransport(BYTES, [6, 6, 6], newLog(), { fin: storedFin(1) }) });
    expect((await ok.client.fetchAssistantMessage({ sessionId: SESSION, taskId: TASK, ...NO_PARSER })).finishReason).toBe(1);
    const none = routedClient({ [B1]: broken, [B2]: broken });
    await expect(none.client.fetchAssistantMessage({ sessionId: SESSION, taskId: TASK, ...NO_PARSER }))
      .rejects.toMatchObject({ code: 'DATA_OUTPUT_ALL_BUILDERS_FAILED', retriable: true });
  });

  /** A transport whose every call waits `ms` (or forever) before reaching `inner`. */
  function delayed(inner: Transport, ms: number | 'never'): Transport {
    const wait = () => (ms === 'never' ? new Promise<never>(() => {}) : new Promise<void>((r) => setTimeout(r, ms)));
    return {
      unary: async (...args: Parameters<Transport['unary']>) => { await wait(); return inner.unary(...args); },
      stream: async (...args: Parameters<Transport['stream']>) => { await wait(); return inner.stream(...args); },
    } as Transport;
  }

  it('asks the Builders at once: a signed Fin wins without waiting for a Builder that hangs', async () => {
    const { client } = routedClient({
      [B1]: delayed(dataTransport(BYTES, [6, 6, 6], newLog()), 'never'),
      [B2]: dataTransport(BYTES, [6, 6, 6], newLog(), { fin: storedFin(1) }),
    });
    const m = await client.fetchAssistantMessage({ sessionId: SESSION, taskId: TASK, ...NO_PARSER });
    expect(m.finishReason).toBe(1);
  });

  it('waits for a slower Builder that stored the signed Fin over a faster one without it', async () => {
    const { client } = routedClient({
      [B1]: dataTransport(BYTES, [6, 6, 6], newLog()),
      [B2]: delayed(dataTransport(BYTES, [6, 6, 6], newLog(), { fin: storedFin(3) }), 30),
    });
    const m = await client.fetchAssistantMessage({ sessionId: SESSION, taskId: TASK, ...NO_PARSER });
    expect(m.finishReason).toBe(3);
  });

  it('says what it needs when it cannot choose the Builder', async () => {
    await expect(makeClient(dataTransport(BYTES, [6, 6, 6], newLog())).fetchAssistantMessage({ sessionId: SESSION, taskId: TASK, ...NO_PARSER }))
      .rejects.toMatchObject({ code: 'SDK_LOCAL_BUILDER_ROUTING_UNCONFIGURED' });
  });
});

describe('assistantTurn (sdk_详细设计 §5.2, §5.5)', () => {
  const OUT = ['<think>\nneed the weather\n</think>\n\n<tool', '_call>\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n</tool_call>'];
  const CH = OUT.map((t) => enc.encode(t));
  const OUT_ROOT = toHex(outputMmrRoot(CH));
  const OUT_SIZE = BigInt(CH.reduce((n, c) => n + c.length, 0));

  function streamTransport(finishReason = 1) {
    const frames = CH.map((text, i) => {
      const mmrRoot = mmrPrefixRoot(OUTPUT_MMR_DOMAIN, CH, i + 1);
      const digest = outputChunkSigningDigest({ chainId: CHAIN_ID, taskHash: fromHex(TASK_HASH), seq: BigInt(i), mmrRoot });
      return { seq: BigInt(i), text, mmrRoot, workerSignature: secp256k1.sign(digest, WORKER_PRIV).toCompactRawBytes(), attachment: new Uint8Array(), attachmentSignature: new Uint8Array() };
    });
    const last = frames[frames.length - 1]!;
    const finDigest = outputFinSigningDigest({ chainId: CHAIN_ID, taskHash: fromHex(TASK_HASH), finalSeq: last.seq, outputMmrRoot: last.mmrRoot, finishReason });
    return createRouterTransport(({ service }) => {
      service(IngressAPI, {
        async *subscribeOutput() {
          for (const f of frames) yield { frame: { case: 'chunk' as const, value: f } };
          yield { frame: { case: 'fin' as const, value: { finalSeq: last.seq, outputMmrRoot: last.mmrRoot, finishReason, workerSignature: secp256k1.sign(finDigest, WORKER_PRIV).toCompactRawBytes() } } };
        },
        ackOutput() { return { acked: true, alreadyAcked: false, ackedAt: 1n }; },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    });
  }

  /** A task reader whose receipt appears only after `pendingReads` reads. */
  function readerWithReceipt(pendingReads: number) {
    const base = taskReader({ receipt: receiptFor(OUT_ROOT, OUT_SIZE, BigInt(CH.length)) });
    let reads = 0;
    return { ...base, queryInferReceipt: async (id: string) => (reads++ < pendingReads ? undefined : base.queryInferReceipt(id)) };
  }

  /** A hub whose profile pins hermes@1 and qwen3@1, as the devnet profile does. */
  const profileHub = () => ({
    ...hub(),
    getProfile: async () => ({ toolCallParser: { name: 'hermes', version: 1 }, reasoningParser: { name: 'qwen3', version: 1 } }),
  });

  async function run(client: TrueOpenClient, extra: Record<string, unknown> = {}) {
    const events: Array<{ kind: string; text?: string; message?: { toolCalls: unknown[]; finishReason?: number; reasoningContent?: string; content: string } }> = [];
    for await (const e of client.assistantTurn({ sessionId: SESSION, taskId: TASK, receiptPollIntervalMs: 1, ...extra })) events.push(e as never);
    return events;
  }

  it('streams reasoning and content, then yields the confirmed calls and finish reason', async () => {
    const events = await run(makeClient(streamTransport(1), readerWithReceipt(2), profileHub()), { allowUnverified: true });
    expect(events.filter((e) => e.kind === 'reasoning').map((e) => e.text).join('')).toBe('need the weather');
    expect(events.some((e) => e.kind === 'content' && e.text!.includes('tool_call'))).toBe(false);
    // No call from unconfirmed frames is handed out: only reasoning, content, then confirmed.
    expect(events.every((e) => ['reasoning', 'content', 'confirmed'].includes(e.kind))).toBe(true);
    const confirmed = events.at(-1)!;
    expect(confirmed.kind).toBe('confirmed');
    expect(confirmed.message).toMatchObject({
      reasoningContent: 'need the weather', content: '', finishReason: 1,
      toolCalls: [{ name: 'get_weather', arguments: '{"city": "Paris"}' }],
    });
  });

  it('keeps the closed calls of a truncated turn; the finish reason says it was cut off', async () => {
    const events = await run(makeClient(streamTransport(3), readerWithReceipt(0), profileHub()), { allowUnverified: true });
    expect(events.at(-1)!.message).toMatchObject({ finishReason: 3, toolCalls: [{ name: 'get_weather' }] });
  });

  it('uses no unverified parser unless allowed: the output is content with no calls', async () => {
    const events = await run(makeClient(streamTransport(1), readerWithReceipt(0), profileHub()));
    expect(events.at(-1)!.message).toMatchObject({ toolCalls: [] });
    expect(events.at(-1)!.message!.content).toContain('<tool_call>');
  });

  it('times out waiting for the receipt with a retriable error', async () => {
    await expect(run(makeClient(streamTransport(1), readerWithReceipt(1_000_000), profileHub()), { allowUnverified: true, receiptTimeoutMs: 20 }))
      .rejects.toMatchObject({ code: 'OUTPUT_RECEIPT_TIMEOUT', retriable: true });
  });
});
