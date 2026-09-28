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

The same flow as `examples/create-session.mjs`, `examples/open-task.mjs` and
`examples/fetch-output.mjs`, which run against a real chain (see `examples/README.md`). Endpoints
and the mnemonic are yours to supply; everything chain-specific is read from the chain.

```ts
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
  defaultGenerationParams,
  TASK_TYPE,
  DEADLINE_LATENCY_CLASS,
  TRUEOPEN_HD_PATH,
} from 'trueopen-sdk';
import { Bip39, Slip10, Slip10Curve, EnglishMnemonic, stringToPath } from '@cosmjs/crypto';

const restUrl = 'https://node.example:1317';
const rpcUrl = 'https://node.example:26657';
const chainId = 'trueopen-localnet-1';
const prefix = 'trueopen';

// --- 1. Identity: HD path m/44'/60'/0'/0/0, EVM-style address ---
const seed = await Bip39.mnemonicToSeed(new EnglishMnemonic(mnemonic));
const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, stringToPath(TRUEOPEN_HD_PATH));
const pubKey = secp256k1PublicKey(privkey);
const address = ethSecp256k1Address(pubKey, prefix);

// --- 2. Chain reads, and the two values that go into signatures ---
const fetchLike = (url: string) => fetch(url);
const hub = new HubReader({ baseUrl: restUrl, fetch: fetchLike });
const taskReader = new RestChainReader({ baseUrl: restUrl, fetch: fetchLike });
const evmChainId = await hub.getEvmChainId(); // EIP-712 domain; never a constant
const businessDenom = await hub.getBusinessDenom(); // order fee denom and the only tx fee denom

// --- 3. Chain writes: ethsecp256k1 direct signing, explicit fee in business_denom ---
// Not fee: 'auto': CosmJS simulates with a sign mode node refuses (see "On-chain writes").
const wallet = await ethSecp256k1SignerFromMnemonic(mnemonic, prefix);
const { client: chain, signingClient } = await connectTrueOpenChainClient({
  rpcUrl, restUrl, signer: wallet, signerAddress: address,
  fee: { amount: [{ denom: businessDenom, amount: '7500' }], gas: '300000' },
});

// --- 4. The facade ---
// nexus endpoints come from the Builders' on-chain descriptors. https is checked against the
// registered certificate fingerprint and never downgraded to http. A localnet with plain http
// endpoints needs TRUEOPEN_ALLOW_INSECURE_HTTP=1 (or { allowInsecureHttp: true }).
const nexus = (url: string, tlsPubkeyHash = '') => nexusIngressTransport(url, tlsPubkeyHash);
const makeClient = (ingressTransport: ReturnType<typeof nexus>) =>
  new TrueOpenClient({
    chainId, userAddress: address, signerPubKey: pubKey,
    signer: privKeySecp256k1Signer(privkey), // request envelopes (64-byte)
    orderSigner: privKeyEip712Signer(privkey), // order + task-data requests (EIP-712, 65-byte)
    evmChainId, // no feeDenom: openTask signs business_denom read through the hub
    chain, hub, taskReader,
    ingressTransport, // default transport for calls not routed by the SDK
    ingressTransportFactory: nexus, // openTask picks Builders by task_builder_seed
    addressPrefix: prefix,
  });
const client = makeClient(nexus('http://nexus.unused.invalid'));

// --- 5. Session -> order ---
const { sessionId } = await client.createSession('demo');
const orderSequence = await client.nextOrderSequence(sessionId); // 0 for a new session
const height = await hub.getLatestHeight();
const res = await client.openTask({
  sessionId,
  orderSequence,
  idempotencyKey: `${sessionId}:${orderSequence}`, // keep it across retries
  order: {
    modelId: '<64hex>', // raw Hash32 model ID, lowercase hex
    profileVersion: 1,
    taskType: TASK_TYPE.TEXT_GENERATION,
    payload: new TextEncoder().encode('hello'), // input_hash / size are derived from this
    inputBucket: 1,
    outputBudgetBucket: 1,
    generationParams: defaultGenerationParams(256n, 60_000n), // enters task_hash: explicit
    amounts: {
      priceBid: { atomicUnits: '100000' }, // per million output tokens
      maxFee: { atomicUnits: '1000' }, // must cover order_value + txFeeReserve
      assignmentPriorityFee: { atomicUnits: '0' }, // must be 0
      txFeeReserve: { atomicUnits: '0' },
    },
    earliestSubmitHeight: height,
    orderExpireHeight: height + 50_000n,
    latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
  },
});
// res.builders: every selected Builder with its ack or error. An ack is local acceptance by
// nexus only; the chain decides whether the task exists.

// --- 6. Output, verified against the chain ---
// Anchors come from chain: accepted task_hash, winner Worker key, accepted InferReceipt.
// OUTPUT_TRUST_ANCHOR_PENDING (retriable) means the receipt is not there yet: poll.
const anchors = await client.resolveOutputTrustAnchors(res.taskId);
for (const b of res.builders.filter((x) => x.ack?.accepted)) {
  try {
    const out = await makeClient(nexus(b.serviceEndpoint, b.tlsPubkeyHash)).fetchTaskOutput({
      sessionId, taskId: res.taskId, anchors, builderAddress: b.address,
    });
    console.log(out.text); // MMR root, size and leaf count match the receipt
    break;
  } catch (e) {
    // try the next Builder
  }
}
signingClient.disconnect();
```

