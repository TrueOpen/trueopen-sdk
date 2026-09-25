import { describe, expect, it } from 'vitest';
import { partialMarkerSuffix, pendingMarkerSuffix } from '../../src/toolcall/marker-scan';

describe('partialMarkerSuffix', () => {
  it('holds back a marker that has only half arrived', () => {
    expect(partialMarkerSuffix('weather is <tool_', ['<tool_call>'])).toBe(6);
  });

  it('holds back nothing when no suffix can begin the marker', () => {
    expect(partialMarkerSuffix('weather is fine', ['<tool_call>'])).toBe(0);
  });

  it('does not hold back a complete marker: the caller finds that with indexOf', () => {
    expect(partialMarkerSuffix('a<tool_call>', ['<tool_call>'])).toBe(0);
  });

  it('holds back the whole buffer when the buffer is itself a partial marker', () => {
    expect(partialMarkerSuffix('<', ['<tool_call>'])).toBe(1);
  });

  it('prefers the longest holdback across several markers', () => {
    // '[TOOL' is 5 characters of '[TOOL_CALLS]'; '[' alone is 1 of '[['.
    expect(partialMarkerSuffix('text [TOOL', ['[[', '[TOOL_CALLS]'])).toBe(5);
  });

  it('holds back nothing for an empty marker set or empty text', () => {
    expect(partialMarkerSuffix('anything', [])).toBe(0);
    expect(partialMarkerSuffix('', ['<tool_call>'])).toBe(0);
  });
});

describe('pendingMarkerSuffix', () => {
  it('holds back a complete marker, because more text may still follow it', () => {
    expect(pendingMarkerSuffix('done<|im_end|>', ['<|im_end|>'])).toBe(10);
  });

  it('holds back a partial marker just like partialMarkerSuffix', () => {
    expect(pendingMarkerSuffix('done<|im_', ['<|im_end|>'])).toBe(5);
  });

  it('holds back nothing when the tail cannot begin any marker', () => {
    expect(pendingMarkerSuffix('done.', ['<|im_end|>'])).toBe(0);
  });
});
