import { describe, expect, it } from 'vitest';
import type { ChatTool } from '../../src/order/chat-input';
import { qwen3CoderParser } from '../../src/toolcall/parsers/qwen3-coder';
import { BUILTIN_TOOL_CALL_PARSERS } from '../../src/toolcall/registry';
import type { ToolCallParseOptions, ToolCallStreamEvent } from '../../src/toolcall/types';

/** One call as Qwen3's chat template writes it: every tag on its own line. */
function block(name: string, params: Readonly<Record<string, string>>): string {
  const body = Object.entries(params)
    .map(([k, v]) => `<parameter=${k}>\n${v}\n</parameter>\n`)
    .join('');
  return `<tool_call>\n<function=${name}>\n${body}</function>\n</tool_call>`;
}

/** Feeds the frames in order through the streaming state and returns every event. */
function run(frames: readonly string[], opts?: ToolCallParseOptions): ToolCallStreamEvent[] {
  const state = qwen3CoderParser.createStreamState(opts);
  const events: ToolCallStreamEvent[] = [];
  for (const frame of frames) events.push(...state.push(frame));
  events.push(...state.finish(opts));
  return events;
}

const parse = (text: string, opts?: ToolCallParseOptions) => {
  const m = qwen3CoderParser.parseComplete(text, opts);
  return { content: m.content, toolCalls: m.toolCalls };
};

/** Spec §7 "with tools". */
const specTools: readonly ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'f',
      parameters: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          r: { type: 'number' },
          b: { type: 'boolean' },
          o: { type: 'object' },
          c: { type: ['integer', 'null'] },
          s: { type: 'string' },
        },
      },
    },
  },
];

describe('spec §7 examples, verbatim', () => {
  it.each([
    ['<tool_call>\n<function=f>\n<parameter=a>\n1\n</parameter>\n</function>\n</tool_call>', '', [{ name: 'f', arguments: '{"a":"1"}' }]],
    ['x<tool_call><function=a></function><function=b></function></tool_call>y', 'xy', [{ name: 'a', arguments: '{}' }, { name: 'b', arguments: '{}' }]],
    ['<tool_call><function=f><parameter=a>\n1\n<parameter=b>2</function></tool_call>', '', [{ name: 'f', arguments: '{"a":"1","b":"2"}' }]],
    ['<tool_call><function=f><parameter=s>say "hi</parameter></function></tool_call>', '', [{ name: 'f', arguments: '{"s":"say \\"hi"}' }]],
  ])('%j', (text, content, toolCalls) => {
    expect(parse(text)).toEqual({ content, toolCalls });
  });

  it.each([
    '<tool_call>\n{"name":"f","arguments":{}}\n</tool_call>',
    '<tool_call><function=f\n<parameter=a>1</parameter></function></tool_call>',
    '<function=f></function>',
  ])('not a call, content verbatim: %j', (text) => {
    expect(parse(text)).toEqual({ content: text, toolCalls: [] });
  });

  it('unclosed final block: a call with recover, content without', () => {
    const text = 'ok<tool_call>\n<function=f>\n</function>\n';
    expect(parse(text, { recoverUnclosedAtEnd: true })).toEqual({ content: 'ok', toolCalls: [{ name: 'f', arguments: '{}' }] });
    expect(parse(text)).toEqual({ content: text, toolCalls: [] });
  });

  it.each([
    [{ n: '10', r: '1.50e3', b: 'True', o: '{"k": 1}', c: 'null', s: '42' }, '{"n":10,"r":1.50e3,"b":true,"o":{"k": 1},"c":null,"s":"42"}'],
    [{ n: 'ten', b: 'yes', o: '[1]' }, '{"n":"ten","b":"yes","o":"[1]"}'],
    [{ n: '  7  ' }, '{"n":7}'],
    [{ s: '  7  ' }, '{"s":"  7  "}'],
    [{ x: '5' }, '{"x":"5"}'],
  ])('with tools: %j', (params, args) => {
    expect(parse(block('f', params), { tools: specTools }).toolCalls).toEqual([{ name: 'f', arguments: args }]);
  });
});

