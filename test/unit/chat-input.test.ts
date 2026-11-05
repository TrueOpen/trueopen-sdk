import { describe, it, expect } from 'vitest';
import { chatInferInputBytes } from '../../src/order/chat-input';
import type { ChatInferInput } from '../../src/order/chat-input';
import { parseStrictJson, canonicalJsonBytes } from '../../src/codec/canonical-json';
import { TrueOpenError } from '../../src/errors/errors';

const dec = new TextDecoder();
const text = (i: ChatInferInput) => dec.decode(chatInferInputBytes(i));

const WEATHER: ChatInferInput = {
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: '伦敦天气怎么样？' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Current weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    },
  ],
  tool_choice: 'auto',
};

describe('chatInferInputBytes', () => {
  it('writes canonical_json_v1: keys by UTF-8 byte order, no whitespace, non-ASCII as itself', () => {
    expect(text(WEATHER)).toBe(
      '{"messages":[{"content":"You are helpful.","role":"system"},{"content":"伦敦天气怎么样？","role":"user"}],' +
        '"tool_choice":"auto",' +
        '"tools":[{"function":{"description":"Current weather for a city","name":"get_weather",' +
        '"parameters":{"properties":{"city":{"type":"string"}},"required":["city"],"type":"object"}},"type":"function"}]}',
    );
  });

  it('gives one byte sequence per request, whatever order the fields were written in', () => {
    const reordered: ChatInferInput = {
      tool_choice: 'auto',
      tools: [{ function: { parameters: { required: ['city'], properties: { city: { type: 'string' } }, type: 'object' }, description: 'Current weather for a city', name: 'get_weather' }, type: 'function' }],
      messages: [{ content: 'You are helpful.', role: 'system' }, { content: '伦敦天气怎么样？', role: 'user' }],
    };
    expect(chatInferInputBytes(reordered)).toEqual(chatInferInputBytes(WEATHER));
  });

  it('re-encoding its own bytes reproduces them (a fixed point of canonical_json_v1)', () => {
    const bytes = chatInferInputBytes(WEATHER);
    expect(canonicalJsonBytes(parseStrictJson(bytes))).toEqual(bytes);
  });

  it('leaves an unset optional field out rather than writing it', () => {
    // The types forbid an explicit undefined; a JavaScript caller can still pass one.
    expect(text({ messages: [{ role: 'user', content: 'hi' }], tools: undefined, parallel_tool_calls: undefined } as never))
      .toBe('{"messages":[{"content":"hi","role":"user"}]}');
  });

  it('carries a multi-turn history with a tool call and its result', () => {
    const t = text({
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"London"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp_c":12}' },
      ],
    });
    expect(t).toContain('{"role":"assistant","tool_calls":[{"function":{"arguments":"{\\"city\\":\\"London\\"}","name":"get_weather"},"id":"call_1","type":"function"}]}');
    expect(t).toContain('{"content":"{\\"temp_c\\":12}","role":"tool","tool_call_id":"call_1"}');
  });

  it('refuses a generation parameter and says where it belongs', () => {
    for (const field of ['temperature', 'top_p', 'max_completion_tokens', 'max_tokens', 'seed', 'presence_penalty', 'frequency_penalty', 'stop']) {
      expect(() => chatInferInputBytes({ messages: [{ role: 'user', content: 'hi' }], [field]: 1 } as never))
        .toThrow(/generationParams/);
    }
  });

  it('refuses the profile-owned fields and anything that is not a chat input field', () => {
    for (const field of ['logprobs', 'top_logprobs', 'logit_bias', 'n']) {
      expect(() => chatInferInputBytes({ messages: [{ role: 'user', content: 'hi' }], [field]: 1 } as never)).toThrow(/profile/);
    }
    // model is resolved from the chain model_id; stream is a delivery preference the SDK does not set here.
    for (const field of ['model', 'stream', 'max_completion_token']) {
      expect(() => chatInferInputBytes({ messages: [{ role: 'user', content: 'hi' }], [field]: 'x' } as never))
        .toThrow(/not a chat input field/);
    }
  });

  it('refuses empty messages, floats and null, which canonical_json_v1 cannot carry', () => {
    const err = (i: unknown) => {
      try {
        chatInferInputBytes(i as ChatInferInput);
      } catch (e) {
        return e;
      }
      return undefined;
    };
    expect(err({ messages: [] })).toMatchObject({ code: 'SDK_LOCAL_CHAT_INPUT_INVALID', category: 'invalid' });
    const schemaWithFloat = { type: 'function', function: { name: 'f', parameters: { type: 'number', minimum: 0.5 } } };
    expect(err({ messages: [{ role: 'user', content: 'hi' }], tools: [schemaWithFloat] })).toMatchObject({ code: 'SDK_LOCAL_CHAT_INPUT_INVALID' });
    expect(err({ messages: [{ role: 'user', content: null }] })).toBeInstanceOf(TrueOpenError);
  });

  it('is a body Cortex routes to its chat path: a JSON object carrying messages, with no refused key', () => {
    const parsed = JSON.parse(text(WEATHER)) as Record<string, unknown>;
    expect(Array.isArray(parsed['messages'])).toBe(true);
    const refused = ['logprobs', 'top_logprobs', 'logit_bias', 'n', 'temperature', 'top_p', 'max_completion_tokens', 'max_tokens', 'seed', 'presence_penalty', 'frequency_penalty', 'stop'];
    expect(Object.keys(parsed).filter((k) => refused.includes(k))).toEqual([]);
  });
});
