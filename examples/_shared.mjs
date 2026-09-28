// Shared helpers for the examples. They import from ../dist, so run `npm run build` first.
import {
  TrueOpenClient,
  HubReader,
  RestChainReader,
  connectTrueOpenChainClient,
  ethSecp256k1SignerFromMnemonic,
  nexusIngressTransport,
  privKeySecp256k1Signer,
  privKeyEip712Signer,
  secp256k1PublicKey,
  ethSecp256k1Address,
  TrueOpenError,
  TRUEOPEN_HD_PATH,
} from '../dist/index.js';
import { Bip39, Slip10, Slip10Curve, EnglishMnemonic, stringToPath } from '@cosmjs/crypto';

/**
 * Read an environment variable; exit with an error when it is missing and has no default.
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    console.error(`\n[missing environment variable] ${name}\nsee examples/README.md`);
    process.exit(1);
  }
  return v;
}

/**
 * The FetchLike that RestChainReader / HubReader expect; the Node global fetch matches it structurally.
 * @param {string} url
 */
export const fetchLike = (url) => fetch(url);

/**
 * Derive an identity from a mnemonic. The protocol HD path uses coin_type 60, not the 118 Cosmos
 * usually takes, and addresses are EVM-style (keccak of the public key).
 * @param {string} mnemonic
 * @param {string} prefix
 */
export async function deriveIdentity(mnemonic, prefix) {
  const seed = await Bip39.mnemonicToSeed(new EnglishMnemonic(mnemonic));
  const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, stringToPath(TRUEOPEN_HD_PATH));
  const pubKey = secp256k1PublicKey(privkey);
  return {
    privkey,
    pubKey,
    address: ethSecp256k1Address(pubKey, prefix),
    // Request envelopes: sha256 then secp256k1, 64 bytes.
    signer: privKeySecp256k1Signer(privkey),
    // The order and the task-data requests: an EIP-712 digest, 65-byte R||S||V.
    orderSigner: privKeyEip712Signer(privkey),
  };
}

/**
 * Connect transport for a nexus endpoint read from chain. https endpoints are checked against the
 * certificate fingerprint registered on chain and never downgraded to http. A localnet whose
 * endpoints are plain http:// or grpc:// needs TRUEOPEN_ALLOW_INSECURE_HTTP=1.
 * @param {string} url
 * @param {string} [tlsPubkeyHash]
 */
export function nexusTransport(url, tlsPubkeyHash = '') {
  return nexusIngressTransport(url, tlsPubkeyHash);
}

/**
 * Default ingress transport for a client that must not call nexus directly.
 * @type {import('@connectrpc/connect').Transport}
 */
const noDefaultNexus = {
  unary: () => Promise.reject(new Error('this client has no default nexus endpoint; use clientFor(serviceEndpoint, tlsPubkeyHash)')),
  stream: () => Promise.reject(new Error('this client has no default nexus endpoint; use clientFor(serviceEndpoint, tlsPubkeyHash)')),
};

/**
 * Everything the examples need, built once:
 * - chain reads (task, session) and hub reads (params, Builders, profiles) over REST;
 * - optionally chain writes over RPC, with fees in the chain business_denom;
 * - a TrueOpenClient whose EVM chain ID and fee denom come from the chain, never from constants.
 * @param {{ write?: boolean }} [opts]
 */
export async function setup(opts = {}) {
  const prefix = env('TRUEOPEN_ADDR_PREFIX', 'trueopen');
  const restUrl = env('TRUEOPEN_REST_URL');
  const mnemonic = env('TRUEOPEN_MNEMONIC');
  const id = await deriveIdentity(mnemonic, prefix);
  const hub = new HubReader({ baseUrl: restUrl, fetch: fetchLike });
  const taskReader = new RestChainReader({ baseUrl: restUrl, fetch: fetchLike });

  // Both go into signatures and are read from chain params.phase0.
  const evmChainId = await hub.getEvmChainId();
  const businessDenom = await hub.getBusinessDenom();

  /** @type {import('../dist/index.js').ChainClient} */
  let chain = {
    querySession: (sessionId) => taskReader.querySession(sessionId),
    querySessionNonce: (address) => taskReader.querySessionNonce(address),
    createSession: async () => { throw new Error('chain writes need setup({ write: true })'); },
    cancelOrder: async () => { throw new Error('chain writes need setup({ write: true })'); },
  };
  let disconnect = () => {};
  if (opts.write) {
    // node verifies keccak256(SignDoc) with an ethsecp256k1 key, which CosmJS's own wallets do not
    // produce. Fees must be explicit (not 'auto': CosmJS simulates with a sign mode node refuses)
    // and in business_denom, the only fee denom the chain accepts.
    const wallet = await ethSecp256k1SignerFromMnemonic(mnemonic, prefix);
    const gas = env('TRUEOPEN_GAS', '300000');
    const feeAmount = env('TRUEOPEN_FEE_AMOUNT', '7500');
    const conn = await connectTrueOpenChainClient({
      rpcUrl: env('TRUEOPEN_RPC_URL'),
      restUrl,
      signer: wallet,
      signerAddress: id.address,
      fee: { amount: [{ denom: businessDenom, amount: feeAmount }], gas },
    });
    chain = conn.client;
    disconnect = () => conn.signingClient.disconnect();
  }

  /** @param {import('@connectrpc/connect').Transport} ingressTransport */
  const makeClient = (ingressTransport) =>
    new TrueOpenClient({
      chainId: env('TRUEOPEN_CHAIN_ID'),
      userAddress: id.address,
      signerPubKey: id.pubKey,
      signer: id.signer,
      orderSigner: id.orderSigner,
      evmChainId,
      // No feeDenom: openTask signs the chain business_denom read through the hub.
      chain,
      ingressTransport,
      hub,
      taskReader,
      ingressTransportFactory: nexusTransport,
      addressPrefix: prefix,
    });
  // openTask routes by itself (ingressTransportFactory) and per-Builder calls go through
  // clientFor, so this client has no default nexus. A placeholder that fails if it is ever used,
  // rather than a real transport to a made-up http:// address, which the SDK would refuse unless
  // insecure http were allowed.
  const client = makeClient(noDefaultNexus);
  /**
   * A client whose calls go to one Builder's nexus endpoint.
   * @param {string} serviceEndpoint
   * @param {string} [tlsPubkeyHash]
   */
  const clientFor = (serviceEndpoint, tlsPubkeyHash = '') => makeClient(nexusTransport(serviceEndpoint, tlsPubkeyHash));
  return { id, hub, taskReader, client, clientFor, businessDenom, evmChainId, disconnect };
}

/**
 * Run `fn` until it stops failing with a retriable error, for chain state that is not there yet.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number, intervalMs?: number, label?: string }} [opts]
 * @returns {Promise<T>}
 */
export async function poll(fn, opts = {}) {
  const attempts = opts.attempts ?? 60;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof TrueOpenError) || !e.retriable || i >= attempts) throw e;
      console.log(`${opts.label ?? 'waiting'}: ${e.code} (${i}/${attempts})`);
      await new Promise((r) => setTimeout(r, opts.intervalMs ?? 3000));
    }
  }
}

/**
 * Print JSON under a heading, with bigint values rendered as strings and bytes as hex.
 * @param {string} label
 * @param {unknown} obj
 */
export function show(label, obj) {
  console.log(`\n=== ${label} ===`);
  console.log(
    JSON.stringify(
      obj,
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v),
      2,
    ),
  );
}
