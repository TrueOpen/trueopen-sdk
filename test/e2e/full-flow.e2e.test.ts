/**
 * End-to-end simulation of the user journey through the TrueOpenClient facade, against a fake
 * node (REST + CometBFT RPC) and three fake nexus Builders (Connect over pinned HTTPS), all on
 * localhost. No chain runs and nothing is broadcast anywhere: the one transaction is signed for
 * real and handed to the fake node, which checks and records it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { OutputStreamEvent } from '../../src/client';
import { FinishReasonV1 } from '../../src/gen/task/v1/evidence_pb.js';
import { startWorld, acceptOnChain, drawWinner, landReceipt, outputText, STREAM } from './support/harness';
import type { World } from './support/harness';
import * as w from './support/world';

let world: World;
beforeEach(async () => { world = await startWorld(); });
afterEach(async () => { await world.close(); });

describe('e2e: full flow through the SDK facade', () => {
  it('reads params, creates a session, opens a task on 3 Builders, streams, fetches and sees it settle', async () => {
    // 1. Chain params: both signature inputs come from chain, never from constants.
    expect(await world.hub.getBusinessDenom()).toBe(w.BUSINESS_DENOM);
    expect(await world.hub.getEvmChainId()).toBe(w.EVM_CHAIN_ID);

    // 2. createSession: a real ethsecp256k1 DIRECT signature over a real TxRaw, sent to the fake RPC.
    const writer = await world.connectWriter();
    const client = world.client(0, { chain: writer.chain });
    let sessionId: string;
    try {
      const session = await client.createSession('e2e');
      sessionId = session.sessionId;
      expect(session.owner).toBe(w.USER.address);
      expect(session.nextExpectedSequence).toBe(0n);
    } finally {
      writer.disconnect();
    }
    expect(sessionId).toBe(w.sessionIdFor(w.USER.address, 0n));
    expect(world.node.txs).toHaveLength(1);
    const tx = world.node.txs[0]!;
    expect(tx.code).toBe(0);
    expect(tx.decoded.signatureValid).toBe(true);
    expect(tx.decoded.pubKeyTypeUrl).toBe('/cosmos.evm.crypto.v1.ethsecp256k1.PubKey');
    expect(tx.decoded.feeDenoms).toEqual([w.BUSINESS_DENOM]);
    expect(tx.decoded.messages.map((m) => m.typeUrl)).toEqual(['/task.v1.MsgCreateSession']);
    // The session round-trips through the REST reader.
    expect((await client.getSession(sessionId)).owner).toBe(w.USER.address);

    // 3. openTask: context, pricing and sequence from chain; fan-out to the anchor-height set.
    const opened = await client.openTask({ sessionId, idempotencyKey: `${sessionId}:0`, order: w.orderIntent() });
    expect(opened.accepted).toBe(true);
    expect(opened.feeDenom).toBe(w.BUSINESS_DENOM);
    expect(opened.context.sessionAnchorHeight).toBe(w.ANCHOR_HEIGHT);
    expect(opened.context.builderSetId).toBe(w.SET_A.id);
    expect(opened.context.timeoutBucketVersion).toBe(w.TIMEOUT_BUCKET_VERSION);
    expect(opened.taskId).toBe(STREAM.task_id);
    // The Worker-signed stream fixture was generated for exactly this task_hash.
    expect(opened.taskHash, 'order changed: regenerate fixtures/output-stream.json (fixtures/gen)').toBe(STREAM.task_hash);
    expect(opened.unresolvedBuilders).toEqual([]);
    expect(opened.builders.map((b) => b.address).sort()).toEqual([...w.SET_A.members].sort());
    for (const b of opened.builders) {
      expect(b.error).toBeUndefined();
      expect(b.ack?.accepted).toBe(true);
      expect(b.ack?.taskId).toBe(STREAM.task_id);
      expect(b.tlsPubkeyHash).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const n of world.nexus.slice(0, 3)) {
      expect(n.verifications.filter((x) => x.method === 'OpenTask')).toEqual([{ method: 'OpenTask', outcome: 'ok' }]);
      // Each Builder recomputed the same task_hash from the order it received.
      expect(n.taskHashes).toEqual([STREAM.task_hash]);
      expect(n.opened[0]!.payload).toEqual(w.PAYLOAD);
      expect(n.opened[0]!.idempotencyKey).toBe(`${sessionId}:0`);
    }
    for (const n of world.nexus.slice(3)) expect(n.calls).toEqual([]);

    // 4. The chain accepts the order and draws a winner; the receipt is not there yet.
    acceptOnChain(world);
    drawWinner(world);
    expect(await client.nextOrderSequence(sessionId)).toBe(1n);

    // 5. streamOutput: trust anchors from chain, every frame and the Fin signature verified.
    const events: OutputStreamEvent[] = [];
    for await (const ev of client.streamOutput({ sessionId, taskId: opened.taskId, sources: world.sources([0, 1, 2]) })) events.push(ev);
    const chunks = events.filter((e) => e.kind === 'chunk');
    expect(chunks.map((e) => e.seq)).toEqual([0n, 1n, 2n, 3n]);
    expect(chunks.map((e) => e.text).join('')).toBe(outputText(STREAM));
    expect(events.at(-1)).toEqual({ kind: 'fin', attested: true, finishReason: FinishReasonV1.EOS_TOKEN });
    expect(world.nexus[0]!.acks).toEqual([{ lastSeq: 3n, outputId: '' }]);

    // 6. The receipt lands: fetch the object in 5-byte ranges and check it against the receipt.
    landReceipt(world);
    const fetched = await client.fetchTaskOutput({ sessionId, taskId: opened.taskId, builderAddress: w.BUILDERS[0]!.address, maxRangeBytes: 5 });
    expect(fetched.text).toBe(outputText(STREAM));
    expect(fetched.outputHash).toBe(STREAM.output_hash);
    expect(fetched.chunks.map((c) => c.length)).toEqual(STREAM.chunk_lengths);
    expect(fetched.receipt?.outputLeafCount).toBe(BigInt(STREAM.output_leaf_count));
    expect(world.nexus[0]!.fetches.map((r) => [r.offset, r.length])).toEqual(
      [[0n, 5n], [5n, 5n], [10n, 5n], [15n, 5n], [20n, 5n], [25n, 5n], [30n, 4n]],
    );

    // 7. The task settles and is compacted to its terminal summary.
    world.node.tasks.get(opened.taskId)!.terminal = true;
    const task = await world.taskReader.queryTask(opened.taskId);
    expect(task.view).toBe('terminal');
    expect(task.terminalPhase).toBe('SETTLED');
    expect(task.acceptedTaskHash).toBe(STREAM.task_hash);
    expect(task.winnerWorker).toBe(w.WORKER_OPERATOR);

    // Every nexus request passed the independent checks.
    for (const n of world.nexus) expect(n.verifications.filter((x) => x.outcome !== 'ok')).toEqual([]);
    // The routes the SDK used, for the record (and so an unexpected one shows up in a diff).
    const routes = [...new Set(world.node.requests.map((r) => r
      .replace(/[0-9a-f]{64}/g, '{hash}')
      .replace(/trueopen1[0-9a-z]{38}/g, '{address}')
      .replace(/\/\d+(?=\/|$)/g, '/{n}')))].sort();
    expect(routes).toEqual([
      'GET /TrueOpen/hub/v1/beacon/{n}',
      'GET /TrueOpen/hub/v1/builder_set/by_height/{n}',
      'GET /TrueOpen/hub/v1/current_service_key/PARTICIPANT_TYPE_CORTEX/{address}',
      'GET /TrueOpen/hub/v1/params',
      'GET /TrueOpen/hub/v1/profile/{hash}/{n}',
      'GET /TrueOpen/hub/v1/service_descriptor/PARTICIPANT_TYPE_BUILDER/{address}',
      'GET /TrueOpen/hub/v1/timeout_bucket/default',
      'GET /TrueOpen/task/v1/params',
      'GET /TrueOpen/task/v1/session/{hash}',
      'GET /TrueOpen/task/v1/task/{hash}',
      'GET /TrueOpen/task/v1/task/{hash}/infer_receipt',
      'GET /cosmos/base/tendermint/v1beta1/blocks/latest',
      'RPC abci_query',
      'RPC broadcast_tx_sync',
      'RPC status',
      'RPC tx_search',
    ]);
  });
});
