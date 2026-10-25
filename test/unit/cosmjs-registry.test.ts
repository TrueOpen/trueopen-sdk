import { describe, it, expect } from 'vitest';
import { taskRegistry } from '../../src/transport/cosmjs-registry';
import { TYPE_URL, encodeMsgCreateSession, encodeMsgCancelOrder, encodeMsgUpdateSessionKey } from '../../src/transport/task-msgs';

describe('taskRegistry', () => {
  it('registry.encode matches the hand-written encoder byte-for-byte (CreateSession)', () => {
    const reg = taskRegistry();
    const bytes = reg.encode({ typeUrl: TYPE_URL.createSession, value: { signer: 'trueopen1x' } });
    expect(bytes).toEqual(encodeMsgCreateSession({ signer: 'trueopen1x' }));
  });

  it('registry.encode matches (CancelOrder, includes uint64)', () => {
    const reg = taskRegistry();
    const value = {
      signer: 'trueopen1x',
      sessionId: '0x33530796a5c450a2c5264ec40d1eeabf0e581d3f84dc09b45c35ac8259f4706a',
      orderSequence: 7n,
    };
    const bytes = reg.encode({ typeUrl: TYPE_URL.cancelOrder, value });
    expect(bytes).toEqual(encodeMsgCancelOrder(value));
  });

  it('registry.encode matches (UpdateSessionKey, CLEAR and a createSession grant)', () => {
    const reg = taskRegistry();
    const sessionId = '0x33530796a5c450a2c5264ec40d1eeabf0e581d3f84dc09b45c35ac8259f4706a';
    const update = { signer: 'trueopen1x', sessionId, action: { clear: true as const } };
    expect(reg.encode({ typeUrl: TYPE_URL.updateSessionKey, value: update })).toEqual(encodeMsgUpdateSessionKey(update));
    const create = {
      signer: 'trueopen1x',
      sessionKey: { sessionKey: new Uint8Array(20).fill(7), expiryHeight: 9n, spendCap: '0' },
    };
    expect(reg.encode({ typeUrl: TYPE_URL.createSession, value: create })).toEqual(encodeMsgCreateSession(create));
  });

  it('still retains the default Cosmos types (MsgSend is encodable)', () => {
    const reg = taskRegistry();
    const bytes = reg.encode({
      typeUrl: '/cosmos.bank.v1beta1.MsgSend',
      value: { fromAddress: 'a', toAddress: 'b', amount: [{ denom: 'utrueopen', amount: '1' }] },
    });
    expect(bytes.length).toBeGreaterThan(0);
  });
});
