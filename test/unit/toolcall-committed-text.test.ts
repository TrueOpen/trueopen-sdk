import { describe, expect, it } from 'vitest';
import { TrailingEosStripper, stripTrailingEos } from '../../src/toolcall/committed-text';

const EOS = ['<|im_end|>'];

describe('stripTrailingEos', () => {
  it('removes a trailing marker', () => {
    expect(stripTrailingEos('sunny<|im_end|>', EOS)).toBe('sunny');
  });

  it('leaves text that does not end with one alone', () => {
    expect(stripTrailingEos('sunny', EOS)).toBe('sunny');
  });

  it('does not touch a marker that is not at the end', () => {
    expect(stripTrailingEos('a<|im_end|>b', EOS)).toBe('a<|im_end|>b');
  });

  it('removes only one marker, so a doubled EOS keeps the inner one visible', () => {
    expect(stripTrailingEos('a<|im_end|><|im_end|>', EOS)).toBe('a<|im_end|>');
  });

  it('removes the longest matching marker regardless of the order given', () => {
    const markers = ['end|>', '<|im_end|>'];
    expect(stripTrailingEos('a<|im_end|>', markers)).toBe('a');
    expect(stripTrailingEos('a<|im_end|>', [...markers].reverse())).toBe('a');
  });

  it('strips nothing when no markers are configured', () => {
    expect(stripTrailingEos('sunny<|im_end|>', [])).toBe('sunny<|im_end|>');
  });
});

describe('TrailingEosStripper', () => {
  it('holds back an EOS that arrives in its own frame until the stream ends', () => {
    const s = new TrailingEosStripper(EOS);
    expect(s.push('sunny')).toBe('sunny');
    expect(s.push('<|im_end|>')).toBe('');
    expect(s.finish()).toBe('');
  });

  it('holds back an EOS split across two frames', () => {
    const s = new TrailingEosStripper(EOS);
    expect(s.push('sunny<|im_')).toBe('sunny');
    expect(s.push('end|>')).toBe('');
    expect(s.finish()).toBe('');
  });

  it('releases a held-back tail that turns out not to be an EOS', () => {
    const s = new TrailingEosStripper(EOS);
    expect(s.push('sunny<|im_')).toBe('sunny');
    expect(s.push('possible')).toBe('<|im_possible');
    expect(s.finish()).toBe('');
  });

  it('releases a mid-text EOS as soon as text follows it', () => {
    const s = new TrailingEosStripper(EOS);
    expect(s.push('a<|im_end|>')).toBe('a');
    expect(s.push('b')).toBe('<|im_end|>b');
    expect(s.finish()).toBe('');
  });

  it('passes everything straight through when no markers are configured', () => {
    const s = new TrailingEosStripper([]);
    expect(s.push('sunny<|im_end|>')).toBe('sunny<|im_end|>');
    expect(s.finish()).toBe('');
  });

  it('concatenating push and finish reproduces the input minus one trailing marker', () => {
    const s = new TrailingEosStripper(EOS);
    const out = ['The ', 'weather', ' is sunny', '<|im_', 'end|>'].map((f) => s.push(f)).join('') + s.finish();
    expect(out).toBe('The weather is sunny');
  });
});
