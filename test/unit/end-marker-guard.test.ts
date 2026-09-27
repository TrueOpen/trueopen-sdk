import { describe, expect, it } from 'vitest';
import { assertNoEndMarkerCollision } from '../../src/toolcall/committed-text';
import { TrueOpenError } from '../../src/errors/errors';

describe('assertNoEndMarkerCollision', () => {
  it('throws when the end marker and EOS marker are identical', () => {
    expect(() => assertNoEndMarkerCollision(['</tc>'], ['</tc>'])).toThrow(TrueOpenError);
  });

  it('throws for the mirror overlap a one-sided check misses', () => {
    // `'</tc>'.endsWith('}</tc>')` is false, but `'}</tc>'.endsWith('</tc>')` is true: the
    // stripper would eat the closing `}` and lose the tool call as plain text.
    expect(() => assertNoEndMarkerCollision(['</tc>'], ['}</tc>'])).toThrow(TrueOpenError);
  });

  it('throws when the EOS marker is a suffix of the end marker', () => {
    expect(() => assertNoEndMarkerCollision(['</tool_calls>'], ['_calls>'])).toThrow(TrueOpenError);
  });

  it('does not throw for a non-overlapping pair', () => {
    expect(() => assertNoEndMarkerCollision(['</tc>'], ['<|endoftext|>'])).not.toThrow();
  });

  it('does not throw when either marker list is empty', () => {
    expect(() => assertNoEndMarkerCollision([], ['</tc>'])).not.toThrow();
    expect(() => assertNoEndMarkerCollision(['</tc>'], [])).not.toThrow();
  });

  it('reports the collision with a dedicated code and family', () => {
    try {
      assertNoEndMarkerCollision(['</tc>'], ['</tc>']);
      expect.unreachable('expected a collision error');
    } catch (error) {
      expect(error).toBeInstanceOf(TrueOpenError);
      const typed = error as TrueOpenError;
      expect(typed.family).toBe('SDK_LOCAL');
      expect(typed.code).toBe('TOOLCALL_END_MARKER_COLLISION');
    }
  });
});
