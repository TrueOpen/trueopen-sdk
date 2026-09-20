import { describe, expect, it } from 'vitest';
import { FinishReasonV1 } from '../../src/gen/task/v1/evidence_pb.js';
import {
  openAIFinishReason,
  toOpenAIChatSSE,
  toOpenAIChatSSEIterable,
  type OpenAIChatSseContext,
  type VerifiedOutputEvent,
} from '../../src/output/openai-sse';
import type { ConfirmedOutputEvent } from '../../src/output/output-confirmation';
import { TrueOpenError } from '../../src/errors/errors';
import { toHex } from '../../src/util/bytes';

const enc = new TextEncoder();
const dec = new TextDecoder();
const ROOT0 = new Uint8Array(32).fill(0x11);
const ROOT1 = new Uint8Array(32).fill(0x22);
const TASK_ID = 'aa'.repeat(32);
const TASK_HASH = 'bb'.repeat(32);
const TEXTS = ['Hello, ', 'wörld'];

const context: OpenAIChatSseContext = {
  id: 'chatcmpl-task-aa',
  taskId: TASK_ID,
  taskHash: TASK_HASH,
  model: 'hf-example',
  created: 1_789_603_200,
};

function events(reason = FinishReasonV1.EOS_TOKEN): VerifiedOutputEvent[] {
  return [
    { type: 'chunk', seq: 0n, text: TEXTS[0]!, mmrRoot: ROOT0 },
    { type: 'chunk', seq: 1n, text: TEXTS[1]!, mmrRoot: ROOT1 },
    { type: 'fin', finalSeq: 1n, outputMmrRoot: ROOT1, finishReason: reason },
  ];
}

function confirmed(overrides: Partial<ConfirmedOutputEvent> = {}): ConfirmedOutputEvent {
  return {
    type: 'confirmed',
    taskId: TASK_ID,
    taskHash: TASK_HASH,
    winnerWorker: 'trueopen1worker',
    inferReceiptHash: 'cc'.repeat(32),
    outputHash: toHex(ROOT1),
    outputMmrRoot: ROOT1,
    outputLeafCount: 2n,
    outputSizeBytes: BigInt(enc.encode(TEXTS.join('')).length),
    ...overrides,
  };
}

