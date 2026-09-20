import { describe, it, expect } from 'vitest';
import { toJsonSafe, formatError } from '../../src/cli/output';
import { TrueOpenError } from '../../src/errors/errors';

describe('cli output', () => {
  it('toJsonSafe converts bigint / Uint8Array into serializable values', () => {
    const s = toJsonSafe({ a: 5n, b: new Uint8Array([0xde, 0xad]), c: 'x' });
    expect(JSON.parse(s)).toEqual({ a: '5', b: 'dead', c: 'x' });
  });
  it('formatError extracts TrueOpenError fields', () => {
    const e = new TrueOpenError('DATA', 'DATA_X', 'boom', { userAction: 'do y' });
    expect(formatError(e)).toMatchObject({ code: 'DATA_X', family: 'DATA', message: 'boom', userAction: 'do y' });
  });
  it('formatError handles a plain Error', () => {
    expect(formatError(new Error('plain'))).toEqual({ message: 'plain' });
  });
});
