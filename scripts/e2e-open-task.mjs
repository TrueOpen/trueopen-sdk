#!/usr/bin/env node
/*
 * Reusable e2e test: walks the full path end to end -- create/reuse a session, pick a
 * model, read on-chain context, assemble a frozen TaskOrderV1, apply three-layer
 * signing, select Task Builders by task_builder_seed, and submit OpenTask (streaming) --
 * printing every parameter and the real response from each endpoint, and independently
 * verifying signatures locally (this proves the SDK's own signatures are self-consistent;
 * it says nothing about whether nexus actually accepted the order).
 *
 * Acceptance criterion: "accepted" is not enough -- ingress accepting a request does not
 * mean it landed on chain. The only authority is the **on-chain**
 * task/v1/task/<task_id>: only when the task exists AND its accepted_task_hash matches
 * the locally computed task_hash byte-for-byte does that prove the Keeper actually
 * accepted this order; task_phase then tells you how far it has progressed.
 *
 * nexus's taskStatus is informational only, never a criterion, for two reasons:
 *   1. In the contract, the stage / set_id / updated_at fields are marked "reserved,
 *      not populated" (see GetTaskStatusResponse in wire proto/nexus/v1/ingress.proto),
 *      so waiting for updated_at != 0 can never succeed;
 *   2. nexus's FSM lags behind the chain -- in practice it only moves to ASSIGNED after
 *      winner_confirm lands on chain.
 * The on-chain pipeline takes roughly 10 blocks from submission to RECEIPT_COMMITTED
 * (devnet ~5s/block, so about 55s), so the default polling window is sized accordingly;
 * a shorter window will produce false negatives.
 *
 * No secrets included: the mnemonic is only ever read from --key-file or
 * TRUEOPEN_MNEMONIC.
 *
 * Prerequisite: run `npm run build` first (this script imports the current SDK from
 * dist/index.js).
 *
 * Usage:
 *   TRUEOPEN_MNEMONIC="word1 ... word24" node scripts/e2e-open-task.mjs
 *   node scripts/e2e-open-task.mjs --key-file /tmp/trueopen-mnemonic.txt
 *
 * Optional flags:
 *   --key-file <path>     mnemonic file (otherwise falls back to TRUEOPEN_MNEMONIC)
 *   --rest <url>          REST endpoint (default http://<rest-host>:1317)
 *   --rpc <url>           RPC endpoint (default http://<rpc-host>:26657)
 *   --chain-id <id>       chain id (default: read automatically from node_info)
 *   --model-id <id>       target model (default: devnet seed model)
 *   --session <id>        reuse an existing session (skip on-chain creation)
 *   --seq <n>             order_sequence (default: read from on-chain StreamState;
 *                         pass this explicitly only to rebroadcast via RBF)
 *   --idempotency-key <k> idempotency key (default: <session>:<seq>)
 *   --poll <n>            number of polls after submission (default 18, 5s interval,
 *                         about 90s total; 0 = no polling). Each round reads both the
 *                         on-chain task and nexus taskStatus; polling ends early once
 *                         the chain reaches RECEIPT_COMMITTED.
 *   --max-output-tokens <n>      max generated tokens (default 128). This is signed
 *                                into task_hash, and the worker must honor it; too
 *                                small a value hard-truncates the answer mid-sentence
 *   --max-output-duration-ms <n>  max generation duration in ms (default 60000)
 *   --prompt <text>       prefix for the input body (default "trueopen e2e open-task");
 *                         the script always appends " @ <ISO timestamp>" because nexus
 *                         dedupes payloads by content hash, so resending the same text
 *                         would be rejected
 *   --stream              streaming retrieval: subscribe to SubscribeOutput as soon as
 *                         winner_confirm lands on chain, verify signatures and the MMR
 *                         root frame by frame as output is generated, without waiting
 *                         for the receipt. Once frames arrive, skip the full-output fetch.
 *   --stream-idle <s>     idle timeout for a single stream, in seconds (default 20);
 *                         on timeout, resubscribe to another endpoint carrying the
 *                         verifier checkpoint
 *   --stream-break-after <n>  fault injection: deliberately drop the stream once after
 *                         receiving the n-th frame, to exercise resubscription with a
 *                         non-empty checkpoint (a live chain naturally never disconnects
 *                         mid-stream). 0 = disabled
 *   --nexus-url <url>         bypass the on-chain descriptor and point at a nexus
 *                         endpoint manually (default: discover the route on chain)
 *   --nexus-tls-pubkey-hash <hex>  pin the certificate fingerprint for the https
 *                         endpoint given via --nexus-url (64 hex chars; required for
 *                         https endpoints since the certificate is self-signed and CA
 *                         chain validation will always fail)
 *   --no-fetch-output     after the on-chain receipt appears, don't fetch the plaintext
 *                         output
 *   --output-timeout <s>  per-endpoint timeout when fetching output (default 60)
 *   --no-submit           only assemble, sign, and verify locally; don't send to nexus
 *   --json                print only the full JSON (by default a human-readable summary
 *                         is also printed)
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Bip39, Slip10, Slip10Curve, EnglishMnemonic, stringToPath } from '@cosmjs/crypto';

const SDK = new URL('../dist/index.js', import.meta.url);
const {
  TrueOpenClient, HubReader, connectTrueOpenChainClient, IngressClient,
  privKeySecp256k1Signer, privKeyEip712Signer, recoverEip712PubKey,
  secp256k1PublicKey, ethSecp256k1Address, verifyCosmosSecp256k1, taskOrderEip712Digest,
  resolveTaskOrderContext, buildTaskOrder, defaultGenerationParams,
  buildOpenTaskRequest, resolveTaskBuilderEndpoints,
  taskOrderHashHex, deriveTaskId, orderEnvelopeSigningBytes, sdkRequestSignBytes,
  decodeSignedOrder, TASK_TYPE, DEADLINE_LATENCY_CLASS, nexusIngressTransport, RestChainReader,
  TRUEOPEN_HD_PATH, EthSecp256k1DirectSigner, PARTICIPANT_TYPE,
} = await import(SDK);

// ---- args ----
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);

const REST = flag('--rest', process.env.TRUEOPEN_REST || 'http://<rest-host>:1317');
const RPC = flag('--rpc', process.env.TRUEOPEN_RPC || 'http://<rpc-host>:26657');
const PREFIX = 'trueopen';
const MODEL_ID = flag('--model-id', process.env.TRUEOPEN_MODEL_ID
  || 'hf-ad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b');
const REUSE_SESSION = flag('--session', undefined);
const SEQ_OVERRIDE = flag('--seq', undefined);
const POLL_TIMES = Number(flag('--poll', '18'));
// The input body. Always append a timestamp: nexus's payload store dedupes by content
// hash, so resending the same sentence would collide with NEXUS_DATA_CONFLICT.
// --prompt only changes the prefix, it doesn't remove this constraint.
const PROMPT = flag('--prompt', 'trueopen e2e open-task');
// Output cap. It's signed into GenerationParamsV1 -> task_hash, so it's part of the
// order content and the worker must honor it. 128 is small enough that a few sentences
// get hard-truncated mid-sentence (observed in practice), hence it's tunable.
const MAX_OUTPUT_TOKENS = BigInt(flag('--max-output-tokens', '128'));
const MAX_OUTPUT_DURATION_MS = BigInt(flag('--max-output-duration-ms', '60000'));
const FETCH_OUTPUT = !has('--no-fetch-output');
// Streaming retrieval: subscribe as soon as winner_confirm lands on chain, receiving
// frames as they're generated, without waiting for the receipt.
const STREAM = has('--stream');
// Idle cap for a single stream. If the subscription starts before the Worker begins
// producing output, nexus will keep the stream open without pushing data, so this is
// what breaks out and triggers a retry.
const STREAM_IDLE_MS = Number(flag('--stream-idle', '20')) * 1000;
// Fault injection: deliberately drop the stream once after the N-th frame, to force the
// "resubscribe with a non-empty checkpoint" code path to run. On a live chain, either no
// frame ever arrives (subscribed too early) or the whole stream comes through in one go
// -- a mid-stream disconnect naturally never happens, yet that's exactly what the
// resumable-stream feature exists for, so without injecting it, it can never be verified.
// Only drops once; everything after that is received normally.
const STREAM_BREAK_AFTER = Number(flag('--stream-break-after', '0'));
// Retrieval still has a cap: the peer might keep the connection open without pushing
// data, and without a timeout the script would hang forever.
// (An earlier version of this comment claimed "SubscribeOutput doesn't push data in
//  practice" -- no longer true: nexus now pushes frames in real time, observed at
//  roughly 4 frames/sec. It only hangs when the subscription starts before the Worker
//  begins producing output, which is covered by STREAM_IDLE_MS.)
const OUTPUT_TIMEOUT_MS = Number(flag('--output-timeout', '60')) * 1000;
const DO_SUBMIT = !has('--no-submit');
const JSON_ONLY = has('--json');

const keyFile = flag('--key-file', undefined);
const mnemonic = (keyFile ? readFileSync(keyFile, 'utf8') : (process.env.TRUEOPEN_MNEMONIC || '')).trim();
if (!mnemonic) {
  console.error('Mnemonic required: set TRUEOPEN_MNEMONIC or pass --key-file <path>');
  process.exit(2);
}

const sha256 = (u) => new Uint8Array(createHash('sha256').update(Buffer.from(u)).digest());
const hex = (u) => Buffer.from(u).toString('hex');
/** Recursively convert byte strings to hex (bigints are handled by the top-level replacer), so TaskOrderV1 reads directly. */
const jsonSafe = (v) => {
  if (v instanceof Uint8Array) return hex(v);
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
};
const log = (...a) => { if (!JSON_ONLY) console.error(...a); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- identity ----
const seed = await Bip39.mnemonicToSeed(new EnglishMnemonic(mnemonic));
const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, stringToPath(TRUEOPEN_HD_PATH));
const signer = privKeySecp256k1Signer(privkey);   // sha256 scheme, 64 bytes: outer order signature + request envelope
const orderSigner = privKeyEip712Signer(privkey);  // keccak scheme, 65 bytes: order EIP-712 + task data plane
const pubKey = secp256k1PublicKey(privkey);
// As of wire v0.4.1 the address is EVM-style: bech32(keccak256(uncompressed_XY)[12:32]).
const address = ethSecp256k1Address(pubKey, PREFIX);
// The order's EIP-712 needs a numeric EVM chain ID and a fee denom; neither is part of
// TaskOrderV2. The EVM chain ID defaults to reading params.phase0.evm_chain_id on chain
// (see below), rather than being hardcoded.
const EVM_CHAIN_ID_FLAG = flag('--evm-chain-id', undefined);
const FEE_DENOM = flag('--fee-denom', 'uusdc');

