# TrueOpen SDK Implementation Design (TypeScript)

> Version: v0.1 / 2026-07-21
> Scope: **Implementation guide for the `trueopen-sdk` TypeScript package** -- directory structure, public API, type definitions, module-to-code mapping, technology choices, engineering practices.
> Upstream reference: this repository turns the SDK detailed design document in the monorepo (under the service-design docs, section 20; referred to below as the "detailed design") into compilable TS code. **The authoritative definitions of protocol fields, endpoints, error codes, and events still live in the protocol modules and in nexus's interface and topic list document**; this document only maps them to an implementation and does not redefine the protocol.
> Hard rule (inherited from the detailed design): the SDK does not create consensus facts and does not define protocol rules; `ingress ack != accepted on chain`; the final state is always whatever the chain query/event says.

---

## 0. Reading Map

| What you want to know | Where to look |
|---|---|
| Tech stack, dependencies | S1 Technology Choices |
| How the code is laid out, directory structure | S2 Package Structure |
| How users call it, public API | S3 Public API Surface |
| How wire/domain types are defined | S4 Type System |
| How the modules in detailed design S2 map to classes | S5 Module Implementation |
| How the six local states are modeled | S6 State Machine Implementation |
| Two-layer signing and canonical encoding | S7 Signing and Encoding |
| How the transport layer is abstracted (Node/browser) | S8 Transport Layer |
| How errors are modeled | S9 Error Model |
| How local storage is abstracted | S10 Persistence |
| Sequence serialization, RBF, idempotent retries | S11 Concurrency and Retries |
| Configuration options | S12 Configuration |
| How to test | S13 Testing Strategy |
| How to build and package | S14 Engineering Practices |
| What to implement first | S15 Implementation Milestones |
| What's still undecided | S16 Open Items |

---

## 1. Technology Choices

### 1.1 Language and Runtime

```text
Language: TypeScript 5.x, strict mode fully enabled.
Modules: ESM first; the build also produces both ESM + CJS (dual package).
Runtime targets: Node >= 18 (built-in fetch / WebCrypto / globalThis.crypto) + modern browsers.
          Node below 18 is not supported; browsers need WebCrypto (HPKE / SHA256 / secp256k1 via library implementations).
```

**Dual runtime support is a hard constraint**: the SDK must run both in Node (CLI/server-side) and in the browser (dApp frontend). This directly determines that the transport layer (S8) and crypto (S7) must go through cross-platform libraries or runtime-agnostic abstractions.

### 1.2 Dependency Choices (Recommended Baseline, Not Protocol-Mandated)

| Area | Choice | Rationale / notes |
|---|---|---|
| Chain interaction (query/tx/event) | `@cosmjs/stargate` + `@cosmjs/proto-signing` + `@cosmjs/tendermint-rpc` | The chain is Cosmos-SDK based (`MsgCreateSession`, module account, AnteHandler, account sequence). CosmJS is the de facto standard: queries go through ABCI/gRPC, events go through Tendermint/CometBFT WebSocket subscriptions. |
| nexus IngressAPI | `@connectrpc/connect` + `@connectrpc/connect-web` (gRPC/gRPC-web/Connect) or plain `fetch` | IngressAPI is `gRPC / HTTPS` (interface list S3). connect-es runs the same code in Node and the browser, with native gRPC-web support. |
| protobuf encode/decode | `@bufbuild/protobuf` (protobuf-es), generated from the chain proto | Canonical encoding must be deterministic; protobuf-es shares its origin with connect-es. On-chain tx uses the CosmJS registry. |
| Signing (secp256k1) | `@cosmjs/crypto` or `@noble/curves/secp256k1` | Cosmos defaults to secp256k1. Prefer reusing an external signer (wallet/Ledger); the SDK does not hold private keys. |
| Hashing (SHA256) | `@noble/hashes/sha256` | Cross-platform, no native dependencies, well audited. |
| Sealed key decryption (HPKE) | `@hpke/core` (`HPKE_BASE_X25519_HKDF_SHA256_AES256GCM`) | Detailed design S5 specifies `sealed_key_envelope_version = HPKE_BASE_X25519_HKDF_SHA256_AES256GCM_V1`. `@hpke/core` implements exactly this suite. |
| Object gateway HTTP | Runtime `fetch` (native in Node 18+ / browsers) | `PutBlob/GetBlob/RangeGet` go over outbound HTTPS (data plane S10); `RangeGet` uses the `Range` header. |
| Validation/schema | `zod` (optional, input validation only) | Runtime validation at the public API boundary; internal code trusts TS types. |

> **Minimal-dependency principle**: use `@noble/*` for crypto/hashing (zero native dependencies, cross-platform); use CosmJS for the chain stack (mature); use the runtime's native `fetch` plus connect-es for nexus/gateway. Avoid pulling in heavy all-in-one frameworks. Final library versions are confirmed in S16 Open Items.

### 1.3 Out of Scope

```text
Does not integrate with NATS (Builder/cortex control plane, detailed design S0).
Does not implement keeper handlers / nexus scheduling / cortex execution / verification algorithms.
Does not manage private keys internally (goes through an external Signer interface by default, S7).
Does not expose AssignTx/OpenVerifyTx/SettleTx as a user submission path (detailed design S2.6).
```

---

## 2. Package Structure

Single package, multiple modules (splitting into a monorepo of packages is deferred until needed). The directory layout aligns with the module breakdown in detailed design S2:

