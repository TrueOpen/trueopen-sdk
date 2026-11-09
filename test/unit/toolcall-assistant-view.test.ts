import { describe, expect, it } from 'vitest';
import { hash32Text } from '../../src/codec/hash32';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  confirmAssistantMessageWithReceipt,
  deriveAssistantMessage,
  deriveAssistantStream,
} from '../../src/toolcall/assistant-view';
import { createMarkerStreamState } from '../../src/toolcall/stream-state';
import type { AssistantStreamEvent, DerivedToolCall, ToolCallParser } from '../../src/toolcall/types';
import {
  OUTPUT_MMR_DOMAIN,
  OutputStreamVerifier,
  outputChunkSigningDigest,
  outputHash,
} from '../../src/output/output-commitment';
import { mmrPrefixRoot } from '../../src/codec/mmr';
import { secp256k1PublicKey } from '../../src/signer/secp256k1';
import type { InferReceiptView } from '../../src/types/node';
import { fromHex } from '../../src/util/bytes';
import { TrueOpenError } from '../../src/errors/errors';
import { FinishReasonV1 } from '../../src/gen/task/v1/evidence_pb.js';
import { qwen3ReasoningParser } from '../../src/toolcall/reasoning';
import { qwen3CoderParser } from '../../src/toolcall/parsers/qwen3-coder';

const CHAIN_ID = 'trueopen-localnet-1';
const TASK_ID = `0x${'aa'.repeat(32)}`;
const TASK_HASH = `0x${'bb'.repeat(32)}`;
// Phase 1: chunks and checkpoints are bound to the dispatch attempt.
const TICKET_HEX = `0x${'ee'.repeat(32)}`;
const TICKET = fromHex(TICKET_HEX.slice(2));
const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const WORKER_PUB = secp256k1PublicKey(PRIV);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const parseCall = (inner: string): DerivedToolCall | undefined => {
  const at = inner.indexOf('|');
  if (at < 0) return undefined;
  return { name: inner.slice(0, at), arguments: inner.slice(at + 1) };
};

const newState = () => createMarkerStreamState({ startMarker: '<tc>', endMarker: '</tc>', parseCall, recoverUnclosed: parseCall });

/** The same marker grammar in both directions, so streaming and one-shot agree. */
const parser: ToolCallParser = {
  name: 'test-markers',
  version: 1,
  createStreamState: newState,
  parseComplete(text, opts) {
    const state = newState();
    const events = [...state.push(text), ...state.finish(opts)];
    return {
      role: 'assistant',
      content: events.flatMap((e) => (e.kind === 'content' ? [e.text] : [])).join(''),
      toolCalls: events.flatMap((e) => (e.kind === 'tool-call-provisional' ? [e.call] : [])),
    };
  },
};

async function* frames(
  ...texts: readonly string[]
): AsyncIterable<{ kind: 'chunk'; text: string } | { kind: 'fin' }> {
  for (const text of texts) yield { kind: 'chunk', text };
  yield { kind: 'fin' };
}

/** As `frames`, ending in a Fin that carries a verified finish reason. */
async function* framesEndingWith(
  finishReason: FinishReasonV1 | undefined,
  ...texts: readonly string[]
): AsyncIterable<{ kind: 'chunk'; text: string } | { kind: 'fin'; finishReason: FinishReasonV1 | undefined }> {
  for (const text of texts) yield { kind: 'chunk', text };
  yield { kind: 'fin', finishReason };
}

async function collect(source: AsyncIterable<AssistantStreamEvent>): Promise<AssistantStreamEvent[]> {
  const out: AssistantStreamEvent[] = [];
  for await (const e of source) out.push(e);
  return out;
}

/** Builds a checkpoint over chunks a Worker really signed, as confirmOutput requires. */
function checkpointOver(chunks: readonly Uint8Array[]) {
  const verifier = new OutputStreamVerifier({
    chainId: CHAIN_ID,
    taskHash: fromHex(TASK_HASH.slice(2)),
    dispatchTicketHash: TICKET,
    workerServicePubKey: WORKER_PUB,
  });
  chunks.forEach((text, i) => {
    const mmrRoot = mmrPrefixRoot(OUTPUT_MMR_DOMAIN, chunks, i + 1);
    const digest = outputChunkSigningDigest({
      chainId: CHAIN_ID,
      taskHash: fromHex(TASK_HASH.slice(2)),
      dispatchTicketHash: TICKET,
      seq: BigInt(i),
      mmrRoot,
    });
    verifier.acceptOrDeduplicate({
      seq: BigInt(i),
      text,
      mmrRoot,
      dispatchTicketHash: TICKET,
      signature: secp256k1.sign(digest, PRIV).toCompactRawBytes(),
    });
  });
  return verifier.checkpoint();
}