async function* source(items: readonly VerifiedOutputEvent[]): AsyncIterable<VerifiedOutputEvent> {
  for (const item of items) yield item;
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string[]> {
  const result: string[] = [];
  for await (const bytes of iterable) result.push(dec.decode(bytes));
  return result;
}

function jsonFrame(frame: string): Record<string, unknown> {
  expect(frame.startsWith('data: ')).toBe(true);
  expect(frame.endsWith('\n\n')).toBe(true);
  return JSON.parse(frame.slice(6, -2)) as Record<string, unknown>;
}

async function expectCode(run: () => Promise<unknown>, code: string, family = 'DATA'): Promise<void> {
  try {
    await run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(TrueOpenError);
    expect(error).toMatchObject({ family, code, retriable: false });
  }
}

describe('openAIFinishReason', () => {
  it.each([
    [FinishReasonV1.EOS_TOKEN, 'stop'],
    [FinishReasonV1.STOP_SEQUENCE, 'stop'],
    [FinishReasonV1.MAX_OUTPUT_TOKENS, 'length'],
    [FinishReasonV1.MAX_OUTPUT_DURATION, 'length'],
  ] as const)('%s maps to %s', (reason, expected) => {
    expect(openAIFinishReason(reason)).toBe(expected);
  });

  it('UNSPECIFIED and unknown enum values fail closed', () => {
    expect(() => openAIFinishReason(FinishReasonV1.UNSPECIFIED)).toThrow(/finish_reason/);
    expect(() => openAIFinishReason(99 as FinishReasonV1)).toThrow(/finish_reason/);
  });
});

describe('toOpenAIChatSSEIterable', () => {
  it('provisional: two content chunks, a terminal chunk, then [DONE]', async () => {
    const frames = await collect(toOpenAIChatSSEIterable(source(events()), context));
    expect(frames).toHaveLength(4);
    const first = jsonFrame(frames[0]!);
    const second = jsonFrame(frames[1]!);
    const terminal = jsonFrame(frames[2]!);
    expect(first).toMatchObject({
      id: context.id,
      object: 'chat.completion.chunk',
      created: context.created,
      model: context.model,
      choices: [{ index: 0, delta: { content: TEXTS[0] }, finish_reason: null }],
    });
    expect(second).toMatchObject({ choices: [{ delta: { content: TEXTS[1] }, finish_reason: null }] });
    expect(terminal).toMatchObject({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    expect(frames[3]).toBe('data: [DONE]\n\n');
    // Verify that metadata never leaks into assistant content / the SSE envelope.
    expect(frames.join('')).not.toContain(toHex(ROOT0));
    expect(frames.join('')).not.toContain('outputMmrRoot');
    expect(frames.join('')).not.toContain('confirmed');
  });

  it('confirmed-only: not a single byte is delivered before the confirmed event arrives', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    async function* delayed(): AsyncIterable<VerifiedOutputEvent> {
      for (const event of events(FinishReasonV1.MAX_OUTPUT_TOKENS)) yield event;
      await gate;
      yield confirmed();
    }
    const iterator = toOpenAIChatSSEIterable(delayed(), context, { delivery: 'confirmed-only' })[Symbol.asyncIterator]();
    let settled = false;
    const firstPromise = iterator.next().then((step) => { settled = true; return step; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    release();
    const first = await firstPromise;
    expect(dec.decode(first.value)).toContain(TEXTS[0]);
    const rest: string[] = [];
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      rest.push(dec.decode(step.value));
    }
    expect(rest).toHaveLength(3);
    expect(jsonFrame(rest[1]!)).toMatchObject({ choices: [{ finish_reason: 'length' }] });
    expect(rest[2]).toBe('data: [DONE]\n\n');
  });

  it('confirmed-only: zero content delivered if the confirmed root/count/size mismatches', async () => {
    const cases: [Partial<ConfirmedOutputEvent>, string][] = [
      [{ outputMmrRoot: new Uint8Array(32).fill(0x33), outputHash: '33'.repeat(32) }, 'ROOT_MISMATCH'],
      [{ outputLeafCount: 3n }, 'LEAF_COUNT_MISMATCH'],
      [{ outputSizeBytes: 999n }, 'SIZE_MISMATCH'],
    ];
    for (const [override, suffix] of cases) {
      const got: string[] = [];
      await expectCode(async () => {
        for await (const bytes of toOpenAIChatSSEIterable(
          source([...events(), confirmed(override)]),
          context,
          { delivery: 'confirmed-only' },
        )) got.push(dec.decode(bytes));
      }, `DATA_OPENAI_SSE_CONFIRMATION_${suffix}`);
      expect(got).toEqual([]);
    }
  });

  it('confirmed-only: zero content and an error when the stream ends without a confirmed event', async () => {
    const got: string[] = [];
    await expectCode(async () => {
      for await (const bytes of toOpenAIChatSSEIterable(
        source(events()), context, { delivery: 'confirmed-only' },
      )) got.push(dec.decode(bytes));
    }, 'DATA_OPENAI_SSE_CONFIRMATION_MISSING');
    expect(got).toEqual([]);
  });

  it('a chunk sequence gap withholds the gap and everything after it', async () => {
    const bad: VerifiedOutputEvent[] = [
      events()[0]!,
      { type: 'chunk', seq: 2n, text: 'bad', mmrRoot: ROOT1 },
    ];
    const got: string[] = [];
    await expectCode(async () => {
      for await (const bytes of toOpenAIChatSSEIterable(source(bad), context)) got.push(dec.decode(bytes));
    }, 'DATA_OPENAI_SSE_CHUNK_SEQ_MISMATCH');
    expect(got).toHaveLength(1);
    expect(got[0]).toContain(TEXTS[0]);
  });

  it('rejects the terminal chunk and DONE when Fin seq/root mismatch or the reason is invalid', async () => {
    const cases: [VerifiedOutputEvent, string][] = [
      [{ type: 'fin', finalSeq: 9n, outputMmrRoot: ROOT1, finishReason: FinishReasonV1.EOS_TOKEN }, 'FIN_SEQ_MISMATCH'],
      [{ type: 'fin', finalSeq: 1n, outputMmrRoot: ROOT0, finishReason: FinishReasonV1.EOS_TOKEN }, 'FIN_ROOT_MISMATCH'],
      [{ type: 'fin', finalSeq: 1n, outputMmrRoot: ROOT1, finishReason: FinishReasonV1.UNSPECIFIED }, 'FINISH_REASON_INVALID'],
    ];
    for (const [fin, suffix] of cases) {
      const got: string[] = [];
      await expectCode(async () => {
        for await (const bytes of toOpenAIChatSSEIterable(
          source([events()[0]!, events()[1]!, fin]), context,
        )) got.push(dec.decode(bytes));
      }, `DATA_OPENAI_SSE_${suffix}`);
      expect(got).toHaveLength(2);
    }
  });

  it('a stream without a Fin event is rejected as incomplete', async () => {
    await expectCode(
      () => collect(toOpenAIChatSSEIterable(source(events().slice(0, 2)), context)),
      'DATA_OPENAI_SSE_STREAM_INCOMPLETE',
    );
  });

  it('strictly validates context id/model/created/choiceIndex', async () => {
    await expectCode(
      () => collect(toOpenAIChatSSEIterable(source(events()), { ...context, id: '' })),
      'DATA_OPENAI_SSE_CONTEXT_INVALID',
    );
    await expectCode(
      () => collect(toOpenAIChatSSEIterable(source(events()), { ...context, taskHash: 'BB'.repeat(32) })),
      'DATA_OPENAI_SSE_CONTEXT_INVALID',
    );
    await expectCode(
      () => collect(toOpenAIChatSSEIterable(source(events()), { ...context, created: -1 })),
      'DATA_OPENAI_SSE_CONTEXT_INVALID',
    );
    await expectCode(
      () => collect(toOpenAIChatSSEIterable(source(events()), { ...context, choiceIndex: 1.5 })),
      'DATA_OPENAI_SSE_CONTEXT_INVALID',
    );
  });

  it('confirmed-only: zero content and failure when the buffer exceeds maxBufferedBytes', async () => {
    const got: string[] = [];
    await expectCode(async () => {
      for await (const bytes of toOpenAIChatSSEIterable(
        source([...events(), confirmed()]),
        context,
        { delivery: 'confirmed-only', maxBufferedBytes: 3 },
      )) got.push(dec.decode(bytes));
    }, 'DATA_OPENAI_SSE_BUFFER_LIMIT_EXCEEDED');
    expect(got).toEqual([]);
  });

  it('rejects invalid delivery / maxBufferedBytes before reading any events', async () => {
    await expectCode(
      () => collect(toOpenAIChatSSEIterable(source(events()), context, {
        delivery: 'other' as 'provisional',
      })),
      'DATA_OPENAI_SSE_DELIVERY_INVALID',
    );
    await expectCode(
      () => collect(toOpenAIChatSSEIterable(source(events()), context, { maxBufferedBytes: -1 })),
      'DATA_OPENAI_SSE_BUFFER_LIMIT_INVALID',
    );
  });

  it('aborting via AbortSignal, whether already aborted or aborted while waiting on next, stops consumption and calls the upstream return', async () => {
    const already = new AbortController();
    already.abort();
    await expectCode(
      () => collect(toOpenAIChatSSEIterable(source(events()), context, { signal: already.signal })),
      'OPENAI_SSE_ABORTED',
      'SDK_LOCAL',
    );

    let returned = false;
    let calls = 0;
    const pending = new Promise<IteratorResult<VerifiedOutputEvent>>(() => {});
    const controlled: AsyncIterable<VerifiedOutputEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            calls += 1;
            if (calls === 1) return Promise.resolve({ done: false, value: events()[0]! });
            return pending;
          },
          return() {
            returned = true;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
    const controller = new AbortController();
    const iterator = toOpenAIChatSSEIterable(controlled, context, { signal: controller.signal })[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    const waiting = iterator.next();
    controller.abort();
    await expectCode(() => waiting, 'OPENAI_SSE_ABORTED', 'SDK_LOCAL');
    await Promise.resolve();
    expect(returned).toBe(true);
  });
});

describe('toOpenAIChatSSE ReadableStream', () => {
  it('browser path and AsyncIterable path produce byte-identical output', async () => {
    const expected = (await collect(toOpenAIChatSSEIterable(source(events()), context))).join('');
    const reader = toOpenAIChatSSE(source(events()), context).getReader();
    let actual = '';
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      actual += dec.decode(step.value);
    }
    expect(actual).toBe(expected);
  });

  it('highWaterMark=0: does not prefetch upstream events without reader demand', async () => {
    let nextCalls = 0;
    const items = events();
    const counted: AsyncIterable<VerifiedOutputEvent> = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next() {
            nextCalls += 1;
            const value = items[index++];
            return Promise.resolve(value === undefined ? { done: true, value: undefined } : { done: false, value });
          },
        };
      },
    };
    const reader = toOpenAIChatSSE(counted, context).getReader();
    await Promise.resolve();
    expect(nextCalls).toBe(0);
    expect((await reader.read()).done).toBe(false);
    expect(nextCalls).toBe(1);
    await Promise.resolve();
    expect(nextCalls).toBe(1);
    expect((await reader.read()).done).toBe(false);
    expect(nextCalls).toBe(2);
    await reader.cancel();
  });

  it('reader.cancel propagates to the upstream iterator.return', async () => {
    let returned = false;
    const cancellable: AsyncIterable<VerifiedOutputEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: false, value: events()[0]! }),
          return: async () => {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const reader = toOpenAIChatSSE(cancellable, context).getReader();
    await reader.read();
    await reader.cancel();
    await Promise.resolve();
    expect(returned).toBe(true);
  });
});