```text
trueopen-sdk/
├─ package.json
├─ tsconfig.json
├─ tsup.config.ts                 # build (ESM+CJS+d.ts)
├─ docs/
│  └─ implementation-design.md    # this document
├─ src/
│  ├─ index.ts                    # public entry point, exports TrueOpenClient + types
│  ├─ client.ts                   # TrueOpenClient facade (assembles the modules)
│  ├─ config.ts                   # TrueOpenClientConfig definition and defaults
│  │
│  ├─ types/                      # S4 type system (wire + domain)
│  │  ├─ order.ts                 #   OrderEnvelope, etc.
│  │  ├─ session.ts               #   StreamState view, etc.
│  │  ├─ dataplane.ts             #   ObjectRefV1 / CredentialV1 / OutputRef
│  │  ├─ challenge.ts             #   UserChallenge / EvidenceRequest views
│  │  ├─ task.ts                  #   TaskState / TaskPhase / verdict enums
│  │  └─ envelope.ts              #   SDKRequestEnvelopeV1
│  │
│  ├─ signer/                     # S2.1 / S7 SignerManager
│  │  ├─ signer.ts                #   Signer interface (injected externally)
│  │  ├─ order-signer.ts          #   OrderEnvelope signing + coverage validation
│  │  └─ request-signer.ts        #   SDKRequestEnvelopeV1 signing
│  │
│  ├─ codec/                      # S7 canonical encoding + hash + domain separation
│  │  ├─ canonical.ts
│  │  ├─ hash.ts
│  │  └─ domains.ts               #   TRUEOPEN_* domain constants
│  │
│  ├─ session/                    # S2.2 SessionManager
│  │  └─ session-manager.ts
│  ├─ quote/                      # S2.3 QuoteEstimator
│  │  └─ quote-estimator.ts
│  ├─ order/                      # S2.4 OrderBuilder
│  │  └─ order-builder.ts
│  │
│  ├─ transport/                  # S8 transport abstraction + implementations
│  │  ├─ ingress-client.ts        #   S2.5 IngressClient interface
│  │  ├─ ingress-connect.ts       #   connect-es implementation
│  │  ├─ chain-client.ts          #   S2.6 ChainClient interface
│  │  ├─ chain-cosmjs.ts          #   CosmJS implementation
│  │  ├─ gateway-client.ts        #   object gateway interface
│  │  └─ gateway-fetch.ts         #   fetch implementation
│  │
│  ├─ task/                       # S2.7 TaskTracker
│  │  ├─ task-tracker.ts
│  │  └─ phase-map.ts             #   TaskPhase -> TaskState mapping
│  ├─ output/                     # S2.8 OutputFetcher
│  │  ├─ output-fetcher.ts
│  │  └─ chunk-verifier.ts        #   S5 chunk continuity validation
│  ├─ challenge/                  # S2.9 ChallengeManager
│  │  └─ challenge-manager.ts
│  │
│  ├─ state/                      # S6 client-side state machine
│  │  ├─ local-state.ts           #   six local states + reducer
│  │  └─ reconcile.ts             #   on-chain state overrides local state
│  ├─ store/                      # S2.10 LocalStore
│  │  ├─ store.ts                 #   Storage interface
│  │  ├─ memory-store.ts
│  │  └─ (fs-store.ts / idb-store.ts depending on runtime)
│  ├─ errors/                     # S2.11 / S9 error model
│  │  └─ errors.ts
│  └─ util/
│     ├─ retry.ts                 #   S11 backoff retry
│     └─ bytes.ts
└─ test/                          # S13
   ├─ unit/  integration/  e2e/
```

---

## 3. Public API Surface

Layered facade: `TrueOpenClient` composes five sub-APIs, corresponding to the user-facing action groups. Lower-level modules (signer/codec/transport) are not exposed directly to typical users, but can be injected/replaced via `config`.

```ts
// src/index.ts
export { TrueOpenClient } from './client';
export type { TrueOpenClientConfig } from './config';
export * from './types';
export { TrueOpenError, ErrorFamily } from './errors/errors';
```

```ts
// src/client.ts
export class TrueOpenClient {
  readonly session: SessionApi;
  readonly orders: OrderApi;
  readonly tasks: TaskApi;
  readonly output: OutputApi;
  readonly challenges: ChallengeApi;

  constructor(config: TrueOpenClientConfig);

  /** Closes event subscriptions, flushes persisted state, releases connections. */
  close(): Promise<void>;
}
```

### 3.1 SessionApi (S2.2)

```ts
interface SessionApi {
  /** Sends MsgCreateSession, waits for SessionCreated, returns and caches session_id. */
  create(opts?: { label?: string }): Promise<SessionHandle>;
  /** Retrieves from local cache or from on-chain StreamState. */
  get(sessionId: string): Promise<SessionHandle>;
  list(): Promise<SessionHandle[]>;
  /** Rebuilds owner / nextExpectedSequence from chain after the cache is lost. */
  rebuild(sessionId: string): Promise<SessionHandle>;
}

interface SessionHandle {
  readonly sessionId: string;
  readonly owner: string;
  readonly nextExpectedSequence: bigint;   // locally observed value; the chain is authoritative
  readonly status: 'ACTIVE' | 'IDLE' | 'CLOSED';
  readonly label?: string;
}
```

### 3.2 OrderApi (S2.3 + S2.4 + S2.5)

