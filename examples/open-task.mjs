// OpenTask example: read the on-chain context, assemble the frozen TaskOrderV1, sign it in three
// layers, pick the Task Builders and submit the order as a stream.
//
// The contract replaced the deprecated SubmitOrder entry point with OpenTask, and the order body
// with the frozen SignedOrderV1. Three things differ from the older example:
//   1. An orderSigner is required: the inner SignedOrderV1.user_signature signs the raw 32-byte
//      task_hash directly, so an ordinary signer that hashes with sha256 first does not work
//      (node verifies with VerifyStrictSecp256k1Digest);
//   2. A hub and an ingressTransportFactory are required: the anchor signed into the order fixes
//      the Task Builders, so the SDK reads the on-chain context and picks endpoints by
//      task_builder_seed;
//   3. The order no longer carries reward_bucket / profile_resource_tier / order_value /
//      infer_timeout_blocks: the Keeper derives them, and sending them gets the order rejected.
//
// Run:
//   TRUEOPEN_RPC_URL=... TRUEOPEN_REST_URL=... TRUEOPEN_CHAIN_ID=trueopen-localnet-1 \
//   TRUEOPEN_MNEMONIC="..." TRUEOPEN_SESSION_ID=<session id> TRUEOPEN_ORDER_SEQUENCE=1 \
//   node examples/open-task.mjs
//
// Without TRUEOPEN_SESSION_ID the example first creates a new session on chain, which spends gas.
import {
  TrueOpenClient, HubReader, connectTrueOpenChainClient,
  privKeySecp256k1DigestSigner, defaultGenerationParams,
  TASK_TYPE, DEADLINE_LATENCY_CLASS,
} from '../dist/index.js';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { GasPrice } from '@cosmjs/stargate';
import { deriveIdentity, nexusTransport, fetchLike, env, show } from './_shared.mjs';

const prefix = env('TRUEOPEN_ADDR_PREFIX', 'trueopen');
const mnemonic = env('TRUEOPEN_MNEMONIC');
const restUrl = env('TRUEOPEN_REST_URL');
const id = await deriveIdentity(mnemonic, prefix);

const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix });
const [account] = await wallet.getAccounts();
const { client: chain, signingClient } = await connectTrueOpenChainClient({
  rpcUrl: env('TRUEOPEN_RPC_URL'), restUrl,
  signer: wallet, signerAddress: account.address, fee: 'auto',
  gasPrice: GasPrice.fromString(env('TRUEOPEN_GAS_PRICE', '0.025utrueopen')),
});

const hub = new HubReader({ baseUrl: restUrl, fetch: fetchLike });

const client = new TrueOpenClient({
  chainId: env('TRUEOPEN_CHAIN_ID', 'trueopen-localnet-1'),
  userAddress: id.address, signerPubKey: id.pubKey, signer: id.signer,
  // The inner order signature must sign the digest directly; see the note at the top of this file.
  orderSigner: privKeySecp256k1DigestSigner(id.privkey),
  chain,
  ingressTransport: nexusTransport('http://nexus.unused.invalid'), // the factory provides the transport actually used
  hub,
  ingressTransportFactory: nexusTransport, // grpc:// is normalised to http(s) internally
  addressPrefix: prefix, // checks signer_address against the public key at construction time, so nexus does not reject the signature
});

// The V1 data plane sends the input in the clear: the SDK derives input_hash / input_size_bytes / payload_ref from the payload.
const { readFileSync } = await import('node:fs');
const payloadFile = process.env.TRUEOPEN_PAYLOAD_FILE;
const payload = payloadFile
  ? new Uint8Array(readFileSync(payloadFile))
  : new TextEncoder().encode('trueopen-placeholder-input');

try {
  console.log('user/signer address:', id.address);
  console.log('Once the order is accepted, a Task Builder may submit Assign on chain, which locks funds up to max_fee.');

  const sessionId = process.env.TRUEOPEN_SESSION_ID
    ?? (await client.createSession('example-open-task')).sessionId;
  console.log('session:', sessionId);

  const res = await client.openTask({
    sessionId,
    orderSequence: BigInt(env('TRUEOPEN_ORDER_SEQUENCE', '1')),
    // Idempotency key: it must stay the same across retries; the same key with a different input_hash is rejected.
    idempotencyKey: `${sessionId}:${env('TRUEOPEN_ORDER_SEQUENCE', '1')}`,
    order: {
      modelId: env('TRUEOPEN_MODEL_ID', 'hf-ad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b'),
      profileVersion: 1,
      taskType: TASK_TYPE.TEXT_GENERATION,
      payload,
      inputBucket: 1,
      outputBudgetBucket: 1,
      // Generation params enter task_hash, so every field must be given explicitly with no implicit defaults.
      generationParams: defaultGenerationParams(128n, 60_000n),
      // Fees are Amounts: the preimage takes the atomic units as decimal text, not as a number.
      amounts: {
        inferInputUnitPriceBid: { atomicUnits: '10' },
        inferOutputUnitPriceBid: { atomicUnits: '10' },
        verifyUnitPriceBid: { atomicUnits: '10' },
        inferFeeCap: { atomicUnits: '600000' },
        verifyFeeCap: { atomicUnits: '300000' },
        maxFee: { atomicUnits: '1000000' },
        assignmentPriorityFee: { atomicUnits: '0' },
        txFeeReserve: { atomicUnits: '0' },
      },
      // The caller decides the height window; this example uses the current height plus 50000 blocks.
      earliestSubmitHeight: (await hub.getLatestHeight()),
      orderExpireHeight: (await hub.getLatestHeight()) + 50_000n,
      latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
    },
  });

  show('openTask ACK', {
    accepted: res.accepted, taskId: res.taskId, taskHash: res.taskHash,
    endpointsTried: res.endpointsTried, reason: res.reason,
  });
  // An ingress ack only means local acceptance; whether the task reached the chain shows up when taskStatus leaves PENDING.
  show('chain context (signed into the order)', res.context);
} catch (e) {
  console.log('\nopenTask failed:', e?.code ?? '', '|', e?.rawMessage ?? e?.message ?? String(e));
} finally {
  signingClient.disconnect();
}
