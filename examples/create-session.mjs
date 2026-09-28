// CreateSession example (spends gas and writes on chain).
// Run:
//   TRUEOPEN_REST_URL=http://<rest-host>:1317 TRUEOPEN_RPC_URL=http://<rpc-host>:26657 \
//   TRUEOPEN_CHAIN_ID=trueopen-localnet-1 TRUEOPEN_MNEMONIC="..." \
//   node examples/create-session.mjs
import { setup, show } from './_shared.mjs';

const { id, client, businessDenom, disconnect } = await setup({ write: true });
console.log('account:', id.address);
console.log(`About to broadcast MsgCreateSession (spends gas, fee in ${businessDenom})...`);
try {
  const created = await client.createSession();
  show('createSession', created);
  // A new session starts at order sequence 0: that is the first orderSequence to sign.
  show('getSession (round trip)', await client.getSession(created.sessionId));
  console.log(`\nexport TRUEOPEN_SESSION_ID=${created.sessionId}`);
} finally {
  disconnect();
}
