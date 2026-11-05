import { describe, expect, it } from 'vitest';
import { FinishReasonV1 } from '../../src/gen/task/v1/evidence_pb.js';
import {
  toOpenAIAssistantSSE,
  toOpenAIAssistantSSEIterable,
  type OpenAIAssistantSseEvent,
} from '../../src/output/openai-assistant-sse';
import type { OpenAIChatSseContext } from '../../src/output/openai-sse';
import type { ConfirmedAssistantMessage, DerivedToolCall } from '../../src/toolcall/types';
import { TrueOpenError } from '../../src/errors/errors';
import { deriveAssistantMessage, deriveAssistantStream } from '../../src/toolcall/assistant-view';
import { hermesParser } from '../../src/toolcall/parsers/hermes';
import { qwen3CoderParser } from '../../src/toolcall/parsers/qwen3-coder';
import { qwen3ReasoningParser } from '../../src/toolcall/reasoning';

const dec = new TextDecoder();
const TASK_ID = `0x${'aa'.repeat(32)}`;
const TASK_HASH = `0x${'bb'.repeat(32)}`;
const DONE = 'data: [DONE]\n\n';

const context: OpenAIChatSseContext = {
  id: 'chatcmpl-task-aa',
  taskId: TASK_ID,
  taskHash: TASK_HASH,
  model: 'hf-example',
  created: 1_789_603_200,
};
const options = { toolCallIdFormat: 'OPENAI_CALL_PREFIX' } as const;

function message(p: {
  content: string;
  toolCalls?: readonly DerivedToolCall[];
  reasoningContent?: string;
  finishReason?: FinishReasonV1 | undefined;
  taskId?: string;
}): ConfirmedAssistantMessage {
  return {
    role: 'assistant',
    content: p.content,
    toolCalls: p.toolCalls ?? [],
    ...(p.reasoningContent !== undefined ? { reasoningContent: p.reasoningContent } : {}),
    ...('finishReason' in p ? (p.finishReason !== undefined ? { finishReason: p.finishReason } : {}) : { finishReason: FinishReasonV1.EOS_TOKEN }),
    confirmation: {
      type: 'confirmed',
      taskId: p.taskId ?? TASK_ID,
      taskHash: TASK_HASH,
      winnerWorker: 'trueopen1worker',
      inferReceiptHash: `0x${'cc'.repeat(32)}`,
      outputHash: `0x${'dd'.repeat(32)}`,
      outputMmrRoot: new Uint8Array(32).fill(0xdd),
      outputLeafCount: 2n,
      outputSizeBytes: 10n,
    },
  };
}

async function* source(items: readonly OpenAIAssistantSseEvent[]): AsyncIterable<OpenAIAssistantSseEvent> {
  for (const item of items) yield item;
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const bytes of iterable) out.push(dec.decode(bytes));
  return out;
}

function json(frame: string): Record<string, unknown> {
  expect(frame.startsWith('data: ')).toBe(true);
  expect(frame.endsWith('\n\n')).toBe(true);
  return JSON.parse(frame.slice(6, -2)) as Record<string, unknown>;
}

const choice = (frame: string) => (json(frame).choices as Record<string, unknown>[])[0]!;

async function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(TrueOpenError);
    expect(error).toMatchObject({ code });
  }
}