```ts
interface OrderApi {
  /** Read-only pre-check (profile / balance / sequence / anchor / rate / payload availability). */
  prepare(input: OrderInput): Promise<OrderQuote>;
  /** Builds an OrderEnvelope (unsigned); pricing comes from the quote. */
  build(input: OrderInput, quote: OrderQuote): Promise<UnsignedOrder>;
  /** Hands off to the external Signer for signing; the price is locked in from this point on. */
  sign(order: UnsignedOrder): Promise<SignedOrder>;
  /** Uploads the encrypted input (PutBlob) then SubmitOrder. Returns a receipt handle (not on-chain accepted). */
  submit(order: SignedOrder, payload: InputPayload): Promise<SubmitReceipt>;
  /** RBF fee-bump replacement: same (sessionId, orderSequence), delta >= minimumReplacementDelta. */
  replace(prev: SignedOrder, bump: PriorityFeeBump): Promise<SubmitReceipt>;
  /** CancelOrder: voids a pending sequence number that has not yet had an Assign accepted. */
  cancel(sessionId: string, orderSequence: bigint): Promise<CancelReceipt>;
}

interface SubmitReceipt {
  sessionId: string;
  taskId: string;
  submitId: Uint8Array;   // hash(TRUEOPEN_SDK_SUBMIT_V1, ...)
  accepted: boolean;      // warning: accepted by nexus ingress, not accepted on chain
  reason?: string;
  builderEndpoint: string;
}
```

### 3.3 TaskApi (S2.7)

```ts
interface TaskApi {
  /** One-off query of the on-chain, user-facing state (coarse state + refined phase). */
  status(sessionId: string, taskId: string): Promise<TaskStatus>;
  /** Event stream: async iterable; resumes from an internal cursor after a disconnect; not a final determination. */
  watch(sessionId: string, taskId: string, opts?: { fromCursor?: string }): AsyncIterable<TaskEvent>;
  /** Local state (six kinds), advanced by events/queries. */
  localState(taskId: string): LocalTaskState;
}

interface TaskStatus {
  state: TaskState;                    // PENDING/ASSIGNED/VERIFYING/SETTLED/CLOSED/FAILED
  phase: TaskPhase;
  stage: 'ASSIGN' | 'OPEN_VERIFY' | 'SETTLE';
  verdict?: TaskVerdict;               // present after SettleAccepted
  optimisticFinality?: OptimisticFinalityStatus;  // PENDING/CHALLENGED/FINAL/OVERTURNED
  challengeUntilHeight?: bigint;
  updatedAt: bigint;
}
```

### 3.4 OutputApi (S2.8 + S5)

```ts
interface OutputApi {
  /** Fetches the retrieval credential (FetchOutputRef, access=SEALED_KEY, usage=SDK_DELIVERY). */
  fetchRef(sessionId: string, taskId: string): Promise<OutputRefWithCredential>;
  /** Non-streaming: fetches the full package + verifies the package hash + the WorkerDelivery signature. */
  fetch(ref: OutputRefWithCredential): Promise<VerifiedOutput>;
  /** Streaming: verifies each chunk as it arrives; stops and switches source on failure; marks it as an optimistic delivery. */
  stream(ref: OutputRefWithCredential): AsyncIterable<VerifiedChunk>;
  /** Resumable transfer: fills in from the last verified chunk boundary using RangeGet. */
  resume(ref: OutputRefWithCredential, from: ChunkBoundary): AsyncIterable<VerifiedChunk>;
  /** Refreshes an expired credential (RefreshCredential). */
  refreshCredential(credentialRef: Uint8Array, opts: RefreshOpts): Promise<CredentialV1>;
}
```

### 3.5 ChallengeApi (S2.9)

```ts
interface ChallengeApi {
  /** PrepareChallenge: window / suggested evidence / fee estimate; does not submit a verdict. */
  prepare(sessionId: string, taskId: string, kind: ChallengeKind): Promise<ChallengePlan>;
  /** Builds and submits a MsgUserChallengeTx on chain. */
  submit(input: UserChallengeInput): Promise<ChallengeHandle>;
  /** Tracks ChallengeState / EvidenceRequest / outcome / economic effect. */
  track(challengeId: string): AsyncIterable<ChallengeUpdate>;
}
```

> **API design convention**: amounts are always `string` (Cosmos coin amount, to avoid precision loss); sequence numbers/heights use `bigint`; hashes/signatures/keys use `Uint8Array`; addresses use `string` (bech32). Every "accepted"-style return value carries an explicit `accepted` comment, so it is never mistaken for a final on-chain state.

---

## 4. Type System

Wire types are the TS mapping of protocol objects; **the fields themselves are authoritative in the protocol modules** -- here we only aim for a consistent shape and naming (camelCase mapped from snake_case). `readonly` expresses immutability / locked-in semantics.

### 4.1 OrderEnvelope (maps to `04-tasks/01` S3.3)

```ts
// src/types/order.ts
export interface OrderEnvelope {
  // identity / session
  readonly userAddress: string;
  readonly sessionId: string;
  readonly orderSequence: bigint;
  // task
  readonly modelId: string;
  readonly profileVersion: string;
  readonly taskType: string;
  readonly inputBucket: string;
  readonly outputBudgetBucket: string;
  readonly payloadHash: Uint8Array;
  readonly payloadSizeHint: bigint;
  readonly maxOutputTokens: bigint;
  readonly maxOutputDuration: bigint;
  // pricing (locked in once signed)
  readonly inferInputUnitPriceBid: string;
  readonly inferOutputUnitPriceBid: string;
  readonly verifyUnitPriceBid: string;
  readonly inferFeeCap: string;
  readonly verifyFeeCap: string;
  readonly maxFee: string;
  // fees
  readonly assignmentPriorityFee: string;
  readonly txFeeReserve: string;
  // anchoring
  readonly sessionAnchorBlockHash: Uint8Array;
  // policy / signature
  readonly deadlinePolicy: DeadlinePolicy;
  readonly signatureScheme: string;
  readonly userSignature: Uint8Array;   // covers everything above (S7.1)
}

/** Unsigned order: fields may still change; once signed it becomes a SignedOrder and the fields are frozen. */
export type UnsignedOrder = Omit<OrderEnvelope, 'userSignature'>;
export interface SignedOrder { readonly envelope: OrderEnvelope; readonly digest: Uint8Array; }
```

