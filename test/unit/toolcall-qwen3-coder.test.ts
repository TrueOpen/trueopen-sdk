import { describe, expect, it } from 'vitest';
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
  const state = qwen3CoderParser.createStreamState();
  const events: ToolCallStreamEvent[] = [];
  for (const frame of frames) events.push(...state.push(frame));
  events.push(...state.finish(opts));
  return events;
}

const parse = (text: string, opts?: ToolCallParseOptions) => {
  const m = qwen3CoderParser.parseComplete(text, opts);
  return { content: m.content, toolCalls: m.toolCalls };
};

describe('spec examples, verbatim', () => {
  it.each([
    ['<tool_call>\n<function=f>\n<parameter=a>\n1\n</parameter>\n</function>\n</tool_call>', '', [{ name: 'f', arguments: '{"a":"1"}' }]],
    ['x<tool_call><function=a></function><function=b></function></tool_call>y', 'xy', [{ name: 'a', arguments: '{}' }, { name: 'b', arguments: '{}' }]],
    ['<tool_call><function=f><parameter=s>say "hi</parameter></function></tool_call>', '', [{ name: 'f', arguments: '{"s":"say \\"hi"}' }]],
  ])('%j', (text, content, toolCalls) => {
    expect(parse(text)).toEqual({ content, toolCalls });
  });

  it.each([
    '<tool_call>\n{"name":"f","arguments":{}}\n</tool_call>',
    // No </parameter> left for an open parameter (TOOL_CALL_PARSER_V1 qwen3_coder@1 payload).
    '<tool_call><function=f><parameter=a>\n1\n<parameter=b>2</function></tool_call>',
    '<tool_call><function=f\n<parameter=a>1</parameter></function></tool_call>',
    '<function=f></function>',
  ])('not a call, content verbatim: %j', (text) => {
    expect(parse(text)).toEqual({ content: text, toolCalls: [] });
  });

  it('unclosed final block: always content, with or without recover (no recovery defined)', () => {
    const text = 'ok<tool_call>\n<function=f>\n</function>\n';
    expect(parse(text, { recoverUnclosedAtEnd: true })).toEqual({ content: text, toolCalls: [] });
    expect(parse(text)).toEqual({ content: text, toolCalls: [] });
  });

  it.each([
    [{ n: '10', r: '1.50e3', b: 'True', o: '{"k": 1}', c: 'null', s: '42' }, '{"n":"10","r":"1.50e3","b":"True","o":"{\\"k\\": 1}","c":"null","s":"42"}'],
    [{ n: '  7  ' }, '{"n":"  7  "}'],
  ])('every value is a JSON string, never coerced: %j', (params, args) => {
    expect(parse(block('f', params)).toolCalls).toEqual([{ name: 'f', arguments: args }]);
  });
});