// ---- chain_id (auto) ----
let CHAIN_ID = flag('--chain-id', undefined);
if (!CHAIN_ID) {
  const ni = await fetch(`${REST}/cosmos/base/tendermint/v1beta1/node_info`).then((r) => r.json()).catch(() => ({}));
  CHAIN_ID = ni?.default_node_info?.network || ni?.node_info?.network;
  if (!CHAIN_ID) { console.error('Could not auto-detect chain_id; pass --chain-id'); process.exit(2); }
}

// ---- pick model (read-only validation) ----
const modelRes = await fetch(`${REST}/TrueOpen/hub/v1/model/${encodeURIComponent(MODEL_ID)}`)
  .then((r) => r.json()).catch(() => ({}));
const activeModel = modelRes.model;
if (!activeModel) { console.error(`Model does not exist: ${MODEL_ID}`); process.exit(2); }

// ---- wire up dependencies ----
// On-chain endpoints may be grpc:// or https://; normalization happens inside the SDK.
// For https endpoints, the nexus certificate's public key is checked against the
// tls_pubkey_hash registered on chain -- https is never downgraded to http.
const nexusTransport = (url, tlsPubkeyHash = '') => nexusIngressTransport(url, tlsPubkeyHash);
const hub = new HubReader({ baseUrl: REST, fetch: (u) => fetch(u) });
// On-chain params.phase0.evm_chain_id feeds the EIP-712 domain separator; --evm-chain-id
// only overrides it.
const EVM_CHAIN_ID = EVM_CHAIN_ID_FLAG !== undefined ? BigInt(EVM_CHAIN_ID_FLAG) : await hub.getEvmChainId();
log(`evm_chain_id = ${EVM_CHAIN_ID}${EVM_CHAIN_ID_FLAG !== undefined ? ' (overridden by --evm-chain-id)' : ' (read from chain)'}`);

