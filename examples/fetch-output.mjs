// FetchOutput example: subscribe to the final plaintext, check sha256 == output_hash, then ACK by default.
// It needs a task that has completed and produced an output; SubscribeOutput blocks until the output arrives.
// Run:
//   TRUEOPEN_NEXUS_URL=http://<nexus-host>:8080 TRUEOPEN_CHAIN_ID=trueopen-localnet-1 \
//   TRUEOPEN_MNEMONIC="..." TRUEOPEN_SESSION_ID=<session id> TRUEOPEN_TASK_ID=<task id> \
//   node examples/fetch-output.mjs
import { TrueOpenClient } from '../dist/index.js';
import { deriveIdentity, nexusTransport, env, show } from './_shared.mjs';

const prefix = env('TRUEOPEN_ADDR_PREFIX', 'trueopen');
const id = await deriveIdentity(env('TRUEOPEN_MNEMONIC'), prefix);

// fetchOutput only needs nexus plus a signing identity and never touches the chain, so a minimal stub stands in for it.
const die = async () => { throw new Error('chain not used by fetchOutput'); };
const stubChain = {
  querySession: die, querySessionNonce: die, querySettlementFinality: die,
  createSession: die, cancelOrder: die, userChallenge: die,
};

const client = new TrueOpenClient({
  chainId: env('TRUEOPEN_CHAIN_ID', 'trueopen-localnet-1'),
  userAddress: id.address, signerPubKey: id.pubKey, signer: id.signer,
  chain: stubChain, ingressTransport: nexusTransport(env('TRUEOPEN_NEXUS_URL')),
  addressPrefix: prefix,
});

const sessionId = env('TRUEOPEN_SESSION_ID');
const taskId = env('TRUEOPEN_TASK_ID');
console.log(`subscribing to output (session=${sessionId} task=${taskId})...`);
console.log('SubscribeOutput blocks until the task has a final plaintext output, so the task must be complete.');
const out = await client.fetchOutput(sessionId, taskId); // subscribe, check the hash, then ACK by default
show('fetchOutput', {
  outputId: out.outputId, outputText: out.outputText,
  createdAt: out.createdAt, expiresAt: out.expiresAt,
});
