import { describe, it, expect } from 'vitest';
import type { EncodeObject } from '@cosmjs/proto-signing';
import type { DeliverTxResponse, StdFee } from '@cosmjs/stargate';
import { CosmjsChainWriter } from '../../src/transport/cosmjs-chain-writer';
import type { TxBroadcaster } from '../../src/transport/cosmjs-chain-writer';
import { ProtoWriter } from '../../src/codec/protobuf';
import { TYPE_URL } from '../../src/transport/task-msgs';
import { TrueOpenError } from '../../src/errors/errors';
import { fromHex } from '../../src/util/bytes';

const SESSION_HEX = '33530796a5c450a2c5264ec40d1eeabf0e581d3f84dc09b45c35ac8259f4706a';
const TASK_HEX = '0c57743effab15ce41ad3f75e0b190774e544c2ce20f1dd701298f89cfc83e35';

function deliverTx(typeUrl: string, value: Uint8Array): DeliverTxResponse {
  return {
    code: 0, height: 1, txIndex: 0, transactionHash: 'H', events: [],
    gasUsed: 1n, gasWanted: 1n, msgResponses: [{ typeUrl, value }],
  } as unknown as DeliverTxResponse;
}

class FakeBroadcaster implements TxBroadcaster {
  last?: { signer: string; messages: readonly EncodeObject[] };
  constructor(private readonly resp: DeliverTxResponse) {}
  async signAndBroadcast(signer: string, messages: readonly EncodeObject[]): Promise<DeliverTxResponse> {
    this.last = { signer, messages };
    return this.resp;
  }
}

const fee: StdFee = { amount: [{ denom: 'utrueopen', amount: '1' }], gas: '200000' };

describe('CosmjsChainWriter', () => {
  // node MsgCreateSessionResponse: bytes session_id=1, uint64 session_nonce=2, status=3.
  it('createSession: session_id bytes are converted to 64-hex, owner is filled in from the tx signer', async () => {
    const respBytes = new ProtoWriter()
      .bytes(1, fromHex(SESSION_HEX)).uint64(2, 7n).uint64(3, 1n)
      .finish();
    const bc = new FakeBroadcaster(deliverTx(TYPE_URL.createSession, respBytes));
    const w = new CosmjsChainWriter({ broadcaster: bc, signerAddress: 'trueopen1me', fee });
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
    const bc = new FakeBroadcaster(deliverTx(TYPE_URL.cancelOrder, respBytes));
    const w = new CosmjsChainWriter({ broadcaster: bc, signerAddress: 'trueopen1me', fee });
    const r = await w.cancelOrder({ sessionId: SESSION_HEX, orderSequence: 3n, ownerSignature: 'abcd01' });
    expect(r.taskId).toBe(TASK_HEX);
    expect(r.nextExpectedSequence).toBe(4n);
    expect(bc.last?.messages[0]?.value).not.toHaveProperty('ownerSignature');
  });

  it('userChallenge: for an enabled kind, evidence/sig strings pass through directly', async () => {
    const respBytes = new ProtoWriter()
      .string(1, 'ch-1').string(2, 'OPEN').uint64(3, 200n).uint64(4, 250n).uint64(5, 1000n)
      .finish();
    const bc = new FakeBroadcaster(deliverTx(TYPE_URL.userChallenge, respBytes));
    const w = new CosmjsChainWriter({ broadcaster: bc, signerAddress: 'trueopen1me', fee });
    const r = await w.userChallenge({
      sessionId: 's', taskId: 't', settlementId: 'st', kind: 'USER_REVALIDATION',
      evidenceDigest: 'evi', bondAmount: 1000n, challengerSignature: 'deadbeef',
    });
    expect(r.challengeId).toBe('ch-1');
    const value = bc.last?.messages[0]?.value as { evidenceDigest: string; challengerSignature: string; requestedEvidence: string[] };
    expect(value.evidenceDigest).toBe('evi');
    expect(value.challengerSignature).toBe('deadbeef');
    expect(value.requestedEvidence).toEqual([]);
  });

  it('userChallenge: throws immediately for a disabled kind, without broadcasting', async () => {
    const bc = new FakeBroadcaster(deliverTx(TYPE_URL.userChallenge, new Uint8Array()));
    const w = new CosmjsChainWriter({ broadcaster: bc, signerAddress: 'trueopen1me', fee });
    await expect(
      w.userChallenge({
        sessionId: 's', taskId: 't', settlementId: 'st', kind: 'OBJECTIVE_PROOF',
        evidenceDigest: 'evi', bondAmount: 1n, challengerSignature: 'sig',
      }),
    ).rejects.toThrowError(TrueOpenError);
    expect(bc.last).toBeUndefined();
  });

  it('throws when the tx fails (code != 0)', async () => {
    const failed = { ...deliverTx(TYPE_URL.createSession, new Uint8Array()), code: 5 } as unknown as DeliverTxResponse;
    const w = new CosmjsChainWriter({ broadcaster: new FakeBroadcaster(failed), signerAddress: 'trueopen1me', fee });
    await expect(w.createSession()).rejects.toThrow();
  });
});
