import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_ORDER_LIFETIME_BLOCKS_V1, validateOrderLifetime } from '../../src/order/order-lifetime';

interface Case { name: string; earliest_submit_height: string; order_expire_height: string; max_order_lifetime_blocks: string; allowed: boolean }
const fixture = JSON.parse(readFileSync('third_party/wire/testdata/v1/task/order_lifetime_v1.json', 'utf8')) as {
  schema: string; maximum_protocol_blocks: string; cases: Case[];
};

describe('validateOrderLifetime (wire order_lifetime_v1.json)', () => {
  it('pins the protocol maximum', () => {
    expect(fixture.schema).toBe('trueopen-order-lifetime-v1');
    expect(BigInt(fixture.maximum_protocol_blocks)).toBe(MAX_ORDER_LIFETIME_BLOCKS_V1);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const run = () => validateOrderLifetime(BigInt(c.earliest_submit_height), BigInt(c.order_expire_height), BigInt(c.max_order_lifetime_blocks));
    if (c.allowed) expect(run).not.toThrow();
    else expect(run).toThrow(expect.objectContaining({ code: 'SDK_LOCAL_ORDER_LIFETIME_INVALID' }));
  });
});