describe('§4 block body', () => {
  it('keeps surrounding prose and separates several blocks', () => {
    const text = `Checking.\n${block('a', { x: '1' })}\n${block('b', {})}\nDone.`;
    expect(parse(text)).toEqual({
      content: 'Checking.\n\n\nDone.',
      toolCalls: [
        { name: 'a', arguments: '{"x":"1"}' },
        { name: 'b', arguments: '{}' },
      ],
    });
  });

  it('ends a function missing </function> at the end of the block', () => {
    const text = '<tool_call>\n<function=f>\n<parameter=a>\n1\n</parameter>\n</tool_call>';
    expect(parse(text).toolCalls).toEqual([{ name: 'f', arguments: '{"a":"1"}' }]);
  });

  it('ends a function missing </function> at the next <function=', () => {
    const text = '<tool_call><function=a><parameter=k>1</parameter><function=b></function></tool_call>';
    expect(parse(text).toolCalls).toEqual([
      { name: 'a', arguments: '{"k":"1"}' },
      { name: 'b', arguments: '{}' },
    ]);
  });

  it('takes NAME and KEY verbatim, without trimming', () => {
    const text = '<tool_call><function= f ><parameter= k >v</parameter></function></tool_call>';
    expect(parse(text).toolCalls).toEqual([{ name: ' f ', arguments: '{" k ":"v"}' }]);
  });

  describe('a block that is not a call flows on as content, verbatim', () => {
    it.each([
      ['an empty block', '<tool_call>\n</tool_call>'],
      ['stray text before the function', '<tool_call>\nI will call\n<function=f>\n</function>\n</tool_call>'],
      ['stray text after the function', '<tool_call><function=f></function> done</tool_call>'],
      ['stray text between parameters', '<tool_call><function=f><parameter=a>1</parameter> and <parameter=b>2</parameter></function></tool_call>'],
      ['an empty function name', '<tool_call><function=></function></tool_call>'],
      ['an empty parameter name', '<tool_call><function=f><parameter=>1</parameter></function></tool_call>'],
      ['a function tag with no >', '<tool_call><function=f</tool_call>'],
      ['a parameter name holding <', '<tool_call><function=f><parameter=a<b>1</parameter></function></tool_call>'],
    ])('%s', (_label, text) => {
      expect(parse(`a ${text} b`)).toEqual({ content: `a ${text} b`, toolCalls: [] });
    });
  });
});

describe('§5 values', () => {
  it('strips exactly one wrapping newline and keeps the rest verbatim', () => {
    const text = '<tool_call><function=f><parameter=code>\n\n  x = "1"\n\n</parameter></function></tool_call>';
    expect(parse(text).toolCalls[0]!.arguments).toBe('{"code":"\\n  x = \\"1\\"\\n"}');
  });

  it('does not HTML-unescape and keeps \\r', () => {
    const text = '<tool_call><function=f><parameter=a>&lt;b&gt;\r</parameter></function></tool_call>';
    expect(parse(text).toolCalls[0]!.arguments).toBe('{"a":"&lt;b&gt;\\r"}');
  });

  it('encodes strings with JSON.stringify rules', () => {
    expect(parse(block('f', { city: 'São Paulo\tSP\u0001' })).toolCalls[0]!.arguments).toBe('{"city":"São Paulo\\tSP\\u0001"}');
  });

  it('keeps a repeated key at its first position with its last value', () => {
    const text = '<tool_call><function=f><parameter=a>1</parameter><parameter=b>2</parameter><parameter=a>3</parameter></function></tool_call>';
    expect(parse(text).toolCalls[0]!.arguments).toBe('{"a":"3","b":"2"}');
  });

  const tools: readonly ChatTool[] = [
    {
      type: 'function',
      function: {
        name: 'search',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'integer' },
            ratio: { type: 'number' },
            exact: { type: 'boolean' },
            filters: { type: 'object' },
            tags: { type: 'array' },
            cursor: { type: ['integer', 'null'] },
            mode: { enum: ['fast', 'slow'] },
            level: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
            count: { type: 'int' },
            size: { type: ' Float64 ' },
            flag: { oneOf: [{ type: 'bool' }] },
            either: { enum: [1, true] },
          },
        },
      },
    },
  ];
  const args = (params: Readonly<Record<string, string>>, name = 'search'): string =>
    parse(block(name, params), { tools }).toolCalls[0]!.arguments;

  it('types each value by its parameter schema', () => {
    expect(
      args({ query: '42', limit: '10', ratio: '0.5', exact: 'True', filters: '{"lang": "en"}', tags: '["a", "b"]', cursor: 'null', mode: 'fast', level: '3', count: '7' }),
    ).toBe('{"query":"42","limit":10,"ratio":0.5,"exact":true,"filters":{"lang": "en"},"tags":["a", "b"],"cursor":null,"mode":"fast","level":3,"count":7}');
  });

  it('applies aliases after trimming and lower-casing, through oneOf too', () => {
    expect(args({ size: '2.5', flag: 'FALSE' })).toBe('{"size":2.5,"flag":false}');
  });

  it('derives types from enum values, in priority order', () => {
    expect(args({ either: '1' })).toBe('{"either":1}');
    expect(args({ either: 'true' })).toBe('{"either":true}');
  });

  it('keeps the literal bytes of a number', () => {
    expect(args({ limit: '12345678901234567890', ratio: '1.50e3' })).toBe('{"limit":12345678901234567890,"ratio":1.50e3}');
  });

  it('rejects number spellings outside the JSON grammar', () => {
    expect(args({ limit: '+5', ratio: '.5' })).toBe('{"limit":"+5","ratio":".5"}');
    expect(args({ limit: '007', ratio: '1.' })).toBe('{"limit":"007","ratio":"1."}');
  });

  it('falls back to the untrimmed raw string when no type matches', () => {
    expect(args({ limit: ' ten ', exact: 'yes', filters: '[1]', tags: '{}', cursor: 'none' })).toBe(
      '{"limit":" ten ","exact":"yes","filters":"[1]","tags":"{}","cursor":"none"}',
    );
  });

  it('accepts 1 / 0 as a boolean', () => {
    expect(args({ exact: '0' })).toBe('{"exact":false}');
  });

  it('leaves undeclared parameters, unknown functions and absent tools as strings', () => {
    expect(args({ other: '5' })).toBe('{"other":"5"}');
    expect(args({ limit: '5' }, 'unknown')).toBe('{"limit":"5"}');
    expect(parse(block('search', { limit: '5' })).toolCalls[0]!.arguments).toBe('{"limit":"5"}');
  });

  it('does not take a schema from an inherited property', () => {
    expect(args({ toString: '5' })).toBe('{"toString":"5"}');
  });
});