Without the order result at hand, `resolveBuilderEndpoints(hub)` lists every active Builder's
endpoint to try instead (that is what `examples/fetch-output.mjs` does).

`TrueOpenClient` methods (see `src/client.ts` for the authoritative signatures):

| Method | Description |
|---|---|
| `createSession(label?)` / `getSession(sessionId)` | create / retrieve a session |
| `openTask({ sessionId, orderSequence, order, idempotencyKey, pricing? })` | reads on-chain context, the fee denom and the profile pricing -> builds the frozen `TaskOrderV3` and refuses an order the chain would reject -> three-layer signing -> selects Task Builders by `task_builder_seed` -> streams the OpenTask submission; returns `{ taskId, taskHash, context, feeDenom, builders, unresolvedBuilders, endpointsTried, ...firstAck }`, where `builders` has every selected Builder's address, endpoint and ack or error |
| `resolveOutputTrustAnchors(taskId, { withReceipt? })` | reads the accepted `task_hash`, the winner Worker's current service key and the accepted `InferReceipt` from chain |
| `cancelOrder(sessionId, orderSequence)` | on-chain `MsgCancelOrder` (authorized by the account signature) |
| `taskStatus(sessionId, taskId)` | local nexus status snapshot (informational) |
| `watchTask(sessionId, taskId, fromCursor?)` | subscribes to the task event stream (`AsyncIterable`) |
| `fetchTaskOutput({ sessionId, taskId, builderAddress, taskHash?, outputHash?, expiresAtHeight? })` | fetches the full output in ranges and recomputes the MMR root from `chunk_lengths` to verify it against the on-chain receipt (see section 4) |
| `streamOutput({ sessionId, taskId, taskHash?, workerServicePubKey?, checkpoint?, sources?, idleTimeoutMs?, finSignaturePolicy?, ack? })` | resumable streaming subscription to output, with per-frame signature and MMR-root verification and a verified terminal frame (see section 4) |
| `confirmOutput({ taskId, taskHash, checkpoint, receipt })` | uses the on-chain Receipt's root / leaf count / size to upgrade provisional output to confirmed |
| `serializeOutputStreamCheckpoint()` / `deserializeOutputStreamCheckpoint()` | strictly encodes a verifier checkpoint into JSON V1, stable across Node/browser |
| `toOpenAIChatSSEIterable(events, context, opts?)` | Node / generic runtimes: verified events -> OpenAI-compatible SSE byte stream |
| `toOpenAIChatSSE(events, context, opts?)` | browser / Web API: returns a `ReadableStream<Uint8Array>` |
| `prepareChallenge(sessionId, taskId, kind, localEvidenceDigest?)` | prepares challenge material (does not submit a verdict) |