// ethsecp256k1 direct signer: node's DIRECT path verifies keccak256(SignDoc) and expects
// an ethsecp256k1 public key -- CosmJS's DirectSecp256k1HdWallet matches none of the three.
const wallet = new EthSecp256k1DirectSigner(privkey, PREFIX);
const conn = await connectTrueOpenChainClient({
  rpcUrl: RPC, restUrl: REST, signer: wallet, signerAddress: address,
  // Can't use 'auto': CosmJS's gas simulation sets the sign mode to
  // SIGN_MODE_UNSPECIFIED, but node's ante handler only accepts SIGN_MODE_DIRECT, so the
  // simulation step gets rejected.
  fee: { amount: [{ denom: FEE_DENOM, amount: flag('--fee-amount', '7500') }], gas: flag('--gas', '300000') },
});

const client = new TrueOpenClient({
  chainId: CHAIN_ID, userAddress: address, signerPubKey: pubKey, signer, orderSigner,
  evmChainId: EVM_CHAIN_ID, feeDenom: FEE_DENOM,
  chain: conn.client, ingressTransport: nexusTransport('http://nexus.unused.invalid'),
  addressPrefix: PREFIX, hub, ingressTransportFactory: nexusTransport,
});

// ---- 1) session ----
let sessionId;
if (REUSE_SESSION) {
  sessionId = REUSE_SESSION;
  log(`Reusing session ${sessionId}`);
} else {
  const session = await client.createSession('e2e-open-task');
  sessionId = session.sessionId;
  log(`Created session ${sessionId}`);
}

// The sole authority for order_sequence is the on-chain
// StreamState.next_expected_sequence: a local counter that drifts out of sync never
// self-heals (this counter only advances when the Keeper accepts an order). --seq is
// only for rebroadcasting the same sequence via RBF.
const ORDER_SEQ = SEQ_OVERRIDE === undefined ? await client.nextOrderSequence(sessionId) : BigInt(SEQ_OVERRIDE);
log(`order_sequence=${ORDER_SEQ}${SEQ_OVERRIDE === undefined ? ' (read from chain)' : ' (overridden by --seq)'}`);

// ---- 2) payload (plaintext V1) ----
const payload = new TextEncoder().encode(`${PROMPT} @ ${new Date().toISOString()}`);
const payloadHash = hex(sha256(payload));

// ---- 3) on-chain context (anchor / builder set / bucket version, all signed) ----
const ctx = await resolveTaskOrderContext(hub, CHAIN_ID);

// ---- 4) assemble the frozen order ----
// The profile's pricing constraints only exist on chain: the Keeper requires
//   worker      = floor(max_output_tokens x price_bid / 1e6)
//   order_value = worker + floor(worker x verify_ratio_bps / 1e4) >= min_order_value
// If too low, nexus will accept it but the chain will reject it afterward
// ("order_value is below the profile minimum"), so here we back-solve the minimum
// price_bid from the profile and add a 20% margin.
const profile = await hub.getProfile(activeModel.model_id, BigInt(activeModel.latest_profile_version || 1));
const PRICING = profile.pricing;
function minPriceBid(target, tokens, ratioBps) {
  const denom = 10_000n + ratioBps;
  const worker = (target * 10_000n + denom - 1n) / denom || 1n;
  return (worker * 1_000_000n + tokens - 1n) / tokens;
}
const PRICE_BID = BigInt(
  flag('--price-bid', ((minPriceBid(PRICING.minOrderValue, MAX_OUTPUT_TOKENS, PRICING.verifyRatioBps) * 12n) / 10n).toString()),
);
const workerMax = (MAX_OUTPUT_TOKENS * PRICE_BID) / 1_000_000n;
const ORDER_VALUE = workerMax + (workerMax * PRICING.verifyRatioBps) / 10_000n;
const MAX_FEE = ORDER_VALUE * 10n;
log(`Profile pricing: min_order_value=${PRICING.minOrderValue} verify_ratio_bps=${PRICING.verifyRatioBps}`);
log(`Derived price_bid=${PRICE_BID} -> order_value=${ORDER_VALUE} (max_fee=${MAX_FEE})`);

const order = buildTaskOrder(ctx, {
  userAddress: address, sessionId, orderSequence: ORDER_SEQ,
  modelId: activeModel.model_id,
  profileVersion: Number(activeModel.latest_profile_version || 1),
  taskType: TASK_TYPE.TEXT_GENERATION,
  payload,
  inputBucket: 1, outputBudgetBucket: 1,
  generationParams: defaultGenerationParams(MAX_OUTPUT_TOKENS, MAX_OUTPUT_DURATION_MS),
  amounts: {
    // price_bid is the **price per million tokens**, and order_value must still meet
    // the profile's min_order_value. Both only exist on chain, so they're derived from
    // the profile rather than hardcoded (--price-bid can override).
    priceBid: { atomicUnits: PRICE_BID.toString() },
    maxFee: { atomicUnits: flag('--max-fee', String(MAX_FEE)) },
    assignmentPriorityFee: { atomicUnits: '0' },
    txFeeReserve: { atomicUnits: '0' },
  },
  earliestSubmitHeight: ctx.latestHeight,
  orderExpireHeight: ctx.latestHeight + 50_000n,
  latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
}, PRICING);

