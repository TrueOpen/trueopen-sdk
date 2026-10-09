import { describe, expect, it } from 'vitest';
import {
  indexOfOutsideQuotes,
  partialMarkerSuffix,
  pendingMarkerSuffix,
  skipJsonString,
  unterminatedQuoteSuffix,
} from '../../src/toolcall/marker-scan';

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

describe('skipJsonString', () => {
  it('skips a complete string, returning the index just past the closing quote', () => {
    expect(skipJsonString('"abc" rest', 0)).toBe(5);
  });

  it('skips an escaped quote as part of the string, not as the closing quote', () => {
    // `"a\"b"` is the string `a"b`; the `\"` must not close it early.
    expect(skipJsonString('"a\\"b" rest', 0)).toBe(6);
  });

  it('treats the hex digits of a \\uXXXX escape as ordinary characters', () => {
    // `\u` is skipped as an escape; the four hex digits must not be mistaken for a quote.
    expect(skipJsonString('"a\\u0041" rest', 0)).toBe(9);
  });

  it('scans to the end of the input on an unterminated string', () => {
    expect(skipJsonString('"abc', 0)).toBe(4);
  });

  it('skips an empty string', () => {
    expect(skipJsonString('"" rest', 0)).toBe(2);
  });
});

describe('indexOfOutsideQuotes', () => {
  it('behaves like indexOf when there are no quotes', () => {
    expect(indexOfOutsideQuotes('abc<tc>def', '<tc>')).toBe(3);
  });

  it('does not find a marker inside double quotes', () => {
    expect(indexOfOutsideQuotes('"<tc>"', '<tc>')).toBe(-1);
    expect(indexOfOutsideQuotes('say "<tc>" done', '<tc>')).toBe(-1);
  });

  it('does not find a marker inside an escaped-quote string', () => {
    // The `</tc>` inside `"print(\"</tc>\")"` is a string literal, not the end marker.
    expect(indexOfOutsideQuotes('"print(\\"</tc>\\")"</tc>', '</tc>')).toBe(18);
  });

  it('finds a marker after a quoted span', () => {
    expect(indexOfOutsideQuotes('"a" <tc>', '<tc>')).toBe(4);
  });

  it('does not find a marker swallowed by an unterminated string', () => {
    expect(indexOfOutsideQuotes('"unterminated </tc>', '</tc>')).toBe(-1);
  });

  it('finds a marker before any quoted span', () => {
    expect(indexOfOutsideQuotes('<tc> "later"', '<tc>')).toBe(0);
  });

  it('skips several quoted spans and finds the marker after the last', () => {
    expect(indexOfOutsideQuotes('"a" "b" <tc>', '<tc>')).toBe(8);
  });

  it('honours fromIndex', () => {
    expect(indexOfOutsideQuotes('"x"<tc>"y"<tc>', '<tc>', 4)).toBe(10);
  });
});

describe('unterminatedQuoteSuffix', () => {
  it('returns 0 when quotes are balanced', () => {
    expect(unterminatedQuoteSuffix('"abc"')).toBe(0);
    expect(unterminatedQuoteSuffix('no quotes')).toBe(0);
    expect(unterminatedQuoteSuffix('"a" "b"')).toBe(0);
    expect(unterminatedQuoteSuffix('')).toBe(0);
  });

  it('returns the length of a trailing unclosed quote span', () => {
    expect(unterminatedQuoteSuffix('"abc')).toBe(4);
    expect(unterminatedQuoteSuffix('text "abc')).toBe(4);
  });

  it('measures from the last unclosed opener when earlier quotes closed', () => {
    expect(unterminatedQuoteSuffix('"a" "b')).toBe(2);
  });

  it('ignores an escaped quote when deciding closure', () => {
    // `"a\"` ends with an escaped quote, so the string is still open.
    expect(unterminatedQuoteSuffix('"a\\"')).toBe(4);
  });
});
