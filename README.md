# trueopen-sdk

> TypeScript client SDK for the TrueOpen decentralized AI inference network.
> Runtime-agnostic (Node >= 18 + modern browsers), dual ESM + CJS package.
> Version: `0.1.0` - wire version: `SDK_WIRE_V1`

---

## 1. Overview

`trueopen-sdk` is the runtime-agnostic TypeScript client SDK for the **TrueOpen decentralized AI inference network**. It wraps the full user flow -- place an order -> track it -> retrieve output -> open a challenge -- into a single facade class, `TrueOpenClient`, that supports dependency injection and unit testing.

### Two-layer signing

At the core of the SDK are **two independent signing layers**:

1. **User signs the `OrderEnvelope`** -- the user signs the order envelope (price / budget / model / session / sequence / deadline / anchor, etc.), producing `user_signature`. The canonical JSON for this layer is **byte-for-byte identical** to the on-chain `CanonicalAssignmentOrderEnvelopeV1` (Go `json.Marshal`); `task_id` is derived from it.
2. **SDK signs the nexus `SDKRequestEnvelope`** -- every request sent to the nexus IngressAPI is signed by an SDK-side signing key over the request envelope (domain + chainId + method + endpoint + session/task + nonce + expiry + `body_digest` + signerAddress). The `body_digest` is **byte-for-byte identical** to the one computed by the nexus oracle.

### The two backends the SDK talks to

| Backend | Protocol | Transport |
|---|---|---|
| **node chain** (Cosmos SDK) | read via REST gateway + write via CosmJS tx | `createTrueOpenChainClient(...)` |
| **nexus IngressAPI** | Connect RPC (gRPC / gRPC-web / Connect) | `@connectrpc/connect` `Transport` |

> **Hard rule**: the SDK never creates consensus facts. `ingress ack != on-chain accepted`; the on-chain query / event is always the final source of truth.

---

## 2. Installation / dependencies

```bash
npm install trueopen-sdk
```

- **Package name**: `trueopen-sdk`
- **Node**: `>= 18` (relies on built-in `fetch` / `globalThis.crypto` WebCrypto)
- **Package shape**: dual ESM + CJS + `.d.ts` (`exports` provides `import` / `require` / `types` at once)
- **`sideEffects: false`**, tree-shakeable

### Runtime dependencies (declared in `package.json`)

| Dependency | Purpose |
|---|---|
| `@noble/curves` | secp256k1 signing / verification (cross-platform, zero native deps) |
| `@noble/hashes` | SHA-256 (canonical JSON digest, chunk verification) |
| `@cosmjs/stargate` / `@cosmjs/proto-signing` | chain writes: `SigningStargateClient` broadcasts user txs, `OfflineSigner`, registry |
| `@connectrpc/connect` | Connect `Transport` abstraction for the nexus IngressAPI |
| `@bufbuild/protobuf` | protobuf-es runtime (output of `buf generate`) |

> The concrete nexus transport implementation is injected by the caller: `@connectrpc/connect-node` on Node, `@connectrpc/connect-web` in the browser. The SDK itself only depends on the abstract `Transport`.

---

## 3. Quick start

> The example below is **illustrative only**. Real endpoints, wallet / signer wiring, and fee policy depend on your deployment -- substitute your own.