const taskId = deriveTaskId(sessionId, ORDER_SEQ);
const idempotencyKey = flag('--idempotency-key', `${sessionId}:${ORDER_SEQ}`);
// expiry must be a block height, and must fall within
// [currentHeight, currentHeight + RequestTTLBlocks]; RequestTTLBlocks defaults to 20
// (nexus taskdata/authorizer.go:327). We use 10 to leave margin for block production.
const expiryHeight = ctx.latestHeight + BigInt(flag('--expiry-blocks', '10'));

// ---- 5) three-layer signing ----
const built = await buildOpenTaskRequest({
  order, payload, sessionId, taskId, expiryHeight,
  orderEip712: { evmChainId: EVM_CHAIN_ID, feeDenom: FEE_DENOM },
  // v0.4.1's TaskDataRequestAuthV1 requires request_nonce to be exactly 32 bytes.
  requestNonce: crypto.getRandomValues(new Uint8Array(32)),
  idempotencyKey, orderSigner, signer, signerPubKey: pubKey,
});

// Independent local signature verification: each of the three signatures verifies on
// its own, and the schemes are never mixed.
const innerSig = decodeSignedOrder(built.input.orderEnvelope).userSignature;
const outerBytes = orderEnvelopeSigningBytes(CHAIN_ID, address, sessionId, ORDER_SEQ, built.orderEnvelopeHex);
const re = built.input.requestEnvelope;
const localChecks = {
  task_hash_matches: built.taskHash === taskOrderHashHex(order),
  // The inner signature covers the order's EIP-712 digest (task_hash is one of its
  // bytes32 fields); it's a 65-byte recoverable signature.
  inner_signature_length_65: innerSig.length === 65,
  inner_signature_recovers_to_user_pubkey:
    hex(recoverEip712PubKey(taskOrderEip712Digest(order, { evmChainId: EVM_CHAIN_ID, feeDenom: FEE_DENOM }), innerSig)) ===
    hex(pubKey),
  // Negative check: verifying the inner signature under the Cosmos
  // "sha256-then-verify" scheme must fail, proving the two schemes are never confused.
  inner_signature_rejected_by_hashing_scheme: !verifyCosmosSecp256k1(
    Buffer.from(built.taskHash, 'hex'), innerSig, pubKey,
  ),
  outer_signature_valid: verifyCosmosSecp256k1(outerBytes, built.input.signature, pubKey),
  request_envelope_signature_valid: verifyCosmosSecp256k1(sdkRequestSignBytes(re), re.signature, re.signerPubKey),
};

// ---- 6) Task Builder routing (seeded with the same anchor / set hash signed into the order) ----
let routed = await resolveTaskBuilderEndpoints(hub, {
  chainId: CHAIN_ID, taskId,
  builderSetHash: ctx.builderSetHash,
  sessionAnchorBlockHash: ctx.sessionAnchorBlockHash,
});

// Manual override: the on-chain descriptor can be wrong (observed after a devnet reset:
// uri=grpc:// while the service actually sits behind TLS, with tls_pubkey_hash left
// empty). --nexus-url + --nexus-tls-pubkey-hash bypass the bad descriptor and connect
// directly to https with a pinned fingerprint. openTask / streamOutput / ackOutput don't
// need builder_address (only the full-fetch fetchTaskOutput compares it byte-for-byte),
// so pointing at a single endpoint manually is safe.
const NEXUS_URL_OVERRIDE = flag('--nexus-url', undefined);
if (NEXUS_URL_OVERRIDE) {
  const NEXUS_TLS_HASH = flag('--nexus-tls-pubkey-hash', '');
  if (NEXUS_URL_OVERRIDE.startsWith('https://') && NEXUS_TLS_HASH === '') {
    console.error('An https endpoint requires --nexus-tls-pubkey-hash as well (the certificate is self-signed, so CA chain validation will always fail)');
    process.exit(2);
  }
  routed = {
    ...routed,
    endpoints: [{ address: '', rank: 1, serviceEndpoint: NEXUS_URL_OVERRIDE, tlsPubkeyHash: NEXUS_TLS_HASH }],
  };
  log(`nexus override: ${NEXUS_URL_OVERRIDE}${NEXUS_TLS_HASH ? ` (pinned fingerprint ${NEXUS_TLS_HASH.slice(0, 12)}...)` : ''}`);
}

// ---- 7) submit (fan out concurrently to every Task Builder, capturing each endpoint's real response) ----
//
// Must be concurrent, not awaited one at a time: the request envelope's expiry_height
// only allows --expiry-blocks (default 10) blocks, while a single endpoint's
// handshake+submit takes 4-5s in practice. If done serially and the chain is fast
// (~1s/block has been observed), the window expires by the time we reach the second or
// third endpoint and nexus returns NEXUS_DATA_EXPIRED -- the whole point of submitting
// redundantly is to not depend on any single Builder being alive, and serializing it
// throws that redundancy away. Widening the expiry would paper over the problem rather
// than fix it: a larger signed window is also a larger replay window.
const acks = [];
if (DO_SUBMIT) {
  const settled = await Promise.all(routed.endpoints.map(async (ep) => {
    const base = { rank: ep.rank, address: ep.address, endpoint: ep.serviceEndpoint };
    const ic = new IngressClient(nexusTransport(ep.serviceEndpoint, ep.tlsPubkeyHash ?? ""));
    try {
      const ack = await ic.openTask(built.input);
      return { ...base, ack: { accepted: ack.accepted, taskId: ack.taskId, reason: ack.reason } };
    } catch (e) {
      return { ...base, error: { code: e.code, message: String(e.message || e).slice(0, 300) } };
    }
  }));
  acks.push(...settled);
}
// The moment submission completes: every later t+Ns is measured from this origin, to
// stay consistent with "elapsed time from submit to receiving output".
const submittedAt = Date.now();

