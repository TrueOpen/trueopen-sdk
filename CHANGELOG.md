# Changelog

## Unreleased

### Added: Web3 transactions for EIP-712 wallets

- **Added:** `connectTrueOpenWeb3ChainClient({ rpcUrl, restUrl, wallet, signerAddress,
  typedDataChainId, fee })` and `createTrueOpenWeb3ChainClient` return the usual `ChainClient`
  (`createSession(grant?)`, `updateSessionKey`, `cancelOrder`, reads) signed by a
  `TypedDataSigner`, so MetaMask / EIP-1193 and Keplr users can create sessions, register / update
  session keys and cancel orders. Transactions use node's Web3 envelope: one critical
  `ExtensionOptionsWeb3Tx`, `SIGN_MODE_LEGACY_AMINO_JSON`, a 65-byte signature over the "Cosmos
  Web3" typed data (cosmos-evm v0.6.3 `WrapTxToTypedData` plus TrueOpen's type rename) of the
  canonical Amino sign doc. One Msg per tx, explicit fee (`'auto'` is `SDK_LOCAL_TX_FEE_AUTO`), no
  fee delegation; a first transaction's public key is recovered from the signature, a stored key
  of another account is `SDK_LOCAL_TX_PUBKEY_MISMATCH`, a missing account
  `CHAIN_ACCOUNT_NOT_FOUND`.
- **Added:** the building blocks: `Web3TxBroadcaster` (a `TxBroadcaster` for `CosmjsChainWriter`),
  `signWeb3Tx`, `assembleWeb3TxRaw`, `encodeExtensionOptionsWeb3Tx`, `aminoMsgCreateSession` /
  `aminoMsgUpdateSessionKey` / `aminoMsgCancelOrder`, `canonicalAminoSignDoc`, `canonicalJson`,
  `cosmosWeb3TypedData`, `cosmosWeb3Domain`, `AMINO_NAME`, `WEB3_EXTENSION_TYPE_URL`.
- **Added:** `createTrueOpenChainClient` takes an optional `inclusion` policy.
- **Changed:** a `MsgUpdateSessionKey` action is checked at runtime on both the protobuf and the
  Amino encoder: anything but exactly one of `set` (a grant) or `clear: true` is
  `SDK_LOCAL_SESSION_KEY_INVALID` (wire `session_key_amino_v1.json` negative cases).
- Tests reproduce `task/session_key_amino_v1.json` (create / set / clear: sign doc bytes, sha256,
  encode_type, hash_struct, domain_separator, signing_digest, signature_65) and
  `shared/account_signing_v1.json` `msg_create_session_transaction`; the produced TxRaw bytes were
  accepted by node's ante handler.

### Registered session keys sign orders (ADR-0037, wire PR #47, untagged; breaking for ChainClient implementers)

A session can have one registered key (a 20-byte eth-style address on chain). That key, not the
wallet, then signs the session's OpenTask orders and the session-allowed requests, so a browser
wallet prompts once per registration instead of once per order. **Enable it only once the chain
and the Task Builders support it**: a chain whose `max_session_key_blocks` is absent, 0 or below 2
is refused with `SDK_LOCAL_SESSION_KEY_UNSUPPORTED`.