```ts
import {
  TrueOpenClient,
  createTrueOpenChainClient,
  nexusIngressTransport,
  privKeySecp256k1Signer,
  secp256k1PublicKey,
} from 'trueopen-sdk';
import { createConnectTransport } from '@connectrpc/connect-node'; // use -web in the browser
import { SigningStargateClient } from '@cosmjs/stargate';

// --- 1. Build the chain client (REST reads + CosmJS writes) ---
// broadcaster satisfies TxBroadcaster (a SigningStargateClient works).
const broadcaster = await SigningStargateClient.connectWithSigner(/* rpcUrl, offlineSigner, opts */);

const chain = createTrueOpenChainClient({
  restUrl: 'https://rest.example-trueopen-node',
  signerAddress: 'trueopen1user...',
  // Use an explicit fee, not 'auto': CosmJS's gas simulation sets the sign mode to
  // SIGN_MODE_UNSPECIFIED, but node's ante handler only accepts SIGN_MODE_DIRECT, so the
  // simulation step itself gets rejected (see "On-chain writes" below).
  fee: { amount: [{ denom: 'uusdc', amount: '7500' }], gas: '300000' },
  broadcaster,
});
// Or do it in one async step: const { client: chain } = await connectTrueOpenChainClient({...})

// --- 2. Build the Connect transport for the nexus IngressAPI ---
const ingressTransport = createConnectTransport({
  baseUrl: 'https://ingress.example-trueopen-nexus',
  httpVersion: '2',
});

// --- 3. Two signers (the SDK never holds private keys; use a wallet / HSM in production) ---
// signer: hashes with sha256 then signs -- used for the outer order envelope and the SDK request envelope.
const signer = privKeySecp256k1Signer(userPrivKeyBytes);
const signerPubKey = secp256k1PublicKey(userPrivKeyBytes); // 33-byte compressed public key
// orderSigner: signs the **EIP-712 digest** (keccak), producing a 65-byte R‖S‖V -- used for
// SignedOrderV2 and the USER branch of the task data plane. Not interchangeable with the
// 64-byte sha256-based signature above.
const orderSigner = privKeyEip712Signer(userPrivKeyBytes);

// --- 4. Build the facade ---
// Use https once TLS is enabled on the node port (the deployment security baseline); for local
// testing use http://127.0.0.1:1317.
const hub = new HubReader({ baseUrl: 'https://node.example:1317', fetch: (u) => fetch(u) });
const client = new TrueOpenClient({
  chainId: 'trueopen-devnet-1',
  userAddress: 'trueopen1user...',
  signerPubKey,
  signer,
  orderSigner,
  chain,
  ingressTransport,
  // Required for openTask: reads on-chain context + picks an endpoint by task_builder_seed
  hub,
  // nexus endpoints verify their certificate against the on-chain descriptor's tls_pubkey_hash
  // (ADR-0015): an https endpoint with a fingerprint registered on-chain is checked against
  // that fingerprint, no downgrade allowed; an https endpoint without a registered fingerprint
  // falls back to http with a WARN during the transition period if the peer offers no TLS, or
  // is rejected if NEXUS_TLS_PUBKEY_HASH_REQUIRED=1 is set.
  ingressTransportFactory: (url, tlsPubkeyHash) => nexusIngressTransport(url, tlsPubkeyHash),
  // Optional: nonce / requestTtlBlocks (OpenTask's expiry is a block height, default +10 blocks)
});

// --- 5. Session -> place order -> track ---
const session = await client.createSession('demo');

const submitted = await client.openTask({
  sessionId: session.sessionId,
  orderSequence: 1n,
  // Required by contract §3.1; must stay identical across retries.
  idempotencyKey: `${session.sessionId}:1`,
  order: {
    modelId: 'hf-<64hex>',
    profileVersion: 1,
    taskType: TASK_TYPE.TEXT_GENERATION,
    payload: new Uint8Array(plaintextInputBytes), // input_hash / size are derived from this
    inputBucket: 1,
    outputBudgetBucket: 1,
    // Generation params go into task_hash and must be given explicitly (no implicit defaults)
    generationParams: defaultGenerationParams(128n, 60_000n),
    // Fees are Amount: the preimage uses decimal text atomic units, not numeric values
    amounts: {
      inferInputUnitPriceBid: { atomicUnits: '1' },
      inferOutputUnitPriceBid: { atomicUnits: '1' },
      verifyUnitPriceBid: { atomicUnits: '1' },
      inferFeeCap: { atomicUnits: '500' },
      verifyFeeCap: { atomicUnits: '400' },
      maxFee: { atomicUnits: '1000' },
      assignmentPriorityFee: { atomicUnits: '0' },
      txFeeReserve: { atomicUnits: '10' },
    },
    earliestSubmitHeight: currentHeight,
    orderExpireHeight: currentHeight + 50_000n,
    latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
  },
});
// submitted: { taskId, taskHash, context, endpointsTried, ...ack }
// ack only means local acceptance by nexus, not on-chain accepted -- whether the task lands
// on-chain is determined by taskStatus moving out of PENDING.

for await (const ev of client.watchTask(session.sessionId, submitted.taskId)) {
  // Events are UX hints only; the on-chain query is the source of truth for final state
  console.log(ev);
}
```

`TrueOpenClient` methods (see `src/client.ts` for the authoritative signatures):