// ---- 8) polling: on-chain state is the acceptance criterion, nexus taskStatus is informational only ----

/** On-chain task snapshot; returns null if not yet on chain (the gateway omits the task field for a nonexistent task). */
async function queryChainTask(id) {
  const body = await fetch(`${REST}/TrueOpen/task/v1/task/${id}`).then((r) => r.json()).catch(() => null);
  const core = body?.task?.active?.core;
  if (!core) return null;
  const asg = body.task.active.assignment ?? {};
  return {
    task_phase: core.task_phase ?? '',
    assignment_status: core.assignment_status ?? '',
    accepted_task_hash: core.accepted_task_hash ?? '',
    order_value: core.order_value?.atomic_units ?? '',
    created_height: core.created_height ?? '',
    updated_height: core.updated_height ?? '',
    assign_accept_height: asg.assign_accept_height ?? '',
    winner_confirm_height: asg.winner_confirm_height ?? '',
    // Streaming retrieval uses this to fetch the Worker's service public key from
    // chain; it's available as soon as winner_confirm lands on a block, a full
    // generation cycle ahead of the receipt.
    winner_worker: asg.winner_worker ?? '',
  };
}

/**
 * Measure the actual block interval, in seconds. Polling faster than block production
 * is pointless -- state only changes when a block lands -- so the interval tracks the
 * measured value instead of a hardcoded constant: the same devnet has been observed to
 * run at ~5s/block and ~1s/block across restarts. Hardcoding 5s wastes time on a fast
 * chain; hardcoding 2s spins uselessly on a slow one.
 */
async function measureBlockSeconds(span = 5n) {
  try {
    const at = async (h) => {
      const path = h === null
        ? `${REST}/cosmos/base/tendermint/v1beta1/blocks/latest`
        : `${REST}/cosmos/base/tendermint/v1beta1/blocks/${h}`;
      const b = await fetch(path).then((r) => r.json());
      return { h: BigInt(b.block.header.height), t: Date.parse(b.block.header.time) };
    };
    const tip = await at(null);
    if (tip.h <= span) return null;
    const back = await at(tip.h - span);
    const dt = (tip.t - back.t) / 1000 / Number(span);
    return dt > 0 && dt < 60 ? dt : null;
  } catch {
    return null;
  }
}

/** Find an accepted endpoint in rank order; fall back to all candidates when there's no ack record. */
function streamCandidates() {
  const accepted = acks.filter((a) => a.ack?.accepted === true).map((a) => a.endpoint);
  const eps = routed.endpoints.filter((e) => accepted.length === 0 || accepted.includes(e.serviceEndpoint));
  return eps.length > 0 ? eps : routed.endpoints;
}

/**
 * Streaming retrieval (contract §3.5 / ADR-0017). The key difference from a full-output
 * fetch: **no receipt required**. Every frame carries the Worker's signature over
 * TRUEOPEN_OUTPUT_CHUNK_V1(chain_id, task_hash, seq, mmr_root); each frame is verified
 * locally and the MMR root over the first seq+1 leaves is recomputed -- any mismatch
 * stops the stream immediately.
 *
 * The only prerequisite is the Worker's service public key, which in turn requires
 * knowing winner_worker -- a field that's available as soon as the winner_confirm block
 * lands on chain, a full generation cycle ahead of the receipt. So this is kicked off by
 * the polling loop the moment it sees winner_worker; in practice the first frame arrives
 * about 30s before the receipt lands on chain.
 */
