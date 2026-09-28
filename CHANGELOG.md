# Changelog

## Unreleased

### Breaking: EIP-712 request signing and session grants (wire v0.4.0)

Requests to Builder Ingress and USER Task data requests are signed as EIP-712 typed data that
a browser wallet can sign, following wire `ea2f230` (the untagged v0.4.0 revision, see the
submodule note below). A Builder on the previous rules rejects this SDK, and the other way
round.

- **Breaking:** `TrueOpenClientConfig.wallet` (a `TypedDataSigner`) signs everything the user
  signs: the order, the request envelopes and the Task data requests. It replaces `signer`,
  `signerPubKey`, `orderSigner`, the separate `sdkSigner` / `sdkSignerPubKey` /
  `sdkSignerAddress` identity, and `addressPrefix`. Every signature is recovered and checked
  against `userAddress` before it is sent (`SDK_LOCAL_SIGNER_ADDRESS_MISMATCH`).
  `BuildOpenTaskInput` takes `wallet` in place of `orderSigner`, `signer` and `signerPubKey`.
- **Breaking:** `SDKRequestEnvelopeV2`. `request_domain` is `TRUEOPEN_SDK_REQUEST_V2`; the
  signature is 65 bytes over the EIP-712 `SDKRequest` ("TrueOpen SDK Request" v1, chainId =
  `evm_chain_id`); `method` is the bare name and `endpoint` `/nexus.v1.IngressAPI/<Method>`;
  `session_id` / `task_id` must be 64-character lowercase hex. `signer_pubkey` is no longer
  sent. Only OpenTask may use a chain-height expiry; every other request uses Unix
  milliseconds.
- **Breaking:** request bodies use the five registered `TRUEOPEN_SDK_BODY_*_V1` domains. The
  OpenTask body is `task_hash, session_id, order_sequence, user_address, input_size_bytes,
  input_hash, input_media_type, idempotency_key`; `payload_ref` is not signed but is still
  `nexus://sha256/<input_hash>`. SubscribeOutput signs `resume_after_seq` by presence and
  AckOutput signs `last_seq` (no longer `output_id`). `getTaskEventsBodyDigest` refuses a
  non-canonical `from_cursor`; `prepareChallengeBodyDigest` refuses a `local_evidence_digest`
  that is neither empty nor 32 bytes.
- **Breaking:** OpenTask has no outer order signature: `OpenTaskHeader.signature` and
  `signature_scheme` are sent empty, and `OpenTaskInput.signature` / `signatureScheme` are
  gone. The order is authorized by its EIP-712 signature alone; the user's account must hold
  its public key on chain (MsgCreateSession) before the first order. `buildOpenTaskRequest`
  refuses a `taskId` not derived from the order's session and sequence.
- **Breaking:** the USER Task data request signs "TrueOpen Task Data Request" **version 2**,
  whose struct ends with `sessionGrantHash`. Version 1 signatures are no longer accepted.
- **Breaking:** account addresses (`userAddress`, the OpenTask `user_address`, `signer_address`)
  must be canonical lowercase Bech32 with the account prefix `trueopen`, decoding to exactly 20
  bytes; anything else is refused locally. A 0x address, as an EIP-1193 wallet reports it, is
  converted (`toAccountAddress`). New: `canonicalAccountAddressBytes`,
  `ACCOUNT_ADDRESS_PREFIX`.
- **Breaking:** the envelope `chain_id` is always the configured chain; a request or an order
  context for another chain is refused locally (`SDK_LOCAL_CHAIN_ID_MISMATCH`).
- **Changed:** the Task data request expiry has its own window, `taskDataExpiryBlocks`
  (default 10, `DEFAULT_TASK_DATA_EXPIRY_BLOCKS`), which must fit the Builders'
  `max_service_material_expiry_blocks`; it no longer follows `requestTtlBlocks`.
- **Breaking:** the request nonce is 32 CSPRNG bytes (was 16), and a configured `nonce()` must
  return exactly 32 bytes.
- **Breaking, removed:** `frame4`, `i64be`, `u64be`, `sdkRequestSignBytes`, `bodyDigest`,
  `SdkRequestEnvelopeFields` (now `SdkRequestFields`), `orderEnvelopeSigningBytes`,
  `SIGN_DOMAINS.order`, `OPEN_TASK_HEADER_SIGNATURE_SCHEME`, the SHA-256 request signer
  (`privKeySecp256k1Signer`, `CosmosSecp256k1Signer`, `verifyCosmosSecp256k1`), and the exports
  of the digest-level `privKeyEip712Signer` / `Eip712Signer`.
