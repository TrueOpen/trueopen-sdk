import type { EncodeObject } from '@cosmjs/proto-signing';
import type { IndexedTx, StdFee } from '@cosmjs/stargate';
import { TrueOpenError } from '../errors/errors';
import { classifyBroadcastError } from '../errors/classify';
import {
  TYPE_URL,
  decodeMsgCreateSessionResponse,
  decodeMsgCancelOrderResponse,
} from './task-msgs';
import type {
  ChainReader,
  ChainClient,
  CreateSessionResult,
  CancelOrderInput,
  CancelOrderResult,
} from './chain-client';

/**
 * SigningStargateClient satisfies this interface; extracted so a fake can be injected for
 * unit tests. Both methods are taken verbatim from its surface so that it still satisfies
 * this structurally, with no adapter.
 *
 * The pair is deliberately `broadcast, then look up` rather than the single
 * `signAndBroadcast`. `signAndBroadcast` broadcasts *and* waits for inclusion behind one
 * call, so a failure does not say which half failed, and the write path cannot be retried:
 * re-calling it re-queries the account sequence and signs a **new** transaction, which
 * genuinely double-submits if the first one landed after all. What that costs differs per
 * message -- a duplicate `MsgCancelOrder` is rejected by the sequence that the first one
 * advanced, and a duplicate `MsgCreateSession` wastes a fee and leaves a stray session.
 */
export interface TxBroadcaster {
  /** Broadcasts without waiting and returns the transaction hash. Called exactly once. */
  signAndBroadcastSync(
    signerAddress: string,
    messages: readonly EncodeObject[],
    fee: StdFee | 'auto',
    memo?: string,
  ): Promise<string>;
  /** Looks up a broadcast transaction; null while it is still only in the mempool. */
  getTx(id: string): Promise<IndexedTx | null>;
}

/**
 * How long to keep asking the chain whether an already-broadcast transaction landed.
 *
 * This is not the read-path retry policy. That one retries a request that failed; this one
 * repeats a request that *succeeded* and truthfully answered "not yet". The transaction is
 * already in flight either way, so waiting longer is free and giving up early is not: it
 * reports failure for something that may be one block from inclusion.
 */
export interface TxInclusionPolicy {
  /** Total lookups, the first one included. */
  readonly attempts: number;
  /** Gap between lookups. Fixed, not exponential -- blocks arrive at a steady rate. */
  readonly intervalMs: number;
  /** Injectable so tests do not spend real time asleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** ~60s at devnet's ~5s blocks, which is about a dozen blocks of margin. */
export const DEFAULT_TX_INCLUSION: TxInclusionPolicy = { attempts: 30, intervalMs: 2000 };

export interface CosmjsChainWriterOptions {
  readonly broadcaster: TxBroadcaster;
  readonly signerAddress: string;
  readonly fee: StdFee | 'auto';
  readonly memo?: string;
  /** Defaults to DEFAULT_TX_INCLUSION. */
  readonly inclusion?: TxInclusionPolicy;
}

/**
 * Broadcasts task user tx via CosmJS (implements the write side of ChainClient).
 * Authorization is the Cosmos account signature alone; neither Msg carries a detached
 * signature. The broadcast path needs a real signer and node, so it's covered by
 * integration tests; Msg construction and response decoding are unit tested with an
 * injected TxBroadcaster.
 */
export class CosmjsChainWriter {
  constructor(private readonly opts: CosmjsChainWriterOptions) {}

  /**
   * Broadcasts once, then waits for inclusion by hash.
   *
   * The split is what makes the wait resumable. `signAndBroadcastSync` is called exactly
   * once and is never retried -- a dropped socket there leaves the outcome genuinely
   * unknown, and re-broadcasting would sign a second transaction. Everything after it is a
   * read keyed by that hash, so a dropped socket during the wait costs one more lookup and
   * nothing else.
   */
  private async broadcast(messages: EncodeObject[]): Promise<IndexedTx> {
    let hash: string;
    try {
      hash = await this.opts.broadcaster.signAndBroadcastSync(
        this.opts.signerAddress,
        messages,
        this.opts.fee,
        this.opts.memo,
      );
    } catch (e) {
      // CheckTx refused it (BroadcastTxError) -> CHAIN_TX_REJECTED with code and log kept.
      throw classifyBroadcastError(e);
    }
    const tx = await this.awaitInclusion(hash);
    if (tx.code !== 0) {
      // Included but rejected by the state machine. Not retriable: the same bytes will be
      // rejected the same way, and the sequence has already advanced.
      throw new TrueOpenError(
        'CHAIN_REJECT',
        'CHAIN_TX_FAILED',
        `tx ${hash} failed on chain with code ${tx.code}: ${tx.rawLog}`,
        { category: 'chain-rejected', details: { txHash: hash, code: tx.code, log: tx.rawLog } },
      );
    }
    return tx;
  }

  private async awaitInclusion(hash: string): Promise<IndexedTx> {
    const policy = this.opts.inclusion ?? DEFAULT_TX_INCLUSION;
    const attempts = Math.max(1, policy.attempts);
    const sleep = policy.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let lastLookupError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(policy.intervalMs);
      try {
        const tx = await this.opts.broadcaster.getTx(hash);
        if (tx !== null) return tx;
        lastLookupError = undefined;
      } catch (cause) {
        // A failed lookup is not a failed transaction. Keep asking.
        lastLookupError = cause;
      }
    }
    // The transaction may still land. Say so rather than implying it did not, and name the
    // hash so the caller can settle the question instead of resubmitting blind.
    throw new TrueOpenError(
      'CHAIN_REJECT',
      'CHAIN_TX_INCLUSION_UNKNOWN',
      `tx ${hash} was broadcast but not observed on chain within ${attempts} lookups; it may still be included -- query this hash before resubmitting`,
      { retriable: false, userAction: `query tx ${hash} on chain`, ...(lastLookupError !== undefined ? { cause: lastLookupError } : {}) },
    );
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
}

function firstResponse(res: IndexedTx, typeUrl: string): Uint8Array {
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
    createSession: () => writer.createSession(),
    cancelOrder: (i) => writer.cancelOrder(i),
  };
}