### 4.2 SDKRequestEnvelopeV1 (maps to interface list S3.0)

```ts
// src/types/envelope.ts
export interface SDKRequestEnvelopeV1 {
  readonly requestDomain: 'TRUEOPEN_SDK_REQUEST_V1';
  readonly chainId: string;
  readonly method: string;
  readonly endpoint: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly requestNonce: Uint8Array;
  readonly expiryHeightOrTime: bigint;
  readonly bodyDigest: Uint8Array;
  readonly signerAddress: string;
  readonly signature: Uint8Array;
}
```

### 4.3 Data Plane (maps to `04-tasks/02` + interface list S0)

```ts
// src/types/dataplane.ts
export interface ObjectRefV1 {
  readonly refVersion: 1;
  readonly scheme: 'trueopen-blob-v1';
  readonly objectKind: string;
  readonly contentDigestAlg: 'SHA256';
  readonly contentDigest: Uint8Array;
  readonly sizeBytes: bigint;
  readonly mediaType: string;
  readonly chunkingScheme: string;
  readonly manifestDigest?: Uint8Array;
  readonly encryptionScheme: string;
  readonly sealedKeyRef?: Uint8Array;
  readonly gatewayHints: string[];
  readonly pinReceiptDigest?: Uint8Array;
  readonly retentionUntilHeight: bigint;
}

export type CredentialUsage =
  | 'SDK_DELIVERY' | 'VERIFIER_FETCH' | 'CHALLENGE_EVIDENCE' | 'WATCHER_AUDIT';

export interface CredentialV1 {
  readonly credentialDomain: 'TRUEOPEN_OBJECT_CREDENTIAL_V1';
  readonly credentialVersion: 'CredentialV1';
  readonly chainId: string;
  readonly taskId: string;
  readonly artifactKind: string;
  readonly objectRefDigest: Uint8Array;
  readonly contentRef: string;
  readonly contentDigest: Uint8Array;
  readonly sizeBytes: bigint;
  readonly mediaType: string;
  readonly encryptionScheme: string;
  readonly encKeySealed: Uint8Array;      // HPKE envelope (decrypted in S7.3)
  readonly recipientAddress: string;
  readonly issuerAddress: string;
  readonly validUntilHeight: bigint;
  readonly maxBytes: bigint;
  readonly usage: CredentialUsage;
  readonly signature: Uint8Array;
}

/** Interface list S0 OutputRef (KB-scale retrieval credential). */
export interface OutputRef {
  readonly taskId: string;
  readonly sessionId: string;
  readonly outputHash: Uint8Array;                 // == delivery_output_hash
  readonly canonicalOutputPackageHash: Uint8Array;
  readonly outputCid: string;
  readonly encKeySealed?: Uint8Array;              // left empty when access=PACKAGE
}
```

### 4.4 Enums (maps to interface list S0 + `04-tasks/06`)

```ts
// src/types/task.ts
export type TaskState = 'PENDING' | 'ASSIGNED' | 'VERIFYING' | 'SETTLED' | 'CLOSED' | 'FAILED';

export type TaskPhase =
  | 'ASSIGN_RANDOMNESS_PENDING' | 'ASSIGNMENT_FINALIZED' | 'OPEN_VERIFY'
  | 'SAMPLE_READY' | 'COMMIT' | 'WORKER_REVEAL' | 'FULL_RESULT_REVEAL'
  | 'SETTLE' | 'SWEEP_OBSERVED';

export type TaskVerdict = 'PASS' | 'FAIL' | 'NO_CONSENSUS' | 'FAIL_REVEAL_TIMEOUT';

// src/types/challenge.ts
export type ChallengeKind = 'VERDICT_FRAUD_PROOF' | 'OBJECTIVE_PROOF' | 'USER_REVALIDATION';
export type OptimisticFinalityStatus = 'PENDING' | 'CHALLENGED' | 'FINAL' | 'OVERTURNED';
export type EvidenceRequestStatus = 'OPEN' | 'SATISFIED' | 'DEFAULTED';
export type ChallengeOutcome =
  | 'NONE' | 'SETTLEMENT_OVERTURNED' | 'ROLE_FAULT_ONLY'
  | 'USER_REVALIDATION_CONFIRMED' | 'USER_REVALIDATION_REJECTED';
```

---

## 5. Module Implementation (Maps to Detailed Design S2)

Each module: **dependencies -> key types/methods -> failure handling**. Classes only show the skeleton and signatures; implementation details follow the corresponding section of the detailed design.

### 5.1 SignerManager (Detailed Design S2.1)

```ts
// src/signer/signer.ts -- injected externally, the SDK does not hold private keys
export interface Signer {
  readonly address: string;
  /** Signs canonical bytes (secp256k1). */
  sign(msg: Uint8Array): Promise<Uint8Array>;
  /** Recipient private-key operation needed to open an HPKE seal (optional: can be proxied by a wallet). */
  hpkeOpen?(sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
}
```

