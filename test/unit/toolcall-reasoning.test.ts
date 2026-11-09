import { describe, it, expect } from 'vitest';
import {
  createMarkerReasoningParser,
  createReasoningRegistry,
  qwen3ReasoningParser,
  BUILTIN_REASONING_PARSERS,
} from '../../src/toolcall/reasoning';
import type { ReasoningParser, ReasoningSplit } from '../../src/toolcall/reasoning';
import { deriveAssistantMessage, deriveAssistantStream } from '../../src/toolcall/assistant-view';
import { hermesParser } from '../../src/toolcall/parsers/hermes';
import type { AssistantStreamEvent } from '../../src/toolcall/types';

const q = qwen3ReasoningParser;

/** Runs the streaming split over `frames` and joins it back into the same shape as `split`. */
function streamSplit(p: ReasoningParser, frames: readonly string[]): ReasoningSplit {
  const s = p.createStreamState();
  let reasoningContent = '';
  let remainder = '';
  // A reasoning event, even an empty one, means a span is present (REASONING_PARSER_V1).
  let hasReasoning = false;
  for (const e of [...frames.flatMap((f) => s.push(f)), ...s.finish()]) {
    if (e.kind === 'reasoning') {
      reasoningContent += e.text;
      hasReasoning = true;
    } else remainder += e.text;
  }
  return { reasoningContent, hasReasoning, remainder };
}

/** Every two-way split, so a marker or a layout newline straddling a frame is exercised. */
function everySplit(text: string): string[][] {
  const out: string[][] = [[text], [...text]];
  for (let cut = 1; cut < text.length; cut += 1) out.push([text.slice(0, cut), text.slice(cut)]);
  return out;
}

const TOOL = '<tool_call>\n{"name": "get_weather", "arguments": {"city": "London"}}\n</tool_call>';