async function startStream(winnerWorker) {
  const t0 = Date.now();
  const binding = await hub.getCurrentServiceKey(PARTICIPANT_TYPE.CORTEX, winnerWorker);
  const overallDeadline = t0 + OUTPUT_TIMEOUT_MS * 3;
  const frames = [];
  const attempts = [];
  // The checkpoint holds the last sequence number, the MMR peaks, and the verified
  // chunks; seq alone can't restore the accumulated verification state. When switching
  // Builders, the full checkpoint is handed to the new verifier; a stale replay of
  // seq=0 is still strictly re-verified and then deduplicated.
  let resumeAfterSeq;
  let checkpoint;
  // Only inject the fault once; after it fires, let the stream finish normally,
  // otherwise fin never arrives.
  let breakArmed = STREAM_BREAK_AFTER > 0;
  // Record the actual resubscription that carries a non-empty checkpoint, as evidence
  // that this path was exercised.
  let resumedFromSeq = null;

  while (Date.now() < overallDeadline) {
    for (const ep of streamCandidates()) {
      if (Date.now() >= overallDeadline) break;
      const resumingFrom = checkpoint !== undefined ? checkpoint.mmr.leafCount - 1n : null;
      if (resumingFrom !== null && resumedFromSeq === null) resumedFromSeq = resumingFrom.toString();
      const sc = new TrueOpenClient({
        chainId: CHAIN_ID, userAddress: address, signerPubKey: pubKey, signer, orderSigner,
        evmChainId: EVM_CHAIN_ID, feeDenom: FEE_DENOM, chain: conn.client,
        ingressTransport: nexusTransport(ep.serviceEndpoint, ep.tlsPubkeyHash ?? ''),
        addressPrefix: PREFIX, hub,
      });
      const iter = sc.streamOutput({
        sessionId, taskId,
        taskHash: built.taskHash,
        workerServicePubKey: binding.servicePubKey,
        ...(checkpoint !== undefined ? { checkpoint, resumeAfterSeq: checkpoint.mmr.leafCount - 1n } : {}),
        onCheckpoint: (next) => { checkpoint = next; streamCheckpoint = next; },
        // Endpoint rotation and the overall deadline are tracked as diagnostics by this
        // script; a single SDK subscription doesn't retry internally.
        maxAttempts: 1,
      })[Symbol.asyncIterator]();
      const before = frames.length;
      try {
        // Race each next() against an idle timer. Can't use `for await` + an outer
        // setTimeout: in practice nexus can leave the stream open without pushing any
        // data (this always happens if the subscription starts before the Worker
        // begins producing output), and in that case next() never settles --
        // iter.return() can't interrupt an already-pending await, so the whole script
        // would hang here.
        for (;;) {
          let timer;
          const idle = new Promise((_r, reject) => {
            timer = setTimeout(() => reject(new Error(`idle for ${STREAM_IDLE_MS / 1000}s with no frame`)), STREAM_IDLE_MS);
          });
          let step;
          try {
            step = await Promise.race([iter.next(), idle]);
          } finally {
            clearTimeout(timer);
          }
          if (step.done) break;
          const f = step.value;
          frames.push({ seq: f.seq.toString(), at_ms: Date.now() - t0, text: f.text });
          resumeAfterSeq = f.seq;
          if (breakArmed && frames.length >= STREAM_BREAK_AFTER) {
            breakArmed = false;
            throw new Error(`Injected stream break (received ${frames.length} frames, seq=${f.seq})`);
          }
        }
        if (frames.length === 0) throw new Error('stream ended normally but no frames were received');
        log(`Stream finished: ${ep.serviceEndpoint}, ${frames.length} frames, first frame +${frames[0].at_ms}ms, elapsed ${Date.now() - t0}ms`);
        return {
          endpoint: ep.serviceEndpoint, builder_address: ep.address,
          winner_worker: winnerWorker,
          worker_service_pubkey: hex(binding.servicePubKey),
          frame_count: frames.length,
          first_frame_ms: frames[0].at_ms,
          last_frame_ms: frames[frames.length - 1].at_ms,
          finished_ms: Date.now() - t0,
          attempts,
          // Non-null proves the "resubscribe with a non-empty checkpoint" path was
          // actually exercised: subsequent frames continue from the verified seq
          // instead of restarting from scratch.
          resumed_from_seq: resumedFromSeq,
          // Reaching here means streamOutput received fin, and fin's root matches the
          // root computed frame by frame.
          per_frame_verified: true,
          output_text: frames.map((f) => f.text).join(''),
          frames,
        };
      } catch (e) {
        iter.return?.().catch(() => {});
        attempts.push({
          at_ms: Date.now() - t0, endpoint: ep.serviceEndpoint,
          got_frames: frames.length - before,
          resume_after_seq: resumeAfterSeq?.toString() ?? null,
          message: String(e.message || e).slice(0, 200),
        });
        log(`  Stream retry: ${ep.serviceEndpoint} received ${frames.length - before} frames this round -- ${String(e.message || e).slice(0, 120)}`);
      }
    }
    await sleep(2000);
  }
  return { error: `Streaming retrieval timed out (${(OUTPUT_TIMEOUT_MS * 3) / 1000}s)`, attempts, partial_frames: frames.length };
}

const chainReader = new RestChainReader({ baseUrl: REST, fetch: (u) => fetch(u) });
const polls = [];
let chainTask = null;
// Values picked up incidentally during polling, to avoid two extra round trips after
// spotting the receipt (measured at ~2s for those two round trips).
let receiptFromPoll = null;
let heightAtReceipt = null;
// Streaming: subscribe as soon as winner_worker appears, without waiting for the
// receipt. It runs concurrently with polling.
let streamTask = null;
let streamInfo = null;
let streamCheckpoint = null;

if (DO_SUBMIT && POLL_TIMES > 0) {
  const ic = routed.endpoints.length > 0
    ? new IngressClient(nexusTransport(routed.endpoints[0].serviceEndpoint, routed.endpoints[0].tlsPubkeyHash ?? ""))
    : null;
  const blockSeconds = await measureBlockSeconds();
  // Use half the block time, clamped to [1s, 5s]: polling twice as fast as block
  // production is enough to catch state transitions; faster than that just spins idle.
  const pollMs = Math.round(Math.min(5000, Math.max(1000, (blockSeconds ?? 5) * 500)));
  log(`Block time ${blockSeconds === null ? 'unknown' : `${blockSeconds.toFixed(2)}s`} -> poll interval ${pollMs}ms`);

  for (let i = 0; i < POLL_TIMES; i++) {
    const row = { t: Math.round((Date.now() - submittedAt) / 1000) };
    chainTask = await queryChainTask(taskId);
    row.chain_phase = chainTask?.task_phase ?? '(not on chain)';
    if (ic) {
      try {
        const st = await ic.getTaskStatus(sessionId, taskId);
        row.nexus_state = st.state;
        row.nexus_phase = st.taskPhase;
      } catch (e) {
        row.nexus_error = String(e.message || e).slice(0, 200);
      }
    }
    polls.push(row);
    log(`  [t+${row.t}s] chain=${row.chain_phase}  nexus=${row.nexus_state ?? row.nexus_error ?? '-'}/${row.nexus_phase ?? ''}`);

    if (STREAM && streamTask === null && chainTask?.winner_worker) {
      row.stream_started = true;
      log(`  winner_worker=${chainTask.winner_worker} -> starting stream (not waiting for receipt)`);
      streamTask = startStream(chainTask.winner_worker).then(
        (r) => { streamInfo = r; },
        (e) => { streamInfo = { error: String(e.message || e).slice(0, 300) }; },
      );
    }

    // Once the receipt lands on chain, output has been produced and there's no need to
    // keep waiting. Fetch the receipt and current chain height together here: the
    // fetch request's validity window is computed from the height **at fetch time**,
    // and both values are needed in the next step.
    if (chainTask?.task_phase === 'TASK_PHASE_RECEIPT_COMMITTED') {
      [receiptFromPoll, heightAtReceipt] = await Promise.all([
        chainReader.queryInferReceipt(taskId).catch(() => undefined),
        hub.getLatestHeight().catch(() => null),
      ]);
      break;
    }
    if (i < POLL_TIMES - 1) await sleep(pollMs);
  }
}