```ts
// src/signer/order-signer.ts
export class OrderSigner {
  constructor(private signer: Signer, private codec: Canonical) {}
  async sign(order: UnsignedOrder): Promise<SignedOrder> {
    this.assertCoverageComplete(order);          // price/budget/model/session/sequence/deadline/anchor all present
    const digest = this.codec.orderDigest(order);
    const sig = await this.signer.sign(digest);
    return { envelope: { ...order, userSignature: sig }, digest };
  }
}
```

Failure handling: incomplete fields before signing -> `SDK_LOCAL_*`; any field change after signing -> throws (immutable type + runtime assertion).

### 5.2 SessionManager (S2.2)

```ts
export class SessionManager {
  constructor(private chain: ChainClient, private signer: Signer, private store: Storage) {}
  async create(label?: string): Promise<SessionHandle> {
    const res = await this.chain.submitUserTx({ kind: 'MsgCreateSession', signer: this.signer.address });
    const sessionId = await this.chain.awaitEvent(res, 'SessionCreated', 'session_id');
    const h: SessionHandle = { sessionId, owner: this.signer.address, nextExpectedSequence: 0n, status: 'ACTIVE', label };
    await this.store.put('session', sessionId, h);
    return h;
  }
  async rebuild(sessionId: string): Promise<SessionHandle> {
    const s = await this.chain.queryStreamState(sessionId);   // owner / next_expected_sequence / status
    const h = toHandle(s);
    await this.store.put('session', sessionId, h);
    return h;
  }
}
```

Failure handling: `next_expected_sequence` has a single source of truth, the chain; when the local cache conflicts with the chain, the chain wins; the local sequence must never be advanced before it is accepted on chain.

### 5.3 QuoteEstimator (S2.3) / OrderBuilder (S2.4)

```ts
export class OrderBuilder {
  async build(input: OrderInput, quote: OrderQuote): Promise<UnsignedOrder> {
    const anchor = await this.chain.finalizedAnchor(this.cfg.anchorDepth); // an already-finalized block, within the anchor_freshness_window
    return { /* fill in the S4.1 fields; pricing comes from quote */ ...toEnvelopeFields(input, quote, anchor) };
  }
  buildReplacement(prev: SignedOrder, bump: PriorityFeeBump): UnsignedOrder {
    // same (sessionId, orderSequence); assignmentPriorityFee delta >= minimumReplacementDelta (value set by chain/parameter table)
  }
}
```

Failure handling: anchor too old or in the future -> refuse to build; `profile FROZEN/DELISTED` / insufficient balance -> corresponding error class; must not generate a different-content order for the same `(sessionId, orderSequence)` (except for RBF).

### 5.4 IngressClient (S2.5) -> see the S8.1 interface.
### 5.5 ChainClient (S2.6) -> see the S8.2 interface.

### 5.6 TaskTracker (S2.7)

```ts
export class TaskTracker {
  async *watch(sessionId: string, taskId: string, fromCursor?: string): AsyncIterable<TaskEvent> {
    for await (const ev of this.ingress.getTaskEvents({ sessionId, taskId, fromCursor })) {
      await this.store.put('bus_cursor', taskId, ev.cursor);      // resume after a disconnect
      const local = reduce(this.state.get(taskId), ev);           // S6 reducer
      this.state.set(taskId, local);
      yield ev;
      if (isTerminalHint(ev)) await this.reconcileFromChain(taskId); // a terminal state must be confirmed with a query
    }
  }
}
```

The `TaskPhase -> TaskState` mapping lives in `task/phase-map.ts` (interface list S0.1). Failure handling: events are only hints; critical states are confirmed against `chain.queryTask`.

### 5.7 OutputFetcher (S2.8) + ChunkVerifier (S5 Algorithm)

```ts
// src/output/chunk-verifier.ts
export class ChunkVerifier {
  private prevHash?: Uint8Array;
  private nextIndex = 0n;
  verify(chunk: RawChunk): VerifiedChunk {
    if (chunk.chunkIndex !== this.nextIndex) throw dataError('DATA_CHUNK_OUT_OF_ORDER');
    if (!eq(chunk.prevChunkHash, this.prevHash ?? EMPTY)) throw dataError('DATA_CHUNK_CHAIN_BROKEN');
    if (!eq(sha256(chunk.bytes), chunk.chunkDigest)) throw dataError('DATA_CHUNK_DIGEST_MISMATCH');
    this.prevHash = chunk.chunkDigest; this.nextIndex += 1n;
    return { ...chunk, verified: true };
  }
  /** Once everything has been received: compare output_hash / canonical_output_package_hash + the WorkerDelivery signature. */
  finalize(assembled: Uint8Array, ref: OutputRef): void { /* S5.1: the three hashes must not be mixed up */ }
}
```

Failure handling: if any chunk fails verification -> stop displaying it and switch to a backup source (multiple sources with a matching digest are accepted; source identity is not part of the verdict); data plane unavailable -> `DATA_UNAVAILABLE`; expired credential -> try `RefreshCredential` first, then fall back to `CREDENTIAL_EXPIRED`.

### 5.8 ChallengeManager (S2.9)

```ts
export class ChallengeManager {
  async prepare(sessionId: string, taskId: string, kind: ChallengeKind): Promise<ChallengePlan> {
    return this.ingress.prepareChallenge({ sessionId, taskId, challengeKind: kind }); // window / evidence / fee
  }
  async submit(input: UserChallengeInput): Promise<ChallengeHandle> {
    const tx = buildMsgUserChallengeTx(input);   // task_id/settlement_id/kind/evidence_digest/bond/...
    const res = await this.chain.submitUserTx(tx);
    return toHandle(res);
  }
}
```