describe('qwen3 reasoning split (Manifest S7.3)', () => {
  it('separates the leading <think> span, dropping the template layout around the markers (rule 6)', () => {
    expect(q.split('<think>\nLet me check.\n</think>\n\nIt is sunny.')).toEqual({
      hasReasoning: true,
      reasoningContent: 'Let me check.',
      remainder: 'It is sunny.',
    });
  });

  it('keeps newlines inside the reasoning and the remainder', () => {
    expect(q.split('<think>\na\n\nb\n</think>\n\nx\n\ny\n')).toEqual({ hasReasoning: true, reasoningContent: 'a\n\nb', remainder: 'x\n\ny\n' });
  });

  it('declares an implicit start marker (rule 6)', () => {
    expect(q.startMarkerClass).toBe('implicit');
  });

  it('absorbs one explicit <think> after leading whitespace (rule 6, implicit)', () => {
    expect(q.split('  \n<think>r</think>c')).toEqual({ hasReasoning: true, reasoningContent: 'r', remainder: 'c' });
    // Only one is absorbed: a second <think> is reasoning text.
    expect(q.split('<think><think>r</think>c')).toEqual({ hasReasoning: true, reasoningContent: '<think>r', remainder: 'c' });
  });

  it('without <think> the output still opens in reasoning, up to the first </think> (rule 6, implicit)', () => {
    expect(q.split('Let me check.\n</think>\n\nIt is sunny.')).toEqual({ hasReasoning: true, reasoningContent: 'Let me check.', remainder: 'It is sunny.' });
    // Text before a mid-output <think> is reasoning too; the <think> is not a marker there.
    expect(q.split('Sure. <think>r</think>c')).toEqual({ hasReasoning: true, reasoningContent: 'Sure. <think>r', remainder: 'c' });
    expect(q.split('a</think>b</think>c')).toEqual({ hasReasoning: true, reasoningContent: 'a', remainder: 'b</think>c' });
    expect(q.split('</think>answer')).toEqual({ hasReasoning: true, reasoningContent: '', remainder: 'answer' });
  });

  it('takes only the leading span: a later <think> is content', () => {
    expect(q.split('<think>r</think>c <think>not reasoning</think>')).toEqual({
      hasReasoning: true,
      reasoningContent: 'r',
      remainder: 'c <think>not reasoning</think>',
    });
  });

  it('an unclosed span is all reasoning, with no remainder (rule 8)', () => {
    expect(q.split('<think>\ncut off by max tokens')).toEqual({ hasReasoning: true, reasoningContent: 'cut off by max tokens', remainder: '' });
  });

  it('no closing marker, no marker at all included, makes the whole output reasoning (rule 8, implicit)', () => {
    expect(q.split('Just an answer.')).toEqual({ hasReasoning: true, reasoningContent: 'Just an answer.', remainder: '' });
    expect(q.split('  <thin')).toEqual({ hasReasoning: true, reasoningContent: '  <thin', remainder: '' });
    expect(q.split('')).toEqual({ hasReasoning: true, reasoningContent: '', remainder: '' });
  });

  // REASONING_PARSER_V1 qwen3@1 worked examples (wire #46 @ 5760ab7); each row is a shared vector.
  const WORKED_EXAMPLES: readonly [string, string, string][] = [
    ['<think>\nabc\n</think>\n\nok', 'abc', 'ok'],
    ['abc\n</think>\n\nok', 'abc', 'ok'],
    ['<think>\n\n</think>\n\nok', '', 'ok'],
    ['abc', 'abc', ''],
    ['<think>\nabc', 'abc', ''],
    ['abc<think>x</think>ok', 'abc<think>x', 'ok'],
    ['<think><think>abc</think>ok', '<think>abc', 'ok'],
    ['  <think>abc</think>ok', 'abc', 'ok'],
    ['  abc</think>ok', '  abc', 'ok'],
    ['\n\nabc</think>ok', 'abc', 'ok'],
    ['\uFEFF<think>abc</think>ok', '\uFEFF<think>abc', 'ok'],
    ['<think>\r\nabc\r\n</think>\r\nok', '\r\nabc\r', '\r\nok'],
    ['<think>a</think>b</think>c', 'a', 'b</think>c'],
  ];

  it('matches the wire worked examples, whole and streamed', () => {
    for (const [text, reasoningContent, remainder] of WORKED_EXAMPLES) {
      expect(q.split(text)).toEqual({ hasReasoning: true, reasoningContent, remainder });
      for (const frames of everySplit(text)) expect(streamSplit(q, frames)).toEqual({ hasReasoning: true, reasoningContent, remainder });
    }
  });

  it('leading whitespace is ASCII SP, HT, LF and CR only', () => {
    expect(q.split('\t\r <think>r</think>c')).toEqual({ hasReasoning: true, reasoningContent: 'r', remainder: 'c' });
    for (const space of ['\uFEFF', '\u00A0', '\u2028', '\u3000']) {
      expect(q.split(`${space}<think>r</think>c`)).toEqual({ hasReasoning: true, reasoningContent: `${space}<think>r`, remainder: 'c' });
    }
  });

  it('streaming gives the same split as split(), whatever the frame boundaries (rule 11)', () => {
    for (const text of [
      '<think>\nLet me check.\n</think>\n\nIt is sunny.',
      'Let me check.\n</think>\n\nIt is sunny.',
      '<think>\na\n\nb\n</think>\n\nx\n\ny\n',
      '  \n<think>r</think>c',
      '  \nr</think>c',
      '<think><think>r</think>c',
      'Sure. <think>r</think>c',
      '<think>r</think>c <think>not reasoning</think>',
      '<think>\ncut off by max tokens',
      '<thin',
      '  <thi',
      '\n\n',
      '</think>answer',
      'Just an answer.',
      `<think>\nI could call ${TOOL} but no.\n</think>\n\n${TOOL}`,
      `I could call ${TOOL} but no.\n</think>\n\n${TOOL}`,
    ]) {
      for (const frames of everySplit(text)) expect(streamSplit(q, frames)).toEqual(q.split(text));
    }
  });
});