| Method | Description |
|---|---|
| `createSession(label?)` / `getSession(sessionId)` | create / retrieve a session |
| `openTask({ sessionId, orderSequence, order, idempotencyKey })` | reads on-chain context -> builds the frozen `TaskOrderV2` -> three-layer signing -> selects Task Builders by `task_builder_seed` -> streams the OpenTask submission; returns `{ taskId, taskHash, context, endpointsTried, ...ack }` |
| `cancelOrder(sessionId, orderSequence)` | signs `owner_signature` + on-chain `MsgCancelOrder` |
| `taskStatus(sessionId, taskId)` | local nexus status snapshot (informational) |
| `watchTask(sessionId, taskId, fromCursor?)` | subscribes to the task event stream (`AsyncIterable`) |
| `fetchTaskOutput({ sessionId, taskId, taskHash, outputHash, builderAddress, expiresAtHeight })` | fetches the full output and recomputes the MMR root from `chunk_lengths` to verify it (see §4) |
| `streamOutput({ sessionId, taskId, taskHash, workerServicePubKey, checkpoint?, sources?, idleTimeoutMs?, finSignaturePolicy?, ack? })` | resumable streaming subscription to output, with per-frame signature and MMR-root verification and a verified terminal frame (see §4) |
| `confirmOutput({ taskId, taskHash, checkpoint, receipt })` | uses the on-chain Receipt's root / leaf count / size to upgrade provisional output to confirmed |
| `serializeOutputStreamCheckpoint()` / `deserializeOutputStreamCheckpoint()` | strictly encodes a verifier checkpoint into JSON V1, stable across Node/browser |
| `toOpenAIChatSSEIterable(events, context, opts?)` | Node / generic runtimes: verified events -> OpenAI-compatible SSE byte stream |
| `toOpenAIChatSSE(events, context, opts?)` | browser / Web API: returns a `ReadableStream<Uint8Array>` |
| `fetchOutputRef(sessionId, taskId, opts?)` | fetches a retrieval credential (superseded by §3.3/§3.4, see §4) |
| `prepareChallenge(sessionId, taskId, kind, localEvidenceDigest?)` | prepares challenge material (does not submit a verdict) |
| `challenge({ sessionId, taskId, settlementId, kind, evidenceDigest, bondAmount })` | signs `challenger_signature` + on-chain `MsgUserChallenge` |

---

## 4. Capability boundaries (important)

This section states plainly **which capabilities are already aligned with the real backend today, and which are still waiting on backend work**. Check every item before integrating.

### ✅ Ready and aligned with the real backend

- **OrderEnvelope canonical JSON + `user_signature`** -- the canonical JSON is **byte-for-byte identical** to node's `CanonicalAssignmentOrderEnvelopeV1` (Go `json.Marshal`): same field order, no whitespace, uint64 as numbers, `tx_fee_reserve` always present, empty `reference_bucket_key` / `timeout_bucket_key` omitted.
- **`task_id` derivation** -- derived from the order signature bytes.
- **cancel / userChallenge signing** -- the signing bytes for `owner_signature` / `challenger_signature`.
- **nexus `SDKRequestEnvelope` + per-method `body_digest`** -- the body_digest for `openTask` / `submitOrder` (deprecated) / `fetchOutputRef` / `getTaskEvents` / `refreshCredential` / `prepareChallenge` is **byte-for-byte identical** to nexus's.
- **EVM-style identity and EIP-712** -- the address `bech32(keccak256(uncompressed_XY)[12:32])`, and the type hash, domain separator, hash struct, signing digest and 65-byte signature for the three EIP-712 domains (`Cosmos Web3` / `TrueOpen Task Order` v2 / `TrueOpen Task Data Request` v1), all anchored to wire's
  `testdata/v1/shared/account_signing_v1.json`.
- **Task data plane authentication** -- the two body digests (METADATA / FETCH), together with their preimages, are anchored to `testdata/v1/task/task_data_auth_v1.json`; the USER branch's EIP-712 and the CORTEX_SERVICE branch's H_FIELDS_V1 are each cross-checked separately. **Verified against a live chain**: the EIP-712 signature for `GetTaskDataMetadata` was verified by a real nexus, the body digest matched nexus's recomputation, and authorization matched the contract (a User can query OUTPUT but not INPUT).