function receiptFor(chunks: readonly Uint8Array[]): InferReceiptView {
  return {
    taskId: TASK_ID,
    winnerWorker: 'trueopen1worker',
    inferReceiptHash: `0x${'cc'.repeat(32)}`,
    outputHash: hash32Text(outputHash(chunks)),
    outputLeafCount: BigInt(chunks.length),
    outputSizeBytes: chunks.reduce((n, c) => n + BigInt(c.length), 0n),
  } as InferReceiptView;
}

describe('deriveAssistantStream', () => {
  it('yields provisional calls only -- this layer cannot produce anything executable', async () => {
    const events = await collect(deriveAssistantStream(frames('a<tc>get_weather|{"c":1}</tc>b'), { parser }));
    expect(events.map((e) => e.kind)).toEqual(['content', 'tool-call-provisional', 'content']);
  });

  it('parses a call whose markers were split across frames', async () => {
    const events = await collect(deriveAssistantStream(frames('<t', 'c>get_weather|{"c', '":1}</tc>'), { parser }));
    expect(events).toEqual([
      { kind: 'tool-call-provisional', call: { name: 'get_weather', arguments: '{"c":1}' } },
    ]);
  });

  it('takes the committed text as is: Cortex strips the EOS, the SDK strips nothing', async () => {
    const events = await collect(deriveAssistantStream(frames('sunny', '<|im_end|>'), { parser }));
    expect(events.flatMap((e) => (e.kind === 'content' ? [e.text] : [])).join('')).toBe('sunny<|im_end|>');
  });

  it('a reset drops the voided attempt and parses the replacement from scratch', async () => {
    // The voided attempt left a call half open; after the reset only the replacement's text counts.
    async function* source(): AsyncIterable<{ kind: 'chunk'; text: string } | { kind: 'reset' } | { kind: 'fin' }> {
      yield { kind: 'chunk', text: 'old <tc>stale|' };
      yield { kind: 'reset' };
      yield { kind: 'chunk', text: 'new <tc>get_' };
      yield { kind: 'chunk', text: 'weather|{"c":1}</tc>' };
      yield { kind: 'fin' };
    }
    const events = await collect(deriveAssistantStream(source(), { parser }));
    expect(events).toEqual([
      { kind: 'content', text: 'old ' },
      { kind: 'reset' },
      { kind: 'content', text: 'new ' },
      { kind: 'tool-call-provisional', call: { name: 'get_weather', arguments: '{"c":1}' } },
    ]);
  });

  it('a reset also restarts the reasoning split', async () => {
    async function* source(): AsyncIterable<{ kind: 'chunk'; text: string } | { kind: 'reset' } | { kind: 'fin' }> {
      yield { kind: 'chunk', text: '<think>\nold plan' };
      yield { kind: 'reset' };
      yield { kind: 'chunk', text: '<think>\nnew\n</think>\n\nanswer' };
      yield { kind: 'fin' };
    }
    const events = await collect(deriveAssistantStream(source(), { parser, reasoning: qwen3ReasoningParser }));
    const after = events.slice(events.findIndex((e) => e.kind === 'reset') + 1);
    expect(after.flatMap((e) => (e.kind === 'reasoning' ? [e.text] : [])).join('')).toBe('new');
    expect(after.flatMap((e) => (e.kind === 'content' ? [e.text] : [])).join('')).toBe('answer');
  });

  it('flushes an unclosed segment at fin rather than dropping it', async () => {
    const events = await collect(deriveAssistantStream(frames('x <tc>trunc'), { parser }));
    expect(events).toEqual([
      { kind: 'content', text: 'x ' },
      { kind: 'content', text: '<tc>trunc' },
    ]);
  });
});