describe('an explicit start marker parser (Manifest S7.3 rules 6 and 8)', () => {
  const e = createMarkerReasoningParser(
    { name: 'explicit_think', version: 1 },
    { startMarker: '<think>', endMarker: '</think>', startMarkerClass: 'explicit', trimNewlines: true },
  );

  it('allows whitespace before the start marker, and nothing else', () => {
    expect(e.startMarkerClass).toBe('explicit');
    expect(e.split('  \n<think>r</think>c')).toEqual({ hasReasoning: true, reasoningContent: 'r', remainder: 'c' });
    expect(e.split('Sure. <think>r</think>c')).toEqual({ hasReasoning: false, reasoningContent: '', remainder: 'Sure. <think>r</think>c' });
    expect(e.split('\uFEFF<think>r</think>c')).toEqual({ hasReasoning: false, reasoningContent: '', remainder: '\uFEFF<think>r</think>c' });
  });

  it('no marker leaves the output whole; unclosed is all reasoning', () => {
    expect(e.split('Just an answer.')).toEqual({ hasReasoning: false, reasoningContent: '', remainder: 'Just an answer.' });
    expect(e.split('a</think>b')).toEqual({ hasReasoning: false, reasoningContent: '', remainder: 'a</think>b' });
    expect(e.split('<think>\ncut off')).toEqual({ hasReasoning: true, reasoningContent: 'cut off', remainder: '' });
  });

  it('streaming agrees with split()', () => {
    for (const text of ['  \n<think>r</think>c', 'Sure. <think>r</think>c', 'Just an answer.', '<thin', '<think>\ncut off', 'a</think>b']) {
      for (const frames of everySplit(text)) expect(streamSplit(e, frames)).toEqual(e.split(text));
    }
  });
});

describe('the reasoning registry', () => {
  it('offers qwen3@1 without allowUnverified: it is vector-verified', () => {
    expect(BUILTIN_REASONING_PARSERS.lookup({ name: 'qwen3', version: 1 })).toEqual({ supported: true, parser: q });
    expect(BUILTIN_REASONING_PARSERS.lookup({ name: 'qwen3', version: 1 }, { allowUnverified: true })).toMatchObject({ supported: true });
  });

  it('still offers an unverified parser only with allowUnverified', () => {
    const custom = createMarkerReasoningParser({ name: 'custom', version: 1 }, { startMarker: '<r>', endMarker: '</r>', startMarkerClass: 'explicit' });
    const registry = createReasoningRegistry([{ parser: custom, conformance: 'unverified' }]);
    expect(registry.lookup({ name: 'custom', version: 1 })).toEqual({ supported: false, reason: 'parser-unverified' });
    expect(registry.lookup({ name: 'custom', version: 1 }, { allowUnverified: true })).toEqual({ supported: true, parser: custom });
  });

  it('distinguishes no parser pinned from one this build lacks', () => {
    expect(BUILTIN_REASONING_PARSERS.lookup({ name: '', version: 0 })).toEqual({ supported: false, reason: 'parser-not-pinned' });
    expect(BUILTIN_REASONING_PARSERS.lookup({ name: 'deepseek_r1', version: 1 })).toEqual({ supported: false, reason: 'parser-unknown' });
    expect(BUILTIN_REASONING_PARSERS.lookup({ name: 'qwen3', version: 2 }, { allowUnverified: true })).toEqual({ supported: false, reason: 'parser-unknown' });
  });

  it('refuses version 0, duplicates and empty markers', () => {
    const p = (version: number) => createMarkerReasoningParser({ name: 'x', version }, { startMarker: '<a>', endMarker: '</a>', startMarkerClass: 'explicit' });
    expect(() => createReasoningRegistry([{ parser: p(0), conformance: 'unverified' }])).toThrow(/version/);
    expect(() => createReasoningRegistry([{ parser: p(1), conformance: 'unverified' }, { parser: p(1), conformance: 'unverified' }])).toThrow(/two/);
    expect(() => createMarkerReasoningParser({ name: 'x', version: 1 }, { startMarker: '', endMarker: '</a>', startMarkerClass: 'explicit' })).toThrow(/non-empty/);
  });
});

