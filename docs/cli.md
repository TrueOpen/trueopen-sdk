# `trueopen` CLI reference

`trueopen` is a thin wrapper around the `TrueOpenClient` facade (zero business logic; the library and the CLI share the same core).

```bash
npm run build          # build first, then it's runnable
node dist/cli.cjs <command>
# after publishing, just `trueopen <command>`
```

This document always writes it as `trueopen`.

---

## Table of contents

- [Global options](#global-options)
- [Key handling](#key-handling)
- [Output and exit codes](#output-and-exit-codes)
- [Command overview (with required configuration)](#command-overview-with-required-configuration)
- [Command reference](#command-reference)
- [order-file format](#order-file-format)
- [Full example: placing one order end to end](#full-example-placing-one-order-end-to-end)
- [Common errors](#common-errors)

---

## Global options

All global options go **before the subcommand**. Priority: `flag` > environment variable > default.

| flag | env var | default | description |
|---|---|---|---|
| `--rest-url <url>` | `TRUEOPEN_REST_URL` | - | root URL of node's gRPC-gateway REST |
| `--rpc-url <url>` | `TRUEOPEN_RPC_URL` | - | root URL of node's CometBFT RPC (only needed for on-chain writes) |
| `--nexus-url <url>` | `TRUEOPEN_NEXUS_URL` | - | explicitly targets a single nexus IngressAPI endpoint |
| `--nexus-tls-pubkey-hash <hex>` | `TRUEOPEN_NEXUS_TLS_PUBKEY_HASH` | - | used with `--nexus-url`: verifies the nexus certificate against this certificate's public key sha256 (64-hex) |
| `--auto` | - | off | discovers endpoints on-chain when `--nexus-url` is not given |
| `--chain-id <id>` | `TRUEOPEN_CHAIN_ID` | - | chain ID; required for any command that signs |
| `--prefix <p>` | `TRUEOPEN_ADDR_PREFIX` | `trueopen` | bech32 address prefix |
| `--gas-price <p>` | `TRUEOPEN_GAS_PRICE` | `0.025utrueopen` | gas price (only used for on-chain writes) |
| `--key-file <path>` | - | - | path to the mnemonic file |
| `--json` | - | off | **only affects error output format** (see below) |
| `--verbose` | - | off | also prints the stack trace on error |

### `--nexus-url` vs. `--auto`

Commands that need to reach nexus must pick one of the two, **except `order submit`**:

- `order submit` selects endpoints itself by `task_builder_seed` and sends the order to every
  selected Task Builder; it needs neither `--auto` nor `--nexus-url` (if `--nexus-url` is given
  anyway, it is only a placeholder).
- The other task-level commands (`task` / `output` / `challenge prepare`):
  - given `--nexus-url` -> only that one endpoint is queried;
  - given `--auto` -> fetches **all** ACTIVE builder endpoints on-chain, and tries them one by
    one until one responds.

> **Why try them one by one**: a task only exists on the specific Task Builder(s) that received
> that order. Selection is determined by `task_builder_seed`, and the seed depends on the
> `session_anchor_block_hash` signed into the order -- when querying status you only have
> `(session, task)` on hand, with no way to recover the anchor and work out who to ask.
> If you already know the specific endpoint, `--nexus-url` is faster.

### nexus TLS verification

Per ADR-0015 (nexus self-terminated TLS and public key pinning, in TrueOpen/monorepo), a Builder's nexus terminates TLS itself with a **self-signed** certificate, and its public key sha256 is registered on-chain alongside the descriptor. The client trusts only that public key, not the issuing authority.

- **`--auto` (on-chain discovery)**: the fingerprint is read from the descriptor; `https`
  endpoints are automatically checked against it, and a mismatch disconnects before a single
  request byte is sent. If the descriptor has no registered fingerprint, the transitional policy
  applies: it falls back to `http` with a WARN only if the peer offers no TLS at all; an
  untrusted certificate does **not** get downgraded. Set `NEXUS_TLS_PUBKEY_HASH_REQUIRED=1` to
  reject in all such cases instead.
- **`--nexus-url` (manually specified)**: there is no on-chain descriptor to look up, so you must
  supply the fingerprint yourself. **An `https` endpoint should also be given
  `--nexus-tls-pubkey-hash`** -- the certificate is self-signed, so without a fingerprint the
  only fallback is standard CA chain validation, which is guaranteed to fail.

```bash
# manually specified + pinned fingerprint (recommended)
trueopen --rest-url $REST --nexus-url https://nexus.example:8080 \
      --nexus-tls-pubkey-hash 3f2a...(64-hex) task status <session> <task>

# retrieve the fingerprint (to verify against a known peer certificate)
openssl s_client -connect nexus.example:8080 </dev/null 2>/dev/null \
  | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256
```

---

## Key handling

The mnemonic is read from **only** two places, and **never** accepted as a plaintext
command-line argument (the command line ends up in shell history and the process list):

1. `--key-file <path>` -- the file's contents (trimmed automatically)
2. the `TRUEOPEN_MNEMONIC` environment variable

Recommended:

```bash
umask 077 && printf '%s' "word1 word2 ... word24" > /tmp/trueopen-key.txt
# delete right after use
rm -f /tmp/trueopen-key.txt
```

Commands that need no key: `builders`, `session get`, `task status`.

---

## Output and exit codes

- **A successful result is always JSON** (with or without `--json`): `bigint` -> decimal string,
  `Uint8Array` -> hex.
- `--json` **only changes the error format**:
  - without `--json`: stderr prints `Error: [CODE] message`, with `Suggestion: ...` appended
    when there is one
  - with `--json`: stderr prints `{"error":{"message":...,"code":...,"family":...}}`
- Exit code is `1` on error, `0` on success.
- `task watch` streams: it prints **one line of JSON per line**, and exits cleanly on `Ctrl-C`.

---

## Command overview (with required configuration)

| Command | key | REST | RPC | chain-id | nexus | cost |
|---|:--:|:--:|:--:|:--:|:--:|---|
| `address` | v | | | | | none |
| `builders` | | v | | | | none |
| `session create [label]` | v | v | v | v | | gas |
| `session get <id>` | | v | | | | none |
| `order submit ...` | v | v | | v | auto-selected | freezes max_fee[^1] |
| `order cancel ...` | v | v | v | v | | gas |
| `task status <s> <t>` | | v | | | v | none |
| `task watch <s> <t>` | v | v | | v | v | none |
| `output ref <s> <t>` | v | v | | v | v | none |
| `output get <s> <t> <task-hash> <output-hash>` | v | v | | v | v | none |
| `output stream <s> <t> <task-hash> <worker-pubkey>` | v | v | | v | v | none |
| `challenge prepare <s> <t> <kind>` | v | v | | v | v | none |
| `challenge submit ...` | v | v | v | v | | locks bond |

[^1]: `order submit` itself does not write to the chain; it only hands a signed order to nexus.
Funds are frozen per `max_fee` once the Task Builder submits an Assign on-chain.

---

## Command reference

### `trueopen address`

Mnemonic -> bech32 address + 33-byte compressed public key. Purely local, no network access.

```bash
trueopen address --key-file /tmp/trueopen-key.txt --prefix trueopen
```
```json
{ "address": "trueopen1qp5c...9epg", "pubKey": "0260ee1ad6...8ad4" }
```

---

### `trueopen builders`

Reads the on-chain builder set and each member's service descriptor, and lists available nexus
endpoints. The first thing to run when troubleshooting.

```bash
trueopen builders --rest-url http://<rest-host>:1317
```

Returns `builderSet` (term, members, `setHash`), `endpoints` (address + `serviceEndpoint`), and
`errors` (which builder's descriptor could not be fetched, and why).

---

### `trueopen session create [label]`

Creates a session on-chain, **spends gas**. `label` is a local note only.

```bash
trueopen session create my-label \
  --key-file /tmp/trueopen-key.txt \
  --rest-url http://<rest-host>:1317 \
  --rpc-url  http://<rpc-host>:26657 \
  --chain-id trueopen-localnet-1
```
```json
{ "sessionId": "1a50a587...2e3f", "owner": "trueopen1qp5c...", "nextExpectedSequence": "0", "status": "ACTIVE", "label": "my-label" }
```

> `session_id` is derived deterministically from `(owner, nonce)`. If the chain is reset and the
> nonce goes back to zero, the same `session_id` and `task_id` reappear -- but nexus's object
> store does not reset with the chain, so resubmitting collides with `NEXUS_DATA_CONFLICT`. Use
> an unused `--seq` or create a new session instead.

### `trueopen session get <sessionId>`

Read-only query of session state.

```bash
trueopen session get 1a50a587...2e3f --rest-url http://<rest-host>:1317
```

---

### `trueopen order submit`

Places an order via contract §3.1's **OpenTask**: reads on-chain context -> builds the frozen
`TaskOrderV2` -> three-layer signing -> selects Task Builders by `task_builder_seed` -> streams
the submission to every selected endpoint, succeeding as soon as one accepts.

| Parameter | Required | Description |
|---|:--:|---|
| `--order-file <f>` | v | TaskOrder JSON, see the [next section](#order-file-format) |
| `--session <id>` | v | session id (canonical lowercase 64-hex) |
| `--seq <n>` | | `order_sequence`. Defaults to reading `StreamState.next_expected_sequence` on-chain -- that is the only authority, and a new session's first order is `0`. Pass it explicitly only to resend under the same sequence (RBF) |
| `--payload-file <f>` | v | the plaintext input body; `input_hash` / `input_size_bytes` / `payload_ref` are derived from it |
| `--idempotency-key <k>` | | the contract §3.1 idempotency key, defaults to `<session>:<seq>` |

```bash
trueopen order submit \
  --order-file   ./order.json \
  --session      1a50a587...2e3f \
  --payload-file ./input.bin \
  --key-file     /tmp/trueopen-key.txt \
  --rest-url http://<rest-host>:1317 \
  --chain-id trueopen-localnet-1
```

Returns:

```json
{
  "accepted": true,
  "taskId": "61ae9b89...4dd0",
  "taskHash": "1ca9cb7d...07be",
  "endpointsTried": 3,
  "reason": "",
  "inputMetadata": { "objectExists": true, "sizeBytes": "21", "retainUntilHeight": "69509", "...": "..." },
  "context": {
    "sessionAnchorHeight": "19659",
    "sessionAnchorBlockHash": "d37ee43c...5f10",
    "builderSetId": "1",
    "builderSetHash": "33530796...706a",
    "referenceBucketVersion": "1",
    "timeoutBucketVersion": "1",
    "latestHeight": "19661"
  }
}
```

- `taskHash` is the **content identity**: it changes if a single bit of the order changes.
- `taskId` is the **slot identity**: determined by `(session_id, order_sequence)`, shared across
  multiple price-revision versions of the same slot.
- `context` is the on-chain context actually signed into this order; check it first when
  troubleshooting.
- **`accepted` only means local acceptance by nexus**, not that it is on-chain; whether the task
  has actually entered the on-chain lifecycle is determined by whether `task status` has moved
  out of `PENDING`.

> **Idempotency key**: the same key with the same `input_hash` returns the same result; the same
> key with a different `input_hash` is rejected. It must stay unchanged when retrying the same
> order.

### `trueopen order cancel`

Cancels an order, **spends gas**.

```bash
trueopen order cancel --session 1a50a587...2e3f --seq 1 \
  --key-file /tmp/trueopen-key.txt \
  --rest-url ... --rpc-url ... --chain-id trueopen-localnet-1
```

---

### `trueopen task status <session> <task>`

A snapshot of task state (nexus's local FSM). No key required.

```bash
trueopen task status 1a50a587...2e3f 61ae9b89...4dd0 \
  --rest-url http://<rest-host>:1317 --auto
```
```json
{ "state": "PENDING", "stage": "", "setId": "", "taskPhase": "UNSPECIFIED", "updatedAt": "0" }
```

> This is nexus's local view, **not a consensus fact**; the on-chain query / event is the source
> of truth for the final state. `state=PENDING` with `updatedAt=0` means the order was accepted
> but has not progressed yet.

### `trueopen task watch <session> <task> [--from-cursor <c>]`

Subscribes to the task event stream, printing one line of JSON per line, exiting cleanly on `Ctrl-C`.

```bash
trueopen task watch 1a50a587...2e3f 61ae9b89...4dd0 \
  --key-file /tmp/trueopen-key.txt \
  --rest-url ... --chain-id trueopen-localnet-1 --auto
```

---

### `trueopen output ref <session> <task>`

Fetches a retrieval credential and its commitment.

| Parameter | Description |
|---|---|
| `--access-level <l>` | `package` \| `sealed_key` (default `sealed_key`) |
| `--usage <u>` | a usage tag |

### `trueopen output get <session> <task> <task-hash> <output-hash>`

Fetches the full output package (the data plane of contract §3.5/§3.6): `GetTaskDataMetadata`
fetches `size_bytes` / `chunk_lengths` / `output_leaf_count` -> `FetchTaskData` fetches the bytes
-> re-chunks per `chunk_lengths` -> computes the MMR root under `TRUEOPEN_OUTPUT_MMR_V1` and
compares it to `<output-hash>`. Outputs
`{endpoint, builderAddress, sizeBytes, mediaType, outputHash, chunkCount, text}`.

`<task-hash>` is the on-chain `accepted_task_hash`, and `<output-hash>` is the on-chain
`InferReceipt.output_hash` (an MMR root as of ADR-0017). The latter is both the verification
target and `TaskDataObjectRefV1.content_hash` -- v0.4.1 retrieval is content-addressed, and
without it the object cannot even be located. Both values only exist on-chain; the CLI never
guesses them.

**`--auto` is required**: nexus compares the `builder_operator_address` in the request against
its own configuration byte-for-byte, and a manually given `--nexus-url` has no on-chain
descriptor to check, so there is no way to know which Builder that endpoint belongs to (this
produces `CLI_OUTPUT_NEEDS_AUTO`). It queries candidate endpoints one by one until it succeeds --
the object only exists on the Task Builder(s) that received that order.

```bash
trueopen output get 845ae6e6...bf8a 22284f6b...62a7 <task-hash> <output-hash> \
  --key-file /tmp/trueopen-key.txt --rest-url ... --chain-id ... --auto --json
```

### `trueopen output stream <session> <task> <task-hash> <worker-pubkey> [--no-ack]`

Streams output via subscription (contract §3.5, ADR-0017), verifying each frame locally as it
arrives: the locally computed root over the first `seq+1` leaves must equal the frame's
`mmr_root`, and the Worker service key's signature over
`TRUEOPEN_OUTPUT_CHUNK_V1(chain_id, task_hash, seq, mmr_root)` must verify. Either failure drops
the current endpoint and resumes from the local checkpoint against the next Builder; duplicate
frames are re-verified and deduplicated, and frames with a sequence gap are not delivered. A
single endpoint switches after 20 seconds idle, up to three rotations. Outputs
`{frameCount, frames, text}`.

`<worker-pubkey>` is the selected Worker's service public key for this Task (33-byte compressed,
hex). It must be supplied by the caller; there is no switch to skip verification -- accepting
output without verifying it discards all of ADR-0017's guarantees.

How to obtain it (both steps are on-chain; usable as soon as `winner_confirm` lands, **no need
to wait for `InferReceipt`**):

```bash
# 1) get winner_worker
curl -s "$REST/TrueOpen/task/v1/task/$TASK_ID" | jq -r .task.active.assignment.winner_worker
# 2) get its service public key (the Worker's participant type is CORTEX)
curl -s "$REST/TrueOpen/hub/v1/current_service_key/PARTICIPANT_TYPE_CORTEX/$WINNER" \
  | jq -r .binding.service_pubkey
```

In code this corresponds to `hub.getCurrentServiceKey(PARTICIPANT_TYPE.CORTEX, winnerWorker)`.

`--no-ack` turns off reporting local delivery progress after receiving (`AckOutput` is only local
progress; it plays no part in settlement, retention, or accountability).

---

### `trueopen challenge prepare <session> <task> <kind>`

Prepares challenge material (read-only, zero cost). `--evidence-file <f>` can attach local
evidence bytes.

### `trueopen challenge submit`

Opens an on-chain challenge, **locks a bond**.

| Parameter | Required |
|---|:--:|
| `--session <id>` `--task <id>` `--settlement <id>` | v |
| `--kind <k>` | v |
| `--evidence <hex>` | v |
| `--bond <amt>` | v |

---

## order-file format

Since `TaskOrderV2` was frozen, the fields have changed materially:

- Fees are **`Amount` (decimal text, atomic units)**, written as strings;
- Enums can be written by name or by numeric value;
- **No longer included**: `reward_bucket` / `profile_resource_tier` / `order_value` /
  `infer_timeout_blocks` -- these are derived by the Keeper, and submitting them gets the order
  rejected;
- **Also not included**: `payload_hash` / `valid_after_height` -- these are derived by the SDK
  from `--payload-file` and the on-chain height;
- `anchor` / `builder_set` / parameter bucket versions are **not in the file**; the SDK reads
  them from the chain on every order and signs them into it.

```json
{
  "modelId": "hf-ad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b",
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
  "earliestSubmitHeight": "19509",
  "orderExpireHeight": "69509",
  "latencyClass": "STANDARD"
}
```

| Field | Values |
|---|---|
| `taskType` | `TEXT_GENERATION` \| `CHAT` \| `EMBEDDING` \| `CLASSIFICATION` \| `IMAGE_GENERATION` \| `MULTIMODAL` |
| `latencyClass` | `ECONOMY` \| `STANDARD` \| `FAST` \| `EXPRESS` |
| `outputBudgetBucket` | must be non-zero |
| `maxOutputTokens` / `maxOutputDurationMs` | required, positive integers |
| `earliestSubmitHeight` / `orderExpireHeight` | must be non-zero, and the former must be less than the latter |

Fee fields that are not given are treated as `"0"`.

`maxOutputTokens` / `maxOutputDurationMs` are **required** (missing values raise an error rather
than falling back to a default): both feed into `GenerationParamsV1` -> `task_hash`, so they are
part of the order's content and the worker must honor them. Silently defaulting them would be
equivalent to signing parameters you never looked at; and when `maxOutputTokens` is too small,
the response gets hard-cut mid-sentence (128 is only enough for roughly 200 Chinese characters),
without you ever knowing what limit you signed.

---

## Full example: placing one order end to end

The following is a full flow that has actually been run against devnet.

```bash
cd trueopen-sdk && npm run build

# 0) prepare the key and the input
umask 077 && printf '%s' "word1 word2 ... word24" > /tmp/trueopen-key.txt
printf 'trueopen cli e2e payload' > /tmp/input.bin

export TRUEOPEN_REST_URL=http://<rest-host>:1317
export TRUEOPEN_RPC_URL=http://<rpc-host>:26657
export TRUEOPEN_CHAIN_ID=trueopen-localnet-1

# 1) confirm identity (zero cost)
node dist/cli.cjs address --key-file /tmp/trueopen-key.txt
# -> { "address": "trueopen1qp5c...9epg", "pubKey": "0260ee..." }

# 2) check the current chain height, used to fill in the order-file's height window
curl -s "$TRUEOPEN_REST_URL/cosmos/base/tendermint/v1beta1/blocks/latest" \
  | grep -o '"height":"[0-9]*"' | head -1
# -> "height":"19509"

# 3) write the order-file (height window uses the value from the previous step)
cat > /tmp/order.json <<'JSON'
{
  "modelId": "hf-ad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b",
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
  "earliestSubmitHeight": "19509",
  "orderExpireHeight": "69509",
  "latencyClass": "STANDARD"
}
JSON

# 4) create a session (on-chain, spends gas)
node dist/cli.cjs session create cli-e2e --key-file /tmp/trueopen-key.txt
# -> { "sessionId": "1a50a587...2e3f", "status": "ACTIVE", ... }

# 5) place the order (OpenTask)
node dist/cli.cjs order submit \
  --order-file   /tmp/order.json \
  --session      1a50a587...2e3f \
  --payload-file /tmp/input.bin \
  --key-file     /tmp/trueopen-key.txt
# -> { "accepted": true, "taskId": "61ae9b89...4dd0", "taskHash": "1ca9cb7d...07be",
#     "endpointsTried": 3, "context": { ... } }

# 6) check status (locates it across candidate endpoints; no key needed)
node dist/cli.cjs task status 1a50a587...2e3f 61ae9b89...4dd0 --auto
# -> { "state": "PENDING", "taskPhase": "UNSPECIFIED", "updatedAt": "0" }

# 7) clean up the key
rm -f /tmp/trueopen-key.txt
```

---

## Common errors

| Error code / message | Cause and fix |
|---|---|
| `CLI_MISSING_KEY` | no mnemonic supplied. Use `--key-file` or `TRUEOPEN_MNEMONIC` (plaintext on the command line is not accepted) |
| `CLI_MISSING_CONFIG` | missing `--rest-url` / `--rpc-url` / `--chain-id`; fill in as prompted |
| `CLI_MISSING_NEXUS` | a task-level command was given neither `--nexus-url` nor `--auto` |
| `CLI_AUTO_NO_ENDPOINT` | `--auto` found no usable endpoint. Run `trueopen builders` first to check on-chain state |
| `CLI_NO_NEXUS_HAS_TASK` | none of the candidate endpoints have this task. Check that `session`/`task` are correct, or the order was never accepted |
| `CLI_WRITE_REQUIRES_RPC` | this command writes to the chain and needs `--rpc-url` and a key |
| `NEXUS_DATA_CONFLICT: object key already committed` | this `(session, seq)` was already submitted before. Use a different `--seq` or create a new session (a chain reset can reproduce an old `session_id`) |
| `NEXUS_DATA_EXPIRED: request height` | the request envelope's expiry window has passed. The SDK defaults to "current height + 10 blocks", and nexus's default cap is 20 blocks; if the chain is producing blocks slowly or the local clock is behind, just retry |
| `SDK_LOCAL_ORDER_SIGNER_REQUIRED` | the inner order signature needs a raw-digest signer. The CLI wires this up automatically, so seeing this is a bug |
| `task not found` (single endpoint) | `--nexus-url` pointed at an endpoint that does not have this task. Use `--auto` to search across endpoints instead |

Suggested troubleshooting order: `trueopen builders` (are the on-chain endpoints healthy) ->
`trueopen session get` (does the session exist) -> `trueopen task status --auto` (which endpoint
has the task).