- **Added:** `TypedDataSigner` with `privateKeyTypedDataSigner`, `eip1193TypedDataSigner`
  (`eth_signTypedData_v4`; the wallet's active chain must be `evm_chain_id`) and
  `keplrTypedDataSigner` (`signEthereum(..., EthSignType.EIP712)`), plus `typedDataJson`,
  `typedDataDigest`, `normalizeWalletSignature` and `signTypedDataAs`.
- **Added:** opt-in session grants. `session: { maxGrantBlocks, grantBlocks?, renewBeforeBlocks? }`
  makes the wallet sign one `SessionGrant` for an in-memory session key, which then signs
  SubscribeOutput, AckOutput, GetTaskEvents, PrepareChallenge and the OUTPUT
  GetTaskDataMetadata / FetchTaskData. OpenTask stays wallet-signed. The grant is renewed
  before it expires, and once more when a Builder reports it expired. New exports:
  `SessionKeyManager`, `sessionGrantTypedData`, `sessionGrantHash`, `sessionGrantMessage`,
  `SESSION_SDK_METHODS`, `SESSION_TASK_DATA_METHODS`, `TrueOpenClient.ingressAuth()`,
  `TrueOpenClient.sessionGrants`.
- **Added:** `evmChainId` defaults to `hub.getEvmChainId()`, read once.
- **Added:** error codes `SDK_AUTH_SESSION_GRANT_INVALID` / `_EXPIRED` /
  `_METHOD_NOT_ALLOWED`, `DATA_ACCESS_INVALID_SIGNATURE`, `DATA_ACCESS_DENIED`,
  `DATA_ACCESS_SESSION_*`, `NEXUS_INGRESS_CONTRACT_NOT_FROZEN` and
  `NEXUS_INGRESS_METHOD_RETIRED` are classified; `DATA_ACCESS_*` codes are now read from the
  message. An expired grant is retriable (renew and resend); the rest are not.
  `NEXUS_DATA_EXPIRED` (the request's own expiry) is re-signed and retried on the same Builder,
  while `DATA_EXPIRED` (retention passed) moves to another Builder.
- **Tests:** every positive EIP-712 section of `account_signing_v1.json` (domain separator,
  hash struct, digest and the exact signature from the fixture keys), every signed row of
  `request_auth_negative_cases`, and every base, tamper and replay row of
  `sdk_request_body_v1.json` are reproduced. The simulated Builders verify requests with an
  SDK-independent implementation of the wire rules (including the five-step check order), and
  new scenarios cover session-signed delivery, grant renewal, a grant on OpenTask and a
  tampered `last_seq`.

### Added

- Wire v0.3.3: model manifest retrieval. `ManifestSource` fetches from the local cache, then
  `ProfileState.manifest_uri`, then mirrors. It verifies each body in this order: hash
  (`TRUEOPEN_MODEL_MANIFEST_V4`), strict parse, canonical bytes, then projection fields.
  `HubReader.getProfileManifestState` reads `manifest_hash`, `manifest_uri` and the projection
  fields.
- `trueopen-sdk/node` entry with an SSRF-safe manifest downloader. It enforces an address
  policy, a pinned connection, TLS checked against the host name, and re-checks on retry and on
  each redirect (at most 3). It applies connect and total timeouts and caps the body at 4 MiB
  after decompression.
- `examples/manifest-proxy.mjs`: a same-origin manifest proxy, the recommended browser
  deployment. Browsers never fetch an on-chain `manifest_uri` directly.
- `parseManifestUri` / `isValidManifestUri`, matching `testdata/v1/hub/manifest_uri_v1.json`.
- `deriveModelId`, the `TRUEOPEN_MODEL_ID_V1` derivation from `chain_id`, `provider`, `repo_id`
  and the proposer address codec bytes. Checked against every vector in
  `testdata/v1/hub/model_id_v1.json`. Non-canonical input is rejected, never normalized, so the
  SDK derives the same identity the Hub Keeper recomputes from the registration signer.
- `hash32ToHex`, the single decoder every reader uses for a REST-encoded Hash32.
- `VerifiedManifest.projectionFullyBound` reports whether the registration digest bound the
  whole projection. Without `RegistrationCheck` only the scalars `ProfileState` exposes are
  compared, so fields such as `min_stake.denom` stay unbound.
- canonical_json_v1 encoder and strict parser (no HTML escaping), the H_V1 framing,
  `chainProjectionHash` and `registrationDigest` (`TRUEOPEN_MODEL_CHAIN_PROJECTION_V3`,
  `TRUEOPEN_MODEL_REGISTRATION_DIGEST_V3`).

- Resumable verified OUTPUT streaming with MMR checkpoints, strict duplicate-frame verification,
  idle timeout, and cross-Builder failover.
- Receipt confirmation against the locally verified MMR root, output leaf count, and byte size.
- OpenAI-compatible Chat Completion SSE adapters for Node `AsyncIterable` and browser
  `ReadableStream`, including provisional and confirmed-only delivery modes.
- Strict JSON V1 serialization for output checkpoints across Node and browser runtimes.

### Changed

- The `third_party/wire` submodule temporarily points at wire commit `ea2f230` (wire PRs #38
  and #39, merged to wire main): the EIP-712 request signing and session grants intended for
  wire v0.4.0, which is not tagged yet. It will move to the `v0.4.0` tag once that is published.
  This revision renames `SDKRequestEnvelopeV1` to `SDKRequestEnvelopeV2` and adds
  `SessionGrantV1`; see the breaking entries above.
- The examples and the README quick start are rewritten against the current facade:
  `create-session`, `open-task` and `fetch-output` read the EVM chain ID and fee denom from chain,
  start at order sequence 0, use the current amount fields, fetch output through the chain trust
  anchors, and use the insecure-http opt-in only for localnet. `examples/_shared.mjs` no longer
  downgrades https to http. `npm run typecheck:examples` checks the examples against the built
  types, and CI runs it.
- **Breaking:** errors are classified. `TrueOpenError` gains `category`, `switchSource` and
  `details`. `dataError` is no longer retriable: a hash mismatch, a bad chunk or Fin signature, a
  forbidden attachment or a bad range sets `switchSource` instead. `IngressClient` (including
  `raw`) now throws a `TrueOpenError` for every Connect error, coded by the nexus code in the
  message (for example `NEXUS_DATA_EXPIRED`), else `NEXUS_TRANSPORT_FAILED` for a local failure
  (including a refused or reset connection) or `NEXUS_CONNECT_<CODE>`; the Connect error stays as `cause`. A CheckTx failure is
  `CHAIN_TX_REJECTED` with the codespace, code and log in `details`. New `classifyNexusError` /
  `classifyBroadcastError`.
- **Breaking:** the order fee denom comes from the chain. `openTask` reads
  `params.phase0.business_denom` (`HubReader.getBusinessDenom`) and signs it; `feeDenom` in the
  config is now an optional check, and an order is refused locally
  (`SDK_LOCAL_FEE_DENOM_MISMATCH`) when it disagrees with the chain. The CLI no longer defaults
  to `uusdc`: `--fee-denom` / `TRUEOPEN_FEE_DENOM` is an optional check, and `--gas-price` is an
  amount whose denom is the chain `business_denom` (any other denom is refused).
- **Breaking:** `openTask` runs the profile pricing checks before signing. It reads the
  profile through `hub.getProfile` (or takes `params.pricing`) and refuses an order below
  `min_order_value` or whose `order_value + tx_fee_reserve` exceeds `max_fee`. It also refuses a
  zero `max_fee` and a non-zero `assignment_priority_fee`. Without pricing it fails with
  `SDK_LOCAL_PRICING_UNAVAILABLE` instead of skipping the checks.
- `openTask` returns `builders` (every selected Builder's address, rank, endpoint and ack or
  error), `unresolvedBuilders` and `feeDenom`. The first accepted ack stays at the top level.
- Output trust anchors come from the chain. New `resolveOutputTrustAnchors(taskId)` reads the
  accepted task_hash and winner Worker, the Worker's current service key (must be ACTIVE) and
  the accepted InferReceipt. `fetchTaskOutput` and `streamOutput` use it when `taskHash` /
  `outputHash` / `workerServicePubKey` are not given (new `taskReader` config), and the CLI
  `output get` / `output stream` no longer take them as required arguments. A task not on chain
  yet, a missing winner or a missing receipt is the retriable `OUTPUT_TRUST_ANCHOR_PENDING`.
- `fetchTaskOutput` fetches in ranges of at most 8 MiB (nexus's default max range), checks each
  range's `served_range` and chunk offsets, retries a range that failed on transport, checks
  the metadata against the accepted receipt, and does not fetch a size-0 object.
  `expiresAtHeight` defaults to latest height + 10.
- **Breaking:** the CLI order file requires every field and rejects unknown fields and unknown
  `taskType` / `latencyClass` values (`CLI_ORDER_FILE_INVALID`). The docs now use the parser's
  field names (`priceBid`, `maxFee`, `assignmentPriorityFee`, `txFeeReserve`).
- CLI `output get` requests expire at latest height + 10 instead of + 20 (nexus's TTL edge).

- **Breaking:** `streamOutput` requires a Worker-signed Fin by default
  (`finSignaturePolicy: 'require'`). An unsigned Fin no longer ends the stream, since a Builder
  could send one after any verified prefix and truncate the output. The `fin` event now carries
  `attested`. Under the explicit `'accept-unsigned'` opt-in an unsigned Fin ends the stream as
  `attested: false`, and it is never acked.
- **Breaking:** the nexus transport never downgrades https to plaintext. An https endpoint
  without a registered fingerprint is verified through the standard CA chain, and a handshake
  failure is an error. `PlaintextFallbackAgent`, `isPlaintextServerError` and the
  `plaintext-fallback` policy are removed. Plaintext `http://` / `grpc://` endpoints are refused
  unless the caller opts in with `allowInsecureHttp: true` or `TRUEOPEN_ALLOW_INSECURE_HTTP=1`
  (localnet only), which logs a warning. The default console sink says it once per endpoint per
  process; an injected `warn` sink sees every occurrence.
- **Breaking:** `openTask` reads the BuilderSet at the order's `session_anchor_height`, both for
  the signed `builder_set_id` / `builder_set_hash` and for routing, matching the chain's check.
  `TaskOrderContextReader` and `TaskBuilderReader` need `getBuilderSetAtHeight` instead of
  `getActiveBuilderSet`, `resolveTaskBuilderEndpoints` takes a required `sessionAnchorHeight`,
  and routing fails with `SDK_LOCAL_BUILDER_SET_MISMATCH` if the set at that height does not
  match the signed hash.
- **Breaking (wire v0.3.3):** orders are `TaskOrderV3`.
  - `model_id` is a raw Hash32. `TaskOrderRequest.modelId` is lowercase 64-hex, and legacy text
    slugs are rejected.
  - Three reserved plaintext fields are added: `payload_mode` = PLAINTEXT, a zero
    `input_key_commitment` and an empty `user_recipient_pubkey`.
  - The domain is `TRUEOPEN_TASK_ORDER_V3`.
  - The order's EIP-712 domain is version 3, with `modelId` typed as `bytes32`.
- **Breaking:** task data body digests use the V2 domains. The object ref frame gained
  `evidence_kind`, and `producer_operator` enters the preimage as address bytes.
- `FinishReasonV1` accepts `USER_STOP` (5) and `STOP_TOKEN` (6). Both map to OpenAI `stop`.
- Task data object refs with an illegal object_kind / evidence_kind combination are refused
  before any body digest is computed.
- **Breaking:** `queryTask` maps the compacted `terminal` arm of `TaskViewV1`
  (`view: 'terminal'`) instead of throwing. `acceptedInputHash`, `receiptStatus` and
  `assignmentStatus` are optional and absent on that arm, so callers must branch on `view`;
  reporting `""` would let code written against the active arm read a compacted task as one
  with an empty input hash and no receipt.
- `cancelOrder` no longer computes an owner signature: `MsgCancelOrder` is authorized by the
  account signature alone.

- The CLI now rotates across discovered Builder endpoints instead of hanging indefinitely on the
  first endpoint without output.
- Confirmed-only SSE delivery has a 16 MiB default memory limit, supports `AbortSignal`, propagates
  stream cancellation, and avoids upstream prefetch until consumer demand.

### Removed

- **Breaking:** the old local task-state model: `reduce`, `initialState`, `reconcile`,
  `phaseToState` and their types (`LocalTaskState`, `TaskEvent`, `AttentionIssue`,
  `ChainTaskView`, `TaskState`). The on-chain query is the task state.
- **Breaking:** `ChunkVerifier` and the chunk-chain types `OutputRef`, `RawChunk`,
  `VerifiedChunk`, `ChunkBoundary` and `CredentialUsage`. Output is verified by its MMR root.
- **Breaking:** `secp256k1Address` and `secp256k1AddressMatches`. They derive
  ripemd160(sha256(pubkey)), which is not this chain's address scheme; use
  `ethSecp256k1Address` / `ethSecp256k1AddressMatches`.
- **Breaking:** `signDetached`, `signOrderEnvelope` and `submitOrderBodyDigest`.
- **Breaking:** the deprecated retrieval-credential path: `TrueOpenClient.fetchOutputRef`,
  `IngressClient.fetchOutputRef` / `refreshCredential` / `submitOrder`,
  `fetchOutputRefBodyDigest`, `refreshCredentialBodyDigest`, the `SubmitOrderAck` and
  `AccessLevelName` types, the CLI `output ref` command and the `CREDENTIAL` error family. Output
  is fetched over the task data plane (`fetchTaskOutput`).
- **Breaking:** the hand-written `TaskPhase`, `TaskVerdict`, `TaskFailureClass`, `ChallengeKind`,
  `OptimisticFinalityStatus`, `EvidenceRequestStatus` and `ChallengeOutcome` types. The wire
  enums `TaskPhase`, `TaskVerdict`, `TaskFailureClass`, `TaskFinalityStatusV1`,
  `AssignmentStatus`, `ReceiptStatus`, `VerificationStatus` and `SettlementStatus` are
  re-exported instead (`task/v1/settlement.proto` is now generated). `prepareChallenge` takes the
  challenge kind as a string, which is what the wire carries.

- **Breaking:** `MsgUserChallenge` (encoding, registry entry, `client.challenge()`, the CLI
  `challenge submit` command and the `TRUEOPEN_USER_CHALLENGE_V1` signing bytes). Wire has no
  such Msg. On-chain challenges (`MsgOpenChallengeRound`) are not supported yet.
- **Breaking:** `querySettlementFinality`, `settlementFinalityToChainView`,
  `HubReader.listProfiles` and the reference bucket query; wire defines none of these routes.
- **Breaking:** `signCancelOrder`, `cancelOrderSigningBytes`, the `DOMAINS` table and the unused
  builder stage domains.

### Fixed

- An `ipfs://` `manifest_uri` can no longer escape `/ipfs/<cid>` on the configured gateway.
  `manifest_uri` is chosen by whoever registered the profile, and the gateway is fetched without
  the address policy, so dot segments in the path turned into a GET for an arbitrary path on
  that host. Dot segments are now refused, and the built URL is re-checked against the gateway
  prefix.
- `RestChainReader.queryTask` decodes `model_id` as a Hash32. It is `bytes` with
  `REST_BYTES_ENCODING_HASH32_LOWER_HEX` in wire, so reading it as an opaque string left
  `ChainTaskSnapshot.modelId` and `ProfileInfo.modelId` in encodings that never compare equal.
- The address policy refuses exactly `3fff::/20` (RFC 9637). It previously covered `3ff0::/12`,
  refusing 16 times that range.
- The manifest downloader bounds the compressed side of a response. A gzip stream of empty
  deflate blocks decodes to nothing, so the 4 MiB decompressed cap never tripped and the socket
  was read until the total timeout.
- `MemoryManifestCache` bounds its total bytes, not only its entry count, which allowed
  `maxEntries * MAX_MANIFEST_BYTES` (256 MiB at the defaults).
- The projection check compares `task_types` element by element. Joining on `","` made `["A,B"]`
  and `["A","B"]` compare equal and hid a length difference.
- `RestChainReader.queryTask` decodes the terminal arm's `model_id` as a Hash32 as well.
- An evidence object with no producer kind reports that, instead of the unhelpful
  "evidence_kind 0 is not a data-plane evidence kind for producer kind 0".
- A ranged output fetch backs off between retries. `Unavailable` and `ResourceExhausted` mean the
  peer is already past what it can serve, and the retry was immediate.
- The CLI order file rejects a zero `profileVersion` / `outputBudgetBucket` by name. Both are
  refused on chain and by `validateTaskOrderScalarScope`, which reported them as the field-less
  "task order scalar scope is invalid".
- `classifyBroadcastError` recognizes a CheckTx failure by shape alone. It also required a class
  name, which a bundler renames when it minifies, so `CHAIN_TX_REJECTED` and the retriable
  sequence-mismatch would have been lost in a minified consumer build.
- `openTask` works on Node 18 without `config.nonce`. Node exposes `globalThis.crypto` unflagged
  only from v19, while this package declares `engines: node >=18`, so the request nonce threw
  `SDK_LOCAL_NO_CRYPTO` on the minimum supported runtime.
