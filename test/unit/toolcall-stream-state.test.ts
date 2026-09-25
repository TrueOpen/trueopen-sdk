import { describe, expect, it } from 'vitest';
import { createMarkerStreamState } from '../../src/toolcall/stream-state';
import type { AssistantStreamEvent, DerivedToolCall } from '../../src/toolcall/types';
import { TrueOpenError } from '../../src/errors/errors';

/** A deliberately trivial stand-in: phase 1 ships no real parser, and the state machine's job is
 *  to decide *what text* reaches parseCall, not to interpret it. */
const parseCall = (inner: string): DerivedToolCall | undefined => {
  const at = inner.indexOf('|');
  if (at < 0) return undefined;
  return { name: inner.slice(0, at), arguments: inner.slice(at + 1) };
};

const make = () => createMarkerStreamState({ startMarker: '<tc>', endMarker: '</tc>', parseCall });

/** Feeds the frames in order and returns every event, including those from finish(). */
function run(frames: readonly string[]): AssistantStreamEvent[] {
  const state = make();
  const events: AssistantStreamEvent[] = [];
  for (const frame of frames) events.push(...state.push(frame));
  events.push(...state.finish());
  return events;
}

describe('createMarkerStreamState', () => {
  it('emits plain text as content', () => {
    expect(run(['hello world'])).toEqual([{ kind: 'content', text: 'hello world' }]);
  });

  it('turns a complete segment into a provisional call', () => {
    expect(run(['<tc>get_weather|{"city":"London"}</tc>'])).toEqual([
      { kind: 'tool-call-provisional', call: { name: 'get_weather', arguments: '{"city":"London"}' } },
    ]);
  });

  it('never emits a confirmed call: provisional is the only kind this layer can produce', () => {
    expect(run(['a<tc>x|1</tc>b']).map((e) => e.kind)).toEqual([
      'content',
      'tool-call-provisional',
      'content',
    ]);
  });

  it('matches a start marker split across frames', () => {
    expect(run(['weather is <t', 'c>x|1</tc>'])).toEqual([
      { kind: 'content', text: 'weather is ' },
      { kind: 'tool-call-provisional', call: { name: 'x', arguments: '1' } },
    ]);
  });

  it('matches an end marker split across frames', () => {
    expect(run(['<tc>x|1</t', 'c>'])).toEqual([
      { kind: 'tool-call-provisional', call: { name: 'x', arguments: '1' } },
    ]);
  });

  it('matches markers split character by character', () => {
    const frames = [...'<tc>get_weather|{"city":"London"}</tc>'];
    expect(run(frames)).toEqual([
      { kind: 'tool-call-provisional', call: { name: 'get_weather', arguments: '{"city":"London"}' } },
    ]);
  });

  it('does not emit a partial start marker as content before it is resolved', () => {
    const state = make();
    expect(state.push('abc<t')).toEqual([{ kind: 'content', text: 'abc' }]);
    expect(state.push('c>x|1</tc>')).toEqual([
      { kind: 'tool-call-provisional', call: { name: 'x', arguments: '1' } },
    ]);
  });

  it('releases a held-back partial marker as content once it cannot become one', () => {
    expect(run(['abc<t', 'ail'])).toEqual([
      { kind: 'content', text: 'abc' },
      { kind: 'content', text: '<tail' },
    ]);
  });

  it('returns to text after a closing marker, because the chat path has no stop conditions', () => {
    expect(run(['<tc>a|1</tc> and then <tc>b|2</tc> done'])).toEqual([
      { kind: 'tool-call-provisional', call: { name: 'a', arguments: '1' } },
      { kind: 'content', text: ' and then ' },
      { kind: 'tool-call-provisional', call: { name: 'b', arguments: '2' } },
      { kind: 'content', text: ' done' },
    ]);
  });

  it('flushes an unclosed segment as plain text at end of stream, marker included', () => {
    // What a generation truncated by max_output_tokens produces. A normal outcome, not an
    // error, and no character may be dropped.
    expect(run(['text <tc>get_weather|{"ci'])).toEqual([
      { kind: 'content', text: 'text ' },
      { kind: 'content', text: '<tc>get_weather|{"ci' },
    ]);
  });

  it('passes an unparseable segment through as text rather than raising', () => {
    // Design S6 row one: "the parse did not succeed" is what happens when calling an engine
    // directly too. It is not an error, and enabling tool calling must never lose data.
    expect(run(['<tc>not a call</tc>'])).toEqual([{ kind: 'content', text: '<tc>not a call</tc>' }]);
  });

  it('emits nothing for an empty stream', () => {
    expect(run([])).toEqual([]);
    expect(run([''])).toEqual([]);
  });

  it('rejects an empty marker, which would match everywhere', () => {
    expect(() => createMarkerStreamState({ startMarker: '', endMarker: '</tc>', parseCall })).toThrow(TrueOpenError);
    expect(() => createMarkerStreamState({ startMarker: '<tc>', endMarker: '', parseCall })).toThrow(TrueOpenError);
  });
});