Failure handling: the SDK does not define the verdict, does not determine fault, and does not treat a local comparison as a ruling; a single failed gateway GET does not by itself constitute a punishable fact.

### 5.9 LocalStore (S2.10) -> S10. ErrorClassifier (S2.11) -> S9.

---

## 6. State Machine Implementation

The six local states (detailed design S3) are modeled as a pure-function reducer plus an on-chain override.

```ts
// src/state/local-state.ts
export type LocalTaskState =
  | { kind: 'draft' }
  | { kind: 'submitted'; submitId: Uint8Array }
  | { kind: 'in_progress'; state: TaskState; phase: TaskPhase }
  | { kind: 'optimistic_finality'; verdict: TaskVerdict; challengeUntil: bigint; finality: OptimisticFinalityStatus }
  | { kind: 'final'; reason: 'settled' | 'failed' | 'refunded' | 'cancelled' }
  | { kind: 'local_attention'; issue: AttentionIssue };

/** Event -> local state (optimistic forward progress). */
export function reduce(prev: LocalTaskState, ev: TaskEvent): LocalTaskState { /* mapping per interface list S0.1 */ }
```

```ts
// src/state/reconcile.ts -- on-chain state overrides local state (detailed design S3 progression rules)
export function reconcile(local: LocalTaskState, chain: TaskStatus): LocalTaskState {
  // any accepted on-chain state overrides local state; optimistic_finality_status is one-directional: PENDING -> CHALLENGED -> FINAL; -> OVERTURNED is an absorbing state
}
```

Invariants (enforced with assertions/tests): `optimistic_finality_status` must never move backward out of `OVERTURNED`/`FINAL`; the local `nextExpectedSequence` must never be advanced before it is accepted on chain.

---

## 7. Signing and Encoding

### 7.1 Two-Layer Signature Coverage (Detailed Design S4)

```text
OrderEnvelope.userSignature covers: price + budget + model/profile + session + sequence + deadline + anchor.
SDKRequestEnvelopeV1.signature covers: requestDomain + chainId + method + endpoint + session/task + nonce + expiry + bodyDigest + signerAddress.
```

### 7.2 Canonical Encoding and Domain Separators

```ts
// src/codec/domains.ts
export const DOMAINS = {
  session: 'TRUEOPEN_SESSION_V1',
  sdkRequest: 'TRUEOPEN_SDK_REQUEST_V1',
  sdkSubmit: 'TRUEOPEN_SDK_SUBMIT_V1',
  credential: 'TRUEOPEN_OBJECT_CREDENTIAL_V1',
  sealedKey: 'TRUEOPEN_SEALED_KEY_V1',
} as const;

// src/codec/canonical.ts -- deterministic encoding: no map iteration order, no floats, fixed field order
export interface Canonical {
  orderDigest(o: UnsignedOrder): Uint8Array;         // hash(domain, fields in fixed order)
  requestBodyDigest(body: unknown): Uint8Array;
  submitId(chainId: string, sessionId: string, taskId: string, orderDigest: Uint8Array): Uint8Array;
}
```

> The encoding must match the on-chain signature-verification bytes **byte for byte**. The implementation should prefer reusing the chain's proto canonical serialization (protobuf-es, generated from the chain proto) over custom concatenation. This is the easiest place to get wrong; S13 must include golden-vector tests.

### 7.3 Sealed Key Decryption (HPKE)

```ts
// aad = hash(chainId, taskId, objectRefDigest, recipientAddress, usage, validUntilHeight)  -- 04-tasks/02 S6
import { CipherSuite, KemId, KdfId, AeadId } from '@hpke/core';
const suite = new CipherSuite({ kem: KemId.DhkemX25519HkdfSha256, kdf: KdfId.HkdfSha256, aead: AeadId.Aes256Gcm });
// use the recipient's private key (via Signer.hpkeOpen, or an injected KEM private key) to open encKeySealed and obtain the symmetric key used to decrypt the payload/output
```

---

## 8. Transport Layer

All transport goes through an interface plus a runtime implementation, so it can be swapped between Node/browser and mocked (S13).

### 8.1 IngressClient (S2.5, Interface List S3)

```ts
export interface IngressClient {
  submitOrder(req: { envelope: SDKRequestEnvelopeV1; orderEnvelope: Uint8Array; payloadRef: ObjectRefV1 }):
    Promise<{ sessionId: string; taskId: string; submitId: Uint8Array; accepted: boolean; reason?: string }>;
  getTaskStatus(req: { sessionId: string; taskId: string }): Promise<TaskStatus>;
  getTaskEvents(req: { envelope?: SDKRequestEnvelopeV1; sessionId: string; taskId: string; fromCursor?: string }):
    AsyncIterable<TaskEvent>;
  fetchOutputRef(req: FetchOutputRefReq): Promise<{ outputRef: OutputRef; credential: CredentialV1 }>;
  refreshCredential(req: RefreshReq): Promise<{ credential: CredentialV1; outputRef?: OutputRef }>;
  prepareChallenge(req: PrepareChallengeReq): Promise<ChallengePlan>;
}
```

Implementation `ingress-connect.ts`: connect-es, using HTTP/2 in Node and gRPC-web in the browser; `getTaskEvents` uses server streaming (gRPC stream / SSE fallback).

### 8.2 ChainClient (S2.6)

```ts
export interface ChainClient {
  queryStreamState(sessionId: string): Promise<StreamStateView>;
  queryTask(sessionId: string, taskId: string): Promise<TaskStatus>;
  finalizedAnchor(depth: number): Promise<{ hash: Uint8Array; height: bigint }>;
  submitUserTx(tx: UserTx): Promise<TxResult>;      // MsgCreateSession / CancelOrder / MsgUserChallengeTx
  subscribeEvents(query: string): AsyncIterable<ChainEvent>;
  awaitEvent(res: TxResult, type: string, attr: string): Promise<string>;
}
```