// The stream may finish after the receipt (fin is sent from the worker side), so wait
// for it to wrap up here.
if (streamTask !== null) await streamTask;

// The one authoritative criterion: the on-chain task exists AND its accepted_task_hash
// matches the locally computed task_hash byte-for-byte. "Task exists" alone isn't
// enough -- that only proves the task_id slot is occupied, not that the Keeper accepted
// the exact order we signed.
const landedOnChain = chainTask !== null && chainTask.accepted_task_hash === built.taskHash;

// Finishing the stream only means Worker-authenticated provisional. Once the receipt is
// available, the same checkpoint is upgraded to confirmed using its root/count/size;
// a historical or pruned receipt is never guessed at or substituted.
let streamConfirmation = null;
if (streamInfo?.frame_count > 0 && streamCheckpoint !== null) {
  let receipt = receiptFromPoll;
  const confirmationDeadline = Date.now() + OUTPUT_TIMEOUT_MS;
  while (!receipt && Date.now() < confirmationDeadline) {
    receipt = await chainReader.queryInferReceipt(taskId).catch(() => undefined);
    if (!receipt) await sleep(2000);
  }
  if (!receipt) {
    streamConfirmation = { confirmed: false, error: `InferReceipt not available within ${OUTPUT_TIMEOUT_MS / 1000}s` };
  } else {
    try {
      const event = client.confirmOutput({ taskId, taskHash: built.taskHash, checkpoint: streamCheckpoint, receipt });
      streamConfirmation = {
        confirmed: true,
        type: event.type,
        task_id: event.taskId,
        task_hash: event.taskHash,
        winner_worker: event.winnerWorker,
        infer_receipt_hash: event.inferReceiptHash,
        output_hash: event.outputHash,
        output_mmr_root: hex(event.outputMmrRoot),
        output_leaf_count: event.outputLeafCount.toString(),
        output_size_bytes: event.outputSizeBytes.toString(),
      };
      log(`Receipt confirmation: root/count/size all match`);
    } catch (e) {
      streamConfirmation = {
        confirmed: false,
        code: e?.code ?? '',
        error: String(e?.message || e).slice(0, 300),
      };
    }
  }
}

// ---- 9) fetch the plaintext output (data plane per contract §3.5/§3.6) ----
//
// v0.4.1 retrieval is content-addressed: TaskDataObjectRefV1 requires task_hash and
// content_hash, where the latter is the on-chain InferReceipt.output_hash (since
// ADR-0017 this is the MMR root over the chunk list). So we must wait for the Worker to
// submit the receipt first -- before that there's no object to locate and nothing to
// verify against.
let output = null;
const outputErrors = [];
// The stream has already verified the plaintext frame by frame, so a full re-fetch
// adds no new information -- unless both paths are explicitly requested.
const streamDelivered = streamInfo?.frame_count > 0;
if (FETCH_OUTPUT && DO_SUBMIT && landedOnChain && !streamDelivered) {
  // The polling loop already fetched the receipt incidentally, so avoid another round
  // trip here.
  const receipt = receiptFromPoll ?? (await chainReader.queryInferReceipt(taskId).catch(() => undefined));
  if (!receipt) {
    outputErrors.push({
      endpoint: '-',
      message: `InferReceipt not yet on chain (receipt_status=${chainTask?.core?.receipt_status ?? chainTask?.receipt_status ?? '?'}): ` +
        'the Worker has not submitted it yet, and without output_hash the object cannot be located. Increase --poll or rerun later.',
    });
    log(outputErrors[0].message);
  } else {
    const pinOf = (endpoint) => routed.endpoints.find((e) => e.serviceEndpoint === endpoint)?.tlsPubkeyHash ?? '';
    // The validity window is computed from the chain height **at fetch time**: a lot
    // of polling time may have passed, and using the height from order submission
    // would already be expired. The round that discovered the receipt already fetched
    // the chain height alongside it; only fetch it again if it's missing.
    const heightNow = heightAtReceipt ?? (await hub.getLatestHeight());
    for (const a of acks.filter((x) => x.ack?.accepted === true)) {
      try {
        const oc = new TrueOpenClient({
          chainId: CHAIN_ID, userAddress: address, signerPubKey: pubKey, signer, orderSigner,
          evmChainId: EVM_CHAIN_ID, feeDenom: FEE_DENOM,
          chain: conn.client, ingressTransport: nexusTransport(a.endpoint, pinOf(a.endpoint)),
          addressPrefix: PREFIX, hub,
        });
        const got = await Promise.race([
          oc.fetchTaskOutput({
            sessionId, taskId,
            taskHash: built.taskHash,
            outputHash: receipt.outputHash,
            builderAddress: a.address,
            expiresAtHeight: heightNow + 20n,
          }),
          new Promise((_r, reject) =>
            setTimeout(() => reject(new Error(`Output fetch timed out (${OUTPUT_TIMEOUT_MS / 1000}s)`)), OUTPUT_TIMEOUT_MS).unref(),
          ),
        ]);
        output = {
          endpoint: a.endpoint,
          builder_address: a.address,
          size_bytes: got.sizeBytes.toString(),
          media_type: got.mediaType,
          output_hash: got.outputHash,
          chunk_count: got.chunks.length,
          // fetchTaskOutput internally re-chunks by chunk_lengths, recomputes the MMR
          // root, and compares it against the receipt, throwing on mismatch --
          // reaching here means verification already passed.
          mmr_root_verified: true,
          output_text: got.text,
        };
        log(`Output retrieved (${a.endpoint}, ${got.sizeBytes} bytes, ${got.chunks.length} chunks): ${got.text.slice(0, 120)}`);
        break;
      } catch (e) {
        outputErrors.push({ endpoint: a.endpoint, message: String(e.message || e).slice(0, 300) });
      }
    }
    if (!output) log(`Failed to retrieve output: ${outputErrors.map((e) => e.message).join(' | ')}`);
  }
}