---

## 4. Capability boundaries (important)

This section states plainly **which capabilities are already aligned with the real backend today, and which are still waiting on backend work**. Check every item before integrating.

### ✅ Ready and aligned with the real backend

- **Order signing** -- the order is signed as EIP-712 "TrueOpen Task Order" v3 (65-byte recoverable signature) and encoded as `SignedOrderV2`; the OpenTask header carries a separate 64-byte secp256k1 signature over `TRUEOPEN_ORDER_V1`.
- **`task_id` derivation** -- `H_FIELDS_V1("TRUEOPEN_TASK_ID_V1", raw32(session_id), u64be(order_sequence))`, anchored to `testdata/v1/task/task_data_plane_v1_golden.json`.
- **nexus `SDKRequestEnvelope` + per-method `body_digest`** -- the body_digest for `openTask` / `getTaskEvents` / `prepareChallenge` / `subscribeOutput` / `ackOutput` is **byte-for-byte identical** to nexus's.
- **EVM-style identity and EIP-712** -- the address `bech32(keccak256(uncompressed_XY)[12:32])`, and the type hash, domain separator, hash struct, signing digest and 65-byte signature for the three EIP-712 domains (`Cosmos Web3` / `TrueOpen Task Order` v3 / `TrueOpen Task Data Request` v1), all anchored to wire's
  `testdata/v1/shared/account_signing_v1.json`.
- **Task data plane authentication** -- the two body digests (METADATA / FETCH, V2 domains), together with their preimages, are anchored to `testdata/v1/task/task_data_auth_v1.json`, and illegal object_kind / evidence_kind combinations are refused before hashing; the USER branch's EIP-712 and the CORTEX_SERVICE branch's H_FIELDS_V1 are each cross-checked separately. **Verified against a live chain**: the EIP-712 signature for `GetTaskDataMetadata` was verified by a real nexus, the body digest matched nexus's recomputation, and authorization matched the contract (a User can query OUTPUT but not INPUT).

