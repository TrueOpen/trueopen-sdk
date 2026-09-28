/**
 * Starts one simulated network (a fake node plus one fake nexus per Builder) and builds SDK
 * clients against it the way an application does: HubReader and RestChainReader over REST, the
 * CosmJS writer over RPC, and the SDK's own pinned nexus transport.
 */
import { sha256 } from '@noble/hashes/sha256';
import { TrueOpenClient } from '../../../src/client';
import type { TrueOpenClientConfig, OutputStreamSource } from '../../../src/client';
import { HubReader } from '../../../src/transport/hub-reader';
import { RestChainReader } from '../../../src/transport/rest-chain-reader';
import type { FetchLike } from '../../../src/transport/rest-chain-reader';
import { connectTrueOpenChainClient } from '../../../src/transport/trueopen-chain-client';
import { EthSecp256k1DirectSigner } from '../../../src/signer/eth-direct-signer';
import { nexusIngressTransport } from '../../../src/transport/nexus-tls';
import { privateKeyTypedDataSigner } from '../../../src/signer/typed-data-signer';
import type { ChainClient } from '../../../src/transport/chain-client';
import { FakeNode } from './fake-node';
import { FakeNexus, TLS_PUBKEY_HASH, loadStream } from './fake-nexus';
import type { OutputStreamFixture } from './fake-nexus';
import * as w from './world';

export const STREAM = loadStream('output-stream.json');
export const REFERENCE_STREAM = loadStream('worker-reference-stream.json');

const fetchLike: FetchLike = (url) => fetch(url);

export interface World {
  readonly node: FakeNode;
  /** One per entry of w.BUILDERS, same order. */
  readonly nexus: readonly FakeNexus[];
  readonly outputs: Map<string, OutputStreamFixture>;
  readonly hub: HubReader;
  readonly taskReader: RestChainReader;
  /** A client whose default ingress is `nexus[i]`. */
  client(i?: number, extra?: Partial<TrueOpenClientConfig>): TrueOpenClient;
  /** Output stream sources for the given Builders, in that order. */
  sources(indexes: readonly number[], extra?: Partial<TrueOpenClientConfig>): OutputStreamSource[];
  /** The CosmJS-backed chain client (real signing, broadcast to the fake node's RPC). */
  connectWriter(): Promise<{ chain: ChainClient; disconnect: () => void }>;
  close(): Promise<void>;
}

export async function startWorld(): Promise<World> {
  const node = await new FakeNode().start();
  const outputs = new Map<string, OutputStreamFixture>([[STREAM.task_id, STREAM]]);
  const nexus = await Promise.all(w.BUILDERS.map((b) => new FakeNexus(b, node, outputs).start()));
  for (const n of nexus) node.descriptors.set(n.builder.address, { uri: n.url, tlsPubkeyHash: TLS_PUBKEY_HASH });

  const hub = new HubReader({ baseUrl: node.restUrl, fetch: fetchLike });
  const taskReader = new RestChainReader({ baseUrl: node.restUrl, fetch: fetchLike });
  // Reads go over REST; a test that needs chain writes swaps in the CosmJS client.
  const readOnlyChain: ChainClient = {
    querySession: (id) => taskReader.querySession(id),
    querySessionNonce: (a) => taskReader.querySessionNonce(a),
    createSession: async () => { throw new Error('this client has no chain writer'); },
    cancelOrder: async () => { throw new Error('this client has no chain writer'); },
  };

  let nonce = 0;
  const client = (i = 0, extra: Partial<TrueOpenClientConfig> = {}): TrueOpenClient =>
    new TrueOpenClient({
      chainId: w.CHAIN_ID,
      userAddress: w.USER.address,
      wallet: privateKeyTypedDataSigner(w.USER.privKey),
      evmChainId: w.EVM_CHAIN_ID,
      chain: readOnlyChain,
      hub,
      taskReader,
      ingressTransport: nexusIngressTransport(nexus[i]!.url, TLS_PUBKEY_HASH),
      ingressTransportFactory: (uri, tls) => nexusIngressTransport(uri, tls ?? ''),
      // Distinct nonces across every client in the world (nexus rejects a replayed one).
      nonce: () => {
        nonce += 1;
        return Uint8Array.from(Buffer.from(w.label32(`e2e-nonce-${nonce}`), 'hex'));
      },
      ...extra,
    });

  return {
    node,
    nexus,
    outputs,
    hub,
    taskReader,
    client,
    sources: (indexes, extra = {}) =>
      indexes.map((i) => ({ id: `builder-${i}`, ingress: client(i, extra).ingress })),
    async connectWriter() {
      const businessDenom = await hub.getBusinessDenom();
      const { client: chain, signingClient } = await connectTrueOpenChainClient({
        rpcUrl: node.rpcUrl,
        restUrl: node.restUrl,
        signer: new EthSecp256k1DirectSigner(w.USER.privKey, w.PREFIX),
        signerAddress: w.USER.address,
        fee: { amount: [{ denom: businessDenom, amount: '7500' }], gas: '300000' },
        fetch: fetchLike,
      });
      return { chain, disconnect: () => signingClient.disconnect() };
    },
    async close() {
      await Promise.all([node.close(), ...nexus.map((n) => n.close())]);
    },
  };
}

/** Records the task on chain as accepted, as the Builder's broadcast would. */
export function acceptOnChain(world: World, stream: OutputStreamFixture = STREAM): void {
  world.node.tasks.set(stream.task_id, {
    taskId: stream.task_id,
    sessionId: stream.session_id,
    orderSequence: 0n,
    taskHash: stream.task_hash,
    inputHash: w.hex(sha256(w.PAYLOAD)),
  });
  const s = world.node.sessions.get(stream.session_id);
  if (s !== undefined) s.nextExpectedSequence += 1n;
}

export function drawWinner(world: World, taskId = STREAM.task_id): void {
  world.node.tasks.get(taskId)!.winner = w.WORKER_OPERATOR;
}

export function landReceipt(world: World, stream: OutputStreamFixture = STREAM): void {
  world.node.receipts.set(stream.task_id, {
    outputHash: stream.output_hash,
    outputSizeBytes: BigInt(stream.output_size_bytes),
    outputLeafCount: BigInt(stream.output_leaf_count),
    winnerWorker: w.WORKER_OPERATOR,
  });
}

export const outputText = (s: OutputStreamFixture): string => Buffer.from(s.output_b64, 'base64').toString('utf8');