> ⚠️ `evm_chain_id` must match **nexus's configuration**, not just the on-chain
> `params.phase0`. It goes into the EIP-712 domain separator; when the two differ, the only
> symptom is nexus reporting "USER signature recovers `<some random address>`, not `<your
> address>`" -- which looks like a signing bug but is actually just a mismatched domain
> separator. The SDK reads this from the chain by default (`HubReader.getEvmChainId()`); if you
> hit this error during integration testing, check nexus's configured value first.
- **MMR_ROOT_V1 and output commitments** -- anchored to `testdata/v1/shared/mmr_primitive_v1.json` and `testdata/v1/task/output_mmr_v1.json`, including 7-leaf discriminating vectors for fold direction and all negative cases.
- **`task_id` and `task_builder_rank`** -- anchored to the cross-language golden vectors published by node.

- **`TaskOrderV2`'s canonical `task_hash`** -- anchored to the three digests published in the
  monorepo's TaskOrder hashing-and-signing doc (chapter 04 "Task", doc 08, §8.3) (core /
  decoded-parameter lower bound / u64 upper bound
  of the four Amount fields), cross-checked together with the preimage length and the five
  intermediate frames; see `test/unit/task-order-contract-vectors.test.ts`. Wire v0.4.3 has not
  yet turned this into a testdata fixture (wire#24), but the published values themselves are
  authoritative. This implementation matches nexus's `internal/nodecontract/taskorder.go`
  `canonicalTaskOrderFieldsV2` field for field. There is also live-chain evidence: across
  multiple submissions on devnet, the on-chain `accepted_task_hash` matched the locally computed
  `task_hash` byte for byte -- stronger evidence than a vector, since it proves the encoding the
  Keeper actually accepts, not a transcription of the published document.
- **REST chain reads** -- `/TrueOpen/task/v1/session/...`, `/session_nonce/...`, `/settlement_finality/...`.
- **CosmJS chain writes** -- `MsgCreateSession` / `MsgCancelOrder` / `MsgUserChallenge` (including the task registry).
- **IngressAPI methods** -- `openTask` (client-streaming) / `getTaskStatus` / `fetchOutputRef` / `refreshCredential` / `prepareChallenge` / `getTaskEvents` / `subscribeOutput` / `ackOutput`; `submitOrder` is kept only for deprecated raw RPC access.

### ✅ Output delivery: two paths (contract §3.5/§3.6, ADR-0017)

`output_hash` is **no longer a sha256 of the whole payload**; it is the MMR root (framing
`MMR_ROOT_V1`) of an ordered list of text chunks under `TRUEOPEN_OUTPUT_MMR_V1`. The
non-streaming case is not a special case -- it is the same object with a chunk list of length 1.
Chunk boundaries are part of the commitment: the same bytes cut a different way produce a
different `output_hash`.

**Streaming**: `client.streamOutput({ sessionId, taskId, taskHash, workerServicePubKey, checkpoint?, sources?, idleTimeoutMs?, ack? })`

- Two checks per frame: the locally computed root over the first `seq+1` leaves must equal the
  frame's `mmr_root`; the Worker service key's signature over
  `TRUEOPEN_OUTPUT_CHUNK_V1(chain_id, task_hash, seq, mmr_root)` must verify. Either failure
  throws and stops the stream.
- The Builder forwards the Worker-signed frames as-is, without adding its own signature, so
  verification happens entirely locally.
- Resuming after a disconnect must restore `OutputStreamVerifier.checkpoint()` (MMR peaks, leaf
  count, and already-verified chunks); a bare `resumeAfterSeq` is not enough and the SDK rejects
  it. When multiple `sources` are given, the SDK rotates across Builders on idle, disconnect, a
  bad frame, or a sequence gap; frames replayed from an old wire position are fully re-verified
  and deduplicated, so they are never delivered twice.
- `OutputFinV1` (since wire v0.4.3 / wire#35) carries `finish_reason` and `worker_signature`: the
  digest is `H_FIELDS_V1(TRUEOPEN_OUTPUT_FIN_V1, chain_id, task_hash, final_seq,
  output_mmr_root, finish_reason)`, with `finish_reason` encoded in the frame as a **uint32_be
  enum value**, accepting only 1..4 (UNSPECIFIED / unknown values are rejected before the digest
  is even computed). The authoritative settlement commitment is still the on-chain
  `InferReceipt.output_hash`; a signed Fin lets the receiver verify the terminal state before the
  Receipt arrives, and gives them a Worker-authenticated finish reason.
- **`finSignaturePolicy`** (a `streamOutput` parameter): `'accept-unsigned'` (default -- verifies
  a signature if present, passes through if absent) / `'require'` (must carry a valid reason and
  a verifiable signature). The default is relaxed because v0.4.3 is an additive field, and before
  nexus forwards signed Fins (nexus#99) ships, live chains still emit the old, unsigned Fin;
  unconditionally failing closed would make the SDK unusable against the current network today.
  The switch only relaxes "whether a signature must be present" -- **a Fin with a bad signature
  is never accepted under any policy**.
- Phase 0 requires `attachment` / `attachment_signature` to be empty; a non-empty value fails closed.
- `workerServicePubKey` must be supplied by the caller; the SDK has no switch to skip this check
  -- accepting output without verifying it discards all of ADR-0017's guarantees. To obtain it:
  on-chain `assignment.winner_worker` -> `hub.getCurrentServiceKey(PARTICIPANT_TYPE.CORTEX,
  winnerWorker)`.
- **No need to wait for `InferReceipt`**: `winner_worker` is available on-chain as soon as
  `winner_confirm` lands, a full generation cycle before the receipt. In devnet testing the
  first frame arrived 25s before the receipt landed on-chain, then stayed steady at ~4
  frames/sec; for the same task, a full-package fetch took 60s versus 34s streaming. If the
  subscription starts before the Worker begins producing output, nexus keeps the stream open
  without pushing data; use `idleTimeoutMs` to enable an idle timeout, and persist each verified
  prefix with `onCheckpoint`; `scripts/e2e-open-task.mjs --stream` demonstrates cross-Builder
  recovery.

> ✅ Verified: the streaming path **has been verified against a live chain**
> (trueopen-localnet-1): 89 frames and 61 frames across two runs, frame counts matching the
> on-chain `output_leaf_count`, per-frame signature and MMR-root verification passing throughout,
> and a `fin` received with a matching root. Unit tests cover: disconnect after the first frame,
> replay of an old-wire seq=0, cross-Builder resumption, dropping a bad source on a sequence gap,
> and resuming from a persisted checkpoint without duplicate delivery.

The checkpoint cannot be passed directly to `JSON.stringify` (it contains bigint / Uint8Array
values); use the dedicated codec instead:

```ts
const json = serializeOutputStreamCheckpoint(checkpoint);
// persist this in your own storage
const restored = deserializeOutputStreamCheckpoint(json);
```

JSON V1 encodes bytes as lowercase hex / canonical padded base64, and u64 as canonical decimal
text; decoding rejects unknown fields, non-canonical encodings, malformed peak shapes, and any
mismatch between the peaks and the chunks' root.

**Receipt confirmation**: chunks received over the stream are only provisional once the Worker
signature and prefix MMR check pass; once the on-chain `InferReceipt` is available, use the same
checkpoint to perform the final confirmation:

```ts
const receipt = await chainReader.queryInferReceipt(taskId);
if (receipt) {
  const confirmed = client.confirmOutput({ taskId, taskHash, checkpoint, receipt });
  // confirmed.type === 'confirmed'
}
```

Confirmation first checks the checkpoint's own chunks / MMR peaks / leaf count for internal
consistency, then checks `receipt.output_hash`, `output_leaf_count`, and `output_size_bytes`
against it one by one. Any mismatch fails closed with a non-retryable
`DATA_OUTPUT_CONFIRMATION_*` error. The Receipt today makes no promise about the finish reason;
a trusted terminal reason still depends on Wire #35's signed Fin and cannot be guessed by
confirmation.

**OpenAI-compatible SSE**: a pure conversion layer that consumes `VerifiedOutputEvent` and never
marks an unverified Nexus frame as trusted on its own:

```ts
const sse = toOpenAIChatSSE(verifiedEvents, {
  id: `chatcmpl-${taskId}`,
  taskId,
  taskHash,
  model: modelId,
  created: Math.floor(Date.now() / 1000),
}, {
  delivery: 'confirmed-only',
  maxBufferedBytes: 4 * 1024 * 1024,
  signal: abortController.signal,
});
```

- `provisional` (default): outputs chunk by chunk; after a verified Fin it sends the terminal
  chunk and `[DONE]`.
- `confirmed-only`: **zero bytes of output** until Receipt confirmation arrives; only after the
  root/count/size are confirmed does it release all content chunks, the terminal chunk, and
  `[DONE]`.
- `confirmed-only` buffers up to 16 MiB by default, which can be lowered with
  `maxBufferedBytes`; going over the limit still delivers nothing and fails closed.
- `AbortSignal` aborts consumption of the upstream events; in the browser, `reader.cancel()`
  propagates to `iterator.return`. The `ReadableStream` uses `highWaterMark=0` and does not
  prefetch upstream events without consumer demand.
- EOS / STOP_SEQUENCE -> OpenAI `stop`; MAX_OUTPUT_TOKENS / MAX_OUTPUT_DURATION -> `length`;
  UNSPECIFIED and unknown values fail closed.
- `id` / `model` / `created` must be supplied from the task context; the adapter never guesses
  them. MMR, signature, and confirmation metadata never leak into `delta.content`.

Wire #35 shipped in **v0.4.3**; the SDK already implements the digest and signature
verification for `TRUEOPEN_OUTPUT_FIN_V1` (anchored to the official `fin_signing` vectors) and
wires it into `streamOutput`. But **the live chain does not yet produce a signed Fin**: nexus's
side of verifying/storing/forwarding it (nexus#99) has not shipped, so the current network still
emits the old, unsigned Fin, and `finSignaturePolicy` defaults to `'accept-unsigned'`. Once
nexus#99 ships, it can switch to `'require'` and complete cross-repo live-chain acceptance for
Cortex -> Nexus -> SDK -> OpenAI SSE.

**Full package**: `client.fetchTaskOutput({ sessionId, taskId, taskHash, outputHash, builderAddress, expiresAtHeight })`

- `GetTaskDataMetadata` fetches `size_bytes` / `chunk_lengths` / `output_leaf_count` ->
  `FetchTaskData` fetches the bytes -> re-chunks them per `chunk_lengths` -> computes the MMR
  root and compares it to `outputHash` (throwing `DATA_OUTPUT_HASH_MISMATCH` on mismatch) ->
  returns `{ bytes, text, outputHash, chunks, sizeBytes, mediaType }`.
- `outputHash` comes from the on-chain `InferReceipt.output_hash`: it is both the verification
  target and `TaskDataObjectRefV1.content_hash` -- v0.4.x retrieval is content-addressed, and
  without it the object cannot even be located.
- `builderAddress` must be the operator address of **the specific Builder being asked**: nexus
  compares it byte-for-byte against its own configuration. The object only exists on the Task
  Builder(s) that accepted that order, so you ask them one at a time.
- `expiresAtHeight` is a **block height** (current height + window), not a timestamp.
- These two methods **do not use `SDKRequestEnvelope`**; they use `TaskDataRequestAuthV1`: the
  body digest binds to one of five domains via `H_FIELDS_V1`, chosen by `requester_kind` --
  USER uses the EIP-712 `TrueOpen Task Data Request` domain, always 65 bytes; CORTEX_SERVICE
  uses `TRUEOPEN_TASK_DATA_REQUEST_V1`, always 64 bytes; the length is not sniffed. See
  `src/transport/task-data-signbytes.ts`.

> `fetchOutputRef(...)` has been superseded by §3.5/§3.6 (marked `deprecated` in the proto); all
> that remains is an unused `CredentialV1`, whose fate is still undecided. `ChunkVerifier` is
> kept for chunked-fetch scenarios.

> These two body_digest computations were verified against the nexus main source (2026-09-15,
> main@b19f6206): `subscribeOutputBodyDigest` = `(session_id, task_id)`, with `resume_after_seq`
> excluded from the signature; `ackOutputBodyDigest` = `(session_id, task_id, output_id)`, where
> **`output_id`, although deprecated, is still part of the signature** (even an empty string
> occupies a field), and `last_seq` is excluded from the signature.

### ✅ On-chain writes: direct ethsecp256k1 signing (`EthSecp256k1DirectSigner`)

The three write paths -- `createSession` / `cancelOrder` / `challenge` -- **cannot use** CosmJS's
built-in `DirectSecp256k1HdWallet`: it disagrees with node's `app/account_ante.go` in three
places, and missing any one of them gets rejected by the ante handler:

| | CosmJS default | node requires |
|---|---|---|
| Address derivation | `ripemd160(sha256(compressed))` | `keccak256(XY)[12:]` |
| DIRECT signing digest | `sha256(SignDoc)` | `keccak256(SignDoc)` |
| Public key type URL | `/cosmos.crypto.secp256k1.PubKey` | `/cosmos.evm.crypto.v1.ethsecp256k1.PubKey` |

The first two are fixed by swapping the signer; the third cannot be, because
`SigningStargateClient.signDirect` hardcodes the public key as
`encodePubkey(encodeSecp256k1Pubkey(...))`. But it assembles the final `TxRaw` from the
**signer's returned** `signed.authInfoBytes`, so `EthSecp256k1DirectSigner` rewrites the public
key type URL inside AuthInfo before signing, then takes the keccak signature over the rewritten
SignDoc -- what gets broadcast is the rewritten version. The proto shapes of the two PubKey types
are identical (`bytes key = 1`); only the type_url changes, the value is untouched.

```ts
import { ethSecp256k1SignerFromMnemonic, connectTrueOpenChainClient } from 'trueopen-sdk';