describe('reasoning before tool calls (S7.3 rules 5 and 7)', () => {
  const opts = { parser: hermesParser, reasoning: q };
  // The model drafts a call while reasoning, then makes a different one.
  const OUTPUT =
    '<think>\nI could run <tool_call>\n{"name": "delete_file", "arguments": {"path": "/"}}\n</tool_call> but that is wrong.\n</think>\n\n' +
    TOOL;

  it('a tool-call marker inside the reasoning is reasoning text, never a call', () => {
    const m = deriveAssistantMessage(OUTPUT, opts);
    expect(m.toolCalls).toEqual([{ name: 'get_weather', arguments: '{"city": "London"}' }]);
    expect(m.reasoningContent).toContain('delete_file');
  });

  it('without a reasoning parser the drafted call would have been surfaced', () => {
    const names = deriveAssistantMessage(OUTPUT, { parser: hermesParser }).toolCalls.map((c) => c.name);
    expect(names).toEqual(['delete_file', 'get_weather']);
  });

  it('an unclosed reasoning span runs no tool parsing (rule 8)', () => {
    const m = deriveAssistantMessage(`<think>\nmaybe ${TOOL}`, opts);
    expect(m.toolCalls).toEqual([]);
    expect(m.content).toBe('');
  });

  it('no closing marker: the whole output is reasoning and no call is parsed (rule 8, implicit)', () => {
    const m = deriveAssistantMessage(TOOL, opts);
    expect(m.reasoningContent).toBe(TOOL);
    expect(m.toolCalls).toEqual([]);
    expect(m.content).toBe('');
  });

  it('an empty reasoning span: reasoningContent is present and empty, and the remainder is parsed', () => {
    // REASONING_PARSER_V1 qwen3@1: an empty span is reasoning_content "", not absent.
    for (const text of [`</think>\n\n${TOOL}`, `<think>\n\n</think>\n\n${TOOL}`]) {
      const m = deriveAssistantMessage(text, opts);
      expect(m.reasoningContent).toBe('');
      expect(m.toolCalls).toHaveLength(1);
    }
  });

  it('an empty reasoning span is one empty reasoning event in the stream', async () => {
    async function* src() {
      yield { kind: 'chunk' as const, text: '<think>\n\n</think>\n\nok' };
      yield { kind: 'fin' as const };
    }
    const events: AssistantStreamEvent[] = [];
    for await (const e of deriveAssistantStream(src(), opts)) events.push(e);
    expect(events).toEqual([{ kind: 'reasoning', text: '' }, { kind: 'content', text: 'ok' }]);
  });

  it('a parser without hasReasoning in its split still works: a non-empty span counts as present', () => {
    const legacy: ReasoningParser = { ...q, split: (text) => ({ reasoningContent: q.split(text).reasoningContent, remainder: q.split(text).remainder }) };
    expect(deriveAssistantMessage(`<think>r</think>${TOOL}`, { parser: hermesParser, reasoning: legacy }).reasoningContent).toBe('r');
    expect('reasoningContent' in deriveAssistantMessage(`</think>${TOOL}`, { parser: hermesParser, reasoning: legacy })).toBe(false);
  });

  it('streaming emits reasoning first and agrees with the full parse, whatever the frame split', async () => {
    const full = deriveAssistantMessage(OUTPUT, opts);
    for (const frames of everySplit(OUTPUT).filter((_, i) => i % 7 === 0)) {
      async function* src() {
        for (const text of frames) yield { kind: 'chunk' as const, text };
        yield { kind: 'fin' as const };
      }
      const events: AssistantStreamEvent[] = [];
      for await (const e of deriveAssistantStream(src(), opts)) events.push(e);
      const kinds = events.map((e) => e.kind);
      // All reasoning precedes everything else.
      expect(kinds.lastIndexOf('reasoning')).toBeLessThan(kinds.findIndex((k) => k !== 'reasoning'));
      expect(events.flatMap((e) => (e.kind === 'reasoning' ? [e.text] : [])).join('')).toBe(full.reasoningContent);
      expect(events.flatMap((e) => (e.kind === 'tool-call-provisional' ? [e.call] : []))).toEqual(full.toolCalls);
      expect(events.flatMap((e) => (e.kind === 'content' ? [e.text] : [])).join('')).toBe(full.content);
    }
  });
});
