# Phase 1 SDK migration

The wire submodule is pinned to PR #49 commit `495ea3e`. This is a breaking,
fresh-genesis contract. Recreate Sessions and checkpoints; do not reuse Phase 0
signed orders or output signatures.

## Session funding and keys

```ts
const session = await client.createSession('chat', {
  initialBuilder: builderAddress,
  initialDeposit: '1000000', // atomic units of chain business_denom
});
await client.depositSession({ sessionId: session.sessionId, amount: '100000' });
const withdrawal = await client.withdrawSession({ sessionId: session.sessionId, amount: '1000' });
// withdrawal.effectiveHeight is registration timing, not proof that money has moved.
const state = await client.getSession(session.sessionId);
```

`getSession` refreshes chain state, including balance, frozen funds, pending
withdrawal/close, effective Session key, pending key change and takeover.
`closeSession` registers delayed CLOSE. Owner-signed chain transactions fund,
withdraw and change keys. Off-chain request grants remain distinct from a
registered delegated order key.

Use `updateSessionKey({ sessionId, set: { sessionKey, expiryHeight, spendCap } })`
or `{ sessionId, clear: true }`. The key is a nonzero raw20 EVM address distinct
from the owner. A zero spend cap means unlimited. Inspect effective heights:
restrictive changes are delayed and cumulative spent is never reset.

An order may explicitly supply `delegatedOrderSigner: { signer, address }`.
The facade checks it against the effective chain key, expiry, registration height
and cumulative cap, then verifies the recovered order signature against that key.
The Builder remains authoritative for concurrent inflight reservations.

## Dispatch and recovery

`openTask` reads the current BuilderSet and sends to the Session-bound Builder.
The group is the full immutable snapshot in cyclic order from the dispatcher;
there is no seed/rank draw, three-Builder fan-out or selection beacon dependency.
`sessionAnchorHeight` remains signed; `sessionAnchorBlockHash` is retired.

```ts
const result = await client.openTaskWithRecovery(params, {
  maxAttempts: 5,
  maxPolls: 30,
  pollIntervalMs: 1000,
  signal: abortController.signal,
});
```

Each network attempt has a 30-second acknowledgement timeout, configurable with
`params.ackTimeoutMs`. Recovery queries chain sequence and binding before retrying.
It does not submit a consumed sequence, waits while takeover is pending, refreshes
stale/future orders or replaced snapshots, and uses sequential candidates after
transport timeout or NO_CAPACITY. Invalid signatures and TLS pin rejection do not
trigger automatic takeover. Expired orders require a new valid intent at the
unconsumed sequence. No background queue or automatic fee replacement is created.

`status` and `dispatchResult` preserve the typed Builder response. They are
provisional observations, not verified dispatch proofs or chain admission.
A consumed sequence is resolved with QueryTask; cancellation does not become a
successful dispatch. `CancelOrder.cancelEffectiveHeight` records delayed timing;
registration does not advance the local sequence.

## Output and trust

Chunk and Fin signatures and checkpoints bind `dispatch_ticket_hash`. The facade
loads it from the chain assignment or accepts an explicitly trusted
`dispatchTicketHash` alongside `taskHash` and `workerServicePubKey`. Missing tickets,
mixed attempts and mismatched checkpoints are refused. Reconnect uses signed
`ResumeOutput`, including the cursor and ticket; `GetDispatchRoster` is also exposed
on `client.ingress` with its own request digest.

For `confirmOutput`, supply the authoritative ticket read from QueryTask as
`dispatchTicketHash`, plus the on-chain receipt and checkpoint. Matching output
bytes alone cannot confirm another attempt. Confirmation of a receipt is distinct
from economic settlement.

Hub reads expose the current and paired previous service-key fields. Current-key
lookup is for live identity. The SDK does not automatically trust a previous or
pending key for optimistic output, nor authenticate raw dispatchResult/roster
proofs. For an historical stream, provide a key verified against the accepted
signed nonce and its admissibility window. Never infer it from a Builder's unsigned
response. Shared dispatch proof verification remains owned by wire's `dispatch/`.

## Validation scope

Tests exercise official wire hash vectors, signed protocol simulations, local
HTTP/TLS transports, funding message codecs, delegated signing and bounded recovery.
Synthetic Phase 1 output signatures reuse captured text/MMR roots; they are clearly
labelled and are not a running Phase 1 Worker capture. Real funded localnet validation
requires matching Node/Nexus/Cortex deployments and is a separate release check.