describe('§4 block body', () => {
  it('keeps surrounding prose and separates several blocks', () => {
    const text = `Checking.\n${block('a', { x: '1' })}\n${block('b', {})}\nDone.`;
    expect(parse(text)).toEqual({
      // The \n between the blocks is layout and dropped; the text after the last block is kept.
      content: 'Checking.\n\nDone.',
      toolCalls: [
        { name: 'a', arguments: '{"x":"1"}' },
        { name: 'b', arguments: '{}' },
      ],
    });
  });

  it('treats a function missing </function> at the end of the block as malformed', () => {
    const text = '<tool_call>\n<function=f>\n<parameter=a>\n1\n</parameter>\n</tool_call>';
    expect(parse(text)).toEqual({ content: text, toolCalls: [] });
  });

  it('treats a function missing </function> before the next <function= as malformed', () => {
    const text = '<tool_call><function=a><parameter=k>1</parameter><function=b></function></tool_call>';
    expect(parse(text)).toEqual({ content: text, toolCalls: [] });
  });

  it('runs a value with an omitted </parameter> on to a later one', () => {
    const text = '<tool_call><function=f><parameter=a>1<parameter=b>2</parameter></function></tool_call>';
    expect(parse(text).toolCalls).toEqual([{ name: 'f', arguments: '{"a":"1<parameter=b>2"}' }]);
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
      ['a space inside a tag', '<tool_call><function=f><parameter = a>1</parameter></function></tool_call>'],
      ['no </parameter> left for an open parameter', '<tool_call><function=f><parameter=a>1</function></tool_call>'],
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

  it('encodes strings by the spec encoding rule (TOOL_CALL_PARSER_V1 qwen3_coder@1 encoding)', () => {
    expect(parse(block('f', { city: 'São Paulo\tSP\u0001' })).toolCalls[0]!.arguments).toBe('{"city":"São Paulo\\tSP\\u0001"}');
  });

  it('treats a KEY repeated within one function as malformed', () => {
    const text = '<tool_call><function=f><parameter=a>1</parameter><parameter=b>2</parameter><parameter=a>3</parameter></function></tool_call>';
    expect(parse(text)).toEqual({ content: text, toolCalls: [] });
  });

  it('allows the same KEY in two different functions', () => {
    const text = '<tool_call><function=f><parameter=a>1</parameter></function><function=g><parameter=a>2</parameter></function></tool_call>';
    expect(parse(text).toolCalls).toEqual([
      { name: 'f', arguments: '{"a":"1"}' },
      { name: 'g', arguments: '{"a":"2"}' },
    ]);
  });

  it('keeps numerals, literals and JSON-looking text as strings (no schema is read)', () => {
    const text = block('search', { limit: '10', exact: 'true', cursor: 'null', filters: '{"lang": "en"}', tags: '["a"]' });
    expect(parse(text).toolCalls[0]!.arguments).toBe('{"limit":"10","exact":"true","cursor":"null","filters":"{\\"lang\\": \\"en\\"}","tags":"[\\"a\\"]"}');
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

  it('never emits a held-back partial start marker as content', () => {
    expect(run(['Hello <tool_', 'call>\n<function=f>\n</function>\n</tool_call>'])).toEqual([
      { kind: 'content', text: 'Hello ' },
      { kind: 'tool-call-provisional', call: { name: 'f', arguments: '{}' } },
    ]);
  });

  it('flushes an unclosed block cut inside its end marker as content, even with recover', () => {
    const text = '<tool_call><function=f></function></tool_c';
    expect(parse(text, { recoverUnclosedAtEnd: true })).toEqual({ content: text, toolCalls: [] });
    expect(run([...text], { recoverUnclosedAtEnd: true })).toEqual([{ kind: 'content', text }]);
  });
});

describe('review follow-ups', () => {
  const wrap = (v: string) => `<tool_call><function=f><parameter=s>${v}</parameter></function></tool_call>`;

  describe('a value holding markup (TOOL_CALL_PARSER_V1 qwen3_coder@1 VALUE)', () => {
    it('</function> and <function= inside a value are plain bytes', () => {
      for (const v of ['a</function>b', 'a<function=g>b']) {
        expect(parse(wrap(v))).toEqual({ content: '', toolCalls: [{ name: 'f', arguments: JSON.stringify({ s: v }) }] });
      }
    });

    it('<parameter= inside a value is plain bytes, not an extra parameter', () => {
      expect(parse(wrap('a<parameter=k>b'))).toEqual({ content: '', toolCalls: [{ name: 'f', arguments: '{"s":"a<parameter=k>b"}' }] });
    });

    it('</tool_call> closes the block there, which is then malformed: all content', () => {
      const input = wrap('a</tool_call>b');
      expect(parse(input)).toEqual({ content: input, toolCalls: [] });
    });
  });

  it('encodes a lone surrogate (unreachable from decoded output) as lower-case \\udxxx', () => {
    expect(parse(wrap('\ud83dx')).toolCalls[0]!.arguments).toBe('{"s":"\\ud83dx"}');
    expect(parse(wrap('\uDE00')).toolCalls[0]!.arguments).toBe('{"s":"\\ude00"}');
  });
});

describe('registration', () => {
  it('is built in as qwen3_coder@1, vector-verified: no allowUnverified needed', () => {
    expect(BUILTIN_TOOL_CALL_PARSERS.lookup({ name: 'qwen3_coder', version: 1 })).toEqual({ supported: true, parser: qwen3CoderParser });
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
