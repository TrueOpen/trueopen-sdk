# Changelog

## Unreleased

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

- The CLI now rotates across discovered Builder endpoints instead of hanging indefinitely on the
  first endpoint without output.
- Confirmed-only SSE delivery has a 16 MiB default memory limit, supports `AbortSignal`, propagates
  stream cancellation, and avoids upstream prefetch until consumer demand.

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

### Known limitations

- Exact optional `resume_after_seq` presence remains blocked on TrueOpen/wire#28.
- Worker-authenticated Fin reason/signature and real streamed terminal SSE remain blocked until
  the Worker runtime and nexus produce and forward signed Fins.