> ⚠️ `evm_chain_id` must match **nexus's configuration**, not just the on-chain
> `params.phase0`. It goes into the EIP-712 domain separator; when the two differ, the only
> symptom is nexus reporting "USER signature recovers `<some random address>`, not `<your
> address>`" -- which looks like a signing bug but is actually just a mismatched domain
> separator. The SDK reads this from the chain by default (`HubReader.getEvmChainId()`); if you
> hit this error during integration testing, check nexus's configured value first.
- **MMR_ROOT_V1 and output commitments** -- anchored to `testdata/v1/shared/mmr_primitive_v1.json` and `testdata/v1/task/output_mmr_v1.json`, including 7-leaf discriminating vectors for fold direction and all negative cases.
- **`task_builder_rank`** -- anchored to all four vectors (preimage and rank) in `testdata/v1/task/task_builder_rank_v1.json`.

- **`TaskOrderV3`'s canonical `task_hash`** -- anchored to the three `TRUEOPEN_TASK_ORDER_V3`
  vectors in `testdata/v1/task/task_order_v3.json` (preimage and digest); the three
  `TRUEOPEN_ORDER_OPENING_V2` vectors in the same file are read as well. See
  `test/unit/task-order-contract-vectors.test.ts`.
- **REST chain reads** -- `/TrueOpen/task/v1/session/...`, `/session_nonce/...`, `/task/...` (both the active and the compacted terminal view).
- **CosmJS chain writes** -- `MsgCreateSession` / `MsgCancelOrder` (including the task registry).
- **Not supported yet** -- `MsgOpenChallengeRound`, the only challenge Msg in wire. `prepareChallenge` (nexus) still prepares material.
- **IngressAPI methods** -- `openTask` (client-streaming) / `getTaskStatus` / `prepareChallenge` / `getTaskEvents` / `subscribeOutput` / `ackOutput` / `getTaskDataMetadata` / `fetchTaskData`. The deprecated `SubmitOrder` / `FetchOutputRef` / `RefreshCredential` RPCs are not wrapped.

### ✅ Output delivery: two paths

`output_hash` is **no longer a sha256 of the whole payload**; it is the MMR root (framing
`MMR_ROOT_V1`) of an ordered list of text chunks under `TRUEOPEN_OUTPUT_MMR_V1`. The
non-streaming case is not a special case -- it is the same object with a chunk list of length 1.
Chunk boundaries are part of the commitment: the same bytes cut a different way produce a
different `output_hash`.

**Streaming**: `client.streamOutput({ sessionId, taskId, taskHash?, workerServicePubKey?, checkpoint?, sources?, idleTimeoutMs?, ack? })`
(`taskHash` and `workerServicePubKey` default to the chain: the accepted task_hash and the
winner Worker's current service key)

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
- `OutputFinV1` carries `finish_reason` and `worker_signature`: the
  digest is `H_FIELDS_V1(TRUEOPEN_OUTPUT_FIN_V1, chain_id, task_hash, final_seq,
  output_mmr_root, finish_reason)`, with `finish_reason` encoded in the frame as a **uint32_be
  enum value**, accepting only 1..6 (UNSPECIFIED / unknown values are rejected before the digest
  is even computed). The authoritative settlement commitment is still the on-chain
  `InferReceipt.output_hash`; a signed Fin lets the receiver verify the terminal state before the
  Receipt arrives, and gives them a Worker-authenticated finish reason.
- **`finSignaturePolicy`** (a `streamOutput` parameter): `'require'` (default) -- the stream is
  complete, and acked, only once a Fin with a valid reason and a `worker_signature` that verifies
  against `workerServicePubKey` arrives. An unsigned Fin only proves the prefix received so far is
  self-consistent, so a Builder could otherwise end the stream early and truncate the output.
  nexus stores and replays the Worker-signed Fin as received.
  `'accept-unsigned'` is an explicit opt-in for peers that still send the old, unsigned Fin: the
  stream ends with a `fin` event carrying `attested: false` and `finishReason: undefined`, and
  the SDK **never acks it**. **A Fin with a bad signature is never accepted under any policy**.
- The terminal event is `{ kind: 'fin', attested: true, finishReason }` for a signed Fin, or
  `{ kind: 'fin', attested: false, finishReason: undefined }` under the opt-in.
- Phase 0 requires `attachment` / `attachment_signature` to be empty; a non-empty value fails closed.
- `workerServicePubKey` must be supplied by the caller; the SDK has no switch to skip this check
  -- accepting output without verifying it discards all of the streamed-output guarantees. To obtain it:
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
a trusted terminal reason still depends on a signed Fin and cannot be guessed by
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

The SDK implements the digest and signature verification for `TRUEOPEN_OUTPUT_FIN_V1`
(anchored to the official `fin_signing` vectors) and requires it in `streamOutput` by default.
nexus verifies the Worker's Fin signature on receipt, stores the signed Fin and replays it
unchanged to subscribers.

**Full package**: `client.fetchTaskOutput({ sessionId, taskId, builderAddress, taskHash?, outputHash?, expiresAtHeight? })`

- `GetTaskDataMetadata` fetches `size_bytes` / `chunk_lengths` / `output_leaf_count` ->
  `FetchTaskData` fetches the bytes in ranges of at most 8 MiB (nexus's default max range;
  `maxRangeBytes` changes it), checking each range's `served_range` and chunk offsets and
  retrying a range that failed on transport -> re-chunks them per `chunk_lengths` -> computes
  the MMR root and compares it to `outputHash` (throwing `DATA_OUTPUT_HASH_MISMATCH` on
  mismatch) -> returns `{ bytes, text, outputHash, taskHash, chunks, sizeBytes, mediaType, receipt? }`.
  A size-0 output is not fetched.
- `taskHash` and `outputHash` default to `resolveOutputTrustAnchors(taskId)`: the accepted
  task and `InferReceipt` on chain, whose size and leaf count the metadata must match.
  `outputHash` is both the verification target and `TaskDataObjectRefV1.content_hash` --
  retrieval is content-addressed. Explicit values override the chain.
- `builderAddress` must be the operator address of **the specific Builder being asked**: nexus
  compares it byte-for-byte against its own configuration. The object only exists on the Task
  Builder(s) that accepted that order, so you ask them one at a time.
- `expiresAtHeight` is a **block height**, not a timestamp; it defaults to the latest height +
  `requestTtlBlocks` (10), inside nexus's 20-block window.
- These two methods **do not use `SDKRequestEnvelope`**; they use `TaskDataRequestAuthV1`: the
  body digest binds to one of five domains via `H_FIELDS_V1`, chosen by `requester_kind` --
  USER uses the EIP-712 `TrueOpen Task Data Request` domain, always 65 bytes; CORTEX_SERVICE
  uses `TRUEOPEN_TASK_DATA_REQUEST_V1`, always 64 bytes; the length is not sniffed. See
  `src/transport/task-data-signbytes.ts`.

> These two body_digest computations were verified against the nexus main source (2026-09-15,
> main@b19f6206): `subscribeOutputBodyDigest` = `(session_id, task_id)`, with `resume_after_seq`
> excluded from the signature; `ackOutputBodyDigest` = `(session_id, task_id, output_id)`, where
> **`output_id`, although deprecated, is still part of the signature** (even an empty string
> occupies a field), and `last_seq` is excluded from the signature.

### ✅ On-chain writes: direct ethsecp256k1 signing (`EthSecp256k1DirectSigner`)

The two write paths -- `createSession` / `cancelOrder` -- **cannot use** CosmJS's
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
import { ethSecp256k1SignerFromMnemonic, connectTrueOpenChainClient, HubReader } from 'trueopen-sdk';

// The HD path is frozen by the protocol at coin_type 60 (TRUEOPEN_HD_PATH), not the usual Cosmos 118.
const signer = await ethSecp256k1SignerFromMnemonic(mnemonic, 'trueopen');
// Fees are only accepted in the chain's business_denom.
const businessDenom = await new HubReader({ baseUrl: restUrl, fetch: (u) => fetch(u) }).getBusinessDenom();
const [account] = await signer.getAccounts();
const { client } = await connectTrueOpenChainClient({
  rpcUrl, restUrl, signer, signerAddress: account.address,
  // Cannot use fee: 'auto': CosmJS's gas simulation sets the sign mode to
  // SIGN_MODE_UNSPECIFIED, but node's ante handler only accepts SIGN_MODE_DIRECT, so the
  // simulation step gets rejected. An explicit fee must be given.
  fee: { amount: [{ denom: businessDenom, amount: '7500' }], gas: '300000' },
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

### ✅ Model manifest retrieval (`ManifestSource`)

The chain stores a profile's `manifest_hash` and a retrieval hint, `ProfileState.manifest_uri`.
`ManifestSource` turns them into a verified manifest. Trust comes only from `manifest_hash`:
`manifest_uri` is never trusted, and a dead URI costs availability, never correctness.

- **Fetch order:** local cache (keyed by `manifest_hash`) → `manifest_uri` → configured mirrors.
  Every source is verified the same way, and a failure moves on to the next one.
- **Verification order:** `H_V1("TRUEOPEN_MODEL_MANIFEST_V4", bytes)` must equal `manifest_hash` →
  strict parse and V4 schema check → the canonical JSON re-encoding must equal the fetched bytes →
  the projection fields must match `ProfileState`. `manifest_uri` always comes from the chain.
  With `registration: { chainId, registrationFee }`, the rebuilt projection's registration digest
  must also equal `ProfileState.registration_digest`, which binds every projection field.
- **`manifest_uri` syntax:** `parseManifestUri` follows `testdata/v1/hub/manifest_uri_v1.json`
  exactly: only `https://` or `ipfs://`, no userinfo or fragment, and strict host, port, percent
  and CID rules.