describe('toOpenAIAssistantSSEIterable', () => {
  it('streams the content, drops the reasoning, and ends with stop', async () => {
    const frames = await collect(toOpenAIAssistantSSEIterable(source([
      { kind: 'reasoning', text: 'The user asks 1+1.' },
      { kind: 'content', text: '1 + 1 ' },
      { kind: 'content', text: 'is 2.' },
      { kind: 'confirmed', message: message({ content: '1 + 1 is 2.', reasoningContent: 'The user asks 1+1.' }) },
    ]), context, options));

    expect(frames).toHaveLength(5);
    expect(json(frames[0]!)).toEqual({
      id: context.id,
      object: 'chat.completion.chunk',
      created: context.created,
      model: context.model,
      system_fingerprint: null,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, logprobs: null, finish_reason: null }],
    });
    expect(choice(frames[1]!)).toEqual({ index: 0, delta: { content: '1 + 1 ' }, logprobs: null, finish_reason: null });
    expect(choice(frames[2]!)).toEqual({ index: 0, delta: { content: 'is 2.' }, logprobs: null, finish_reason: null });
    expect(choice(frames[3]!)).toEqual({ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' });
    expect(frames[4]).toBe(DONE);
    expect(frames.join('')).not.toContain('The user asks');
  });

  it('a reset before any content is ignored (only reasoning was dropped)', async () => {
    const frames = await collect(toOpenAIAssistantSSEIterable(source([
      { kind: 'reasoning', text: 'voided attempt' },
      { kind: 'reset' },
      { kind: 'content', text: 'ok' },
      { kind: 'confirmed', message: message({ content: 'ok' }) },
    ]), context, options));
    expect(choice(frames[1]!)).toEqual({ index: 0, delta: { content: 'ok' }, logprobs: null, finish_reason: null });
    expect(frames.at(-1)).toBe(DONE);
  });

  it('a reset after content was streamed fails closed, with no terminal chunk', async () => {
    const seen: string[] = [];
    await expectCode(async () => {
      for await (const bytes of toOpenAIAssistantSSEIterable(source([
        { kind: 'content', text: 'voided' },
        { kind: 'reset' },
        { kind: 'content', text: 'replacement' },
      ]), context, options)) seen.push(dec.decode(bytes));
    }, 'DATA_OPENAI_SSE_ATTEMPT_RESET');
    expect(seen.join('')).not.toContain('[DONE]');
  });

  it('sends the confirmed tool calls, one chunk each, then tool_calls', async () => {
    const calls = [
      { name: 'get_weather', arguments: '{"city": "London"}' },
      { name: 'list_files', arguments: '{"path":"."}' },
    ];
    const frames = await collect(toOpenAIAssistantSSEIterable(source([
      { kind: 'content', text: 'Checking.' },
      { kind: 'confirmed', message: message({ content: 'Checking.', toolCalls: calls }) },
    ]), context, options));

    expect(frames).toHaveLength(6);
    const toolChunks = [frames[2]!, frames[3]!].map((f) => choice(f));
    const ids = toolChunks.map((c) => ((c.delta as { tool_calls: { id: string }[] }).tool_calls[0]!).id);
    toolChunks.forEach((c, i) => {
      expect(c).toEqual({
        index: 0,
        delta: { tool_calls: [{ index: i, id: ids[i], type: 'function', function: calls[i] }] },
        logprobs: null,
        finish_reason: null,
      });
      expect(ids[i]).toMatch(/^call_[A-Za-z0-9]{24}$/);
    });
    expect(new Set(ids).size).toBe(2);
    expect(choice(frames[4]!)).toMatchObject({ delta: {}, finish_reason: 'tool_calls' });
    expect(frames[5]).toBe(DONE);
  });

  it('keeps the arguments exactly as the model wrote them', async () => {
    const args = '{ "b": 1,\n  "a": [1, 2] }';
    const frames = await collect(toOpenAIAssistantSSEIterable(source([
      { kind: 'confirmed', message: message({ content: '', toolCalls: [{ name: 'f', arguments: args }] }) },
    ]), context, options));
    const delta = choice(frames[1]!).delta as { tool_calls: { function: { arguments: string } }[] };
    expect(delta.tool_calls[0]!.function.arguments).toBe(args);
  });

  it('a turn with only a tool call still opens with the role chunk', async () => {
    const frames = await collect(toOpenAIAssistantSSEIterable(source([
      { kind: 'reasoning', text: 'call it' },
      { kind: 'confirmed', message: message({ content: '', toolCalls: [{ name: 'f', arguments: '{}' }] }) },
    ]), context, options));
    expect(frames).toHaveLength(4);
    expect(choice(frames[0]!).delta).toEqual({ role: 'assistant', content: '' });
    expect(choice(frames[1]!).delta).toHaveProperty('tool_calls');
  });

  it('uses the manifest id format', async () => {
    const frames = await collect(toOpenAIAssistantSSEIterable(source([
      { kind: 'confirmed', message: message({ content: '', toolCalls: [{ name: 'f', arguments: '{}' }] }) },
    ]), context, { toolCallIdFormat: 'MISTRAL_ALNUM_9' }));
    const delta = choice(frames[1]!).delta as { tool_calls: { id: string }[] };
    expect(delta.tool_calls[0]!.id).toMatch(/^[A-Za-z0-9]{9}$/);
  });

  it('maps a cut-off turn to length even with closed calls', async () => {
    const frames = await collect(toOpenAIAssistantSSEIterable(source([
      { kind: 'confirmed', message: message({ content: '', toolCalls: [{ name: 'f', arguments: '{}' }], finishReason: FinishReasonV1.MAX_OUTPUT_TOKENS }) },
    ]), context, options));
    expect(choice(frames[frames.length - 2]!)).toMatchObject({ finish_reason: 'length' });
  });

  it('pads every chunk when obfuscation is on', async () => {
    const frames = await collect(toOpenAIAssistantSSEIterable(source([
      { kind: 'content', text: 'hi' },
      { kind: 'confirmed', message: message({ content: 'hi', toolCalls: [{ name: 'f', arguments: '{}' }] }) },
    ]), context, { ...options, includeObfuscation: true }));
    for (const frame of frames.slice(0, -1)) expect(json(frame).obfuscation).toMatch(/^[A-Za-z0-9]{8,48}$/);
  });

  it('fails closed, with no terminal chunk and no [DONE]', async () => {
    const cases: [readonly OpenAIAssistantSseEvent[], string][] = [
      [[{ kind: 'content', text: 'hi' }], 'DATA_OPENAI_SSE_CONFIRMATION_MISSING'],
      [[{ kind: 'content', text: 'hi' }, { kind: 'confirmed', message: message({ content: 'hi', taskId: `0x${'ee'.repeat(32)}` }) }], 'DATA_OPENAI_SSE_CONFIRMATION_CONTEXT_MISMATCH'],
      [[{ kind: 'content', text: 'hi' }, { kind: 'confirmed', message: message({ content: 'hi!' }) }], 'DATA_OPENAI_SSE_CONTENT_MISMATCH'],
      [[{ kind: 'content', text: 'hi' }, { kind: 'confirmed', message: message({ content: 'hi', finishReason: undefined }) }], 'DATA_OPENAI_SSE_FINISH_REASON_UNAVAILABLE'],
    ];
    for (const [items, code] of cases) {
      const got: string[] = [];
      await expectCode(async () => {
        for await (const bytes of toOpenAIAssistantSSEIterable(source(items), context, options)) got.push(dec.decode(bytes));
      }, code);
      expect(got.join('')).not.toContain('finish_reason":"');
      expect(got).not.toContain(DONE);
    }
  });

  it('rejects an invalid context or id format before reading any event', async () => {
    let pulled = false;
    const lazy: AsyncIterable<OpenAIAssistantSseEvent> = {
      [Symbol.asyncIterator]() {
        return { next() { pulled = true; return Promise.resolve({ done: true, value: undefined }); } };
      },
    };
    await expectCode(() => collect(toOpenAIAssistantSSEIterable(lazy, { ...context, taskId: 'nope' }, options)), 'DATA_OPENAI_SSE_CONTEXT_INVALID');
    await expectCode(
      () => collect(toOpenAIAssistantSSEIterable(lazy, context, { toolCallIdFormat: 'UUID' as never })),
      'SDK_LOCAL_CALL_ID_FORMAT_INVALID',
    );
    expect(pulled).toBe(false);
  });

  it('the ReadableStream path produces the same bytes', async () => {
    const items: OpenAIAssistantSseEvent[] = [
      { kind: 'content', text: 'hi' },
      { kind: 'confirmed', message: message({ content: 'hi' }) },
    ];
    const expected = (await collect(toOpenAIAssistantSSEIterable(source(items), context, options))).join('');
    const reader = toOpenAIAssistantSSE(source(items), context, options).getReader();
    let actual = '';
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      actual += dec.decode(step.value);
    }
    expect(actual).toBe(expected);
  });

  // The adapter refuses a confirmed message whose content differs from what was streamed. With
  // the real parsers the streamed content and the confirmed re-parse agree, under every frame
  // split and finish reason, including an unclosed call that is (or is not) recovered.
  it('the real parsers stream exactly the content they confirm', async () => {
    const H = '<tool_call>\n{"name": "f", "arguments": {"a": 1}}\n</tool_call>';
    const C = '<tool_call>\n<function=f>\n<parameter=a>\n1\n</parameter>\n</function>\n</tool_call>';
    const cases = [
      { parser: hermesParser, text: `<think>\nplan ${H}\n</think>\n\nSure. ${H} done` },
      { parser: hermesParser, text: 'plan\n</think>\n\n<tool_call>\n{"name": "f", "arguments": {}}' },
      { parser: hermesParser, text: '<think>\nunclosed reasoning <tool_call>{"name":"f"}' },
      { parser: hermesParser, text: 'r</think>text <tool_call>{"name":"f","arguments":{}}</tool_' },
      { parser: qwen3CoderParser, text: `<think>\nr\n</think>\n\nok ${C} tail` },
      { parser: qwen3CoderParser, text: 'r</think><tool_call>\n<function=f>\n<parameter=a>\n1' },
    ];
    const reasons = [FinishReasonV1.EOS_TOKEN, FinishReasonV1.STOP_SEQUENCE, FinishReasonV1.MAX_OUTPUT_TOKENS, FinishReasonV1.USER_STOP];
    for (const { parser, text } of cases) {
      for (const finishReason of reasons) {
        const confirmedMsg = deriveAssistantMessage(text, { parser, reasoning: qwen3ReasoningParser, finishReason });
        for (let cut = 0; cut <= text.length; cut += 1) {
          const frames = [text.slice(0, cut), text.slice(cut)].filter((t) => t !== '');
          async function* out() {
            for (const t of frames) yield { kind: 'chunk' as const, text: t };
            yield { kind: 'fin' as const, finishReason };
          }
          const events: OpenAIAssistantSseEvent[] = [];
          for await (const e of deriveAssistantStream(out(), { parser, reasoning: qwen3ReasoningParser })) {
            if (e.kind === 'reasoning' || e.kind === 'content') events.push(e);
          }
          events.push({ kind: 'confirmed', message: { ...message({ content: confirmedMsg.content, toolCalls: confirmedMsg.toolCalls, finishReason }) } });
          const sse = await collect(toOpenAIAssistantSSEIterable(source(events), context, options));
          expect(sse[sse.length - 1]).toBe(DONE);
        }
      }
    }
  });
});
