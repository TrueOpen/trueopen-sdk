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
  for (const e of [...frames.flatMap((f) => s.push(f)), ...s.finish()]) {
    if (e.kind === 'reasoning') reasoningContent += e.text;
    else remainder += e.text;
  }
  return { reasoningContent, remainder };
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
      reasoningContent: 'Let me check.',
      remainder: 'It is sunny.',
    });
  });

  it('keeps newlines inside the reasoning and the remainder', () => {
    expect(q.split('<think>\na\n\nb\n</think>\n\nx\n\ny\n')).toEqual({ reasoningContent: 'a\n\nb', remainder: 'x\n\ny\n' });
  });

  it('allows whitespace before the start marker, and nothing else (rule 6)', () => {
    expect(q.split('  \n<think>r</think>c')).toEqual({ reasoningContent: 'r', remainder: 'c' });
    expect(q.split('Sure. <think>r</think>c')).toEqual({ reasoningContent: '', remainder: 'Sure. <think>r</think>c' });
  });

  it('takes only the leading span: a later <think> is content', () => {
    expect(q.split('<think>r</think>c <think>not reasoning</think>')).toEqual({
      reasoningContent: 'r',
      remainder: 'c <think>not reasoning</think>',
    });
  });

  it('an unclosed span is all reasoning, with no remainder (rule 8)', () => {
    expect(q.split('<think>\ncut off by max tokens')).toEqual({ reasoningContent: 'cut off by max tokens', remainder: '' });
  });

  it('no marker leaves the output whole (rule 8)', () => {
    expect(q.split('Just an answer.')).toEqual({ reasoningContent: '', remainder: 'Just an answer.' });
    expect(q.split('')).toEqual({ reasoningContent: '', remainder: '' });
  });

  it('streaming gives the same split as split(), whatever the frame boundaries (rule 11)', () => {
    for (const text of [
      '<think>\nLet me check.\n</think>\n\nIt is sunny.',
      '<think>\na\n\nb\n</think>\n\nx\n\ny\n',
      '  \n<think>r</think>c',
      'Sure. <think>r</think>c',
      '<think>r</think>c <think>not reasoning</think>',
      '<think>\ncut off by max tokens',
      '<thin',
      'Just an answer.',
      `<think>\nI could call ${TOOL} but no.\n</think>\n\n${TOOL}`,
    ]) {
      for (const frames of everySplit(text)) expect(streamSplit(q, frames)).toEqual(q.split(text));
    }
  });
});

describe('the reasoning registry', () => {
  it('offers qwen3@1 only with allowUnverified, since no vectors exist yet', () => {
    expect(BUILTIN_REASONING_PARSERS.lookup({ name: 'qwen3', version: 1 })).toEqual({ supported: false, reason: 'parser-unverified' });
    expect(BUILTIN_REASONING_PARSERS.lookup({ name: 'qwen3', version: 1 }, { allowUnverified: true })).toMatchObject({ supported: true });
  });

  it('distinguishes no parser pinned from one this build lacks', () => {
    expect(BUILTIN_REASONING_PARSERS.lookup({ name: '', version: 0 })).toEqual({ supported: false, reason: 'parser-not-pinned' });
    expect(BUILTIN_REASONING_PARSERS.lookup({ name: 'deepseek_r1', version: 1 })).toEqual({ supported: false, reason: 'parser-unknown' });
    expect(BUILTIN_REASONING_PARSERS.lookup({ name: 'qwen3', version: 2 }, { allowUnverified: true })).toEqual({ supported: false, reason: 'parser-unknown' });
  });

  it('refuses version 0, duplicates and empty markers', () => {
    const p = (version: number) => createMarkerReasoningParser({ name: 'x', version }, { startMarker: '<a>', endMarker: '</a>' });
    expect(() => createReasoningRegistry([{ parser: p(0), conformance: 'unverified' }])).toThrow(/version/);
    expect(() => createReasoningRegistry([{ parser: p(1), conformance: 'unverified' }, { parser: p(1), conformance: 'unverified' }])).toThrow(/two/);
    expect(() => createMarkerReasoningParser({ name: 'x', version: 1 }, { startMarker: '', endMarker: '</a>' })).toThrow(/non-empty/);
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

  it('no reasoning found: the message carries no reasoningContent and parses the whole output', () => {
    const m = deriveAssistantMessage(TOOL, opts);
    expect('reasoningContent' in m).toBe(false);
    expect(m.toolCalls).toHaveLength(1);
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