- **`ipfs://`** is fetched only through a configured `ipfsGateway`.

**Node (full downloader safety):**

```ts
import { HubReader } from 'trueopen-sdk';
import { createNodeManifestSource } from 'trueopen-sdk/node';

const source = createNodeManifestSource({
  reader: new HubReader({ baseUrl: 'https://node.example:1317', fetch }),
  mirrors: ['https://mirror.example/manifests/{manifest_hash}.json'], // optional
  ipfsGateway: 'http://127.0.0.1:8080', // optional; needed for ipfs:// URIs
});
const { manifest, bytes, source: from } = await source.fetchManifest(modelIdHex, 1n);
```

The Node downloader does the following for the chain-provided URI:

- It resolves the host and refuses loopback, private, CGNAT, link-local and metadata addresses.
  It also refuses unique-local, multicast, unspecified and reserved addresses. This applies to
  IPv4 and IPv6, including IPv4-mapped, NAT64 and 6to4 forms.
- It connects only to the address it checked, through a pinned lookup.
- It verifies TLS against the original host name.
- It re-resolves and re-checks on every retry and redirect hop, and follows at most 3 redirects.
  It never follows a redirect from https to http.
- It applies a connect timeout and a total timeout.
- It caps the body at 4 MiB, both by `Content-Length` and by the bytes actually read after
  gzip, deflate or br decompression. It refuses any other encoding.

