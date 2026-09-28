import { describe, it, expect } from 'vitest';
import type { EncodeObject } from '@cosmjs/proto-signing';
import type { IndexedTx, StdFee } from '@cosmjs/stargate';
import { CosmjsChainWriter } from '../../src/transport/cosmjs-chain-writer';
import type { TxBroadcaster } from '../../src/transport/cosmjs-chain-writer';
import { ProtoWriter } from '../../src/codec/protobuf';
import { TYPE_URL } from '../../src/transport/task-msgs';
import { TrueOpenError } from '../../src/errors/errors';
import { fromHex } from '../../src/util/bytes';

const SESSION_HEX = '33530796a5c450a2c5264ec40d1eeabf0e581d3f84dc09b45c35ac8259f4706a';
const TASK_HEX = '0c57743effab15ce41ad3f75e0b190774e544c2ce20f1dd701298f89cfc83e35';

function indexedTx(typeUrl: string, value: Uint8Array, code = 0): IndexedTx {
  return {
    code, height: 1, txIndex: 0, hash: 'H', events: [], rawLog: '',
    tx: new Uint8Array(), gasUsed: 1n, gasWanted: 1n, msgResponses: [{ typeUrl, value }],
  } as unknown as IndexedTx;
}

/**
 * Counts broadcasts separately from lookups, because the whole point of the split is that
 * the first is called once and the second may be called many times.
 */
class FakeBroadcaster implements TxBroadcaster {
  last?: { signer: string; messages: readonly EncodeObject[] };
  broadcasts = 0;
  lookups = 0;
  /** Lookups that return null before the tx is "included"; then `resp` is returned. */
  constructor(private readonly resp: IndexedTx, private readonly pendingLookups = 0, private readonly lookupFailures = 0) {}
  async signAndBroadcastSync(signer: string, messages: readonly EncodeObject[]): Promise<string> {
    this.broadcasts += 1;
    this.last = { signer, messages };
    return 'TXHASH';
  }
  async getTx(): Promise<IndexedTx | null> {
    this.lookups += 1;
    if (this.lookups <= this.lookupFailures) throw new Error('socket hang up');
    if (this.lookups <= this.lookupFailures + this.pendingLookups) return null;
    return this.resp;
  }
}

/** Nothing in these tests should spend real time asleep. */
const instant = { attempts: 30, intervalMs: 0, sleep: async () => {} };

const fee: StdFee = { amount: [{ denom: 'utrueopen', amount: '1' }], gas: '200000' };

describe('CosmjsChainWriter', () => {
  // node MsgCreateSessionResponse: bytes session_id=1, uint64 session_nonce=2, status=3.
  it('createSession: session_id bytes are converted to 64-hex, owner is filled in from the tx signer', async () => {
    const respBytes = new ProtoWriter()
      .bytes(1, fromHex(SESSION_HEX)).uint64(2, 7n).uint64(3, 1n)
      .finish();
    const bc = new FakeBroadcaster(indexedTx(TYPE_URL.createSession, respBytes));
    const w = new CosmjsChainWriter({ broadcaster: bc, signerAddress: 'trueopen1me', fee, inclusion: instant });
    const r = await w.createSession();
    expect(r).toEqual({
      sessionId: SESSION_HEX, owner: 'trueopen1me', nonce: 7n, status: 'MUTATION_STATUS_V1_APPLIED',
    });
    expect(bc.last?.messages[0]?.typeUrl).toBe(TYPE_URL.createSession);
    expect((bc.last?.messages[0]?.value as { signer: string }).signer).toBe('trueopen1me');
  });

  // node MsgCancelOrderResponse: bytes task_id=1, cancelled_sequence=2, next_expected_sequence=3, status=4.
  it('cancelOrder: decodes task_id, and no longer sends the removed ownerSignature field', async () => {
    const respBytes = new ProtoWriter()
      .bytes(1, fromHex(TASK_HEX)).uint64(2, 3n).uint64(3, 4n).uint64(4, 1n)
      .finish();
    const bc = new FakeBroadcaster(indexedTx(TYPE_URL.cancelOrder, respBytes));
    const w = new CosmjsChainWriter({ broadcaster: bc, signerAddress: 'trueopen1me', fee, inclusion: instant });
    const r = await w.cancelOrder({ sessionId: SESSION_HEX, orderSequence: 3n, ownerSignature: 'abcd01' });
    expect(r.taskId).toBe(TASK_HEX);
    expect(r.nextExpectedSequence).toBe(4n);
    expect(bc.last?.messages[0]?.value).not.toHaveProperty('ownerSignature');
  });

  it('throws when the tx was included but the state machine rejected it (code != 0)', async () => {
    const failed = indexedTx(TYPE_URL.createSession, new Uint8Array(), 5);
    const w = new CosmjsChainWriter({ broadcaster: new FakeBroadcaster(failed), signerAddress: 'trueopen1me', fee, inclusion: instant });
    await expect(w.createSession()).rejects.toMatchObject({ code: 'CHAIN_TX_FAILED' });
  });

  // ---- the point of splitting broadcast from wait ----
  //
  // signAndBroadcast does both behind one call, so a failure cannot say which half failed
  // and the whole thing cannot be retried: re-calling it re-queries the account sequence
  // and signs a NEW transaction, double-submitting if the first one landed after all. So
  // the broadcast happens once and only the lookup repeats.

  it('broadcasts exactly once no matter how long inclusion takes', async () => {
    const bc = new FakeBroadcaster(indexedTx(TYPE_URL.createSession, new ProtoWriter().bytes(1, fromHex(SESSION_HEX)).uint64(2, 7n).uint64(3, 1n).finish()), 5);
    const w = new CosmjsChainWriter({ broadcaster: bc, signerAddress: 'trueopen1me', fee, inclusion: instant });
    await w.createSession();
    expect(bc.broadcasts).toBe(1);
    expect(bc.lookups).toBe(6); // five "not yet", then found
  });

  it('a failing lookup is retried and never re-broadcasts', async () => {
    // A dropped socket while asking whether the tx landed says nothing about the tx. The
    // old path would have surfaced this as a broadcast failure, inviting a resubmit.
    const bc = new FakeBroadcaster(
      indexedTx(TYPE_URL.createSession, new ProtoWriter().bytes(1, fromHex(SESSION_HEX)).uint64(2, 7n).uint64(3, 1n).finish()),
      0,
      3,
    );
    const w = new CosmjsChainWriter({ broadcaster: bc, signerAddress: 'trueopen1me', fee, inclusion: instant });
    const r = await w.createSession();
    expect(r.sessionId).toBe(SESSION_HEX);
    expect(bc.broadcasts).toBe(1);
    expect(bc.lookups).toBe(4); // three throws, then found
  });

  it('reports an unknown outcome rather than a failure when inclusion is never observed', async () => {
    // The tx may still land. Saying "failed" would invite a resubmit that double-submits,
    // so the error names the hash and is explicitly not retriable.
    const bc = new FakeBroadcaster(indexedTx(TYPE_URL.createSession, new Uint8Array()), 99);
    const w = new CosmjsChainWriter({
      broadcaster: bc, signerAddress: 'trueopen1me', fee,
      inclusion: { attempts: 3, intervalMs: 0, sleep: async () => {} },
    });
    await expect(w.createSession()).rejects.toMatchObject({
      code: 'CHAIN_TX_INCLUSION_UNKNOWN',
      retriable: false,
    });
    await expect(w.createSession()).rejects.toThrow(/TXHASH/);
    expect(bc.broadcasts).toBe(2); // one per call, never more
    expect(bc.lookups).toBe(6); // three per call
  });
});
