import { describe, it, expect } from 'vitest';
import { TrueOpenError } from '../../src/errors/errors';

describe('TrueOpenError', () => {
  it('carries family/code/message, is not retriable by default', () => {
    const e = new TrueOpenError('CHAIN_REJECT', 'CHAIN_REJECT_SEQUENCE', 'sequence mismatch');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(TrueOpenError);
    expect(e.name).toBe('TrueOpenError');
    expect(e.family).toBe('CHAIN_REJECT');
    expect(e.code).toBe('CHAIN_REJECT_SEQUENCE');
    expect(e.retriable).toBe(false);
  });
  it('can mark retriable and userAction', () => {
    const e = new TrueOpenError('NEXUS_INGRESS', 'NEXUS_INGRESS_RATE_LIMITED', 'slow down', {
      retriable: true,
      userAction: 'switch to a different Builder and resend',
    });
    expect(e.retriable).toBe(true);
    expect(e.userAction).toBe('switch to a different Builder and resend');
  });
});