Mirrors and the gateway are operator-configured. They get the same size and time limits, but
no address policy.

**Browsers.** A page cannot pin DNS or check which address it connects to, so the SDK never
fetches an on-chain `manifest_uri` directly from a browser. `new ManifestSource(...)` needs at
least one of these:

- **A `fetcher`**, for example the same-origin proxy described below.
- **`mirrors` and/or `ipfsGateway`**: sources you control, fetched with `boundedWebFetch` over
  the platform `fetch`.

This is the default behaviour. Without a `fetcher`, an `https` `manifest_uri` is skipped and
recorded in `attempts` as `MANIFEST_URI_SKIPPED`, and the mirrors are used instead.

**Recommended browser deployment: a same-origin proxy fetcher.** Serve a small endpoint from
your app's origin. It fetches the `manifest_uri` on the server with the Node downloader and
returns the bytes unchanged. In the browser, point the fetcher at it:

```ts
import { ManifestSource, HubReader, boundedWebFetch } from 'trueopen-sdk';
import type { ManifestFetcher } from 'trueopen-sdk';

// ManifestFetcher = (url, { maxBytes, timeoutMs }) => Promise<Uint8Array>
const proxyFetcher: ManifestFetcher = (url, limits) =>
  boundedWebFetch(`/manifest-proxy?url=${encodeURIComponent(url)}`, limits);

const source = new ManifestSource({
  reader: new HubReader({ baseUrl: 'https://node.example:1317', fetch }),
  fetcher: proxyFetcher,
  mirrors: ['https://mirror.example/manifests/{manifest_hash}.json'], // optional fallback
});
```

The proxy must enforce every downloader rule on the server. `createNodeManifestFetcher()` from
`trueopen-sdk/node` does this by default:

- Resolve the host, and refuse unless every address is public (IPv4 and IPv6, including
  IPv4-mapped, NAT64 and 6to4 forms).
- Connect only to the address it checked (no DNS rebinding).
- Verify TLS against the original host name.
- Re-check the address on every retry and every redirect hop. Follow at most 3 redirects, and
  never from https to http.
- Apply a connect timeout and a total timeout.
- Cap the body at 4 MiB after decompression, and allow only gzip, deflate or br.
- Accept only a URL that is valid `manifest_uri` syntax (`parseManifestUri`, https), so the
  endpoint is not an open proxy.
- Return the bytes exactly as fetched.

The proxy is trusted for network safety only, not for integrity. The browser SDK still re-checks
everything the proxy returns:

- the hash against `manifest_hash`;
- strict parsing;
- exact canonical bytes;
- the projection against `ProfileState`.

A proxy that alters the body therefore cannot get a manifest accepted.
[`examples/manifest-proxy.mjs`](examples/manifest-proxy.mjs) is a runnable example.

### ⚠️ Integration checkpoint (byte encoding conventions)