Implementation `chain-cosmjs.ts`: CosmJS `StargateClient`/`SigningStargateClient` + `Tendermint34/37Client` WebSocket subscriptions. **Only user-side tx submission is allowed**; `AssignTx/OpenVerifyTx/SettleTx` are not exposed through this interface.

### 8.3 GatewayClient (Data Plane S10)

```ts
export interface GatewayClient {
  putBlob(bytes: Uint8Array | ReadableStream, meta: BlobMeta): Promise<{ ref: ObjectRefV1 }>;
  getBlob(ref: ObjectRefV1, credential: CredentialV1): Promise<ReadableStream<Uint8Array>>;
  rangeGet(ref: ObjectRefV1, credential: CredentialV1, range: ByteRange): Promise<ReadableStream<Uint8Array>>;
}
```

Implementation `gateway-fetch.ts`: `fetch` + the `Range` header; streaming uses `Response.body` (ReadableStream).

---

## 9. Error Model

A single error class plus stable error families (detailed design S7), to guarantee `instanceof` checks and serializability across platforms.

```ts
// src/errors/errors.ts
export type ErrorFamily =
  | 'SDK_LOCAL' | 'SDK_AUTH' | 'NEXUS_INGRESS'
  | 'CHAIN_REJECT' | 'DATA' | 'CREDENTIAL' | 'CHALLENGE';

export class TrueOpenError extends Error {
  constructor(
    readonly family: ErrorFamily,
    readonly code: string,          // e.g. 'SDK_AUTH_EXPIRED' / 'NEXUS_INGRESS_DUPLICATE_SUBMIT'
    message: string,
    readonly opts?: { retriable?: boolean; userAction?: string; cause?: unknown },
  ) { super(message); this.name = 'TrueOpenError'; }
}
```

Mapping (detailed design S7 table): the `reason` for `accepted=false` -> the corresponding `NEXUS_INGRESS_*`; `FetchOutputRef` errors -> `CREDENTIAL_*`; on-chain reject codes -> `CHAIN_REJECT_*` (**`retriable=false` by default; never retried blindly**); data plane unavailable -> `DATA_UNAVAILABLE`.

---

## 10. Persistence

```ts
// src/store/store.ts
export interface Storage {
  get<T>(ns: Namespace, key: string): Promise<T | undefined>;
  put<T>(ns: Namespace, key: string, val: T): Promise<void>;
  delete(ns: Namespace, key: string): Promise<void>;
  iterate<T>(ns: Namespace, prefix: string): AsyncIterable<[string, T]>;
}
export type Namespace = 'session' | 'order' | 'task' | 'credential' | 'bus_cursor' | 'account';
```

Implementations: `memory-store.ts` (default/testing), `fs-store.ts` (Node), `idb-store.ts` (browser IndexedDB).

**Secrets boundary (detailed design S6, hard rule)**: the Storage layer refuses to write plaintext private keys / unencrypted payload keys / unencrypted long-lived output (unless `config.allowPlaintextOutput=true` is explicitly enabled). Serializing `Uint8Array`/`bigint` requires a custom replacer/reviver.

---

## 11. Concurrency and Retries

```text
Sequence serialization: within a single session, order submissions are serialized by nextExpectedSequence; SessionManager keeps a submission lock per session (a promise queue) to prevent concurrent submissions from racing for the same sequence number.
Concurrency across sessions: multiple models / multiple threads should use multiple sessionIds (do not split a single session's counter per model).
RBF: replace() reuses the same (sessionId, orderSequence) and only adjusts assignmentPriorityFee; it does not advance nextExpectedSequence locally.
Idempotent submission: submitId deduplicates; NEXUS_INGRESS_DUPLICATE_SUBMIT is treated as already accepted, not as a failure.
Retries: util/retry.ts uses exponential backoff with jitter; only retries when retriable=true (network / rate limiting / ack timeout); CHAIN_REJECT_* is never retried.
Multiple Builders: the same SignedOrder can be resent to multiple Builder endpoints; deduplication by pending_key is decided by the keeper.
```

```ts
// src/util/retry.ts
export async function withRetry<T>(fn: () => Promise<T>, o: RetryOpts): Promise<T> { /* backoff + jitter, only for retriable errors */ }
```

---

## 12. Configuration

```ts
// src/config.ts
export interface TrueOpenClientConfig {
  chainId: string;
  // transport endpoints
  ingress: { builders: BuilderEndpoint[] };   // multiple Builders allowed, for failover
  chainRpc: string;                            // CometBFT RPC (WS events)
  chainGrpc?: string;                          // optional gRPC query
  gateway?: { hints?: string[] };
  // dependency injection (has a default implementation, replaceable)
  signer: Signer;                              // required: external signer
  storage?: Storage;                           // defaults to memory
  transport?: { ingress?: IngressClient; chain?: ChainClient; gateway?: GatewayClient };
  // SDK-side parameters (detailed design S9; not protocol parameters)
  anchorDepth?: number;                        // depth of the finalized block to use
  retry?: RetryOpts;
  eventReconnect?: { intervalMs: number; maxBackoffMs: number };
  cache?: { sessionTtlMs: number };
  allowPlaintextOutput?: boolean;              // defaults to false
}
```

