import { describe, it, expect } from 'vitest';
import { HASH32_TEXT_RE, hash32Text, isHash32Text, strictHash32 } from '../../src/codec/hash32';
import { TrueOpenError } from '../../src/errors/errors';

/** ADR-0034: the one client-facing Hash32 spelling is 0x followed by 64 lowercase hex. */
describe('Hash32 text form', () => {
  const hex = 'bce966ae829f212a35982bcd85aaea77d8893539afa04f32ea540c46ff8323b0';
  const text = `0x${hex}`;
  const raw = Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));

  it('hash32Text writes 0x + 64 lowercase hex and refuses other lengths', () => {
    expect(hash32Text(raw)).toBe(text);
    expect(hash32Text(raw)).toHaveLength(66);
    expect(() => hash32Text(new Uint8Array(31))).toThrowError(TrueOpenError);
    expect(() => hash32Text(new Uint8Array(33))).toThrowError(TrueOpenError);
  });

  it('strictHash32 accepts 0x + 64 lowercase hex and decodes the 32 bytes after 0x', () => {
    expect(strictHash32('task_id', text)).toEqual(raw);
    expect(isHash32Text(text)).toBe(true);
    expect(HASH32_TEXT_RE.test(text)).toBe(true);
  });

  it.each([
    ['bare 64-hex', hex],
    ['uppercase hex after 0x', `0x${hex.toUpperCase()}`],
    ['mixed-case hex after 0x', `0x${hex.slice(0, 10).toUpperCase()}${hex.slice(10)}`],
    ['0X prefix', `0X${hex}`],
    ['too short', text.slice(0, -2)],
    ['too long', `${text}00`],
    ['empty', ''],
    ['non-hex', `0x${'g'.repeat(64)}`],
    ['surrounding whitespace', ` ${text}`],
  ])('strictHash32 rejects %s', (_name, value) => {
    expect(isHash32Text(value)).toBe(false);
    try {
      strictHash32('session_id', value);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TrueOpenError);
      expect((e as TrueOpenError).code).toBe('SDK_LOCAL_NOT_HASH32');
      expect((e as TrueOpenError).message).toMatch(/session_id must be 0x followed by 64 lowercase hex characters/);
    }
  });
});