- **Breaking (implementers):** `ChainClient.updateSessionKey(input)` is a new required method, and
  `StreamStateView` gains four required fields: `sessionKeyExpiryHeight`, `sessionKeySpendCap`,
  `sessionKeySpent` and `sessionKeySetHeight` (plus the optional `sessionKey`). A custom
  `ChainClient` / `ChainReader`, a test double, a wrapper (like the CLI's read-only chain) or code
  that builds a `StreamStateView` literal no longer compiles until updated. Migration, for a node
  without session keys: return `0n` / `"0"` for the four fields and no `sessionKey`, and have
  `updateSessionKey` throw if unsupported. Callers of the SDK's own clients need no change.
- **Added:** `createSession(label | { label?, sessionKey?: { expiryBlocks?, spendCap?, key? } })`.
  With `sessionKey` the SDK generates the key from a CSPRNG (or takes `key`, material from
  `generateSessionKey()` the caller persisted before the broadcast), registers it in the same
  `MsgCreateSession`, loads it, and returns it once in `SessionHandle.sessionKey`
  (`{ address, privateKey, expiryHeight, spendCap }`). `expiryBlocks` is an integer in
  `[2, max_session_key_blocks]` (default `max_session_key_blocks - 2`, at least 2; one block never
  lands). `spendCap` defaults to `"0"`, which is unlimited: a leaked key can then authorize orders
  up to the whole account balance.
- **Added:** `updateSessionKey(sessionId, { renew } | { rotate } | { clear: true })`, returning
  `{ response, newKey? }`. All three are `MsgUpdateSessionKey`, signed by the wallet; the session
  key never signs a transaction. `renew` keeps the loaded key (it must still be the chain's key);
  `rotate` generates a fresh key (or takes `rotate.key`), loads it and returns it as `newKey`;
  `clear` removes the registration and the loaded key. `renew` and `rotate` default the cap to the
  chain's current one; when the chain has no key (after a clear, which zeroes the cap) `rotate`
  requires an explicit `spendCap`. `spent` is never reset. `renew` checks the chain's key and then
  sends the tx, which is not atomic: a rotate on another device in between is overwritten.
- **Added:** `useSessionKey(sessionId, privateKey)`, `forgetSessionKey(sessionId)` and
  `sessionKeyState(sessionId)` (`registered`, `matchesLoadedKey`, `expiryHeight`, `spendCap`,
  `spent`, `setHeight`, `status`). Also exported: `generateSessionKey`, `sessionKeyFromPrivateKey`,
  `registeredSessionKey`, `RegisteredSessionKeys`, `sessionKeyAddressHex`,
  `DEFAULT_SESSION_KEY_ANCHOR_WAIT_MS`, `DEFAULT_REGISTERED_KEY_HEIGHT_MAX_AGE_MS` and the
  `SessionKeyOptions` / `RegisterSessionKeyOptions` / `SessionKeyUpdate` /
  `UpdateSessionKeyResult` / `SessionKeyState` / `SessionKeyHandle` /
  `RegisteredSessionKeysOptions` types.
- **Key custody:** the SDK generates the key and never derives it from a signature. It keeps keys in
  memory only and never logs them. **The caller persists `privateKey`** and reloads it with
  `useSessionKey` after a restart; it cannot be recovered.
- **Added:** `openTask` prechecks, before anything is signed, what the chain checks at admission:
  the session is not CLOSED, the registered key is the loaded one, the latest height is at or
  before the key's expiry, the session anchor is at or after the key's `set_height`,
  `spent + max_fee` fits a u64 (even with an unlimited cap), and (with a nonzero cap)
  `spent + max_fee <= cap`. A failed check never falls back to the wallet: renew or
  raise the cap, load the current key, or call `forgetSessionKey` to sign with the wallet. Right
  after a registration the anchor can still be below `set_height`, so `openTask` waits up to
  `sessionKeyAnchorWaitMs` (default 15 s; `sessionKeyAnchorPollMs`, default 1 s; 0 disables) for a
  fresh anchor; a caller-supplied `context` is used as is and refused if too old. Both settings
  are validated in the constructor (wait finite and `>= 0`, poll finite and `> 0`, else
  `SDK_LOCAL_SESSION_KEY_CONFIG_INVALID`).
- **Added:** requests fall back near the key's expiry. The client tracks the loaded key's expiry
  height (create, rotate, renew, `useSessionKey`, and every `openTask` / `sessionKeyState` read).
  From `sessionKeyRequestExpiryMarginBlocks` (default 3) blocks before it, the session-allowed
  requests are signed by the configured grant key, else the wallet: the margin keeps a request
  from being refused as expired on arrival, and output of orders admitted just before expiry stays
  readable. Orders never fall back. A
  registered-key `FetchTaskData` the Builder reports expired is not retried by `fetchTaskOutput`.
- **Added:** `HubReader.getMaxSessionKeyBlocks()` reads `params.session.max_session_key_blocks`
  (the `StreamStateView` fields are listed under Breaking above).
- **Added:** error codes `SDK_LOCAL_SESSION_KEY_INVALID`, `SDK_LOCAL_SESSION_KEY_UNSUPPORTED`,
  `SDK_LOCAL_SESSION_KEY_NOT_REGISTERED`, `SDK_LOCAL_SESSION_KEY_EXPIRED`,
  `SDK_LOCAL_SESSION_KEY_SPEND_CAP_EXCEEDED` (also for a u64 overflow, with `details.overflow`),
  `SDK_LOCAL_SESSION_KEY_ANCHOR_BEFORE_SET_HEIGHT` (retriable when the SDK resolved the context),
  `SDK_LOCAL_SESSION_KEY_CONFIG_INVALID` and `SDK_LOCAL_SESSION_CLOSED`, plus the nexus code
  `SDK_AUTH_SESSION_KEY_SPEND_CAP_EXCEEDED` (category `auth`). The chain's
  `ERR_SESSION_KEY_INVALID`, `ERR_SESSION_KEY_EXPIRED` and `ERR_SESSION_KEY_SPEND_CAP_EXCEEDED`
  appear in a Builder's tx result or a tx log.
- **Unchanged:** the order domain, EIP-712 types and digest. Only the recovered signer differs. A
  registered-key request carries `signer_address` = the owner, no `session_grant` and an all-zero
  `sessionGrantHash`, and is allowed only for the session-allowed requests (OUTPUT task data
  included). A `SessionGrant` key (the opt-in `session` config) still cannot sign orders. Requests
  never consume the cap; only admitted orders do.
- **Recovery:** there is no automatic resubmission on `ASSIGN_REJECTED`. `waitForAdmission`
  (below) diagnoses it; fix the cause (renew, raise the cap, load the current key, or sign with
  the wallet) and call `openTask(retry)`.
- **Added:** `waitForAdmission(res, { timeoutMs?, pollIntervalMs?, signal? })` waits for the chain
  to decide an order and resolves `accepted` (chain task has this `task_hash`), `superseded`
  (another `task_hash` for the `task_id`), `rejected` or `timeout`. The chain is the truth; every
  acking Builder's task events are hints (`ASSIGN_ACCEPTED` / `ASSIGNMENT_FINALIZED` trigger a
  read; `ASSIGN_REJECTED` / `ASSIGN_TIMEOUT` after the Builder's last `ORDER_RECEIVED`, or a
  NotFound event stream, are that Builder's report). `rejected` needs every acked Builder to have
  reported and a later chain read to show no task, since one Builder's rejection does not prove
  another did not get the order admitted; or, with no reports needed, the latest height past the
  order's `orderExpireHeight` and a later read with no task (a Builder may refuse the key-signed
  event stream once the key was rotated or cleared or the session closed). A task without a valid
  accepted task_hash decides nothing yet. It carries `diagnosis` (`reason`: `session-closed`,
  `cleared`, `rotated`, `expired`, `anchor-before-set-height`, `spend-cap` or `unrelated`;
  `sequenceFree`; the events; the session read) and `retry`. Abort throws
  `ORDER_ADMISSION_WAIT_ABORTED`; bad options are `SDK_LOCAL_POLL_INTERVAL_INVALID` /
  `SDK_LOCAL_TIMEOUT_INVALID`; a client without `taskReader` / `ingressTransportFactory` / `hub` is
  `SDK_LOCAL_ADMISSION_UNCONFIGURED`. Exported with `DEFAULT_ADMISSION_WAIT_MS`,
  `nextRetryIdempotencyKey` and the `WaitForAdmissionOptions` / `AdmissionOutcome` /
  `RejectionDiagnosis` / `RejectionReason` types.
- **Added:** `OpenTaskResult` gains `orderSequence`, `orderSignedBy` (`'wallet' | 'session-key'`),
  `orderSignerAddress` (the key's 20-byte address, never its private key), `maxFee`,
  `orderExpireHeight` and
  `retryParams`: the same params under the same sequence, without `context` / `expiryHeight`,
  with the idempotency key `<key>#retry<n>`. The re-signed order has a new `task_hash`, and an
  idempotency key only repeats the same one, so the retry needs a new key. `rejected.retry` drops
  `orderSequence` when the sequence was used up meanwhile (`sequenceFree: false`).
- **Added:** `openTask({ orderSigner: 'wallet' })` signs the order with the wallet while a key is
  loaded, skipping the key prechecks; the envelope is signed as without a key (grant, else
  wallet). The default `'auto'` is unchanged. An unknown value is `SDK_LOCAL_ORDER_SIGNER_INVALID`.
- The SDK never re-signs, renews, raises a cap or switches to the wallet by itself. Builders that
  abandoned a rejected order accept its retry; a task that reached the chain and finished refuses
  a new version (`NEXUS_INGRESS_TASK_TERMINAL`).
- **Interop with the deployed node (PR #34) and nexus (PR #56):**
  - **Fixed:** `waitForAdmission` on a retry no longer counts the previous attempt's
    `ASSIGN_REJECTED` / `ASSIGN_TIMEOUT`: Nexus keeps an abandoned task's journal and the event
    stream replays it, so a Builder's report is reset on every `ORDER_RECEIVED`.
  - **Fixed:** the admission hints are `ASSIGN_ACCEPTED` and `ASSIGNMENT_FINALIZED`; the chain
    codes `WORKER_ASSIGNMENT_FINALIZED` / `WORKER_HANDRAISES_ACCEPTED` never reach the SDK.
  - **Added:** a GetTaskEvents NotFound from a Builder that acked the order is its report
    (`ABANDONED_REPORT`, `'ABANDONED'`), so a fast rejection is not a wait until the deadline.
  - **Fixed:** `retryParams` keeps the order window relative (`OpenTaskParams.orderWindow`,
    `OrderWindowOffsets`), rebased on the retry's context, so a retry after a past-deadline
    rejection is not refused by every Builder. `openTask` refuses an order whose
    `orderExpireHeight` is below the latest height with `SDK_LOCAL_ORDER_EXPIRED`. An invalid
    `orderWindow` is `SDK_LOCAL_ORDER_WINDOW_INVALID`.
  - **Added:** a retry whose order is identical to the rejected one (the Builders keep a tombstone
    of its input) resolves one fresh context, then fails with `SDK_LOCAL_RETRY_ORDER_UNCHANGED`.
  - **Added:** a retry answered `NEXUS_INGRESS_ORDER_REPLACEMENT_UNSUPPORTED` by a Builder still
    tracking the rejected version is re-sent to it after `orderReplacementRetryMs` (default
    `DEFAULT_ORDER_REPLACEMENT_RETRY_MS`, 1000), at most `ORDER_REPLACEMENT_RETRY_ATTEMPTS` (3)
    times, with the envelope re-signed under a fresh nonce. A bad value is `SDK_LOCAL_CONFIG_INVALID`.
  - **Added:** Builders may lag a key change by up to `MAX_SESSION_KEY_CACHE_TTL_BLOCKS` (10)
    blocks. The client records each session's last key-change height (createSession with a key,
    rotate, renew, `useSessionKey`); within 10 blocks of it a key-signed request or OpenTask
    refused with `SDK_AUTH_INVALID_SIGNATURE` / `DATA_ACCESS_INVALID_SIGNATURE` /
    `*_SESSION_GRANT_EXPIRED` is re-signed with a fresh nonce and re-sent after
    `sessionKeyChangeRetryMs` (default `DEFAULT_KEY_CHANGE_RETRY_DELAY_MS`, 1000), at most
    `DEFAULT_KEY_CHANGE_RETRY_ATTEMPTS` (10) times. Outside the window those answers are final.
    `RegisteredSessionKeys` gains `retryAfterKeyChange`, `keyChangeHeight`, `noteKeyChange` and the
    `keyChangeRetryDelayMs` / `keyChangeRetryAttempts` / `sleep` options; `set` and `refreshExpiry`
    take an optional key-change / set height.
  - **Changed:** a `*_SESSION_GRANT_EXPIRED` answer to a request that carried no grant is
    `retriable: false` on every path (SDK envelopes, streams, Task Data, OpenTask fan-out
    results), outside the key-change window. A key-signed Task Data request answered
    `DATA_ACCESS_INVALID_SIGNATURE` (what a Builder without the local Task says) is
    `switchSource: true`.
  - **Added:** `openTask` with a registered key refuses an order whose `earliestSubmitHeight` is
    after the key's expiry (`SDK_LOCAL_SESSION_KEY_EXPIRED`; the Keeper checks the expiry at the
    admitting height); a window that only ends after it is sent with
    `OpenTaskResult.keyExpiresInOrderWindow`. `OpenTaskResult` gains `earliestSubmitHeight` and
    `sessionKeyExpiryHeight`. The `expired` diagnosis compares the expiry with the later of the
    latest height and `earliestSubmitHeight`.
  - **Added:** a spend cap above u64 max, or an expiry above 2^63 - 1, is
    `SDK_LOCAL_SESSION_KEY_INVALID` before any transaction (client and `MsgCreateSession` /
    `MsgUpdateSessionKey` encoders).
  - **Added:** registration tx failures are classified: `CHAIN_SESSION_KEY_INVALID` (task 1144),
    `CHAIN_SESSION_KEY_EXPIRED` (1145), `CHAIN_SESSION_KEY_SPEND_CAP_EXCEEDED` (1146),
    `CHAIN_SESSION_CLOSED` (1105 "session cannot update authorization") and
    `CHAIN_SESSION_NOT_OWNER` (sdk 4), matched on code and raw-log text (and codespace for
    CheckTx), with the generic code in `details.txFailure`; `sessionTxFailureCode` is exported.
    **Changed:** these failures no longer surface as `CHAIN_TX_FAILED` / `CHAIN_TX_REJECTED`.
  - **Added:** `updateSessionKey` `clear` and `rotate` (and `renew`) read the session first and send
    nothing for a CLOSED session (`SDK_LOCAL_SESSION_CLOSED`) or another user's
    (`SDK_LOCAL_SESSION_NOT_OWNER`).
- Pinned to wire PR #47 @ `602cb18` (untagged, two commits after `v0.5.0`). Its proto is identical to
  `88d1238`; `602cb18` adds the server-side request vectors and the session key Amino vectors.
  Re-pin to the release tag once it ships.

### Lower time to first token

- **Added:** early subscribe. `streamOutput({ waitForAnchors })` (or `pendingAnchors`, a promise
  the caller already has) opens SubscribeOutput at once and waits for the trust anchors in
  parallel. Frames that arrive first are held unverified, bounded by `maxPendingFrames` (default
  `DEFAULT_MAX_PENDING_FRAMES`, 256; at the bound the SDK stops reading the subscription), and are
  released only once the anchors arrive and each frame verifies; nothing is delivered,
  checkpointed or acked before that. A Fin held before the anchors is checked after the frames
  before it. If the anchor wait fails, the SDK closes the subscription and throws that error. The
  checks are the same as before; the Worker service key is still read once, so a key rotated
  mid-stream is not covered. Calls with both `taskHash` and `workerServicePubKey` behave as
  before.
- **Added:** `streamOutput({ signal })`: aborting closes the subscription and any anchor wait and
  throws `OUTPUT_STREAM_ABORTED`.
- **Changed:** `streamOutput` resubscribes on the same source after the last verified frame,
  without using an attempt, when nexus drops a slow subscriber with ResourceExhausted after this
  subscription delivered new verified frames (at most `MAX_OVERFLOW_RESUBSCRIBES`, 64, times).
  With `waitForAnchors`, the `ASSIGNMENT_FINALIZED` hint is read from the first source when it is
  an `IngressClient`.
- **Changed:** `waitForOutputTrustAnchors`: an `ASSIGNMENT_FINALIZED` event that lands while a
  chain read is in flight starts the event's read at once instead of after it; an older read's
  "not yet" never overrides a newer read. `signal` now ends the wait at once, even mid-read.
- **Added:** connection warm-up. Transports from `nexusIngressTransport` for the same pinned
  certificate key now share one keep-alive agent (`sharedPinnedHttpsAgent`; opt out with
  `shareConnections: false`), and `prewarmNexusConnections(uri, hash, { connections })` leaves
  idle TLS connections in that agent's pool. `TrueOpenClientConfig.ingressPrewarm` makes
  `openTask` prewarm every selected Builder concurrently while the order is being signed;
  `prewarmTaskBuilders` does it on demand.
- **Changed:** `openTask` reads the fee denom, pricing, order sequence and context concurrently,
  resolves the selected Builders while the order is being signed, reads their descriptors
  concurrently, and no longer reads the anchor-height BuilderSet twice.
- **Added:** `resolveTaskBuilders({ sessionId, orderSequence?, context? })`: the Builders an
  order will go to, before anything is signed.
- **Added:** `TaskOrderContextCache` (used by `TrueOpenClient` unless
  `orderContextReuse: false`): reuses the session anchor across orders while
  `latest - anchor <= floor(anchor_freshness_window_blocks * 0.25)` and the anchor-height
  BuilderSet still reads back, re-reading the latest height, that set, the timeout bucket
  version, the generation limits and the window in one concurrent round.
  `HubReader.getAnchorFreshnessWindowBlocks()` reads the window. Also exported:
  `resolveTaskOrderContextWithBuilderSet`.

### Breaking: Hash32 text is 0x-prefixed (ADR-0034, wire #44)

Every client-facing string form of a Hash32 (a 32-byte digest or ID) is now `0x` followed by
exactly 64 lowercase hex characters, 66 in all. Input accepts only that form: a bare 64-hex
string, uppercase hex, `0X` or any other length is refused. There is no fallback for the bare
spelling, so the SDK must move together with the node and Nexus releases that adopt wire #44.

- **Breaking:** every Hash32 the SDK returns or accepts as a string is `0x` + 64 lowercase hex:
  `sessionId`, `taskId`, `taskHash`, `modelId`, `inputHash`, `outputHash` (and the output MMR root
  text), `manifestHash`, `tokenizerHash` / `schemaHash`, `registrationDigest`, `builderSetHash` /
  `setHash`, the session anchor block hash, `descriptorHash`, `tlsPubkeyHash`, `inferReceiptHash`,
  `rankHash`, `TaskDataObjectRef` hashes and the task-data `body_digest`. `deriveTaskId`,
  `deriveModelId`, `taskOrderHashHex`, `domainHashHex` and `tlsPubkeyHashOfCertificate` return
  that form, and `MODEL_ID_GRAMMAR` is `^0x[0-9a-f]{64}$`.
- **Breaking:** `strictHash32(field, text)` requires `^0x[0-9a-f]{64}$` and decodes the 64 hex
  after `0x`. Nexus ingress strings (`session_id`, `task_id`, `input_hash`, `TaskDataObjectRefV1`
  hashes, `body_digest`) are sent in the `0x` form, and an `OpenTask` ack whose `task_id` or
  `session_id` is set in any other form is refused (`NEXUS_RESPONSE_MALFORMED`).
- **Breaking:** `hash32ToHex` is renamed `restHash32`. Node REST Hash32 fields
  (`HASH32_LOWER_HEX`) are read through it: the `0x` form passes through, a protojson base64 value
  is converted to it, and a bare 64-hex string is refused. `RestChainReader` now decodes
  `session_id`, `task_id`, `task_hash`, `accepted_input_hash`, `output_hash` and
  `infer_receipt_hash` the same way. REST paths carry the `0x` string as is.
- **Breaking:** the output checkpoint JSON (`OUTPUT_STREAM_CHECKPOINT_JSON_V1`, schema version
  unchanged) writes and accepts `task_hash` and the MMR peak `hash` only as `0x` + 64 lowercase hex;
  `worker_service_pubkey` stays bare hex (33 bytes, not a Hash32). A checkpoint persisted by an
  earlier SDK version no longer deserializes.
- **Breaking:** a pinned nexus `tls_pubkey_hash` (and `--nexus-tls-pubkey-hash` /
  `TRUEOPEN_NEXUS_TLS_PUBKEY_HASH`) must be `0x` + 64 lowercase hex; it is no longer trimmed or
  lowercased.
- **Added:** `hash32Text(bytes)`, `isHash32Text(value)` and `HASH32_TEXT_RE` are exported.
- **Unchanged:** raw protobuf bytes, EIP-712 `bytes32` values and every hash or signature preimage
  stay raw 32 bytes. `payload_ref` stays `"nexus://sha256/" + bare lowercase hex`. Bech32 and EVM
  addresses, signatures, the 33-byte service key, nonces and the beacon `randomness_hex` keep
  their spelling. No digest changes.
- Pinned to wire `main` @ `41af15b` (wire #44, pre-v0.5.0); superseded by the `602cb18` pin (see the registered session keys entry above).

### Breaking: session-signed OpenTask

- **Breaking:** with `session` configured, the session key now signs the OpenTask request
  envelope too, under a grant for the order's own user (wire PR #43). The order itself is still
  signed by the wallet, so a browser wallet prompts once per order instead of twice. A Builder
  that predates wire PR #43 refuses it with `SDK_AUTH_SESSION_METHOD_NOT_ALLOWED`; without
  `session`, OpenTask is wallet-signed as before.
- **Changed:** `SESSION_SDK_METHODS` includes `OpenTask`. `buildOpenTaskRequest` takes an
  optional `session`. `IngressClient.openTask` no longer refuses every session grant, only one
  whose user is not the order user (`SDK_LOCAL_REQUEST_MALFORMED`).

### Breaking: signer-selected signature_chain_id (wire pre-v0.5.0)

The EIP-712 domain `chainId` is no longer the chain's `evm_chain_id`; it is now a signer-chosen
`signature_chain_id` carried next to each signature (ADR-0033), so a browser wallet signs under its
active network and the chain needs no `eth_chainId` endpoint.

- **Breaking:** `TrueOpenClientConfig.evmChainId` becomes `signatureChainId`
  (`bigint | number | string`), defaulting to `1` (Ethereum mainnet) for session keys and server-side
  keys instead of reading `params.phase0.evm_chain_id` from the hub. `HubReader.getEvmChainId` is
  removed. `0`, negatives and values above `2^63-1` are refused locally
  (`SDK_LOCAL_SIGNATURE_CHAIN_ID_INVALID`).
- `SignedOrderV2`, `SessionGrantV1`, `TaskDataRequestAuthV1` and `SDKRequestEnvelopeV2` now carry
  `signature_chain_id` (fields 4, 7, 13, 14), equal to the domain chainId each digest was built with.
- Pinned to wire `feat/signature-chain-id` @ `8a4d726` (pre-v0.5.0); re-pin to the v0.5.0 tag once it
  ships. This is a breaking signing change with no transition window: the SDK must be upgraded
  together with node, Nexus and Cortex.

### Expired order code

- `NEXUS_INGRESS_ORDER_EXPIRED` is classified as `expired`, not retriable and not to be sent to
  another Builder. A Builder returns it (`FailedPrecondition`) for an `OpenTask` whose
  `order_expire_height` has passed; the chain would not admit the order either.

### Order version refusal codes

- `NEXUS_INGRESS_ORDER_REPLACEMENT_UNSUPPORTED` and `NEXUS_INGRESS_TASK_TERMINAL` are classified
  as `conflict`, not retriable, and not to be sent to another Builder. A Builder returns them
  (`FailedPrecondition`) for an `OpenTask` whose `task_hash` differs from the version it already
  holds for the same task, pending or finished; replacing a pending order is not supported yet.
  In `openTask` they appear as the per-Builder `error` of the refusing Builder.

### Breaking: EIP-712 request signing and session grants (wire v0.4.0)

Requests to Builder Ingress and USER Task data requests are signed as EIP-712 typed data that
a browser wallet can sign, following wire v0.4.0 (see the submodule note below). A Builder
on the previous rules rejects this SDK, and the other way round.

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

- The `third_party/wire` submodule is pinned to wire **v0.4.0** (`586ea8f`): the EIP-712
  request signing and session grants. This release renames `SDKRequestEnvelopeV1` to `SDKRequestEnvelopeV2` and adds
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