> Protocol parameters (`minimumReplacementDelta` / `assignmentDeadline` / `anchorFreshnessWindow` / challenge window/bond, etc.) **are not part of config** -- they are read from the chain/parameter table; the SDK does not set them itself.

---

## 13. Testing Strategy

```text
Unit tests:
  codec: golden-vector -- fixed input -> fixed digest/signature bytes, compared against the on-chain signature-verification bytes (guards against encoding drift, S7.2).
  chunk-verifier: out-of-order / broken-chain / digest-mismatch / multi-source-equivalence cases.
  state reducer + reconcile: event sequences -> local state; on-chain overrides and invariants (no backward movement).
  errors: family/code/retriable mapping.
Integration tests:
  mock IngressClient / ChainClient / GatewayClient (in-memory implementations), running the full submit -> track -> fetch -> challenge flow.
  correctness of the progression where ingress ack != accepted on chain.
  crash recovery: rebuilding session/task from the mock chain after clearing the local cache.
E2E (optional, requires a devnet):
  connect to a devnet: real MsgCreateSession / SubmitOrder / retrieval; marked opt-in (skipped by default in CI).
Tooling: vitest (cross-platform); mock transport uses in-memory fixtures; helper assertions for bigint/Uint8Array.
```

---

## 14. Engineering Practices

```text
Build: tsup (esbuild) -> ESM + CJS + .d.ts; target es2022; sourcemaps.
package.json exports: { ".": { import, require, types } }; "type": "module"; sideEffects: false.
tsconfig: strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, moduleResolution: bundler.
Lint/format: eslint (@typescript-eslint) + prettier.
Browser build: no Node built-in polyfills; crypto goes through @noble/@hpke (cross-platform); transport goes through connect-web/fetch.
CI: typecheck + lint + unit + integration; E2E is manual/nightly.
Versioning: aligned with SDK_WIRE_V1; breaking wire changes -> major version bump + migration notes.
```

Target shape of `package.json` (the current repository is an empty shell and needs to be filled in):

```jsonc
{
  "name": "trueopen-sdk",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" } },
  "engines": { "node": ">=18" },
  "scripts": {
    "build": "tsup", "typecheck": "tsc --noEmit",
    "test": "vitest run", "lint": "eslint src"
  }
}
```

---

## 15. Implementation Milestones

```text
M1 Foundation: type system (S4) + codec/domains/hash (S7) + Signer interface + errors (S9) + memory store.
        Exit criteria: golden-vector tests pass (encoding/signature bytes match the chain).
M2 Session and order: SessionManager + QuoteEstimator + OrderBuilder (including RBF/Cancel construction).
        Exit criteria: create session, build+sign OrderEnvelope, field-coverage validation.
M3 Submission and tracking: IngressClient(connect) + ChainClient(cosmjs) + TaskTracker + state machine (S6).
        Exit criteria: full submit -> watch -> reconcile flow (mock or devnet), ack != accepted handled correctly.
M4 Retrieval and verification: GatewayClient + OutputFetcher + ChunkVerifier + HPKE unsealing + RefreshCredential.
        Exit criteria: streaming/non-streaming retrieval, resumable transfer, three-hash verification, multi-source equivalence.
M5 Challenges: ChallengeManager (PrepareChallenge + MsgUserChallengeTx + outcome/economic tracking).
        Exit criteria: submission within the challenge window and result display.
M6 Polish: browser build verification, fs/idb store, retry/concurrency, E2E, documentation and examples.
```

---

## 16. Open Items

```text
1. Finalize dependencies: connect-es vs plain gRPC-web; CosmJS version; proto source (registry generated from the chain proto). -> S1.2
2. Canonical encoding baseline: confirm a serialization scheme that matches the on-chain signature-verification bytes byte for byte (proto vs custom), and produce golden vectors. -> S7.2
3. IngressAPI's concrete wire schema / full error code enumeration: the authoritative source is nexus's interface and topic list document, kept in sync as it is updated.
4. Source of the HPKE recipient private key: the boundary and security stance between a wallet-proxied hpkeOpen and an SDK-injected KEM private key. -> S7.3
5. Final shape of the event transport: the tradeoff and fallback order among gRPC stream / SSE / WebSocket. -> S8.1
6. Signer ecosystem: whether Keplr/Leap/Ledger/local keystore adapters are built in or shipped as a separate package.
7. Whether session tokens (the IngressAPI UX credential) are implemented in v0.1. -> detailed design S4.3
All open items' acceptance criteria are tracked under the corresponding category in the monorepo's issue tracker document (overview section 00), so the SDK side never unilaterally decides protocol details.
```

---

## Appendix: Quick Mapping to the Detailed Design

| Detailed design S2 module | Implementation in this document | Directory |
|---|---|---|
| S2.1 SignerManager | OrderSigner / RequestSigner + Signer interface | `src/signer/` |
| S2.2 SessionManager | SessionManager | `src/session/` |
| S2.3 QuoteEstimator | QuoteEstimator | `src/quote/` |
| S2.4 OrderBuilder | OrderBuilder | `src/order/` |
| S2.5 IngressClient | IngressClient(connect) | `src/transport/ingress-*` |
| S2.6 ChainClient | ChainClient(cosmjs) | `src/transport/chain-*` |
| S2.7 TaskTracker | TaskTracker + phase-map | `src/task/` |
| S2.8 OutputFetcher | OutputFetcher + ChunkVerifier | `src/output/` |
| S2.9 ChallengeManager | ChallengeManager | `src/challenge/` |
| S2.10 LocalStore | Storage + implementations | `src/store/` |
| S2.11 ErrorClassifier | TrueOpenError + mapping | `src/errors/` |
