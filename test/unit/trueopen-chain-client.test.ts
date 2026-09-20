import { describe, it, expect } from 'vitest';
import type { EncodeObject } from '@cosmjs/proto-signing';
import type { DeliverTxResponse, StdFee } from '@cosmjs/stargate';
import { createTrueOpenChainClient } from '../../src/transport/trueopen-chain-client';
import type { TxBroadcaster } from '../../src/transport/cosmjs-chain-writer';
import type { FetchLike, FetchResponse } from '../../src/transport/rest-chain-reader';
import { ProtoWriter } from '../../src/codec/protobuf';
import { TYPE_URL } from '../../src/transport/task-msgs';
import { fromHex } from '../../src/util/bytes';

const fee: StdFee = { amount: [{ denom: 'utrueopen', amount: '1' }], gas: '200000' };

function deliverTx(typeUrl: string, value: Uint8Array): DeliverTxResponse {
  return {
    code: 0, height: 1, txIndex: 0, transactionHash: 'H', events: [],
    gasUsed: 1n, gasWanted: 1n, msgResponses: [{ typeUrl, value }],
  } as unknown as DeliverTxResponse;
}

class FakeBroadcaster implements TxBroadcaster {
  last?: readonly EncodeObject[];
  constructor(private readonly resp: DeliverTxResponse) {}
  async signAndBroadcast(_s: string, messages: readonly EncodeObject[]): Promise<DeliverTxResponse> {
    this.last = messages;
    return this.resp;
  }
}

function okJson(body: unknown): FetchResponse {
  return { ok: true, status: 200, json: async () => body };
}

describe('createTrueOpenChainClient (combined read + write, no real node)', () => {
  it('read goes through REST fetch', async () => {
    let calledUrl = '';
    const fetch: FetchLike = async (url) => {
      calledUrl = url;
      return okJson({
        session: {
          session_id: 'sess-1', owner_user_address: 'trueopen1me', next_expected_sequence: '2',
          last_active_height: '10', open_pending_count: '0', status: 'ACTIVE',
        },
      });
    };
    const client = createTrueOpenChainClient({
      restUrl: 'http://rest', signerAddress: 'trueopen1me', fee,
      broadcaster: new FakeBroadcaster(deliverTx(TYPE_URL.createSession, new Uint8Array())),
      fetch,
    });
    const s = await client.querySession('sess-1');
    expect(calledUrl).toBe('http://rest/TrueOpen/task/v1/session/sess-1');
    expect(s.owner).toBe('trueopen1me');
    expect(s.nextExpectedSequence).toBe(2n);
  });

  it('write goes through the broadcaster', async () => {
    // node MsgCreateSessionResponse: bytes session_id=1, uint64 session_nonce=2, status=3.
    const sessionHex = '33530796a5c450a2c5264ec40d1eeabf0e581d3f84dc09b45c35ac8259f4706a';
    const respBytes = new ProtoWriter()
      .bytes(1, fromHex(sessionHex)).uint64(2, 0n).uint64(3, 1n)
      .finish();
    const bc = new FakeBroadcaster(deliverTx(TYPE_URL.createSession, respBytes));
    const client = createTrueOpenChainClient({
      restUrl: 'http://rest', signerAddress: 'trueopen1me', fee, broadcaster: bc,
      fetch: async () => okJson({}),
    });
    const created = await client.createSession();
    expect(created.sessionId).toBe(sessionHex);
    expect(bc.last?.[0]?.typeUrl).toBe(TYPE_URL.createSession);
  });
});