const out = {
  chain: { chainId: CHAIN_ID, rest: REST, rpc: RPC, userAddress: address, signerPubKeyHex: hex(pubKey) },
  model: { model_id: activeModel.model_id, status: activeModel.status, latest_profile_version: activeModel.latest_profile_version },
  session: { sessionId, orderSequence: ORDER_SEQ.toString(), reused: !!REUSE_SESSION },
  chain_context: {
    session_anchor_height: ctx.sessionAnchorHeight.toString(),
    session_anchor_block_hash: ctx.sessionAnchorBlockHash,
    builder_set_id: ctx.builderSetId,
    builder_set_hash: ctx.builderSetHash,
    timeout_bucket_version: ctx.timeoutBucketVersion.toString(),
    latest_height: ctx.latestHeight.toString(),
  },
  // Order body: the 25 fields signed into order_envelope. The envelope alone is just
  // hex and doesn't reveal the parameters, which are the full set of inputs that
  // determine task_hash, so they're expanded in full here.
  task_order_v2: jsonSafe(order),
  openTaskHeader: {
    order_envelope_bytes: built.input.orderEnvelope.length,
    order_envelope_hex: built.orderEnvelopeHex,
    payload_ref: built.input.payloadRef,
    user_signature_outer: hex(built.input.signature),
    user_signature_inner_over_task_hash: hex(innerSig),
    session_id: sessionId,
    order_sequence: ORDER_SEQ.toString(),
    user_address: address,
    signature_scheme: built.input.signatureScheme,
    input_size_bytes: String(payload.length),
    input_hash: built.input.inputHash,
    input_media_type: built.input.inputMediaType,
    idempotency_key: built.input.idempotencyKey,
    payload_text: new TextDecoder().decode(payload),
  },
  request_envelope: {
    request_domain: re.requestDomain, chain_id: re.chainId, method: re.method, endpoint: re.endpoint,
    session_id: re.sessionId, task_id: re.taskId,
    request_nonce: hex(re.requestNonce),
    expiry_height: re.expiryHeightOrTime?.toString?.() ?? String(re.expiryHeightOrTime ?? ''),
    body_digest: hex(re.bodyDigest), signer_address: re.signerAddress,
    signature: hex(re.signature), signer_pubkey: hex(re.signerPubKey),
  },
  derived: { task_id: taskId, task_hash: built.taskHash, payload_hash: payloadHash },
  local_verification: localChecks,
  task_builders: {
    builder_set_id: routed.builderSetId,
    selected: routed.endpoints.map((e) => ({ rank: e.rank, address: e.address, serviceEndpoint: e.serviceEndpoint })),
    resolveErrors: routed.errors.map((e) => String(e.error?.message ?? e.error)),
  },
  submit_result: DO_SUBMIT ? acks : 'skipped (--no-submit)',
  status_polls: polls,
  chain_task: chainTask,
  output,
  output_errors: outputErrors,
  stream: streamInfo,
  stream_confirmation: streamConfirmation,
  // accepted only means ingress took the request; landed_on_chain means the Keeper
  // actually accepted the exact order we signed.
  verdict: {
    any_accepted: acks.some((a) => a.ack?.accepted === true),
    landed_on_chain: landedOnChain,
    chain_task_phase: chainTask?.task_phase ?? '',
    output_delivered_by: streamDelivered ? 'stream' : output ? 'fetch' : '',
    output_confirmed: streamConfirmation?.confirmed === true,
  },
};

if (!JSON_ONLY) {
  log('----------------------------------------');
  log(`chain_id=${CHAIN_ID}  anchor=${ctx.sessionAnchorHeight} (${ctx.sessionAnchorBlockHash.slice(0, 16)}...)`);
  log(`session=${sessionId}  seq=${ORDER_SEQ}  model=${activeModel.model_id}`);
  log(`task_id=${taskId}`);
  log(`task_hash=${built.taskHash}`);
  log(`Local three-signature verification: ${JSON.stringify(localChecks)}`);
  for (const a of acks) {
    log(`  rank${a.rank} ${a.endpoint} -> ${a.ack ? (a.ack.accepted ? 'accepted OK' : `rejected: ${a.ack.reason}`) : `ERR ${a.error.code} ${a.error.message}`}`);
  }
  if (streamInfo?.frame_count) {
    log(`Stream: ${streamInfo.frame_count} frames @ ${streamInfo.endpoint}  first frame +${streamInfo.first_frame_ms}ms  finished +${streamInfo.finished_ms}ms  per-frame signature+root verification passed`);
  } else if (streamInfo?.error) {
    log(`Stream failed: ${streamInfo.error}`);
  }
  log(`Verdict: any_accepted=${out.verdict.any_accepted}  landed_on_chain=${out.verdict.landed_on_chain}  output_confirmed=${out.verdict.output_confirmed}  chain_task_phase=${out.verdict.chain_task_phase || '(not on chain)'}`);
  if (DO_SUBMIT) log(`Total time (submit -> output received): ${((Date.now() - submittedAt) / 1000).toFixed(1)}s  delivery path=${out.verdict.output_delivered_by || '(not retrieved)'}`);
  log('----------------------------------------');
}
console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

conn.signingClient?.disconnect?.();