describe('streaming', () => {
  const text = `Let me look.\n${block('get_weather', { city: 'São Paulo', days: '3' })}\nOne moment.`;
  const whole = qwen3CoderParser.parseComplete(text);

  function collect(events: readonly ToolCallStreamEvent[]): { content: string; calls: unknown[] } {
    let content = '';
    const calls: unknown[] = [];
    for (const e of events) {
      if (e.kind === 'content') content += e.text;
      else calls.push(e.call);
    }
    return { content, calls };
  }

  it('gives the same result for every two-frame split', () => {
    for (let i = 0; i <= text.length; i += 1) {
      expect(collect(run([text.slice(0, i), text.slice(i)])), `split at ${i}`).toEqual({ content: whole.content, calls: whole.toolCalls });
    }
  });

  it('gives the same result one character per frame', () => {
    expect(collect(run([...text]))).toEqual({ content: whole.content, calls: whole.toolCalls });
  });

  it('types values on the streaming path with the tools given at creation', () => {
    const events = run([...block('f', { n: '5', b: 'false' })], { tools: specTools });
    expect(events.filter((e) => e.kind === 'tool-call-provisional')).toEqual([
      { kind: 'tool-call-provisional', call: { name: 'f', arguments: '{"n":5,"b":false}' } },
    ]);
  });

  it('never emits a held-back partial start marker as content', () => {
    expect(run(['Hello <tool_', 'call>\n<function=f>\n</function>\n</tool_call>'])).toEqual([
      { kind: 'content', text: 'Hello ' },
      { kind: 'tool-call-provisional', call: { name: 'f', arguments: '{}' } },
    ]);
  });

  it('drops a partial end marker before recovering', () => {
    expect(parse('<tool_call><function=f></function></tool_c', { recoverUnclosedAtEnd: true })).toEqual({
      content: '',
      toolCalls: [{ name: 'f', arguments: '{}' }],
    });
  });
});

describe('registration', () => {
  it('is built in as qwen3_coder@1, unverified', () => {
    expect(BUILTIN_TOOL_CALL_PARSERS.lookup({ name: 'qwen3_coder', version: 1 })).toEqual({ supported: false, reason: 'parser-unverified' });
    expect(BUILTIN_TOOL_CALL_PARSERS.lookup({ name: 'qwen3_coder', version: 1 }, { allowUnverified: true })).toEqual({
      supported: true,
      parser: qwen3CoderParser,
    });
  });

  it('does not answer to the engine flag name qwen3_xml', () => {
    expect(BUILTIN_TOOL_CALL_PARSERS.lookup({ name: 'qwen3_xml', version: 1 }, { allowUnverified: true })).toEqual({
      supported: false,
      reason: 'parser-unknown',
    });
  });
});
