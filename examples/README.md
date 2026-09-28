# Examples

Runnable scripts that use `TrueOpenClient` the way an application does, against a real chain and
nexus. They import from `../dist`.

## Prerequisites

```bash
npm run build                 # the examples import dist/index.js
npm run typecheck:examples    # optional: checks them against the built types
```

Node >= 18 (uses global `fetch`). All configuration is via environment variables.

## Environment variables

| Variable | Purpose | Example |
|---|---|---|
| `TRUEOPEN_REST_URL` | node gRPC-gateway REST | `http://<rest-host>:1317` |
| `TRUEOPEN_RPC_URL` | node CometBFT RPC (only for chain writes) | `http://<rpc-host>:26657` |
| `TRUEOPEN_CHAIN_ID` | Cosmos chain ID | `trueopen-localnet-1` |
| `TRUEOPEN_MNEMONIC` | mnemonic of a funded test account | `"flee cover ..."` |
| `TRUEOPEN_ADDR_PREFIX` | bech32 prefix (default `trueopen`) | `trueopen` |
| `TRUEOPEN_ALLOW_INSECURE_HTTP` | `1` allows plain `http://` / `grpc://` nexus endpoints. **Localnet only.** | `1` |
| `TRUEOPEN_FEE_AMOUNT` / `TRUEOPEN_GAS` | tx fee amount and gas for chain writes (defaults `7500` / `300000`) | - |
| `TRUEOPEN_MODEL_ID` | raw Hash32 model ID, 64-hex (open-task) | - |
| `TRUEOPEN_SESSION_ID` / `TRUEOPEN_TASK_ID` | the session and task to use | - |

Nothing chain-specific is hard-coded: the EVM chain ID and the fee denom (`business_denom`, used
for the order signature and for tx fees) are read from `params.phase0` on chain.

nexus endpoints come from the Builders' on-chain descriptors. An https endpoint is checked against
the certificate fingerprint registered on chain and is never downgraded to http. A localnet whose
endpoints are plain http needs `TRUEOPEN_ALLOW_INSECURE_HTTP=1`.

## The flow

```bash
export TRUEOPEN_REST_URL=http://<rest-host>:1317 TRUEOPEN_RPC_URL=http://<rpc-host>:26657
export TRUEOPEN_CHAIN_ID=trueopen-localnet-1 TRUEOPEN_MNEMONIC="..."
export TRUEOPEN_ALLOW_INSECURE_HTTP=1   # localnet only

node examples/read.mjs            # 0. read-only: chain params and nexus endpoints
node examples/create-session.mjs  # 1. create a session (gas); prints TRUEOPEN_SESSION_ID
TRUEOPEN_MODEL_ID=<64hex> node examples/open-task.mjs   # 2. place an order; prints TRUEOPEN_TASK_ID
node examples/fetch-output.mjs    # 3. wait for the receipt, fetch and verify the output
```

### read.mjs -- read-only, costs nothing
Prints the chain's EVM chain ID and business denom, the nexus endpoint of each active Builder, and,
when set, the session, task and infer receipt.

### create-session.mjs -- spends gas
Broadcasts `MsgCreateSession` with an explicit fee in the chain business denom. A new session's
first order sequence is 0.

### open-task.mjs -- places an order
Reads the next order sequence from chain (0 for a new session), builds and signs the order, and
sends it to every Task Builder selected by `task_builder_seed`. Before signing, the SDK checks the
order against the chain's generation limits and the model profile's pricing, and refuses one the
chain would reject. It prints each selected Builder's outcome.

> An `accepted` ack is local acceptance by nexus. The chain decides whether the task exists; once
> it is assigned, funds up to `max_fee` are frozen.

### fetch-output.mjs -- fetches and verifies the output
Reads the trust anchors from chain (`resolveOutputTrustAnchors`): the accepted task hash, the
winner Worker's service key and the accepted infer receipt. It waits while the receipt is not
there yet, then fetches the output from the Builders with `fetchTaskOutput`, which checks the MMR
root, size and leaf count against the receipt.

## Notes
- Local facade logic is covered by `test/unit/*.test.ts`, and `test/integration/smoke.test.ts`
  runs the whole journey against a fake backend.
- Assertion-style checks against a live chain are in `test/integration/chain.integration.test.ts`
  (skipped unless its environment variables are set).

### manifest-proxy.mjs -- same-origin manifest proxy for browser apps
A server-side endpoint, `GET /manifest-proxy?url=<manifest_uri>`, for the recommended browser
deployment. It accepts only a valid https `manifest_uri` and fetches it with
`createNodeManifestFetcher()`, which applies the address policy, the pinned connection, TLS,
redirect and timeout limits, and the 4 MiB cap. It returns the bytes unchanged. The browser
`ManifestSource` still verifies the hash and canonical bytes.
```bash
npm run build && PORT=8787 node examples/manifest-proxy.mjs
```
