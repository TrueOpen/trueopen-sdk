# trueopen-sdk API Reference

The symbol-by-symbol reference for the SDK's public surface. The
[README](../README.md) explains the *why* (concepts, capability boundaries, quick start);
this page documents the *what* (signatures, semantics, error codes). It tracks `main`.

## Package entry points

| Entry | Runtime | Contents |
|---|---|---|
| `trueopen-sdk` | browser / Node / Deno | Everything except the Node-only downloader |
| `trueopen-sdk/node` | Node only | `createNodeManifestSource`, `createNodeManifestFetcher` |

The `./node` entry exists so browser bundles never pull in `node:https`, `node:dns` or
`node:zlib`.

---

## 1. `TrueOpenClient` — the facade

`TrueOpenClient` is the single object a caller needs for the end-to-end flow. Everything
else on this page is a building block it composes, or a reader/writer you inject into it.

### 1.1 Construction

```ts
new TrueOpenClient(cfg: TrueOpenClientConfig)
```

| Field | Type | Notes |
|---|---|---|
| `chainId` | `string` | Cosmos chain id (e.g. `"trueopen-testnet-1"`). Signed into every order. |
| `userAddress` | `string` | The user's account (order user + signer of every request). Canonical bech32, or a `0x` EVM address which is converted. |
| `wallet` | `TypedDataSigner` | Signs the order, the OpenTask request envelope, and every other Builder request, all as EIP-712 typed data (65-byte R‖S‖V, each recovered and checked against `userAddress` before sending). Use `privateKeyTypedDataSigner` (CLI/servers), `eip1193TypedDataSigner` (browser wallets) or `keplrTypedDataSigner` (Keplr). |
| `chain` | `ChainClient` | Chain read+write (use `connectTrueOpenChainClient`). |
| `ingressTransport` | `Transport` | Connect transport for nexus `IngressAPI`. |
| `signatureChainId` | `bigint \| number \| string` | The signer-chosen EIP-712 domain chainId (the wallet's active network). Defaults to `1` (Ethereum mainnet) for session keys and servers. |
| `feeDenom` | `string` | Optional override; checked against the chain `business_denom` (§3). |
| `hub` | `FacadeHubReader` | Needed by `openTask` (builder set, order context, pricing). |
| `taskReader` | `OutputTaskReader` | Needed to derive output trust anchors (§10). |
| `sessionKeyRequestExpiryMarginBlocks` | `number` | Blocks of margin before a registered key's expiry for requests (default 3): the key signs a session's requests only while `latest + margin <= expiry`, then they fall back to the grant or the wallet. Orders are unaffected. A non-negative integer, else `SDK_LOCAL_SESSION_KEY_CONFIG_INVALID`. |
| `sessionKeyAnchorWaitMs` / `sessionKeyAnchorPollMs` | `number` | How long `openTask` waits for an anchor at or after a registered key's `set_height` (default `DEFAULT_SESSION_KEY_ANCHOR_WAIT_MS`, 15000; 0 disables; finite and `>= 0`) and the poll interval (default 1000; finite and `> 0`). Anything else throws `SDK_LOCAL_SESSION_KEY_CONFIG_INVALID` from the constructor. |
| `session` | `{ maxGrantBlocks, grantBlocks?, renewBeforeBlocks? }` | Opt-in session grants: the wallet signs one `SessionGrant` for an in-memory session key, which then signs SubscribeOutput / AckOutput / GetTaskEvents / PrepareChallenge / OUTPUT task-data requests. For OpenTask the grant key signs the request envelope; the order itself is signed by the wallet, or by a registered key (§6.1). The key is never persisted. |
| `nonce` | `() => Uint8Array` | Request nonce (exactly 32 bytes). Defaults to the platform secure RNG. |
| `expiry` | `() => bigint` | Request expiry (Unix ms). Defaults to now + `requestTtlMs`. |
| `requestTtlMs` | `number` | Non-OpenTask request expiry (default 5 min). |
| `requestTtlBlocks` | `number` | OpenTask expiry window in blocks (default 10). |
| `taskDataExpiryBlocks` | `number` | Task-data request (metadata/fetch) expiry window in blocks (default 10). |
| `fetchDescriptor` | `DescriptorDocFetch` | For builder descriptor hash verification. |
| `ingressTransportFactory` | `(endpoint, tlsPubkeyHash?) => Transport` | Per-builder transport factory used by `openTask` routing. |

### 1.2 Sessions

```ts
createSession(opts?: string | { label?: string; sessionKey?: SessionKeyOptions }): Promise<SessionHandle>
getSession(sessionId: string): Promise<SessionHandle>
nextOrderSequence(sessionId: string): Promise<bigint>
cancelOrder(sessionId: string, orderSequence: bigint): Promise<CancelOrderResult>
```

- `createSession` writes `MsgCreateSession` on chain. `SessionHandle` wraps `sessionId`
  plus the signer so later orders in the same session reuse it.
- `nextOrderSequence` reads `StreamState.next_expected_sequence` — the sole source of
  truth. A locally incremented counter never self-heals after a rejected order.
- `cancelOrder` is authorized by the account signature alone.
- Registered session keys (ADR-0037) have their own methods: §6.1.

### 1.3 Orders

```ts
async openTask(params: OpenTaskParams): Promise<OpenTaskResult>
```

`OpenTaskParams`:

| Field | Notes |
|---|---|
| `sessionId` | Required. |
| `order` | `TaskOrderIntent` (user intent including `payload`). `userAddress`/`sessionId`/`orderSequence` are filled in by the client. |
| `idempotencyKey` | Required. Same key + same `input_hash` → same result; same key + different `input_hash` → rejected. |
| `orderSequence?` | Defaults to `nextOrderSequence`. Pass explicitly only for RBF. |
| `context?` | Defaults to a context from the client's `TaskOrderContextCache` (session anchor reused across orders, see §3.2; `config.orderContextReuse: false` resolves a fresh one each time). Passed contexts are used as is. |
| `expiryHeight?` | Block height (default `latestHeight + requestTtlBlocks`). |
| `inputMediaType?` / `chunkSizeBytes?` | OpenTask transport tuning. |
| `pricing?` | Defaults to `hub.getProfile(...).pricing`; pass to skip the read. |
| `orderSigner?` | `'auto'` (default): a loaded registered key signs the order, after its prechecks, else the wallet. `'wallet'`: the wallet signs even with a key loaded; no key prechecks run and the envelope is signed as without a key (grant when `session` is configured, else the wallet). Anything else is `SDK_LOCAL_ORDER_SIGNER_INVALID`. |

`openTask` resolves the fee denom, pricing, order sequence and context concurrently (fails
closed with `SDK_LOCAL_PRICING_UNAVAILABLE` / `SDK_LOCAL_FEE_DENOM_MISMATCH` if unavailable),
builds the frozen `TaskOrderV3`, derives `task_id`, then signs the order while it resolves the
selected Builders' endpoints (selection depends only on `task_id` and the context) and prewarms
connections to them through `config.ingressPrewarm`. It then fans out to the selected builders
and returns the per-builder result.

```ts
async resolveTaskBuilders({ sessionId, orderSequence?, context? }): Promise<{ taskId, orderSequence, context, endpoints, unresolvedBuilders }>
async prewarmTaskBuilders(endpoints): Promise<void>
```

`resolveTaskBuilders` gives the Builders an order will go to before anything is signed; pass the
returned `context` to `openTask` so it signs against the same anchor and BuilderSet.
`prewarmTaskBuilders` opens connections to them through `config.ingressPrewarm`, concurrently,
and never rejects (no-op without `ingressPrewarm`). Under Node, set
`ingressPrewarm: (uri, hash) => prewarmNexusConnections(uri, hash)` with
`ingressTransportFactory: nexusIngressTransport` (see §10).

`OpenTaskResult` (extends `OpenTaskAck`):

| Field | Notes |
|---|---|
| `taskId` / `taskHash` | Derived identity and content hash. |
| `context` | The on-chain context actually used. |
| `endpointsTried` | Number of builders contacted. |
| `feeDenom` | The denom signed into the order. |
| `builders` | `OpenTaskBuilderResult[]` — `{ address, rank, serviceEndpoint, tlsPubkeyHash, ack?, error? }`. |
| `unresolvedBuilders` | `{ address, error }[]` — selected builders whose nexus endpoint could not be resolved. |
| `orderSequence` | The sequence signed into the order. |
| `orderSignedBy` | `'wallet' \| 'session-key'`. |
| `orderSignerAddress?` | 20-byte address of the registered key that signed (session-key orders only; never the private key). |
| `maxFee` | The order's `max_fee` (bigint, atomic units). The anchor height is `context.sessionAnchorHeight`. |
| `retryParams` | `OpenTaskParams` for a re-signed order under the same sequence: these params with `orderSequence` set, `context` / `expiryHeight` removed, and `idempotencyKey` = `<key>#retry1` (`<key>#retryK` becomes `#retry(K+1)`, see `nextRetryIdempotencyKey`). The payload is the same object. Never sent by the SDK itself. |

```ts
async waitForAdmission(res: OpenTaskResult, opts?: WaitForAdmissionOptions): Promise<AdmissionOutcome>

type AdmissionOutcome =
  | { kind: 'accepted'; taskId }                          // chain task has this task_hash
  | { kind: 'superseded'; taskId; chainTaskHash }         // chain task for task_id has another task_hash
  | { kind: 'rejected'; taskId; diagnosis: RejectionDiagnosis; retry: OpenTaskParams }
  | { kind: 'timeout'; taskId };
interface RejectionDiagnosis {
  sequenceFree: boolean;   // chain next_expected_sequence == res.orderSequence
  reason: RejectionReason; // 'session-closed' | 'cleared' | 'rotated' | 'expired' | 'anchor-before-set-height' | 'spend-cap' | 'unrelated'
  events: readonly { builderAddress: string; eventCode: string }[];
  session: StreamStateView;
}
```

Waits for the chain to decide an order (acks are only local acceptance). Needs `taskReader` and
`ingressTransportFactory` (`SDK_LOCAL_ADMISSION_UNCONFIGURED`).

| Option | Notes |
|---|---|
| `timeoutMs?` | Bound on the wait (default `DEFAULT_ADMISSION_WAIT_MS`, 60000); finite `> 0` else `SDK_LOCAL_TIMEOUT_INVALID`. Running out resolves `{ kind: 'timeout' }`. |
| `pollIntervalMs?` | Chain read interval (default `DEFAULT_TRUST_ANCHOR_POLL_MS`, 1000); finite `> 0` else `SDK_LOCAL_POLL_INTERVAL_INVALID`. |
| `signal?` | Aborts at once: throws `ORDER_ADMISSION_WAIT_ABORTED` (family `SDK_LOCAL`). |

- The chain is the truth: `taskReader.queryTask(taskId)` at once and every `pollIntervalMs`; a 404
  is "not on chain yet", any other read error is thrown.
- The task event stream of every Builder whose ack was `accepted` is opened (signed with this
  client's `ingressAuth()`) and closed when the wait ends. `ASSIGNMENT_FINALIZED`,
  `WORKER_ASSIGNMENT_FINALIZED` and `WORKER_HANDRAISES_ACCEPTED` trigger an immediate read;
  `ASSIGN_REJECTED` / `ASSIGN_TIMEOUT` are recorded (first per Builder). A failing stream is
  ignored, so that Builder never reports and the wait can only end on chain or by timeout.
- `rejected` only when every acked Builder reported and a chain read started after the last
  report shows no task. Then `chain.querySession` is read: `sequenceFree` compares
  `nextExpectedSequence`; if it moved on, the task is read once more (this order may have just
  been admitted). The reason, in order: CLOSED → `session-closed`; for a key-signed order, no key
  → `cleared`, another key → `rotated`, latest height > expiry → `expired`, anchor <
  `set_height` → `anchor-before-set-height`, `spent + maxFee` over a nonzero cap (or past u64)
  → `spend-cap`; else (and always for a wallet order) `unrelated`.
- `retry` is `res.retryParams`, without `orderSequence` when `sequenceFree` is false.
- The SDK never re-signs, renews, raises a cap or switches to the wallet by itself; the caller
  decides and calls `openTask(retry)` (optionally with `orderSigner: 'wallet'`). The retry uses a
  new idempotency key because the re-signed order's `task_hash` differs. Re-sending the same
  `task_id` to a Builder that holds it as a terminal task needs Nexus local terminal-task retry
  support, a separate Nexus requirement not yet available.

### 1.4 Task status and events

```ts
taskStatus(sessionId: string, taskId: string): Promise<TaskStatusView>
watchTask(sessionId: string, taskId: string, fromCursor?: string, opts?: { signal?: AbortSignal }): AsyncIterable<GetTaskEventsResponse>
```

- `taskStatus` is a **local, informational** nexus snapshot. Never a correctness criterion.
- `watchTask` subscribes to nexus's task event stream. `GetTaskEventsResponse` carries
  `cursor`, `state`, `taskPhase`, `eventCode`, `chainHeight`, `taskId`. Use for UX feedback
  and reconnect recovery (pass `fromCursor` to resume); feeding a state-machine reducer is
  left to the caller. It carries **no** content-level commitment, unlike `streamOutput`.
  Abort `opts.signal` to close the request when giving up on it: stopping reads alone does
  not. It cancels only this stream, not the transport.

---

## 2. Errors

```ts
class TrueOpenError extends Error
new TrueOpenError(family, code, message?, { retriable?, switchSource?, category?, details?, cause? })
function dataError(code, message?): TrueOpenError        // DATA family, switchSource, category data-corrupt
function classifyNexusError(err): unknown                // Connect error → typed TrueOpenError
function classifyBroadcastError(err): unknown            // CheckTx BroadcastTxError → CHAIN_TX_REJECTED
function nexusErrorCode(message): string | undefined     // leading NEXUS_*/SDK_* code
```

| Field | Meaning |
|---|---|
| `family` | `DATA` / `NEXUS_INGRESS` / `SDK_AUTH` / `SDK_LOCAL` / `CHAIN_REJECT`. |
| `code` | Stable machine-readable code (e.g. `NEXUS_DATA_NOT_FOUND`). |
| `retriable` | Retry the same peer (e.g. an expired request window). |
| `switchSource` | Move to another builder (e.g. a hash mismatch). |
| `category` | `auth` / `expired` / `not-found` / `data-unavailable` / `capacity` / `invalid` / `conflict` / `data-corrupt` / `internal` / `transport` / `chain-rejected`. |
| `details` / `cause` | Structured extras / the original error. |

`classifyNexusError` maps a Connect error to a typed `TrueOpenError`. The nexus code in the
message wins over the Connect code; a local transport failure (socket/TLS) becomes
`NEXUS_TRANSPORT_FAILED` and its message is never read as a nexus code. `retriable` and
`switchSource` drive the failover in `streamOutput` and `fetchTaskOutput`.

`classifyBroadcastError` turns a CosmJS `BroadcastTxError` (CheckTx rejection) into
`CHAIN_TX_REJECTED`, keeping codespace/code/log in `details`. An account-sequence mismatch
(sdk code 32) is retriable; matched by shape, not class name.

---

## 3. Orders & model ID

### 3.1 Model ID

```ts
function deriveModelId(input: ModelIdInput): string        // "TRUEOPEN_MODEL_ID_V1"
function isValidModelId(modelId: string): boolean
function validateModelId(modelId: string): void
```

`deriveModelId({ chainId, provider, repoId, proposerAddress })` reproduces the on-chain
identity hash. `provider` is a canonical token (`HUGGINGFACE`); `repoId` is
`<namespace>/<name>` (NFC, ≤255 bytes); `proposerAddress` is canonical bech32. Non-canonical
input is rejected, never normalized — the Hub Keeper recomputes the same digest from the
registration signer. `deriveModelId` returns, and `isValidModelId` accepts, a non-zero Hash32 in
its text form: `0x` + 64 lowercase hex (`MODEL_ID_GRAMMAR = '^0x[0-9a-f]{64}$'`).

### 3.2 Building an order

```ts
async function resolveTaskOrderContext(hub, chainId): Promise<TaskOrderChainContext>
function buildTaskOrder(ctx, req: TaskOrderRequest, pricing?): TaskOrderV3
function deriveTaskId(sessionId: string, orderSequence: bigint): string   // 0x + 64 lowercase hex in and out
function defaultGenerationParams(maxOutputTokens: bigint, maxOutputDurationMs: bigint): GenerationParamsV1
function payloadRefFor(payload: Uint8Array): string          // "nexus://sha256/<bare 64-hex>"
```

`TaskOrderRequest` (the full set of facts signed into `task_hash`):

| Field | Notes |
|---|---|
| `payload` | Raw `Uint8Array`. Its sha256 becomes `input_hash`; must be non-empty. |
| `modelId` | Hash32, `0x` + 64 lowercase hex. |
| `profileVersion` | `number`. |
| `taskType` | `TASK_TYPE` numeric value. |
| `inputBucket` / `outputBudgetBucket` | `number`; `outputBudgetBucket` must be non-zero. |
| `generationParams` | `GenerationParamsV1` — use `defaultGenerationParams`. |
| `amounts` | `priceBid` / `maxFee` / `assignmentPriorityFee` / `txFeeReserve`, each `{ atomicUnits: string }`. |
| `earliestSubmitHeight` / `orderExpireHeight` | `bigint`; `earliest < expire`. |
| `latencyClass` | `DEADLINE_LATENCY_CLASS` numeric value. |

`TaskOrderV3` is the frozen order (28 fields). Its `task_hash` is
`H_FIELDS_V1("TRUEOPEN_TASK_ORDER_V3", ...)`. Key invariants enforced locally: positive
`max_fee`, zero `assignment_priority_fee`, `payload_mode = PLAINTEXT`,
`input_key_commitment = zero32`, empty `user_recipient_pubkey`.

`resolveTaskOrderContext` reads the anchor beacon, the builder set **at the anchor
height**, the timeout bucket, and the generation limits. `resolveTaskOrderContextWithBuilderSet`
also returns the BuilderSet it read, so routing does not read it again.

```ts
class TaskOrderContextCache {
  constructor(hub: TaskOrderContextCacheReader, chainId: string, opts?: { maxAnchorAgeFraction?, anchorLag? })
  resolve(): Promise<ResolvedTaskOrderContext>   // { context, builderSet }
  invalidate(): void
}
```

Reuses the session anchor (height and beacon block hash) across orders, saving one sequential
chain round trip per order. On reuse it still re-reads, in one concurrent round, the latest
height, the BuilderSet at the anchor height (the chain needs it ACTIVE; a pruned body fails the
read), the current timeout bucket version, the generation limits and task params
`session.anchor_freshness_window_blocks` (`HubReader.getAnchorFreshnessWindowBlocks`). The anchor
is reused only while `latest - anchor <= floor(window * maxAnchorAgeFraction)` (default 0.25);
otherwise, or when any of those reads fails, a fresh anchor is resolved. Without
`getAnchorFreshnessWindowBlocks` it never reuses. After a reuse it checks in the background
whether the set at the latest height moved on, and if so the next order gets a fresh anchor.
`TrueOpenClient` uses one per client unless `config.orderContextReuse` is `false`.

`resolveFeeDenom(chainDenom, override)` picks the order's EIP-712 `feeDenom`: the chain
`business_denom` is authoritative, an override that disagrees is refused
(`SDK_LOCAL_FEE_DENOM_MISMATCH`), and a missing chain denom with no override is
`SDK_LOCAL_FEE_DENOM_UNAVAILABLE`.

### 3.3 Order EIP-712 signing

```ts
taskOrderEip712Digest(order, ctx: OrderEip712Context): Uint8Array
taskOrderTypedData(order, ctx): TypedData
signAndEncodeOrder(order, ctx, signer): Promise<EncodedSignedOrder>
encodeSignedOrder(order, userSignature): Uint8Array
decodeSignedOrder(bytes): SignedOrderV2
buildOpenTaskRequest(input): Promise<BuildOpenTaskResult>
```

The order is authorized by the **inner** EIP-712 signature (`SignedOrderV2.user_signature`,
65-byte R‖S‖V recovering to the order user). There is no outer order signature;
`OpenTaskHeader.signature` stays empty. Domain: name `"TrueOpen Task Order"`, version `3`,
`chainId = signature_chain_id`. Checked byte-for-byte against wire's golden vectors.

`OrderEip712Context` = `{ signatureChainId, feeDenom }`.

---

## 4. SDK request envelope & body

### 4.1 Envelope (every nexus request is signed)

```ts
const SDK_REQUEST_DOMAIN = 'TRUEOPEN_SDK_REQUEST_V2'
const SDK_REQUEST_EIP712_DOMAIN_NAME = 'TrueOpen SDK Request'
const SDK_REQUEST_EIP712_DOMAIN_VERSION = '1'
const INGRESS_SERVICE_PATH = '/nexus.v1.IngressAPI'
const SESSION_SDK_METHODS = ['SubscribeOutput', 'AckOutput', 'GetTaskEvents', 'PrepareChallenge']
const HEIGHT_EXPIRY_THRESHOLD = 1_000_000_000_000n

function sdkRequestEip712Domain(signatureChainId): { name, version, chainId }
function sdkRequestTypedData(f: SdkRequestFields, signatureChainId, sessionGrantHash?): TypedData
function sdkRequestEip712Digest(f: SdkRequestFields, signatureChainId, sessionGrantHash?): Uint8Array
async function signSdkRequestEnvelope(fields: SdkRequestFields, opts: { signerAddress, signer, signatureChainId, session?, chainId? }): Promise<SignedSdkRequestEnvelope>
function ingressEndpoint(method: string): string
function strictHash32(field: string, text: string): Uint8Array
```

`SdkRequestFields` = `{ chainId, method, sessionId, taskId, requestNonce, expiryHeightOrTime,
bodyDigest }` (`endpoint` is derived, not a field). `sessionId` / `taskId` are Hash32 text,
`0x` + 64 lowercase hex, sent as is; `strictHash32` refuses any other spelling with
`SDK_LOCAL_NOT_HASH32` and decodes the 64 hex after `0x` to the raw 32 bytes the digest frames. `SignedSdkRequestEnvelope` adds
`requestDomain`, `endpoint`, `signatureChainId`, `signerAddress`, `signature`, and
`sessionGrant?`. Every Builder request carries one; the SDK recovers the signature and checks
it against the sender before sending.

### 4.2 Body digests

```ts
const SDK_BODY_DOMAIN = { OPEN_TASK, SUBSCRIBE_OUTPUT, ACK_OUTPUT, GET_TASK_EVENTS, PREPARE_CHALLENGE }
function openTaskBodyDigest(b: OpenTaskBody): Uint8Array
function openTaskPayloadRef(inputHash: string): string
function subscribeOutputBodyDigest(sessionId, taskId, resumeAfterSeq?): Uint8Array
function ackOutputBodyDigest(sessionId, taskId, lastSeq): Uint8Array
function getTaskEventsBodyDigest(sessionId, taskId, fromCursor): Uint8Array
function parseFromCursor(fromCursor: string): bigint | undefined
function prepareChallengeBodyDigest(...): Uint8Array
```

`OpenTaskBody` = `{ taskHash, sessionId, orderSequence, userAddress, inputSizeBytes,
inputHash, inputMediaType, idempotencyKey }`.

---

## 5. Task data signing

```ts
const TASK_DATA_BODY_DOMAIN = { UPLOAD, FINALIZE_RESULT, FINALIZE_VERIFIER, METADATA, FETCH }   // all "..._BODY_V2"
const TASK_DATA_EIP712_DOMAIN_NAME = 'TrueOpen Task Data Request'
const TASK_DATA_EIP712_DOMAIN_VERSION = '2'
const TASK_DATA_RPC_METHOD = { GetTaskDataMetadata, FetchTaskData, ... }
const TASK_DATA_OBJECT_KIND = { UNSPECIFIED, INPUT, OUTPUT, EVIDENCE_MANIFEST, EVIDENCE_ARTIFACT, ... }
const TASK_DATA_REQUESTER_KIND = { UNSPECIFIED, USER, CORTEX_SERVICE }
const EVIDENCE_PRODUCER_KIND = { UNSPECIFIED, WORKER, VERIFIER }
const EVIDENCE_KIND = { UNSPECIFIED, WORKER_VALUE_OPENING, VERIFIER_VALUE_OPENING, SETTLEMENT_ROOT_OPENING, WORKER_TOKEN_OPENING }

function canonicalObjectRefFrame(ref: TaskDataObjectRef): Uint8Array
function taskDataMetadataBodyDigest(ref: TaskDataObjectRef): Uint8Array
function taskDataFetchBodyDigest(ref: TaskDataObjectRef, range?: ByteRange): Uint8Array
function taskDataRequestTypedData(f, signatureChainId, sessionGrantHash?): TypedData
function taskDataRequestEip712Digest(f, signatureChainId, sessionGrantHash?): Uint8Array
function taskDataRequestSignBytes(f: TaskDataRequestAuthFields): Uint8Array
```

`TaskDataObjectRef` = `{ taskHash, sessionId, taskId, objectKind, contentHash,
evidenceProducerKind?, verifyRound?, producerOperator?, evidenceKind? }`. The nine-field
canonical frame gained `evidence_kind` (V2); `producer_operator` enters the preimage as
address bytes. `canonicalObjectRefFrame` **throws** on an illegal object_kind /
evidence_kind combination before computing any digest (fail-closed).

`TaskDataRequestAuthFields` = `{ schemaVersion, chainId, builderOperatorAddress, rpcMethod,
bodyDigest, requesterKind, requesterAddress, serviceAuthorizationNonce, requestNonce,
expiryHeight }`.

---

## 6. Sessions & session grants

```ts
class SessionManager            // session handle bookkeeping
interface SessionHandle         // { sessionId, ... }

const SESSION_GRANT_EIP712_TYPES
const SESSION_SDK_METHODS
const SESSION_TASK_DATA_METHODS
function sessionGrantTypedData(f: SessionGrantFields, signatureChainId): TypedData
function sessionGrantHash(f: SessionGrantFields): Uint8Array
function sessionGrantMessage(g: SignedSessionGrant): SessionGrantV1
class SessionKeyManager implements SessionAuthority
```

`SessionGrantFields` = `{ chainId, user, sessionKey, expiryHeight, grantNonce, signatureChainId }`;
`SignedSessionGrant` adds `userSignature` (65-byte R‖S‖V by the user's wallet).

### The session key

A **session key** is a short-lived secp256k1 private key the SDK generates so a browser wallet
does not prompt on every request. The flow:

1. `SessionKeyManager` draws the key from the platform CSPRNG. It lives **only in memory** —
   never persisted and never derived from a signature.
2. The user's wallet signs one `SessionGrant` (EIP-712 `SessionGrant(string chainId, string user,
   address sessionKey, uint64 expiryHeight, bytes32 grantNonce)`), authorizing that key.
3. The session key then signs the session-allowed requests; each such request carries
   `sessionGrantHash = hashStruct(SessionGrant)` and its signature recovers to
   `grant.sessionKey`, while `signer_address` stays the granting user.
4. Before the grant expires — or when a Builder reports it expired — the manager **renews with a
   fresh key and a fresh grant**; the old key simply lapses. There is no revocation.

A session key may sign only `SubscribeOutput`, `AckOutput`, `GetTaskEvents`, `PrepareChallenge`,
and `GetTaskDataMetadata` / `FetchTaskData` of an OUTPUT object. `OpenTask` and every other
request stay wallet-signed. `maxGrantBlocks` must equal the Builders' `max_session_grant_blocks`;
`grantBlocks` (default `maxGrantBlocks - 2`) and `renewBeforeBlocks` (default a quarter of the
lifetime) tune the grant window.

Three distinct things: `session_id` is the on-chain stream namespace
(`TRUEOPEN_SESSION_V1(user_address, session_nonce)`), `SessionGrant` is the signed authorization,
and the **session key** is the in-memory key that grant authorizes.

### 6.1 Registered session keys (ADR-0037)

A different thing from a `SessionGrant`: the chain stores one 20-byte key per session, and that key
signs the session's orders and session-allowed requests. A `SessionGrant` key cannot sign orders. A
registered-key request carries `signer_address` = the owner, no `session_grant` and an all-zero
`sessionGrantHash`; its signature recovers to the key address. The order domain and digest are
unchanged. The key never signs a transaction.

```ts
interface SessionKeyOptions { expiryBlocks?: number; spendCap?: bigint | string }
interface RegisterSessionKeyOptions extends SessionKeyOptions { key?: SessionKeyMaterial }   // from generateSessionKey()
type SessionKeyUpdate = { renew: SessionKeyOptions } | { rotate: RegisterSessionKeyOptions } | { clear: true }
interface SessionKeyHandle { address: string; privateKey: Uint8Array; expiryHeight: bigint; spendCap: string }
interface SessionHandle { sessionId; /* ... */ sessionKey?: SessionKeyHandle }   // set only by createSession({ sessionKey })
interface UpdateSessionKeyResult { response: MsgUpdateSessionKeyResponse; newKey?: SessionKeyHandle }
interface SessionKeyState {
  registered: boolean; matchesLoadedKey: boolean; expiryHeight: bigint;
  spendCap: string; spent: string; setHeight: bigint; status: 'ACTIVE' | 'IDLE' | 'CLOSED'
}

createSession({ label?, sessionKey?: RegisterSessionKeyOptions }): Promise<SessionHandle>
updateSessionKey(sessionId: string, update: SessionKeyUpdate): Promise<UpdateSessionKeyResult>
useSessionKey(sessionId: string, privateKey: Uint8Array): Promise<void>
forgetSessionKey(sessionId: string): void
sessionKeyState(sessionId: string): Promise<SessionKeyState>
```

| Method | Behavior |
|---|---|
| `createSession({ sessionKey })` | Generates a key from a CSPRNG (or takes `sessionKey.key` from `generateSessionKey()`), registers it in `MsgCreateSession`, loads it and returns it once in `handle.sessionKey`. **Persist `privateKey` now**; to persist it before the broadcast (a broadcast that times out may still land), generate it yourself and pass it as `key`. |
| `updateSessionKey(.., { renew })` | `MsgUpdateSessionKey` (wallet-signed) with the loaded key and a new expiry and cap. The key must be loaded and still the chain's key (`SDK_LOCAL_SESSION_KEY_NOT_REGISTERED`); the session must not be CLOSED. The check and the tx are not atomic: if another device rotates in between, the renew re-registers the old key (there is no compare-and-set on chain), so do not renew on one device while rotating on another. |
| `updateSessionKey(.., { rotate })` | Generates a fresh key (never the old one; or takes `rotate.key`), registers it, and after the chain applied it loads it; `newKey` is its material, which you persist. Orders the old key signed that were not yet admitted are rejected. When the chain has no key (never set, or cleared) `spendCap` is required (`SDK_LOCAL_SESSION_KEY_INVALID`): there is no cap to keep, and the cleared cap 0 would be unlimited. |
| `updateSessionKey(.., { clear: true })` | Removes the registration and, on success, the loaded key; the wallet signs the session's orders again. |
| `useSessionKey` | Loads a persisted key after a restart. The session must belong to this user, not be CLOSED, and have exactly this key registered; else nothing is loaded. |
| `forgetSessionKey` | Unloads the key; the chain registration is unchanged. |
| `sessionKeyState` | `QuerySession` view plus `matchesLoadedKey`. Use it to diagnose a rejection. |

Terms. `expiryBlocks` is an integer in `[2, max_session_key_blocks]` (one block never lands: the
tx executes at the latest height + 1 or later and the chain needs `height < expiry`); the default
is `max_session_key_blocks - 2`, at least 2. The key expires at the latest height plus
`expiryBlocks`. `max_session_key_blocks` (`params.session.max_session_key_blocks`, read through
`HubReader.getMaxSessionKeyBlocks`) absent, 0 or below 2 is
`SDK_LOCAL_SESSION_KEY_UNSUPPORTED`. `spendCap` is a canonical unsigned decimal; `"0"` (the create
default) is unlimited, so a leaked key can then authorize orders up to the whole balance.
`renew` and `rotate` default to the chain's current cap. `spent` is never reset; requests never
consume the cap, only admitted orders do. The key is exactly 20 bytes, not all zero and not the
owner's address. Supplied material (`key`) is checked with `sessionKeyFromPrivateKey`: a valid
32-byte private key whose address is `key.address`, neither the owner's nor the key being rotated
out; no error ever carries key material.

Custody: the SDK never derives the key from a signature, keeps it in memory only and never logs
it. The caller persists `privateKey`.

`openTask` with a loaded key reads the session first and checks, before signing: not CLOSED; the
registered key is the loaded one; `latest_height <= session_key_expiry_height`; the session anchor
is at or after `session_key_set_height`; `spent + max_fee` fits a u64 even with cap 0 (the chain's
`AMOUNT_OVERFLOW`, reported as `SDK_LOCAL_SESSION_KEY_SPEND_CAP_EXCEEDED` with `details.overflow`);
and, with a nonzero cap, `spent + max_fee <= cap`. A failed check never falls back to the wallet. Right after a registration the fresh anchor is still
below `set_height`, so `openTask` polls (up to `sessionKeyAnchorWaitMs`) until one reaches it; a
caller-supplied `context` is used as is and refused when its anchor is older. Recovery after
`ASSIGN_REJECTED`: `waitForAdmission` (§1.3) diagnoses the rejection from chain state and returns
`retry`, the same-sequence params; fix the cause and call `openTask(retry)`. The SDK never
resubmits on its own. `orderSigner: 'wallet'` signs one order with the wallet without unloading the key.

Expiry and requests. The client tracks the loaded key's expiry height: set by `createSession`,
`rotate`, `renew` and `useSessionKey`, and refreshed by every `openTask` session read and
`sessionKeyState`. The key signs the session-allowed requests only while `latest_height + margin
<= expiry`, where the margin is `sessionKeyRequestExpiryMarginBlocks` (default
`DEFAULT_REGISTERED_KEY_EXPIRY_MARGIN_BLOCKS`, 3). After that those requests fall back to the
configured grant (`session`), else the wallet, so the output of the last orders admitted before
expiry can still be streamed, acked and fetched. The margin keeps a request judged against a
slightly old height, or reaching the Builder a block later, from being refused as expired (testnet
makes a block about every 0.5 s); raise it on chains with shorter blocks. The height is the hub's,
reused from one of the client's own reads made within about one block
(`DEFAULT_REGISTERED_KEY_HEIGHT_MAX_AGE_MS`), read again otherwise.
Orders never fall back: `openTask` refuses with `SDK_LOCAL_SESSION_KEY_EXPIRED`. A registered-key
request the Builder reports expired is not renewed or resent, and a `fetchTaskOutput` range retry
does not repeat it (the error is marked not retriable).

`StreamStateView` gains `sessionKey?: Uint8Array` (absent = wallet-only), `sessionKeyExpiryHeight:
bigint` (0 without a key), `sessionKeySpendCap: string`, `sessionKeySpent: string` and
`sessionKeySetHeight: bigint`.

Exports: `generateSessionKey`, `sessionKeyFromPrivateKey`, `registeredSessionKey`,
`RegisteredSessionKeys`, `sessionKeyAddressHex`, `DEFAULT_SESSION_KEY_ANCHOR_WAIT_MS`,
`DEFAULT_REGISTERED_KEY_HEIGHT_MAX_AGE_MS`,
`encodeMsgUpdateSessionKey`, `decodeMsgUpdateSessionKeyResponse` and the types above.

Error codes:

| Code | Meaning |
|---|---|
| `SDK_LOCAL_SESSION_KEY_INVALID` | Malformed key, grant or `expiryBlocks` / `spendCap` input. |
| `SDK_LOCAL_ORDER_SIGNER_INVALID` | `openTask` `orderSigner` is not `'auto'` or `'wallet'`. |
| `SDK_LOCAL_ADMISSION_UNCONFIGURED` | `waitForAdmission` without `taskReader` or `ingressTransportFactory`. |
| `ORDER_ADMISSION_WAIT_ABORTED` | `waitForAdmission`'s `signal` was aborted (family `SDK_LOCAL`). |
| `SDK_LOCAL_SESSION_KEY_UNSUPPORTED` | No `getMaxSessionKeyBlocks` reader, or the chain's limit is absent, 0 or below 2. |
| `SDK_LOCAL_SESSION_KEY_NOT_REGISTERED` | No key, or a different key, is registered or loaded for the session; also `useSessionKey` on a session owned by another user. |
| `SDK_LOCAL_SESSION_KEY_EXPIRED` | `latest_height` is past the key's expiry; renew. |
| `SDK_LOCAL_SESSION_KEY_SPEND_CAP_EXCEEDED` | `spent + max_fee` would exceed the cap (raise it), or overflow a u64 even with cap 0 (`details.overflow`; `spent` is never reset, so sign with the wallet). |
| `SDK_LOCAL_SESSION_KEY_CONFIG_INVALID` | `sessionKeyAnchorWaitMs` is not finite and `>= 0`, `sessionKeyAnchorPollMs` not finite and `> 0`, or `sessionKeyRequestExpiryMarginBlocks` not a non-negative integer. |
| `SDK_LOCAL_SESSION_KEY_ANCHOR_BEFORE_SET_HEIGHT` | The order's anchor is below the key's `set_height`; retriable when the SDK resolved the context. |
| `SDK_LOCAL_SESSION_CLOSED` | The session is CLOSED. |
| `SDK_AUTH_SESSION_KEY_SPEND_CAP_EXCEEDED` | Nexus refused an order over the cap (family `SDK_AUTH`, category `auth`, not retriable). |
| `ERR_SESSION_KEY_INVALID` / `_EXPIRED` / `_SPEND_CAP_EXCEEDED` | Chain codes, seen in a Builder's tx result or a tx log (not classified by the SDK). |

---

## 7. Task lifecycle enums (re-exported from wire)

```ts
// task.v1
enum TaskPhase        // TASK_PHASE_UNSPECIFIED, ...ASSIGNMENT_PENDING, ...WORKER_ASSIGNED, ...RECEIPT_COMMITTED, ...
enum AssignmentStatus // ASSIGNMENT_STATUS_*, incl. RANDOMNESS_PENDING / WORKER_ASSIGNED
enum ReceiptStatus    // RECEIPT_STATUS_*
enum VerificationStatus
enum SettlementStatus
enum TaskVerdict
enum TaskFailureClass
// shared.v1
enum TaskFinalityStatusV1
// task.v1.evidence
enum FinishReasonV1   // EOS_TOKEN=1, STOP_SEQUENCE=2, MAX_OUTPUT_TOKENS=3, MAX_OUTPUT_DURATION=4, USER_STOP=5, STOP_TOKEN=6
```

---

## 8. Output — commitment, verification, delivery

### 8.1 MMR and chunk/Fin signing

```ts
const OUTPUT_MMR_DOMAIN = 'TRUEOPEN_OUTPUT_MMR_V1'
const OUTPUT_CHUNK_DOMAIN = 'TRUEOPEN_OUTPUT_CHUNK_V1'
const OUTPUT_FIN_DOMAIN = 'TRUEOPEN_OUTPUT_FIN_V1'
const ACCEPTED_FINISH_REASONS = [1, 2, 3, 4, 5, 6]

function outputHash(chunks: readonly Uint8Array[]): Uint8Array        // MMR root over chunks
function isAcceptedFinishReason(value: number): boolean

function outputChunkSigningDigest(f: OutputChunkSigningFields): Uint8Array
function verifyOutputChunkSignature(f, signature, workerServicePubKey): boolean
function outputFinSigningDigest(f: OutputFinSigningFields): Uint8Array
function verifyOutputFinSignature(f, signature, workerServicePubKey): boolean

class OutputStreamVerifier
```

`OutputChunkSigningFields` = `{ chainId, taskHash, seq, mmrRoot, text }`.
`OutputFinSigningFields` = `{ chainId, taskHash, finalSeq, outputMmrRoot, finishReason }`.
Both signatures verify against the selected Worker's **current service key**; a bad
signature is never trusted. `verifyOutputFinSignature` also rejects an unaccepted
`finish_reason`.

`OutputStreamVerifier` accumulates chunks into an MMR, re-verifies every frame against the
committed root, dedupes replays, and emits `OutputStreamVerifierCheckpoint` (leaf count,
MMR peaks, last seq) for resumable streaming. `OutputFrameAcceptance` is
`'accepted' | 'duplicate'`.

### 8.2 Trust anchors

```ts
async resolveOutputTrustAnchors(taskId, { withReceipt? }): Promise<OutputTrustAnchors>
```

Derives, from chain queries, everything output is verified against: accepted `task_hash`
and `winner_worker`; the winner's current service key (must be `ACTIVE`); and (with
`withReceipt`) the accepted `InferReceipt` → `output_hash` / size / leaf count. Requires
`config.taskReader` and `hub.getCurrentServiceKey`. A missing winner or receipt is a
retriable `OUTPUT_TRUST_ANCHOR_PENDING`; a task that failed or settled without a winner (task
phase `FAILED` / `SETTLED`, or the terminal arm once the task is compacted) is a final
`OUTPUT_TRUST_ANCHOR_NO_WINNER`. The anchors are only as trustworthy as the
endpoints the readers point at.

```ts
async waitForOutputTrustAnchors(taskId, opts?: WaitForOutputTrustAnchorsOptions): Promise<OutputTrustAnchors>
```

Waits until the chain names the winner, then returns the streaming anchors
(`resolveOutputTrustAnchors(taskId, { withReceipt: false })`) to pass to `streamOutput` as
`taskHash` / `workerServicePubKey`. `streamOutput({ waitForAnchors })` runs this wait itself,
in parallel with an already open subscription (§8.3).

| Option | Notes |
|---|---|
| `sessionId?` | Also watch this client's Builder event stream: the first `ASSIGNMENT_FINALIZED` triggers one immediate chain read, started at once even if a read is already in flight (the first read to find the winner wins; an older read's "not yet" never overrides a newer read). The event is only a hint; without it, or if the event stream fails, the wait just polls. |
| `pollIntervalMs?` | Chain read interval, default `DEFAULT_TRUST_ANCHOR_POLL_MS` (1000, about one block). |
| `timeoutMs?` | Bound on the whole wait, default `DEFAULT_TRUST_ANCHOR_WAIT_MS` (60000); then `OUTPUT_TRUST_ANCHOR_TIMEOUT`. |
| `signal?` | Abort the wait at once: `OUTPUT_TRUST_ANCHOR_WAIT_ABORTED`. |

Each read is the task, then the winner's key, in order. Only `OUTPUT_TRUST_ANCHOR_PENDING` is
waited out; any other error from the newest read (for example
`OUTPUT_TRUST_ANCHOR_WORKER_KEY_INACTIVE` or `OUTPUT_TRUST_ANCHOR_NO_WINNER`) is thrown at once.
The event stream is closed when the wait ends. `timeoutMs` takes effect between reads; a single
chain read is bounded only by the reader's own limits.

### 8.3 Streaming

```ts
async *streamOutput(p: StreamOutputParams): AsyncIterable<OutputStreamEvent>
```

`StreamOutputParams`:

| Field | Notes |
|---|---|
| `sessionId` / `taskId` | Required. |
| `taskHash?` / `workerServicePubKey?` | Default to `resolveOutputTrustAnchors(taskId, { withReceipt: false })`. |
| `checkpoint?` / `resumeAfterSeq?` | Resume from a persisted verifier checkpoint. |
| `onCheckpoint?` | Persist a defensive checkpoint after each frame. |
| `ack?` | Report delivery progress after fin (default true). Only a Worker-signed fin is ever acked. |
| `finSignaturePolicy?` | `'require'` (default) or `'accept-unsigned'`. |
| `idleTimeoutMs?` | Idle cap for a single subscription. |
| `sources?` / `maxAttempts?` | Builder failover pool and attempt budget. A ResourceExhausted end (nexus dropping a subscriber that fell 256 frames behind) after new verified frames resubscribes on the same source after the last verified frame without using an attempt (at most `MAX_OVERFLOW_RESUBSCRIBES`, 64, times; then each counts as a failed attempt). |
| `waitForAnchors?` | Early subscribe: open the subscription at once and wait for the anchors in parallel (`true` = `waitForOutputTrustAnchors` with `{ sessionId }`; an options object is passed as is). The event hint is read from the first source when its ingress is an `IngressClient`, else from this client's ingress. Ignored when both `taskHash` and `workerServicePubKey` are given. |
| `pendingAnchors?` | Early subscribe with a promise of `{ taskHash, workerServicePubKey }` the caller already has; takes precedence over `waitForAnchors`. |
| `maxPendingFrames?` | Read-ahead bound before the anchors arrive (default `DEFAULT_MAX_PENDING_FRAMES`, 256). At the bound the SDK stops reading the subscription; nothing is dropped. |
| `signal?` | Abort: closes the subscription and any anchor wait, throws `OUTPUT_STREAM_ABORTED`. |

`OutputStreamEvent`:

```ts
{ kind: 'chunk', seq: bigint, text: string, mmrRoot: Uint8Array }
{ kind: 'fin', attested: true,  finishReason: FinishReasonV1 }
{ kind: 'fin', attested: false, finishReason: undefined }   // only under 'accept-unsigned'
```

- `text` is the **presented** view with the chat template's trailing EOS marker
  (`<|im_end|>`) stripped; `mmrRoot` still covers the committed bytes.
- The stream completes only on a fin whose `final_seq` and `output_mmr_root` match the
  locally verified prefix **and** whose Worker signature verifies. An unsigned fin is a bad
  frame under the default policy; under the explicit opt-in it ends the stream as
  `attested: false` and is never acked.
- Early subscribe: frames (and a fin) that arrive before the anchors are held unverified and
  never delivered, checkpointed or acked before they verify; once the anchors arrive they go
  through the same checks, in arrival order. The checks are the same as without early
  subscribe; the Worker's service key is read once, so a key rotated mid-stream is not covered
  (as before). If the anchor wait fails (no winner, timeout, inactive key, failed read), the SDK
  closes the subscription itself (nexus never ends it on a terminal task state) and throws that
  error. A subscription error before the anchors is handled after them, as a normal failed
  attempt. The idle timeout starts when the anchors are known.

### 8.4 Fetch (whole object)

```ts
async fetchTaskOutput(p): Promise<{ bytes, text, outputHash, taskHash, chunks, sizeBytes, mediaType, receipt? }>
```

`p` = `{ sessionId, taskId, taskHash?, outputHash?, anchors?, builderAddress,
expiresAtHeight?, maxRangeBytes?, rangeAttempts? }`. Fetches in ranges (≤
`DEFAULT_MAX_RANGE_BYTES` = 8 MiB), checks each range's `served_range` and chunk offsets,
retries a range that failed on transport (with backoff), checks the metadata against the
accepted receipt, and computes the MMR root against `output_hash`. A size-0 object is
returned verified as one zero-length leaf without a fetch. `bytes` is the committed object;
`text` has the EOS marker stripped.

### 8.5 Confirmation

```ts
confirmOutput(p: ConfirmOutputParams): ConfirmedOutputEvent
confirmOutputWithReceipt(input: ConfirmOutputWithReceiptInput): ConfirmedOutputEvent
```

Upgrade locally verified output to **confirmed** using the on-chain
`InferReceipt.output_hash`, leaf count, and byte size.

### 8.6 OpenAI chat SSE

```ts
type OutputDeliveryMode = 'provisional' | 'confirmed-only'
type OpenAIFinishReason = 'stop' | 'length'
const DEFAULT_CONFIRMED_ONLY_MAX_BUFFERED_BYTES = 16 * 1024 * 1024

function openAIFinishReason(reason: FinishReasonV1): OpenAIFinishReason
async function* toOpenAIChatSSEIterable(events, context, options?): AsyncIterable<Uint8Array>
function toOpenAIChatSSE(events, context, options?): ReadableStream<Uint8Array>
```

Adapters that turn `VerifiedOutputEvent` (the `streamOutput` stream) into OpenAI
`chat.completion.chunk` SSE, for Node (`Iterable`) and browser (`ReadableStream`).
`OpenAIChatSseContext` = `{ id, model }`; `OpenAIChatSseOptions` carries the delivery mode
(`provisional` = stream as frames arrive; `confirmed-only` = buffer and emit only after
confirmation) and the buffer cap. Build a `VerifiedOutputFinEvent` only from an
`attested: true` fin.

### 8.7 Checkpoint codec

```ts
const OUTPUT_STREAM_CHECKPOINT_JSON_FORMAT_V1 = 'trueopen-output-stream-checkpoint-v1'
function serializeOutputStreamCheckpoint(checkpoint: OutputStreamVerifierCheckpoint): string
function deserializeOutputStreamCheckpoint(json: string): OutputStreamVerifierCheckpoint
```

JSON round-trip for a verifier checkpoint (MMR peaks + leaf count + last seq), so a caller
can persist resumable-stream state across restarts.

---

## 9. Chain access

### 9.1 Types

```ts
interface StreamStateView    // { sessionId, owner, nextExpectedSequence, lastActiveHeight, openPendingCount, status }
interface ChainTaskSnapshot  // { view: 'active'|'terminal', terminalPhase?, taskId, acceptedTaskHash, acceptedInputHash?, winnerWorker, receiptStatus?, assignmentStatus?, modelId, profileVersion, orderSequence }
interface InferReceiptView   // { taskId, winnerWorker, inferReceiptHash, outputHash, outputSizeBytes, outputLeafCount }
```

`ChainTaskSnapshot` has a `view` discriminator. **Branch on `view`** before reading
`acceptedInputHash` / `receiptStatus` / `assignmentStatus` — they are `undefined` on the
compacted `terminal` arm, not `""`.

### 9.2 Readers

```ts
class HubReader        // hub.v1.Query over the gRPC-gateway REST API
class RestChainReader  // task.v1.Query (session / task / infer receipt)
```

`HubReader` (`baseUrl`, `fetch`, `retry?`) reads: models (`listModels`), profiles
(`getProfile`), pricing, builder set by height (`getBuilderSetAtHeight`), service
descriptors (`getServiceDescriptor`), current service keys (`getCurrentServiceKey`),
`business_denom` (`getBusinessDenom`), and manifest state
(`getProfileManifestState`). Hash32 fields decode to `0x` + 64 lowercase hex through
`restHash32`: the `0x` form passes through, a protojson base64 value is converted, and a bare
64-hex string is refused. `RestChainReader` decodes its Hash32 fields (`session_id`, `task_id`,
`task_hash`, `model_id`, `output_hash`, ...) the same way; REST paths carry the `0x` string as is.

`RestChainReader` reads session state, session nonce, the task snapshot (`queryTask`), and
the infer receipt (`queryInferReceipt`). `withQueryRetry(policy, run)` retries only
retriable failures; `DEFAULT_QUERY_RETRY = { attempts: 3, baseDelayMs: 200 }`.

### 9.3 Writers & chain clients

```ts
connectTrueOpenChainClient(opts): Promise<{ client, ... }>
createTrueOpenChainClient(cfg)
class CosmjsChainWriter
composeChainClient(...)
const DEFAULT_TX_INCLUSION
```

`connectTrueOpenChainClient` wires the CosmJS read/write client over the RPC/REST
endpoints with the given signer. `CosmjsChainWriter` encodes and broadcasts
`MsgCreateSession` / `MsgCancelOrder` (`task-msgs.ts` holds `encodeMsgCreateSession`,
`decodeMsgCreateSessionResponse`, etc.), classifies a CheckTx rejection as
`CHAIN_TX_REJECTED`, and enforces the tx-inclusion policy. `taskRegistry` is the CosmJS
type registry.

---

## 10. Nexus transport, TLS & IngressClient

```ts
nexusIngressTransport(uri, tlsPubkeyHash?, policy?): Transport
nexusTransportOptions(uri, tlsPubkeyHash?, policy?): NexusTransportOptions
prewarmNexusConnections(uri, tlsPubkeyHash?, opts?: PrewarmNexusOptions): Promise<number>
sharedPinnedHttpsAgent(tlsPubkeyHash): PinnedHttpsAgent
class PinnedHttpsAgent
tlsPubkeyHashOfCertificate(cert): string   // sha256(SubjectPublicKeyInfo DER), 0x + 64 lowercase hex
isTLSPubkeyMismatch(err): boolean
```

Rules:

- `grpcs://` / `grpc://` normalize to `https://` / `http://`.
- https with an on-chain hash → `PinnedHttpsAgent` (no fallback).
- https without a hash → standard CA verification (default), or `reject` under
  `unpinnedHttps: 'reject'` / `NEXUS_TLS_PUBKEY_HASH_REQUIRED=1`.
- plaintext `http://` is **refused** (`NEXUS_INSECURE_HTTP_REFUSED`) unless opted in with
  `allowInsecureHttp` / `TRUEOPEN_ALLOW_INSECURE_HTTP=1` (localnet only). The default
  console sink warns once per endpoint; an injected `warn` sink sees every occurrence.
- https is **never** downgraded to http.
- Transports for the same pinned key share one keep-alive `PinnedHttpsAgent`
  (`sharedPinnedHttpsAgent`), so a connection left idle by OpenTask, a prewarm or an earlier
  stream is reused instead of a new TCP + TLS handshake. Each connection carries one request at
  a time (HTTP/1.1); aborting a stream closes only its own connection. `shareConnections: false`
  restores a private agent per transport.
- `prewarmNexusConnections` sends `connections` (default 2, at most 8) concurrent
  `GET /healthz` through that same agent and leaves the keep-alive connections idle in its
  pool, under the same TLS rules. Best effort: resolves with the number that completed, rejects
  only when the endpoint is refused by policy. An unpinned endpoint uses Node's global agent,
  which keeps connections alive only on Node 19+.

`IngressClient` wraps the `IngressAPI` (openTask, task status/events, task-data
metadata/fetch, output stream) and signs each request with the SDK request envelope.
`isSessionGrantExpired`, `envelopeMessage`, `DEFAULT_OPEN_TASK_CHUNK_BYTES` are exported.

---

## 11. Builder routing & selection

```ts
resolveTaskBuilderEndpoints(reader, input): Promise<ResolveTaskBuilderResult>
selectTaskBuilders(input): SelectedBuilder[]
taskBuilderSeed(input): Uint8Array
taskBuilderRank(input, memberIndex): bigint
const BUILDERS_PER_TASK, DOMAIN_TASK_BUILDERS_V1, DOMAIN_TASK_BUILDER_RANK_V1
fanOutToEndpoints(endpoints, fn): Promise<FanOutResult>
class TaskBuilderAllEndpointsFailedError
```

`resolveTaskBuilderEndpoints` reads the builder set **at `sessionAnchorHeight`** (the same
set the chain checks the order against) and fails with `SDK_LOCAL_BUILDER_SET_MISMATCH` if
the set hash doesn't match the signed value. `selectTaskBuilders` is deterministic by
`task_builder_seed`. `fanOutToEndpoints` sends to every selected builder and aggregates the
first accepted ack plus per-builder errors.

---

## 12. Model manifest & URI

```ts
class ManifestSource
class MemoryManifestCache
function boundedWebFetch(url, limits): Promise<Uint8Array>

function verifyManifestBytes(bytes, state, registration?): VerifiedManifest
function parseModelManifestV4(bytes): ModelManifestV4
function modelManifestHash(bytes): Uint8Array
function projectionFromManifest(m, chain): JsonObject
function chainProjectionHash(projection): Uint8Array
function registrationDigest(r): Uint8Array

function parseManifestUri(uri, maxBytes?): ManifestUri
function isValidManifestUri(uri, maxBytes?): boolean
function isPublicAddress(ip): boolean

// Node entry (trueopen-sdk/node)
function createNodeManifestSource(opts): ManifestSource
function createNodeManifestFetcher(opts): ManifestFetcher
```

`ManifestSource.fetchManifest(modelId, profileVersion)` fetches from local cache →
`ProfileState.manifest_uri` → mirrors, verifying each body in order: hash
(`TRUEOPEN_MODEL_MANIFEST_V4`) → strict parse → canonical re-encode → projection fields.
`verifyManifestBytes` returns `VerifiedManifest` with `projectionFullyBound` (true only when
a `RegistrationCheck` bound the whole projection via `registration_digest`). The Node entry
adds the SSRF-safe downloader: public-address policy, pinned connection (no DNS rebinding),
TLS host-name check, redirect/size/timeout limits, and compressed-side bounds.
`parseManifestUri` accepts `https://` and `ipfs://` (CIDv0/CIDv1, no dot segments).

---

## 13. Codec & crypto

### 13.1 EIP-712

```ts
eip712EncodeType(primaryType, types): string
eip712TypeHash(primaryType, types): Uint8Array
eip712HashStruct(primaryType, types, value): Uint8Array
eip712DomainSeparator(types, domain): Uint8Array
eip712SigningDigest(domainSeparator, hashStruct): Uint8Array
eip712Digest(types, primaryType, domain, value): Uint8Array
type Eip712Field = { name, type }
type Eip712Types = Readonly<Record<string, readonly Eip712Field[]>>
type Eip712Struct = { [key: string]: Eip712Value }
```

The raw EIP-712 encoder (encodeType / typeHash / hashStruct / domainSeparator / digest).
Higher-level domain/typed-data helpers build on this.

### 13.2 Domain hash & framing

```ts
function domainHash(domain, ...fields): Uint8Array        // H_FIELDS_V1 over strings
function domainHashHex(domain, ...fields): string          // 0x + 64 lowercase hex
function canonicalFrameBytes(...parts): Uint8Array        // u32 length-prefixed each part
function canonicalHashBytes(...parts): Uint8Array         // sha256(canonicalFrameBytes)
function framedV1Preimage(domain, payload): Uint8Array    // TRUEOPEN_FRAME_V1 || u32(domain) || domain || u64(len) || payload
function framedHashV1(domain, payload): Uint8Array        // H_V1 (opaque payload)
function optionalV1(value): Uint8Array                    // 0x00 absent | 0x01 + frame
function uint32BE / int32BE / uint64BE / boolByte / enumBE
```

### 13.3 Address codec

```ts
function canonicalOperatorAddressBytes(field, value): Uint8Array   // bech32 → codec bytes, throws on bad
function canonicalAccountAddressBytes(field, value): Uint8Array
function toAccountAddress(value): string                           // 0x EVM → bech32
const ACCOUNT_ADDRESS_PREFIX = 'trueopen'
```

### 13.3a Hash32 text

```ts
const HASH32_TEXT_RE = /^0x[0-9a-f]{64}$/
function hash32Text(bytes: Uint8Array): string             // 32 bytes -> 0x + 64 lowercase hex
function isHash32Text(value: unknown): value is string
function strictHash32(field: string, text: string): Uint8Array   // SDK_LOCAL_NOT_HASH32 on any other spelling
function restHash32(value: string): string                 // REST: 0x form as is, base64 converted, bare hex refused
```

ADR-0034: the only client-facing spelling of a Hash32 is `0x` followed by exactly 64 lowercase
hex characters. Raw protobuf bytes, EIP-712 `bytes32` values and hash preimages stay raw 32
bytes; the conversion happens at the boundary only. `payload_ref` keeps the bare lowercase hex.

### 13.4 Canonical JSON

```ts
function canonicalJsonBytes(value: CanonicalJsonValue): Uint8Array
function parseStrictJson(bytes): CanonicalJsonValue
type CanonicalJsonValue = string | bigint | boolean | readonly CanonicalJsonValue[] | { [k: string]: CanonicalJsonValue }
```

`canonicalJsonBytes` sorts keys by UTF-8 bytes, escapes no HTML, rejects non-canonical
numbers — the exact encoding the H_V1 digests commit to. `parseStrictJson` rejects
duplicate keys, floats, exponents, BOM, lone surrogates, and returns integers as `bigint`.

### 13.5 MMR & protobuf

```ts
mmrLeaf / mmrNode / mmrEmpty / mmrRoot / mmrPrefixRoot / MmrAccumulator
class ProtoWriter / ProtoReader
```

---

## 14. Signers & EVM identity

```ts
// sha256 digest signers (64-byte R‖S) — low-level request envelopes
privKeySecp256k1DigestSigner(privKey): Secp256k1DigestSigner
secp256k1PublicKey(privKey): Uint8Array
verifySecp256k1Digest(digest, sig, pubKey): boolean

// EIP-712 typed-data signers (65-byte R‖S‖V)
privateKeyTypedDataSigner(privKey): TypedDataSigner   // raw private key
eip1193TypedDataSigner(provider)                       // browser wallet (EIP-1193)
keplrTypedDataSigner(provider)                         // Keplr's signEthereum
typedDataDigest(typedData): Uint8Array
typedDataJson(typedData): string
normalizeWalletSignature(sig): Uint8Array
signTypedDataAs(typedData, signer): Promise<{ signature, signerAddress }>

// EVM identity / recovery
uncompressedXY(pubKey): Uint8Array
ethAddressBytes(pubKey): Uint8Array
ethAddress0x(pubKey): string
ethSecp256k1Address(pubKey, prefix): string
ethSecp256k1AddressMatches(pubKey, address): boolean
recoverEip712PubKey(digest, sig): Uint8Array
recoverEip712Address(digest, sig, prefix): string
verifyEip712(...): boolean
const TRUEOPEN_HD_PATH

// DIRECT tx signing (ethsecp256k1, path A)
EthSecp256k1DirectSigner
ethSecp256k1SignerFromMnemonic(mnemonic, prefix)
ethAccountParser
const ETH_SECP256K1_PUBKEY_TYPE_URL, ETH_ACCOUNT_TYPE_URL
```

Two signer families are **not interchangeable**: `Secp256k1DigestSigner` signs a sha256
digest (64-byte R‖S); the typed-data signers sign EIP-712 typed data (65-byte R‖S‖V
recovering to an address). `TrueOpenClient` takes a single `wallet: TypedDataSigner` — the
order and the SDK request envelope are both EIP-712 now, so one wallet signs both.

---

## 15. End-to-end flow examples

Two complete flows: **streaming** (frames arrive as the Worker generates, verified one by
one) and **non-streaming** (fetch the whole object after the receipt lands). Both share the
same setup; they diverge only at the output step.

The values marked `// TODO` are chain/model-specific: read them from the chain (model id,
profile version, pricing) or your deployment (endpoints).

### 15.1 Shared setup

```ts
import {
  TrueOpenClient, HubReader, RestChainReader, connectTrueOpenChainClient,
  resolveTaskOrderContext, defaultGenerationParams,
  privateKeyTypedDataSigner, EthSecp256k1DirectSigner,
  TASK_TYPE, DEADLINE_LATENCY_CLASS, nexusIngressTransport, prewarmNexusConnections, IngressClient,
} from 'trueopen-sdk';
import { Bip39, Slip10, Slip10Curve, EnglishMnemonic, stringToPath } from '@cosmjs/crypto';

const CHAIN_ID = 'trueopen-testnet-1';
const REST = 'http://127.0.0.1:1317';
const RPC = 'http://127.0.0.1:26657';
const MNEMONIC = process.env.TRUEOPEN_MNEMONIC!;      // 24 words, never hard-code

// 1. One mnemonic → two signers.
//    - EthSecp256k1DirectSigner signs on-chain txs (keccak256 SignDoc, path A).
//    - privateKeyTypedDataSigner is the EIP-712 wallet (order + request envelope).
const seed = await Bip39.mnemonicToSeed(new EnglishMnemonic(MNEMONIC));
const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, stringToPath("m/44'/60'/0'/0/0"));
const signer = new EthSecp256k1DirectSigner(privkey, 'trueopen');
const address = (await signer.getAccounts())[0].address;   // trueopen1...
const wallet = privateKeyTypedDataSigner(privkey);          // EIP-712 wallet

// 2. Chain client + readers.
const { client: chainClient, signingClient } = await connectTrueOpenChainClient({
  rpcUrl: RPC, restUrl: REST, signer, signerAddress: address,
  fee: { amount: [{ denom: 'uusdc', amount: '7500' }], gas: '300000' },
});
const hub = new HubReader({ baseUrl: REST, fetch });              // hub.v1 reads
const taskReader = new RestChainReader({ baseUrl: REST, fetch }); // task.v1 reads

// 3. The facade. hub + taskReader let openTask / streamOutput / fetchTaskOutput
//    resolve the fee denom, evm chain id, pricing and output trust anchors themselves.
const client = new TrueOpenClient({
  chainId: CHAIN_ID, userAddress: address, wallet,
  chain: chainClient,
  ingressTransport: nexusIngressTransport('https://nexus:8080'), // see §10 for TLS pinning
  ingressTransportFactory: (endpoint, tlsPubkeyHash) => nexusIngressTransport(endpoint, tlsPubkeyHash),
  // Opens connections to the selected Builders while openTask signs (same shared agent).
  ingressPrewarm: (endpoint, tlsPubkeyHash) => prewarmNexusConnections(endpoint, tlsPubkeyHash),
  hub, taskReader,
});

// Per-Builder client for streamOutput / fetchTaskOutput: those call this.ingress directly,
// so point it at a specific Builder's endpoint (openTask routes via ingressTransportFactory).
const makeClient = (endpoint: string, tlsPubkeyHash = '') =>
  new TrueOpenClient({
    chainId: CHAIN_ID, userAddress: address, wallet, chain: chainClient,
    ingressTransport: nexusIngressTransport(endpoint, tlsPubkeyHash),
    hub, taskReader,
  });

// 4. Session + on-chain order context.
const session = await client.createSession('demo');
const ctx = await resolveTaskOrderContext(hub, CHAIN_ID);

// 5. The order intent. payload is the raw input (see README for chat vs raw-text shape).
const order = {
  modelId: '0x<64-hex-hash32>',               // TODO: from hub.listModels()
  profileVersion: 1,
  taskType: TASK_TYPE.TEXT_GENERATION,
  payload: new TextEncoder().encode('hello'),
  inputBucket: 1, outputBudgetBucket: 1,
  generationParams: defaultGenerationParams(128n, 60_000n),
  amounts: {
    priceBid: { atomicUnits: '4265625' },     // TODO: meet profile min_order_value
    maxFee: { atomicUnits: '12010' },
    assignmentPriorityFee: { atomicUnits: '0' },
    txFeeReserve: { atomicUnits: '0' },
  },
  earliestSubmitHeight: ctx.latestHeight,
  orderExpireHeight: ctx.latestHeight + 50_000n,
  latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
};

// 6. Open the task.
const result = await client.openTask({
  sessionId: session.sessionId,
  order,
  context: ctx,                               // reuse the context we already resolved
  idempotencyKey: `${session.sessionId}:0`,
});
const taskId = result.taskId;                 // e.g. 111fa1f3... (derived task_id)
```

### 15.2 Streaming

```ts
// One output source per Builder that accepted the order. Early subscribe: SubscribeOutput
// opens now, while the SDK waits for the anchors (taskHash + workerServicePubKey, needs
// taskReader + hub). Frames that arrive first are held unverified and released only once the
// anchors are known and each verifies; the stream ends with a Worker-signed fin. If the wait
// fails (no winner, timeout), the subscription is closed and that error is thrown.
const sources = result.builders
  .filter((x) => x.ack?.accepted)
  .map((b) => ({ id: b.address, ingress: new IngressClient(nexusIngressTransport(b.serviceEndpoint, b.tlsPubkeyHash), client.ingressAuth()) }));
if (sources.length === 0) throw new Error('no Builder accepted the order');
let text = '';
for await (const event of client.streamOutput({
  sessionId: session.sessionId, taskId, sources, idleTimeoutMs: 20_000,
  // Poll the chain for the winner, plus the first source's ASSIGNMENT_FINALIZED event as a hint.
  waitForAnchors: true,
})) {
  if (event.kind === 'chunk') {
    text += event.text;
    process.stdout.write(event.text);
  } else {
    // kind === 'fin'
    console.error(`\nfin: attested=${event.attested} finish_reason=${event.finishReason}`);
  }
}
console.log(text);                            // presented view (chat-template EOS stripped)
```

To resume after a disconnect, persist `onCheckpoint` and pass it back on the next call:

```ts
let cp;
for await (const event of makeClient(b.serviceEndpoint, b.tlsPubkeyHash).streamOutput({
  sessionId: session.sessionId, taskId,
  onCheckpoint: (c) => { cp = c; },          // persist MMR peaks + leaf count + seq
})) { /* … */ }
// …later, on a fresh process:
for await (const event of makeClient(b.serviceEndpoint, b.tlsPubkeyHash).streamOutput({
  sessionId: session.sessionId, taskId, checkpoint: cp, resumeAfterSeq: cp.leafCount - 1n,
})) { /* … */ }
```

### 15.3 Non-streaming (fetch after the receipt)

```ts
// Wait for the receipt, then fetch the whole object in verified ranges. Resolve the trust
// anchors explicitly (accepted task_hash, winner key, accepted receipt), then try each
// accepted builder until one serves the verified object. (fetchTaskOutput also derives the
// anchors itself when taskReader + hub are configured — see §8.2 — but resolving once lets
// you pass them to every attempt.)
const anchors = await client.resolveOutputTrustAnchors(taskId);
let output;
for (const b of result.builders.filter((x) => x.ack?.accepted)) {
  try {
    output = await makeClient(b.serviceEndpoint, b.tlsPubkeyHash).fetchTaskOutput({
      sessionId: session.sessionId, taskId, anchors, builderAddress: b.address,
    });
    break;
  } catch (e) {
    // try the next builder
  }
}
if (!output) throw new Error('no accepted builder served the output');
console.log(output.text);                     // presented text (EOS stripped)
// output.bytes is the committed object; output.outputHash is the MMR root the receipt commits to.

// Optionally upgrade to "confirmed" using the on-chain receipt.
const confirmed = client.confirmOutput({ sessionId: session.sessionId, taskId });
```

`fetchTaskOutput` will return a retriable `OUTPUT_TRUST_ANCHOR_PENDING` if the receipt
hasn't landed yet — poll and retry:

```ts
for (;;) {
  try {
    const anchors = await client.resolveOutputTrustAnchors(taskId);
    const b = result.builders.find((x) => x.ack?.accepted);
    const output = await makeClient(b.serviceEndpoint, b.tlsPubkeyHash).fetchTaskOutput({
      sessionId: session.sessionId, taskId, anchors, builderAddress: b.address,
    });
    console.log(output.text);
    break;
  } catch (e) {
    if (e instanceof TrueOpenError && e.code === 'OUTPUT_TRUST_ANCHOR_PENDING') { await sleep(2000); continue; }
    throw e;
  }
}
```
