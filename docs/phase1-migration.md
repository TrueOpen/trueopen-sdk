# Phase 1 SDK migration

The wire submodule is pinned to PR #49 commit `b30fba8`. This is a breaking,
fresh-genesis contract. Recreate Sessions and checkpoints; do not reuse Phase 0
signed orders or output signatures.

## Order lifetime (wire #49 @ `b30fba8`)

An order's lifetime, `order_expire_height - earliest_submit_height`, must be at most the
Session's frozen `max_order_lifetime_blocks` (1..7200 in V1); admission refuses a longer one.
`getSession` returns the frozen value as `frozenParams.maxOrderLifetimeBlocks` (and
`paramsVersion`); when a node does not return it the SDK checks the protocol ceiling, 7200, and
never substitutes the current parameters. `openTask` anchors the order at the latest height and
keeps the requested lifetime, so a re-signed retry -- including after
`NEXUS_INGRESS_DISPATCH_NOT_READY` past the old expiry -- gets a later expiry. A lifetime outside
the bound is `SDK_LOCAL_ORDER_LIFETIME_INVALID` before anything is signed;
`validateOrderLifetime` and `MAX_ORDER_LIFETIME_BLOCKS_V1` are exported.

## Retrying a sequence after NO_CAPACITY

Within one VRF epoch a same-sequence retry continues the earlier attempts' cursor and skip
count, so once they passed the last Worker of the draw (or `max_skips`) a retry in that epoch
cannot dispatch. The Builder refuses such a retry up front with `NEXUS_INGRESS_NO_CAPACITY` and
`details.dispatchAvailableHeight`, the next epoch's first height. `dispatchRetryHeight(error)`
returns it (and the `NEXUS_INGRESS_DISPATCH_NOT_READY` height); wait until the latest height
reaches it and call `openTask` again with the same `orderSequence`, which re-signs the order in
the new epoch with an expiry covering it. `openTaskWithRecovery` does this itself when no other
Builder is left to route to, waiting for the earliest height any Builder named. The first failure of an accepted order arrives as the task event
`NO_CAPACITY`, which carries no height; the height comes with the refusal of the retry.

## Builder service-key rotation

A Builder with a pending service-key rotation refuses new orders, same-sequence retries,
takeovers and new Sessions with `NEXUS_INGRESS_BUILDER_KEY_ROTATING` and
`serviceKeyRotationEffectiveHeight` (its activation height). `openTaskWithRecovery` routes the
order to the next Builder as for `NO_CAPACITY`, skips every rotating Builder, and when all are
rotating waits for the earliest activation height and re-signs. Existing orders keep their
Builder. `getSession` also returns `closedHeight` for a CLOSED Session.

## Session funding and keys

```ts
const session = await client.createSession({
  label: 'chat',
  initialBuilder: builderAddress, // the Builder's address (trueopen1...), required by the chain
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

Register a session key in the same `MsgCreateSession` with
`createSession({ ..., sessionKey: { expiryBlocks, spendCap, key? } })`, load a
persisted one with `useSessionKey(sessionId, privateKey)`, and change it with
`updateSessionKey(sessionId, { renew } | { rotate } | { clear: true })`. The key
is a nonzero raw20 EVM address distinct from the owner. A zero spend cap means
unlimited; cumulative spent is never reset. Restrictive changes are delayed: the
result then carries `effectiveHeight`, and `rotate` keeps the old key loaded and
returns the new one as `newKey`; load it with `useSessionKey` once the chain
applied it.

A loaded registered key signs the session's orders (the Phase 1
`delegatedOrderSigner` option is removed). `openTask` checks it against the
effective chain key, expiry, registration height and cumulative cap before
signing. The Builder remains authoritative for concurrent inflight reservations.

## Dispatch and recovery

`openTask` reads the current BuilderSet and sends to the Session-bound Builder.
The group is the full immutable snapshot in cyclic order from the dispatcher;
there is no seed/rank draw, three-Builder fan-out or selection beacon dependency.
`sessionAnchorHeight` remains signed (the latest height); `sessionAnchorBlockHash` is retired.
`TaskOrderContextCache`, `orderContextReuse`, `DEFAULT_ANCHOR_LAG` and
`HubReader.getAnchorFreshnessWindowBlocks()` are removed: each order resolves a fresh context.
`prewarmTaskBuilders` / `resolveTaskBuilders` give the bound Builder.

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

## Issue #21: attempt replacement and admission hints

When `NEXUS_INGRESS_ATTEMPT_STALE` terminates a subscription, the SDK stops using
its old cursor/checkpoint. It subscribes without a cursor to discover the replacement
`DispatchResultHeaderV1`, checks its task/session/Worker identity, and compares its
accepted ticket with chain-derived anchors. It then persists an empty replacement
checkpoint, emits `{ kind: 'reset', previousDispatchTicketHash, dispatchTicketHash }`,
and resubscribes **with the new ticket and no cursor**. Consumers must clear old text
on `reset`. The derived views (`deriveAssistantStream` / `streamAssistantMessage` and
`assistantTurn`) yield `{ kind: 'reset' }` and parse the replacement attempt from scratch. Subsequent reconnects carry only the cursor verified under that ticket.
Both low-level subscription methods reject a cursor without a raw32 ticket.

Before chain recording, an application can supply `resolveDispatchResult(header)`
to authenticate the optimistic header using its own proof verifier and return
`OutputTrustAnchors`. This callback must return an independently trusted ticket,
task hash, Worker identity and service key; copying unverified header fields is
not verification. Missing/mismatched headers or anchors never reset trust silently.

`openTaskWithRecovery` now consumes typed OpenTask error details. A recorded-task
redirect queries that task at the supplied Builder binding without resubmitting,
even if the Session reader lags. A pending-takeover hint enforces its activation
height before contacting the candidate; it does not authorize a third candidate.
Chain facts remain authoritative and all waits use bounded budgets.

`waitForOutputTrustAnchors(taskId, { sessionId, ...options })` combines polling with Builder
events. Only `DISPATCH_RECORDED` accelerates the admission read; retired
`ASSIGN_ACCEPTED`/`ASSIGNMENT_FINALIZED` and provisional `DISPATCH_ACCEPTED` do not.
The event itself never establishes admission. Event transport failure falls back
to polling, and success, timeout or cancellation aborts the event subscription.
Use `streamOutput({ ..., admissionWait: { timeoutMs: 30000, pollIntervalMs: 1000 } })`
(the same as `waitForAnchors` with the stream's `sessionId`) to enable this wait while
deriving the initial anchors. Explicit anchors retain
the immediate subscription path.
