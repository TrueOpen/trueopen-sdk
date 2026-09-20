// CreateSession example (spends gas and writes on chain): exercises the CosmJS chain write and the response decoding round trip.
// Run:
//   TRUEOPEN_RPC_URL=http://<rpc-host>:26657 \
//   TRUEOPEN_REST_URL=http://<rest-host>:1317 \
//   TRUEOPEN_MNEMONIC="..." \
//   node examples/create-session.mjs
import { connectTrueOpenChainClient } from '../dist/index.js';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { GasPrice } from '@cosmjs/stargate';
import { env, show } from './_shared.mjs';

const prefix = env('TRUEOPEN_ADDR_PREFIX', 'trueopen');
const wallet = await DirectSecp256k1HdWallet.fromMnemonic(env('TRUEOPEN_MNEMONIC'), { prefix });
const [account] = await wallet.getAccounts();
console.log('account:', account.address, '\nAbout to broadcast MsgCreateSession (spends gas)...');

const { client, signingClient } = await connectTrueOpenChainClient({
  rpcUrl: env('TRUEOPEN_RPC_URL'),
  restUrl: env('TRUEOPEN_REST_URL'),
  signer: wallet,
  signerAddress: account.address,
  fee: 'auto',
  gasPrice: GasPrice.fromString(env('TRUEOPEN_GAS_PRICE', '0.025utrueopen')),
});
try {
  const created = await client.createSession();
  show('createSession', created);
  show('querySession (round-trip confirmation)', await client.querySession(created.sessionId));
} finally {
  signingClient.disconnect();
}
