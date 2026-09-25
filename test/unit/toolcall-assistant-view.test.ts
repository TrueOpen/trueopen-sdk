import { describe, expect, it } from 'vitest';
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
import { fromHex, toHex } from '../../src/util/bytes';
import { TrueOpenError } from '../../src/errors/errors';

const CHAIN_ID = 'trueopen-localnet-1';
const TASK_ID = 'aa'.repeat(32);
const TASK_HASH = 'bb'.repeat(32);
const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const WORKER_PUB = secp256k1PublicKey(PRIV);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const parseCall = (inner: string): DerivedToolCall | undefined => {
  const at = inner.indexOf('|');
  if (at < 0) return undefined;
  return { name: inner.slice(0, at), arguments: inner.slice(at + 1) };
};

const newState = () => createMarkerStreamState({ startMarker: '<tc>', endMarker: '</tc>', parseCall });

/** The same marker grammar in both directions, so streaming and one-shot agree. */
const parser: ToolCallParser = {
  name: 'test-markers',
  version: '1',
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

async function* frames(
  ...texts: readonly string[]
): AsyncIterable<{ kind: 'chunk'; text: string } | { kind: 'fin' }> {
  for (const text of texts) yield { kind: 'chunk', text };
  yield { kind: 'fin' };
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
    taskHash: fromHex(TASK_HASH),
    workerServicePubKey: WORKER_PUB,
  });
  chunks.forEach((text, i) => {
    const mmrRoot = mmrPrefixRoot(OUTPUT_MMR_DOMAIN, chunks, i + 1);
    const digest = outputChunkSigningDigest({
      chainId: CHAIN_ID,
      taskHash: fromHex(TASK_HASH),
      seq: BigInt(i),
      mmrRoot,
    });
    verifier.acceptOrDeduplicate({
      seq: BigInt(i),
      text,
      mmrRoot,
      signature: secp256k1.sign(digest, PRIV).toCompactRawBytes(),
    });
  });
  return verifier.checkpoint();
}

function receiptFor(chunks: readonly Uint8Array[]): InferReceiptView {
  return {
    taskId: TASK_ID,
    winnerWorker: 'trueopen1worker',
    inferReceiptHash: 'cc'.repeat(32),
    outputHash: toHex(outputHash(chunks)),
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

  it('strips a trailing EOS that arrives as its own frame', async () => {
    const events = await collect(
      deriveAssistantStream(frames('sunny', '<|im_end|>'), { parser, trailingEosMarkers: ['<|im_end|>'] }),
    );
    expect(events).toEqual([{ kind: 'content', text: 'sunny' }]);
  });

  it('keeps an EOS that is not trailing', async () => {
    const events = await collect(
      deriveAssistantStream(frames('a<|im_end|>b'), { parser, trailingEosMarkers: ['<|im_end|>'] }),
    );
    expect(events.flatMap((e) => (e.kind === 'content' ? [e.text] : [])).join('')).toBe('a<|im_end|>b');
  });

  it('flushes an unclosed segment at fin rather than dropping it', async () => {
    const events = await collect(deriveAssistantStream(frames('x <tc>trunc'), { parser }));
    expect(events).toEqual([
      { kind: 'content', text: 'x ' },
      { kind: 'content', text: '<tc>trunc' },
    ]);
  });
});

describe('confirmAssistantMessageWithReceipt', () => {
  // The markers are split between the two chunks, so a per-chunk parse would find neither.
  const chunks = [utf8('a<tc>get_'), utf8('weather|{"c":1}</tc>b')];

  it('returns the full list once the receipt reconciles', () => {
    const message = confirmAssistantMessageWithReceipt(
      {
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

  it('throws on a receipt whose output_hash disagrees, yielding nothing executable', () => {
    expect(() =>
      confirmAssistantMessageWithReceipt(
        {
          chainId: CHAIN_ID,
          taskId: TASK_ID,
          taskHash: TASK_HASH,
          checkpoint: checkpointOver(chunks),
          receipt: { ...receiptFor(chunks), outputHash: 'dd'.repeat(32) },
        },
        { parser },
      ),
    ).toThrow(TrueOpenError);
  });

  it('throws on a receipt whose leaf count disagrees', () => {
    expect(() =>
      confirmAssistantMessageWithReceipt(
        {
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

  it('strips a trailing EOS first', () => {
    expect(
      deriveAssistantMessage('sunny<|im_end|>', { parser, trailingEosMarkers: ['<|im_end|>'] }).content,
    ).toBe('sunny');
  });
});