// The HD path is frozen by the protocol at coin_type 60 (TRUEOPEN_HD_PATH), not the usual Cosmos 118.
const signer = await ethSecp256k1SignerFromMnemonic(mnemonic, 'trueopen');
const [account] = await signer.getAccounts();
const { client } = await connectTrueOpenChainClient({
  rpcUrl, restUrl, signer, signerAddress: account.address,
  // Cannot use fee: 'auto': CosmJS's gas simulation sets the sign mode to
  // SIGN_MODE_UNSPECIFIED, but node's ante handler only accepts SIGN_MODE_DIRECT, so the
  // simulation step gets rejected. An explicit fee must be given.
  fee: { amount: [{ denom: 'uusdc', amount: '7500' }], gas: '300000' },
});
```

`connectTrueOpenChainClient` also installs `ethAccountParser`: node's accounts are cosmos/evm's
`EthAccount`, which CosmJS's built-in `accountFromAny` does not recognize, so it cannot even
retrieve `account_number` / `sequence`. **This is required starting with the second tx**: after
the account's first tx, the chain stores its public key as ethsecp256k1, and the next time
`sequence` is queried, CosmJS's `decodePubkey` throws "Pubkey type URL not recognized".

> ✅ Verified: this path **has been verified against a live chain** (trueopen-localnet-1).
> `MsgCreateSession` was broadcast for real through this signer and landed on-chain multiple
> times: the address derivation via keccak, the keccak256(SignDoc) digest, and the rewritten
> ethsecp256k1 public key type URL all passed node's ante handler.

### ⚠️ Integration checkpoint (byte encoding conventions)

`evidence_digest` / `owner_signature` / `challenger_signature` are `string` in the on-chain
proto; the SDK **passes them through unchanged** (signatures as hex strings). The byte encoding
the chain side expects needs end-to-end signature verification against a real chain.

### Protocol hard rule

The chain **never stores the output / input body**, only hashes / commitments. Delivering the
body always happens off-chain, and its authenticity is verified against the on-chain
`output_hash`.

---

## 5. Architecture / dependency injection

`trueopen-sdk` follows **ports & adapters**:

- **`ChainClient` (port)** -- chain reads (REST, `RestChainReader`) + chain writes (CosmJS,
  `CosmjsChainWriter`). The `createTrueOpenChainClient(...)` factory composes reader and writer
  synchronously; `connectTrueOpenChainClient(...)` first builds a `SigningStargateClient`
  (including the task registry) asynchronously, then composes them. `broadcaster` is supplied by
  the caller (a `SigningStargateClient` satisfies `TxBroadcaster`).
- **nexus `Transport` (port)** -- the `@connectrpc/connect` `Transport`, with Node and browser
  each injecting their own concrete implementation.

Both ports are injected via `TrueOpenClientConfig`. This makes the SDK **runtime-agnostic**, and
also lets you **unit test** with a fake broadcaster + stub fetch + in-memory transport, without a
real devnet.

---

## 6. Testing / building

| Command | Description |
|---|---|
| `npm test` | vitest (111 test cases passing) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | tsup -> ESM + CJS + `.d.ts` + `dist/cli.cjs` (bin, target es2022) |
| `npm run generate` | `buf generate` (generates protobuf-es from the wire submodule + nexus proto) |

> Chain / nexus integration tests are skipped without a live devnet (e.g.
> `test/integration/chain.integration.test.ts`). Canonical encoding / signing bytes are guarded
> by golden-vector unit tests to catch drift from the backend.

### proto source

The single authority for all proto is **[TrueOpen/wire](https://github.com/TrueOpen/wire)**,
pinned as a submodule at `third_party/wire` (currently **v0.4.3**). **This repo no longer keeps
any proto of its own** -- a hand-copied subset would silently drift, and nexus applies
`DiscardUnknown` + `proto.Equal` to order bytes, so a single field-number mismatch gets the whole
order rejected. (wire also absorbs nexus's `nexus.v1.IngressAPI`, so the on-chain contract and
the nexus service surface come from the same commit.)

```bash
git clone --recurse-submodules <repo>        # first time
git submodule update --init --recursive       # already cloned
npm run generate                              # needs BSR network access (cosmos/gogo annotation deps)
```

| proto | source |
|---|---|
| `nexus.v1.IngressAPI` | `third_party/wire` (v0.4.3) |
| `task.v1` / `shared.v1` | `third_party/wire` (v0.4.3) |
| `cosmos.base.v1beta1` + gogoproto / cosmos_proto / amino annotations | BSR (commit pinned in `buf.lock`) |

The generation scope is limited by `buf.gen.yaml`'s `paths` to the transitive closure the SDK
needs (13 wire files + 5 annotation/type dependencies), not all 74 proto files in wire. RPCs the
SDK uses: `OpenTask` / `GetTaskStatus` / `GetTaskEvents` / `GetTaskDataMetadata` /
`FetchTaskData` / `SubscribeOutput` / `AckOutput` / `PrepareChallenge` / `FetchOutputRef` (the
last one has been superseded by the contract, see §4).

Upgrading the wire version: `git -C third_party/wire fetch --tags && git -C third_party/wire
checkout <tag>`, then recompute the import closure, update `buf.gen.yaml`'s `paths`, and run
`npm run generate && npm test`. The tests read directly from the submodule's `testdata/`, so the
vectors change along with the version -- intentionally: the vectors are the source of truth, not
copied into local constants.

## 7. CLI (the second production entry point)

Besides the library, `trueopen-sdk` ships the `trueopen` CLI -- a thin wrapper around the
`TrueOpenClient` facade (zero business logic; both entry points share the same core). After
`npm run build`, run it with `node dist/cli.cjs <cmd>` (after publishing, just `trueopen <cmd>`).

> 📖 **See [docs/cli.md](docs/cli.md) for the full command and argument reference, the
> order-file format, end-to-end examples, and a common-errors table.** Only a quick reference
> table follows below.

### Commands (mapped to facade methods)
| Command | Facade | Cost |
|---|---|---|
| `trueopen address` | mnemonic -> address | none |
| `trueopen builders` | discovers the nexus endpoint on-chain | none |
| `trueopen session create [label]` / `session get <id>` | createSession / getSession | gas / none |
| `trueopen order submit --order-file <f> --session <id> --payload-file <f> [--seq <n>] [--idempotency-key <k>]` | openTask | freezes max_fee |
| `trueopen order cancel --session <id> --seq <n>` | cancelOrder | gas |
| `trueopen task status <session> <task>` / `task watch <session> <task>` | taskStatus / watchTask (streaming) | none |
| `trueopen output get <session> <task> <task-hash> <output-hash>` | fetchTaskOutput (requires `--auto`) | none |
| `trueopen output stream <session> <task> <task-hash> <worker-pubkey>` | streamOutput (per-frame signature + root verification) | none |
| `trueopen output ref <session> <task>` | fetchOutputRef (superseded by the contract) | none |
| `trueopen challenge prepare <session> <task> <kind>` / `challenge submit ...` | prepareChallenge / challenge | none / locks bond |

### Order-file format for `order submit`

Since `TaskOrderV2` was frozen, the fields have changed materially: fees are now **Amount
(decimal text, atomic units)** for the four fee fields (`priceBid` / `maxFee` /
`assignmentPriorityFee` / `txFeeReserve`), enums can be written by name, and the file **no
longer includes** `reward_bucket` / `profile_resource_tier` / `order_value` /
`infer_timeout_blocks` / `payload_hash` / `valid_after_height` -- the first four are derived by
the Keeper (submitting them gets the order rejected), and the last two are derived by the SDK
from `--payload-file` and the on-chain height.

```json
{
  "modelId": "hf-<64hex>",
  "profileVersion": 1,
  "taskType": "TEXT_GENERATION",
  "inputBucket": 1,
  "outputBudgetBucket": 1,
  "maxOutputTokens": 128,
  "maxOutputDurationMs": 60000,
  "inferInputUnitPriceBid": "2",
  "inferOutputUnitPriceBid": "3",
  "verifyUnitPriceBid": "4",
  "inferFeeCap": "600",
  "verifyFeeCap": "300",
  "maxFee": "1000",
  "assignmentPriorityFee": "0",
  "txFeeReserve": "0",
  "earliestSubmitHeight": "100",
  "orderExpireHeight": "50100",
  "latencyClass": "STANDARD"
}
```

`taskType` accepts `TEXT_GENERATION` / `CHAT` / `EMBEDDING` / `CLASSIFICATION` /
`IMAGE_GENERATION` / `MULTIMODAL`; `latencyClass` accepts `ECONOMY` / `STANDARD` / `FAST` /
`EXPRESS` (or the corresponding numeric value directly).

`anchor / builder_set / parameter bucket versions` are not in the file -- the SDK reads them
from the chain at order time and signs them into the order.

### Configuration (priority: flag > env > default)
| flag | env | default |
|---|---|---|
| `--rest-url` | `TRUEOPEN_REST_URL` | - |
| `--rpc-url` | `TRUEOPEN_RPC_URL` | - |
| `--nexus-url` / `--auto` | `TRUEOPEN_NEXUS_URL` | `--auto` discovers on-chain |
| `--nexus-tls-pubkey-hash` | `TRUEOPEN_NEXUS_TLS_PUBKEY_HASH` | - (`--auto` reads it from the on-chain descriptor) |
| `--chain-id` | `TRUEOPEN_CHAIN_ID` | - |
| `--prefix` | `TRUEOPEN_ADDR_PREFIX` | `trueopen` |
| `--gas-price` | `TRUEOPEN_GAS_PRICE` | `0.025utrueopen` |
| `--json` | - | human-readable |

**Connect only what you need**: read-only commands need only REST; commands that touch nexus
need nexus (`--auto` can discover it); commands that write to the chain (session create, order
cancel, challenge submit) need rpc + a key.

### Keys (production security)

The mnemonic is only ever read from `--key-file <path>` (a file, chmod 600 recommended) or the
`TRUEOPEN_MNEMONIC` environment variable, **never accepted as a plaintext command-line
argument**.

### Examples
```bash
npm run build
# read-only (no cost)
node dist/cli.cjs builders --rest-url https://<host>:1317
TRUEOPEN_MNEMONIC="..." node dist/cli.cjs address
# create a session (gas); use https once TLS is enabled on the node port (local testing can use http://127.0.0.1)
TRUEOPEN_RPC_URL=https://<host>:26657 TRUEOPEN_REST_URL=https://<host>:1317 \
  TRUEOPEN_MNEMONIC="..." node dist/cli.cjs session create
# retrieve the output body (--auto discovers nexus, verifies the certificate against the on-chain tls_pubkey_hash)
TRUEOPEN_REST_URL=https://<host>:1317 TRUEOPEN_MNEMONIC="..." \
  node dist/cli.cjs output get <session> <task> --auto --json
```
Exit codes: 0 on success, 1 on error (with `--json`, errors are printed to stderr as `{error:{code,message}}`).
