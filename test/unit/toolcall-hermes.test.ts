import { describe, expect, it } from 'vitest';
import { hermesParser } from '../../src/toolcall/parsers/hermes';
import type { AssistantStreamEvent } from '../../src/toolcall/types';

const call = (name: string, args: string): string =>
  `<tool_call>{"name":"${name}","arguments":${args}}</tool_call>`;

/** Feeds the frames in order through the streaming state and returns every event. */
function run(frames: readonly string[]): AssistantStreamEvent[] {
  const state = hermesParser.createStreamState();
  const events: AssistantStreamEvent[] = [];
  for (const frame of frames) events.push(...state.push(frame));
  events.push(...state.finish());
  return events;
}

describe('hermesParser.parseComplete', () => {
  it('extracts a single call with no surrounding text', () => {
    expect(hermesParser.parseComplete(call('get_weather', '{"city":"London"}'))).toEqual({
      role: 'assistant',
      content: '',
      toolCalls: [{ name: 'get_weather', arguments: '{"city":"London"}' }],
    });
  });

  it('keeps surrounding prose and separates multiple calls', () => {
    const text = `Let me check. ${call('get_weather', '{"city":"London"}')} Done. ${call('add', '{"x":1,"y":2}')}`;
    expect(hermesParser.parseComplete(text)).toEqual({
      role: 'assistant',
      content: 'Let me check.  Done. ',
      toolCalls: [
        { name: 'get_weather', arguments: '{"city":"London"}' },
        { name: 'add', arguments: '{"x":1,"y":2}' },
      ],
    });
  });

  it('preserves the argument bytes exactly, including whitespace and key order', () => {
    // The model wrote the arguments with spaces and a key order of its choosing. Re-serializing
    // through JSON.parse/stringify would collapse the spaces and reorder keys, changing the bytes
    // the cross-language vectors pin.
    const inner = '{"name":"get_weather","arguments": { "unit": "f", "city": "London" }}';
    const parsed = hermesParser.parseComplete(`<tool_call>${inner}</tool_call>`);
    expect(parsed.toolCalls[0]!.arguments).toBe('{ "unit": "f", "city": "London" }');
  });

  it('accepts newline after the start marker', () => {
    const text = '<tool_call>\n{"name":"get_weather","arguments":{"city":"London"}}\n</tool_call>';
    expect(hermesParser.parseComplete(text).toolCalls).toEqual([
      { name: 'get_weather', arguments: '{"city":"London"}' },
    ]);
  });

  it('handles arguments appearing before name', () => {
    const inner = '{"arguments":{"city":"London"},"name":"get_weather"}';
    expect(hermesParser.parseComplete(`<tool_call>${inner}</tool_call>`).toolCalls).toEqual([
      { name: 'get_weather', arguments: '{"city":"London"}' },
    ]);
  });

  it('handles an escaped quote inside an argument string', () => {
    const inner = '{"name":"echo","arguments":{"msg":"say \\"hi\\""}}';
    expect(hermesParser.parseComplete(`<tool_call>${inner}</tool_call>`).toolCalls).toEqual([
      { name: 'echo', arguments: '{"msg":"say \\"hi\\""}' },
    ]);
  });

  it('extracts array arguments verbatim', () => {
    expect(
      hermesParser.parseComplete('<tool_call>{"name":"f","arguments":[1,2,3]}</tool_call>').toolCalls,
    ).toEqual([{ name: 'f', arguments: '[1,2,3]' }]);
  });

  it('extracts scalar arguments (number, string, boolean, null) verbatim', () => {
    expect(hermesParser.parseComplete('<tool_call>{"name":"f","arguments":42}</tool_call>').toolCalls[0]!.arguments).toBe('42');
    expect(hermesParser.parseComplete('<tool_call>{"name":"f","arguments":"hi"}</tool_call>').toolCalls[0]!.arguments).toBe('"hi"');
    expect(hermesParser.parseComplete('<tool_call>{"name":"f","arguments":true}</tool_call>').toolCalls[0]!.arguments).toBe('true');
    expect(hermesParser.parseComplete('<tool_call>{"name":"f","arguments":null}</tool_call>').toolCalls[0]!.arguments).toBe('null');
  });

  it('extracts deeply nested arguments verbatim', () => {
    const args = '{"a":{"b":[1,{"c":2}]}}';
    expect(
      hermesParser.parseComplete(`<tool_call>{"name":"f","arguments":${args}}</tool_call>`).toolCalls[0]!.arguments,
    ).toBe(args);
  });

  it('ignores extra top-level keys beyond name and arguments', () => {
    expect(
      hermesParser.parseComplete('<tool_call>{"name":"f","arguments":{"x":1},"thought":"why"}</tool_call>').toolCalls,
    ).toEqual([{ name: 'f', arguments: '{"x":1}' }]);
  });

  it('does not close early on a literal end marker inside an argument string', () => {
    // Design §5.3: a marker inside a quoted span is content, not control syntax.
    const text = '<tool_call>{"name":"run_code","arguments":{"code":"print(\\"</tool_call>\\")"}}</tool_call>';
    expect(hermesParser.parseComplete(text)).toEqual({
      role: 'assistant',
      content: '',
      toolCalls: [{ name: 'run_code', arguments: '{"code":"print(\\"</tool_call>\\")"}' }],
    });
  });

  it('does not treat a start marker quoted in prose as a call', () => {
    const text = 'He wrote "<tool_call>" in his explanation.';
    expect(hermesParser.parseComplete(text)).toEqual({
      role: 'assistant',
      content: 'He wrote "<tool_call>" in his explanation.',
      toolCalls: [],
    });
  });

  it('recovers a name-only call as empty arguments', () => {
    expect(hermesParser.parseComplete('<tool_call>{"name":"get_weather"}</tool_call>').toolCalls).toEqual([
      { name: 'get_weather', arguments: '{}' },
    ]);
  });

  it('passes invalid JSON through as text rather than raising', () => {
    // Design S6 row one: parse failure is ordinary text, not an error.
    expect(hermesParser.parseComplete('<tool_call>not json</tool_call>')).toEqual({
      role: 'assistant',
      content: '<tool_call>not json</tool_call>',
      toolCalls: [],
    });
  });

  it('passes an object without a string name through as text', () => {
    expect(hermesParser.parseComplete('<tool_call>{"arguments":{"city":"London"}}</tool_call>')).toEqual({
      role: 'assistant',
      content: '<tool_call>{"arguments":{"city":"London"}}</tool_call>',
      toolCalls: [],
    });
  });

  it('passes a non-object inner through as text', () => {
    expect(hermesParser.parseComplete('<tool_call>[1,2]</tool_call>')).toEqual({
      role: 'assistant',
      content: '<tool_call>[1,2]</tool_call>',
      toolCalls: [],
    });
    expect(hermesParser.parseComplete('<tool_call>42</tool_call>')).toEqual({
      role: 'assistant',
      content: '<tool_call>42</tool_call>',
      toolCalls: [],
    });
  });

  it('tolerates whitespace around the inner JSON', () => {
    expect(
      hermesParser.parseComplete('<tool_call>  {"name":"f","arguments":{"x":1}}  </tool_call>').toolCalls,
    ).toEqual([{ name: 'f', arguments: '{"x":1}' }]);
  });

  it('does not mistake a comma or brace inside an argument string for structure', () => {
    const args = '{"s":"a,b}c"}';
    expect(
      hermesParser.parseComplete(`<tool_call>{"name":"f","arguments":${args}}</tool_call>`).toolCalls[0]!.arguments,
    ).toBe(args);
  });

  it('flushes an unclosed segment as plain text, marker included', () => {
    // A generation truncated by max_output_tokens produces exactly this. Normal, not an error,
    // and no character may be dropped (design S7 requirement 2).
    expect(hermesParser.parseComplete('text <tool_call>{"name":"get_w')).toEqual({
      role: 'assistant',
      content: 'text <tool_call>{"name":"get_w',
      toolCalls: [],
    });
  });
});