describe('an unclosed final call is recovered only when the model stopped by itself', () => {
  const UNCLOSED = ['x <tc>get_', 'weather|{"c":1}'] as const;
  const calls = (events: readonly AssistantStreamEvent[]) =>
    events.flatMap((e) => (e.kind === 'tool-call-provisional' ? [e.call] : []));

  it.each([
    ['EOS_TOKEN', FinishReasonV1.EOS_TOKEN],
    ['STOP_SEQUENCE', FinishReasonV1.STOP_SEQUENCE],
    ['STOP_TOKEN', FinishReasonV1.STOP_TOKEN],
  ])('stream: recovered after a Fin of %s', async (_label, reason) => {
    const events = await collect(deriveAssistantStream(framesEndingWith(reason, ...UNCLOSED), { parser }));
    expect(events).toEqual([
      { kind: 'content', text: 'x ' },
      { kind: 'tool-call-provisional', call: { name: 'get_weather', arguments: '{"c":1}' } },
    ]);
  });

  it.each([
    ['MAX_OUTPUT_TOKENS', FinishReasonV1.MAX_OUTPUT_TOKENS],
    ['MAX_OUTPUT_DURATION', FinishReasonV1.MAX_OUTPUT_DURATION],
    ['USER_STOP', FinishReasonV1.USER_STOP],
    ['an unavailable reason', undefined],
  ])('stream: text after a Fin of %s', async (_label, reason) => {
    const events = await collect(deriveAssistantStream(framesEndingWith(reason, ...UNCLOSED), { parser }));
    expect(calls(events)).toEqual([]);
    expect(events.flatMap((e) => (e.kind === 'content' ? [e.text] : [])).join('')).toBe(UNCLOSED.join(''));
  });

  it('non-streaming: follows the finish reason it is given', () => {
    const text = UNCLOSED.join('');
    expect(deriveAssistantMessage(text, { parser, finishReason: FinishReasonV1.EOS_TOKEN }).toolCalls).toHaveLength(1);
    expect(deriveAssistantMessage(text, { parser, finishReason: FinishReasonV1.STOP_TOKEN }).toolCalls).toHaveLength(1);
    expect(deriveAssistantMessage(text, { parser, finishReason: FinishReasonV1.MAX_OUTPUT_TOKENS }).toolCalls).toEqual([]);
    expect(deriveAssistantMessage(text, { parser, finishReason: FinishReasonV1.USER_STOP }).toolCalls).toEqual([]);
    expect(deriveAssistantMessage(text, { parser }).toolCalls).toEqual([]);
  });

  it('a parser that defines no recovery never recovers (qwen3_coder@1), whatever the finish reason', async () => {
    const text = 'ok<tool_call>\n<function=f>\n<parameter=a>\n1\n</parameter>\n</function>\n';
    for (const finishReason of [FinishReasonV1.EOS_TOKEN, FinishReasonV1.STOP_SEQUENCE, FinishReasonV1.STOP_TOKEN]) {
      expect(deriveAssistantMessage(text, { parser: qwen3CoderParser, finishReason })).toEqual({ role: 'assistant', content: text, toolCalls: [] });
      const events = await collect(deriveAssistantStream(framesEndingWith(finishReason, text.slice(0, 9), text.slice(9)), { parser: qwen3CoderParser }));
      expect(calls(events)).toEqual([]);
      expect(events.flatMap((e) => (e.kind === 'content' ? [e.text] : [])).join('')).toBe(text);
    }
  });

  it('an unclosed reasoning span still runs no tool parsing (S7.3 rule 8)', () => {
    const text = '<think>\nmaybe <tc>rm|{}';
    const m = deriveAssistantMessage(text, { parser, reasoning: qwen3ReasoningParser, finishReason: FinishReasonV1.EOS_TOKEN });
    expect(m.toolCalls).toEqual([]);
  });
});

