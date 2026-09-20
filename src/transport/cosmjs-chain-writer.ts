import type { EncodeObject } from '@cosmjs/proto-signing';
import type { DeliverTxResponse, StdFee } from '@cosmjs/stargate';
import { assertIsDeliverTxSuccess } from '@cosmjs/stargate';
import { TrueOpenError } from '../errors/errors';
import { isChallengeKindEnabled } from '../types/node';
import {
  TYPE_URL,
  decodeMsgCreateSessionResponse,
  decodeMsgCancelOrderResponse,
  decodeMsgUserChallengeResponse,
} from './task-msgs';
import type {
  ChainReader,
  ChainClient,
  CreateSessionResult,
  CancelOrderInput,
  CancelOrderResult,
  UserChallengeInput,
  UserChallengeResult,
} from './chain-client';

/** SigningStargateClient satisfies this interface; extracted so a fake can be injected for unit tests. */
export interface TxBroadcaster {
  signAndBroadcast(
    signerAddress: string,
    messages: readonly EncodeObject[],
    fee: StdFee | 'auto',
    memo?: string,
  ): Promise<DeliverTxResponse>;
}

export interface CosmjsChainWriterOptions {
  readonly broadcaster: TxBroadcaster;
  readonly signerAddress: string;
  readonly fee: StdFee | 'auto';
  readonly memo?: string;
}

/**
 * Broadcasts task user tx via CosmJS (implements the write side of ChainClient).
 * The detached signatures (owner_signature / challenger_signature) and evidence_digest
 * are all proto strings; callers pass in an already-computed hex/opaque string (see
 * signCancelOrder / signUserChallenge), and this layer does no byte encoding of its own.
 * The broadcast path needs a real signer and node, so it's covered by integration tests;
 * Msg construction, the challenge-enabled guard, and response decoding can be unit tested
 * with an injected TxBroadcaster.
 */
export class CosmjsChainWriter {
  constructor(private readonly opts: CosmjsChainWriterOptions) {}

  private async broadcast(messages: EncodeObject[]): Promise<DeliverTxResponse> {
    const res = await this.opts.broadcaster.signAndBroadcast(
      this.opts.signerAddress,
      messages,
      this.opts.fee,
      this.opts.memo,
    );
    assertIsDeliverTxSuccess(res);
    return res;
  }

  async createSession(): Promise<CreateSessionResult> {
    const res = await this.broadcast([
      { typeUrl: TYPE_URL.createSession, value: { signer: this.opts.signerAddress } },
    ]);
    const r = decodeMsgCreateSessionResponse(firstResponse(res, TYPE_URL.createSession));
    // The node response has no owner field; MsgCreateSession.signer_address is the session
    // owner, so use it to fill the field in.
    return { sessionId: r.sessionId, owner: this.opts.signerAddress, nonce: r.sessionNonce, status: r.status };
  }

  async cancelOrder(input: CancelOrderInput): Promise<CancelOrderResult> {
    // The frozen wire contract's MsgCancelOrder has no owner_signature, so input.ownerSignature
    // is never sent on-chain.
    const value = {
      signer: this.opts.signerAddress,
      sessionId: input.sessionId,
      orderSequence: input.orderSequence,
    };
    const res = await this.broadcast([{ typeUrl: TYPE_URL.cancelOrder, value }]);
    return decodeMsgCancelOrderResponse(firstResponse(res, TYPE_URL.cancelOrder));
  }

  async userChallenge(input: UserChallengeInput): Promise<UserChallengeResult> {
    if (!isChallengeKindEnabled(input.kind)) {
      throw new TrueOpenError('CHALLENGE', 'CHALLENGE_KIND_NOT_ENABLED', `challenge kind not enabled on chain: ${input.kind}`);
    }
    const value = {
      signer: this.opts.signerAddress,
      sessionId: input.sessionId,
      taskId: input.taskId,
      settlementId: input.settlementId,
      challengeKind: input.kind,
      evidenceDigest: input.evidenceDigest,
      bondAmount: input.bondAmount,
      requestedEvidence: [] as string[],
      challengerSignature: input.challengerSignature,
    };
    const res = await this.broadcast([{ typeUrl: TYPE_URL.userChallenge, value }]);
    return decodeMsgUserChallengeResponse(firstResponse(res, TYPE_URL.userChallenge));
  }
}

function firstResponse(res: DeliverTxResponse, typeUrl: string): Uint8Array {
  const first = res.msgResponses[0];
  if (!first) {
    throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_TX_NO_RESPONSE', `tx succeeded but returned no msgResponses for ${typeUrl}`);
  }
  return first.value;
}

/** Composes a read port with a write adapter into a full ChainClient. */
export function composeChainClient(reader: ChainReader, writer: CosmjsChainWriter): ChainClient {
  return {
    querySession: (id) => reader.querySession(id),
    querySessionNonce: (a) => reader.querySessionNonce(a),
    querySettlementFinality: (s, t) => reader.querySettlementFinality(s, t),
    createSession: () => writer.createSession(),
    cancelOrder: (i) => writer.cancelOrder(i),
    userChallenge: (i) => writer.userChallenge(i),
  };
}
