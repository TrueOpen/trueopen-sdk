# Manual test examples

Runnable scripts that call `TrueOpenClient` like a real consumer, against a real devnet. Scripts import from `../dist`.

## Prerequisites

```bash
npm run build          # build first; the examples import dist/index.js
```

Node >= 18 (uses global `fetch`). All configuration is via environment variables.

## Environment variables

| Variable | Purpose | Example |
|---|---|---|
| `TRUEOPEN_REST_URL` | node gRPC-gateway REST | `http://<rest-host>:1317` |
| `TRUEOPEN_RPC_URL` | node CometBFT RPC | `http://<rpc-host>:26657` |
| `TRUEOPEN_NEXUS_URL` | nexus IngressAPI (http) | `http://<nexus-host>:8080` |
| `TRUEOPEN_CHAIN_ID` | chain ID | `trueopen-localnet-1` |
| `TRUEOPEN_ADDR_PREFIX` | bech32 prefix (default `trueopen`) | `trueopen` |
| `TRUEOPEN_MNEMONIC` | mnemonic of a funded test account | `"flee cover ..."` |
| `TRUEOPEN_GAS_PRICE` | gas price (default `0.025utrueopen`) | `0.025utrueopen` |
| `TRUEOPEN_SESSION_ID` / `TRUEOPEN_TASK_ID` / `TRUEOPEN_QUERY_ADDR` | used for queries / placing orders / retrieval | - |

## Scripts

### 1. read.mjs -- read-only (zero cost) ✅
Reads the chain and discovers the nexus endpoint on-chain (builders -> serviceDescriptor -> fetch the document, verify its hash -> service_endpoint).
```bash
TRUEOPEN_REST_URL=http://<rest-host>:1317 \
TRUEOPEN_QUERY_ADDR=trueopen1qp5c4zkm4q4efuqrwjaww8n5yvrht7fdvnp2mq \
node examples/read.mjs
```

### 2. create-session.mjs -- create a session (spends gas, on-chain) ✅
```bash
TRUEOPEN_RPC_URL=http://<rpc-host>:26657 TRUEOPEN_REST_URL=http://<rest-host>:1317 \
TRUEOPEN_MNEMONIC="..." node examples/create-session.mjs
```

### 3. open-task.mjs -- place an order (OpenTask: three-layer signing + streaming submission)
```bash
TRUEOPEN_RPC_URL=... TRUEOPEN_REST_URL=... TRUEOPEN_CHAIN_ID=trueopen-localnet-1 \
TRUEOPEN_MNEMONIC="..." TRUEOPEN_SESSION_ID=<session id> TRUEOPEN_ORDER_SEQUENCE=1 \
node examples/open-task.mjs
```
The order entry point has moved from the deprecated SubmitOrder to **OpenTask**; the order body itself is
the frozen `SignedOrderV1`. The old canonical JSON envelope cannot produce the canonical `task_hash`, so it
**can never be broadcast on-chain**.

Three differences from the old example:
- Requires `orderSigner` -- the inner `SignedOrderV1.user_signature` **signs the raw 32-byte task_hash
  directly**, so it cannot use an ordinary signer that first does a sha256 hash (node uses
  `VerifyStrictSecp256k1Digest`);
- Requires `hub` + `ingressTransportFactory` -- the Task Builders are uniquely determined by the anchor
  signed into the order, so the SDK must read the on-chain context and pick an endpoint by
  `task_builder_seed` (no `TRUEOPEN_NEXUS_URL` needed);
- The order no longer carries `reward_bucket` / `profile_resource_tier` / `order_value` /
  `infer_timeout_blocks` -- these are derived by the Keeper, and submitting them causes rejection; the fee
  field is now `Amount` (decimal text, atomic units).

> ⚠️ ingress returning `accepted` only means it was accepted locally; whether the task actually lands
> on-chain must be checked via `taskStatus` moving out of `PENDING`. Once accepted, the Task Builder may
> submit an Assign on-chain, at which point funds are frozen per `max_fee`.

### 4. fetch-output.mjs -- retrieve the final plaintext output (subscribe -> verify hash -> ACK)
```bash
TRUEOPEN_NEXUS_URL=http://<nexus-host>:8080 TRUEOPEN_CHAIN_ID=trueopen-localnet-1 \
TRUEOPEN_MNEMONIC="..." TRUEOPEN_SESSION_ID=<session id> TRUEOPEN_TASK_ID=<task id> \
node examples/fetch-output.mjs
```
> Requires a task that has already completed and produced output; `SubscribeOutput` will hang until the
> output arrives.

## Notes
- Purely local (no backend) facade logic is covered in `test/unit/*.test.ts` and
  `test/integration/smoke.test.ts` (a fake backend runs the full journey).
- Assertion-style live-chain verification is in `test/integration/chain.integration.test.ts`
  (env-gated).