describe('confirmAssistantMessageWithReceipt', () => {
  // Both markers straddle a chunk boundary, so a per-chunk parse would find neither.
  const chunks = [utf8('a<t'), utf8('c>get_weather|{"c":1}</t'), utf8('c>b')];

  it('returns the full list once the receipt reconciles', () => {
    const message = confirmAssistantMessageWithReceipt(
      {
        dispatchTicketHash: TICKET_HEX,
        chainId: CHAIN_ID,
        taskId: TASK_ID,
        taskHash: TASK_HASH,
        checkpoint: checkpointOver(chunks),
        receipt: receiptFor(chunks),
      },
      { parser },
    );
    expect(message.role).toBe('assistant');
    expect(message.content).toBe('ab');
    expect(message.toolCalls).toEqual([{ name: 'get_weather', arguments: '{"c":1}' }]);
    expect(message.confirmation.type).toBe('confirmed');
  });

  it('keeps a leading U+FEFF of the committed output (REASONING_PARSER_V1: it is not whitespace)', () => {
    const bytes = utf8('\uFEFFhi');
    const bom = [bytes.slice(0, 2), bytes.slice(2)];
    const message = confirmAssistantMessageWithReceipt(
      { dispatchTicketHash: TICKET_HEX, chainId: CHAIN_ID, taskId: TASK_ID, taskHash: TASK_HASH, checkpoint: checkpointOver(bom), receipt: receiptFor(bom) },
      { parser },
    );
    expect(message.content).toBe('\uFEFFhi');
  });

  it('throws on a receipt whose output_hash disagrees, yielding nothing executable', () => {
    expect(() =>
      confirmAssistantMessageWithReceipt(
        {
          dispatchTicketHash: TICKET_HEX,
          chainId: CHAIN_ID,
          taskId: TASK_ID,
          taskHash: TASK_HASH,
          checkpoint: checkpointOver(chunks),
          receipt: { ...receiptFor(chunks), outputHash: `0x${'dd'.repeat(32)}` },
        },
        { parser },
      ),
    ).toThrow(TrueOpenError);
  });

  it('throws on a receipt whose leaf count disagrees', () => {
    expect(() =>
      confirmAssistantMessageWithReceipt(
        {
          dispatchTicketHash: TICKET_HEX,
          chainId: CHAIN_ID,
          taskId: TASK_ID,
          taskHash: TASK_HASH,
          checkpoint: checkpointOver(chunks),
          receipt: { ...receiptFor(chunks), outputLeafCount: 99n },
        },
        { parser },
      ),
    ).toThrow(TrueOpenError);
  });

  it('throws on a receipt whose output size bytes disagrees', () => {
    expect(() =>
      confirmAssistantMessageWithReceipt(
        {
          dispatchTicketHash: TICKET_HEX,
          chainId: CHAIN_ID,
          taskId: TASK_ID,
          taskHash: TASK_HASH,
          checkpoint: checkpointOver(chunks),
          receipt: { ...receiptFor(chunks), outputSizeBytes: 99n },
        },
        { parser },
      ),
    ).toThrow(TrueOpenError);
  });

  it('decodes multi-byte characters split across chunks', () => {
    const bytes = utf8('伦敦天气');
    const split = [bytes.slice(0, 5), bytes.slice(5)];
    const message = confirmAssistantMessageWithReceipt(
      {
        dispatchTicketHash: TICKET_HEX,
        chainId: CHAIN_ID,
        taskId: TASK_ID,
        taskHash: TASK_HASH,
        checkpoint: checkpointOver(split),
        receipt: receiptFor(split),
      },
      { parser },
    );
    expect(message.content).toBe('伦敦天气');
  });
});

describe('deriveAssistantMessage', () => {
  it('parses already-confirmed text with no provisional stage', () => {
    expect(deriveAssistantMessage('a<tc>x|1</tc>', { parser })).toEqual({
      role: 'assistant',
      content: 'a',
      toolCalls: [{ name: 'x', arguments: '1' }],
    });
  });

  it('takes the committed text as is, with nothing stripped', () => {
    expect(deriveAssistantMessage('sunny<|im_end|>', { parser }).content).toBe('sunny<|im_end|>');
  });
});

describe('qwen3_coder@1 values are JSON strings on every path (wire #46)', () => {
  const text = '<think>\nplan\n</think>\n\n<tool_call>\n<function=f>\n<parameter=n>\n5\n</parameter>\n</function>\n</tool_call>';
  const strings = [{ name: 'f', arguments: '{"n":"5"}' }];
  const opts = { parser: qwen3CoderParser, reasoning: qwen3ReasoningParser };

  it('streaming', async () => {
    const events = await collect(deriveAssistantStream(frames(text.slice(0, 40), text.slice(40)), opts));
    expect(events.flatMap((e) => (e.kind === 'tool-call-provisional' ? [e.call] : []))).toEqual(strings);
  });

  it('confirmation', () => {
    const chunks = [utf8(text.slice(0, 40)), utf8(text.slice(40))];
    const message = confirmAssistantMessageWithReceipt(
      { dispatchTicketHash: TICKET_HEX, chainId: CHAIN_ID, taskId: TASK_ID, taskHash: TASK_HASH, checkpoint: checkpointOver(chunks), receipt: receiptFor(chunks) },
      opts,
    );
    expect(message.toolCalls).toEqual(strings);
    expect(message.reasoningContent).toBe('plan');
  });

  it('non-streaming', () => {
    expect(deriveAssistantMessage(text, opts).toolCalls).toEqual(strings);
  });
});