The order envelope sent to nexus is the protobuf `SignedOrderV2`, and the OpenTask header
signature covers its hex text. This header layer is nexus-side and has no wire fixture; it is
checked by a regression value and by live submissions.

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
| `npm test` | vitest |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | tsup -> ESM + CJS + `.d.ts` + `dist/cli.cjs` (bin, target es2022) |
| `npm run generate` | `buf generate` (generates protobuf-es from the wire submodule + nexus proto) |

> Chain / nexus integration tests are skipped without a live devnet (e.g.
> `test/integration/chain.integration.test.ts`). Canonical encoding / signing bytes are guarded
> by golden-vector unit tests to catch drift from the backend.

### proto source

The single authority for all proto is **[TrueOpen/wire](https://github.com/TrueOpen/wire)**,
pinned as a submodule at `third_party/wire`. It currently points at wire commit **`ea2f230`**
(wire PRs #38 and #39, merged to wire main), the EIP-712 request signing and session grants
intended for wire v0.4.0. That release is not tagged yet, so the pin is temporary: it will move to the
`v0.4.0` tag once that is published. **This repo no longer keeps
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
| `nexus.v1.IngressAPI` | `third_party/wire` (commit `ea2f230`) |
| `task.v1` / `shared.v1` | `third_party/wire` (commit `ea2f230`) |
| `cosmos.base.v1beta1` + gogoproto / cosmos_proto / amino annotations | BSR (commit pinned in `buf.lock`) |

The generation scope is limited by `buf.gen.yaml`'s `paths` to the transitive closure the SDK
needs (14 wire files + 5 annotation/type dependencies), not all 74 proto files in wire. RPCs the
SDK uses: `OpenTask` / `GetTaskStatus` / `GetTaskEvents` / `GetTaskDataMetadata` /
`FetchTaskData` / `SubscribeOutput` / `AckOutput` / `PrepareChallenge`. `task/v1/settlement.proto`
is generated as well, for the `TaskVerdict` / `TaskFailureClass` enums the SDK re-exports.

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
| `trueopen output get <session> <task> [task-hash] [output-hash]` | fetchTaskOutput, anchors read from chain (requires `--auto`) | none |
| `trueopen output stream <session> <task> [task-hash] [worker-pubkey]` | streamOutput, anchors read from chain (per-frame signature + root verification) | none |
| `trueopen challenge prepare <session> <task> <kind>` | prepareChallenge | none |

### Order-file format for `order submit`

Since `TaskOrderV2`/`TaskOrderV3`, the fields have changed materially: fees are now **Amount
(decimal text, atomic units)** for the four fee fields (`priceBid` / `maxFee` /
`assignmentPriorityFee` / `txFeeReserve`), enums can be written by name, and the file **no
longer includes** `reward_bucket` / `profile_resource_tier` / `order_value` /
`infer_timeout_blocks` / `payload_hash` / `valid_after_height` -- the first four are derived by
the Keeper (submitting them gets the order rejected), and the last two are derived by the SDK
from `--payload-file` and the on-chain height.

```json
{
  "modelId": "<64hex>",
  "profileVersion": 1,
  "taskType": "TEXT_GENERATION",
  "inputBucket": 1,
  "outputBudgetBucket": 1,
  "maxOutputTokens": 128,
  "maxOutputDurationMs": 60000,
  "priceBid": "100000",
  "maxFee": "1000",
  "assignmentPriorityFee": "0",
  "txFeeReserve": "0",
  "earliestSubmitHeight": "100",
  "orderExpireHeight": "50100",
  "latencyClass": "STANDARD"
}
```

Every field is required and no other field is accepted (the CLI never fills in a default).
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
| `--gas-price` | `TRUEOPEN_GAS_PRICE` | `0.025` in the chain `business_denom` (any other denom is refused) |
| `--fee-denom` | `TRUEOPEN_FEE_DENOM` | - (optional check; the chain `business_denom` is always used) |
| `--json` | - | human-readable |

**Connect only what you need**: read-only commands need only REST; commands that touch nexus
need nexus (`--auto` can discover it); commands that write to the chain (session create, order
cancel) need rpc + a key.

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