describe('hermesParser.createStreamState', () => {
  it('matches a start marker split across frames', () => {
    expect(run(['weather is <tool_', 'call>{"name":"x","arguments":{}}</tool_call>'])).toEqual([
      { kind: 'content', text: 'weather is ' },
      { kind: 'tool-call-provisional', call: { name: 'x', arguments: '{}' } },
    ]);
  });

  it('matches markers split character by character', () => {
    const text = call('get_weather', '{"city":"London"}');
    expect(run([...text])).toEqual([
      { kind: 'tool-call-provisional', call: { name: 'get_weather', arguments: '{"city":"London"}' } },
    ]);
  });

  it('returns to text after a closing marker', () => {
    expect(run([call('a', '{}'), ' and then ', call('b', '{}'), ' done'])).toEqual([
      { kind: 'tool-call-provisional', call: { name: 'a', arguments: '{}' } },
      { kind: 'content', text: ' and then ' },
      { kind: 'tool-call-provisional', call: { name: 'b', arguments: '{}' } },
      { kind: 'content', text: ' done' },
    ]);
  });

  it('streams a call whose argument contains a literal end marker, split across frames', () => {
    // The split lands inside the escaped-quote region, so the end marker arrives while the
    // argument string is still open. The scan must not treat it as the real end marker.
    const part1 = '<tool_call>{"name":"run_code","arguments":{"code":"print(\\"';
    const part2 = '</tool_call>\\")"}}</tool_call>';
    expect(run([part1, part2])).toEqual([
      {
        kind: 'tool-call-provisional',
        call: { name: 'run_code', arguments: '{"code":"print(\\"</tool_call>\\")"}' },
      },
    ]);
  });

  it('agrees with parseComplete on the same text, whatever the frame split', () => {
    const text = `before ${call('get_weather', '{"city":"London","unit":"f"}')} after`;
    const complete = hermesParser.parseComplete(text);

    // Byte-by-byte, chunk-by-chunk, and on marker boundaries must all yield the same result.
    for (const frames of [[text], [...text], [text.slice(0, 10), text.slice(10)], [text.slice(0, 33), text.slice(33)]]) {
      const events = run(frames);
      let content = '';
      const toolCalls = events.flatMap((e) => (e.kind === 'content' ? [] : [e.call]));
      for (const e of events) if (e.kind === 'content') content += e.text;
      expect({ role: 'assistant' as const, content, toolCalls }).toEqual(complete);
    }
  });

  it('agrees with parseComplete under every possible frame split', () => {
    // A text with quotes, an escaped quote, nesting and trailing prose, so that splitting at
    // every position exercises marker-boundary, quote-boundary and escape-boundary holdback.
    // This is the core buffer-caching invariant: the Worker chooses frame boundaries, so no
    // split may change the result.
    const text = 'before <tool_call>{"name":"f","arguments":{"s":"a\\"b,c"}}</tool_call> after';
    const complete = hermesParser.parseComplete(text);
    for (let cut = 1; cut < text.length; cut += 1) {
      const events = run([text.slice(0, cut), text.slice(cut)]);
      let content = '';
      const toolCalls = events.flatMap((e) => (e.kind === 'content' ? [] : [e.call]));
      for (const e of events) if (e.kind === 'content') content += e.text;
      expect({ role: 'assistant' as const, content, toolCalls }).toEqual(complete);
    }
  });
});
