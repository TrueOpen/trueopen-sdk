# Tool Call Support in the SDK (Design)

> Version: v0.3 / 2026-09-26 (v0.1 2026-09-23). v0.2 corrected S9, which misstated who owns
> the V3 manifest vectors, and refreshed S12.1 and S12.4, which predated wire v0.2.1. v0.3
> records P1 as delivered and adds S10.1: the standing decision to wait for the undefined
> encodings rather than invent them, with the change list for when each blocker clears.
> Scope: **How the TypeScript SDK turns committed output text into an OpenAI-compatible
> `content` + `tool_calls` view** -- module layout, public API, the execution gate,
> failure semantics, and what is blocked upstream.
> Upstream reference: ADR-0022 v1.4 (`monorepo#6`), Manifest S7, verification algorithm S8.
> This document maps that decision to an implementation; it does not redefine it.
> Hard rule (ADR-0022 decision five): **parsing results never enter the protocol.** They
> are not committed, not in the receipt, not in evidence, not on chain.

---

## 0. Reading Map

| What you want to know | Where to look |
|---|---|
| Why parsing happens in the SDK at all | S1 Why Here |
| Where the code goes | S2 Module Layout |
| The types an application sees | S3 Core Types |
| Why provisional and confirmed tool calls are different event types | **S4 The Execution Gate** |
| The public API | S5 Public API |
| What happens when parsing fails or is not possible | S6 Failure Semantics |
| How a tool call split across frames is handled | S7 Streaming State Machine |
| How the parser is chosen and trusted | S8 Manifest Verification |
| What cannot be built yet | **S9 Upstream Blocker** |
| Order of work, and what is delivered | S10 Phasing |
| Why we are waiting, and what changes when each blocker clears | **S10.1 Deliberately waiting** |
| How this gets tested | S11 Testing |
| Where `tools[]` goes, who renders the chat template | **S12 The Input Side** |
| What the producer emits right now, and where it diverges | **S13 What Actually Arrives Today** |

---

## 1. Why Here

A model cannot emit the OpenAI `tool_calls` structure. It emits text carrying
model-specific markers:

```text
<tool_call>
{"name": "get_weather", "arguments": {"city": "London"}}
</tool_call>
```

Something has to turn that into `{name, arguments}`. In an ordinary deployment the
inference engine's HTTP layer does it. In TrueOpen it cannot, and the reason is not
architectural tidiness:

**The agent reads text but executes tool calls.** The protocol commits the text --
`output_hash`, the output MMR, the Verifier's prefill check all cover exactly those
bytes. If `tool_calls` came from anywhere else, the only part with side effects would be
the only part nobody verified. ADR-0022 records the concrete attack that follows.

So the parse must run **on bytes that are already committed and already verified**. That
places it after signature verification and MMR reconciliation, which is to say: in the
SDK.

---

## 2. Module Layout

The guiding constraint is ADR-0022 decision five. Protocol work and derived-view work
must be separable in the file tree, not merely by convention, so that a parser defect
cannot reach the verification path.

**`streamOutput()` and `fetchTaskOutput()` keep their current contracts.** They continue
to yield verified `{seq, text, mmrRoot}`. Tool calling is a layer wrapped around them.

```text
src/manifest/          (new)
  fetch.ts             retrieve the full manifest from pointer / indexer
  canonical.ts         S2.6 canonical encoding + TRUEOPEN_MODEL_MANIFEST_V3 hash
  validate.ts          rule 11 (reject unknown fields) + S7 block validation
  types.ts             ManifestV3 / OutputDecoding / ToolCalling

src/toolcall/          (new)
  registry.ts          (name, version) -> parser
  types.ts             ToolCallParser, DerivedAssistantMessage, stream events
  stream-state.ts      incremental state machine
  parsers/
    hermes.ts          <tool_call>...</tool_call>
    mistral.ts         [TOOL_CALLS][...]
    llama3-json.ts

src/client.ts          extended with derived-view methods; existing methods untouched
```

`src/toolcall/` must not depend on `src/manifest/`. The parser takes a
`ToolCallParser`; where that parser came from is the caller's problem. This keeps S10's
phase 1 unblocked by S9.

---

## 3. Core Types

```ts
/** ADR-0022's "derived assistant message". A view, never a commitment. */
export interface DerivedAssistantMessage {
  readonly role: 'assistant';
  readonly content: string;
  readonly toolCalls: readonly DerivedToolCall[];
}

/**
 * Only what the model's own bytes determine. `id` / `type` / `index` are synthesized by
 * the Provider and are deliberately absent here -- they carry no model information, and
 * putting them on this type would invite treating them as part of the parse.
 */
export interface DerivedToolCall {
  readonly name: string;
  /**
   * The argument JSON exactly as the model wrote it. Not re-serialized: round-tripping
   * through JSON.parse/stringify reorders keys and changes bytes, and these bytes are
   * what a cross-language shared vector pins.
   */
  readonly arguments: string;
}

export interface ToolCallParser {
  readonly name: string;      // matches vLLM --tool-call-parser
  readonly version: string;   // version of the behaviour spec, not of the engine
  parseComplete(text: string): DerivedAssistantMessage;
  createStreamState(): ToolCallStreamState;
}
```

---

## 4. The Execution Gate

ADR-0022 decision three: before the receipt is accepted and `output_hash` reconciles,
a parsed tool call may only be delivered through a channel that **does not trigger
execution**; the standard delta comes after.

### 4.1 The SDK already has this shape -- reuse it

The two-stage model is not new work. `streamOutput()` verifies frames locally and hands
back an `OutputStreamVerifierCheckpoint`; a **separate**, caller-driven
`confirmOutput({taskId, taskHash, checkpoint, receipt})` upgrades that to a
`ConfirmedOutputEvent` using the on-chain `InferReceipt`. The chain read is the caller's,
deliberately: `streamOutput` performs no hidden chain queries, which is what lets it run
against a Builder while the caller decides when and how to reach the node.

Tool calling must mirror that split rather than invent a second confirmation path. So
there are two entry points, one per stage, and they pair with the existing two exactly:

| Protocol layer | Derived-view layer |
|---|---|
| `streamOutput()` -> verified frames + checkpoint | `streamAssistantMessage()` -> content + provisional calls + checkpoint |
| `confirmOutput(checkpoint, receipt)` -> confirmed | `confirmAssistantMessage(checkpoint, receipt)` -> confirmed calls |

A caller who already knows the `streamOutput` / `confirmOutput` pair knows this one.

### 4.2 Provisional and confirmed are different types, not a flag

```ts
export type AssistantStreamEvent =
  | { readonly kind: 'content'; readonly text: string }
  | { readonly kind: 'tool-call-provisional'; readonly call: DerivedToolCall };

/** Only reachable through confirmAssistantMessage, i.e. only after reconciliation. */
export interface ConfirmedAssistantMessage extends DerivedAssistantMessage {
  readonly confirmation: ConfirmedOutputEvent;
}
```

The alternative -- one tool-call type carrying `confirmed: boolean` -- fails in the wrong
direction. A caller who ignores the flag executes an unconfirmed call, and the cost of
forgetting is a side effect that cannot be taken back. Here the confirmed calls are not
merely tagged differently, they are **only reachable through a function that requires a
receipt**. Forgetting to call it yields nothing to execute, which is the safe outcome.
**The safe default belongs in the type system, not in a doc comment.**

Timeline:

```text
frame arrives -> signature + incremental MMR root -> parser state machine
                                                       |- text     -> emit content
                                                       `- closing marker
                                                            -> emit tool-call-provisional
                                                               (MUST NOT be executed)
caller fetches InferReceipt from chain, then:
confirmAssistantMessage(checkpoint, receipt)
   -> confirmOutput reconciles root / leaf count / size
   -> on success: the full tool call list, now executable
   -> on mismatch: throws; equivocation per ADR-0017 decision three
```

Confirmation returns the **full list**, not a delta against the provisional stream: a
caller that buffered provisional calls discards them and acts on the confirmed set alone,
with nothing to correlate.

### 4.3 If the receipt never arrives

Observed in practice on the devnet: a task can sit at `WORKER_ASSIGNED` with the receipt
never committed. In that case `confirmAssistantMessage` is simply never called, and the
provisional calls stay provisional forever.

**There is no timeout that promotes a provisional call**, and there must not be. "The
receipt is taking a long time" and "the bytes were committed" are unrelated facts, and
a timeout would silently convert the first into the second.

### 4.4 Why non-streaming has no provisional stage

`fetchTaskOutput()` takes the on-chain `InferReceipt.output_hash` as a **required input**
and retrieves content-addressed against it. By the time it returns, the bytes have
already been reconciled with the chain commitment, so a parse over them is confirmed by
construction. `fetchAssistantMessage` therefore returns a message directly and never
emits a provisional state.

---

## 5. Public API

```ts
// --- non-streaming: one call, already confirmed (S4.4) ---
async fetchAssistantMessage(
  p: FetchTaskOutputParams & ToolCallParams,
): Promise<DerivedAssistantMessage>;

// --- streaming: stage one, local verification only ---
async *streamAssistantMessage(
  p: StreamOutputParams & ToolCallParams,
): AsyncIterable<AssistantStreamEvent>;

// --- streaming: stage two, mirrors confirmOutput's signature exactly ---
confirmAssistantMessage(
  p: ConfirmOutputParams & ToolCallParams,
): ConfirmedAssistantMessage;

export interface ToolCallParams {
  /** Where the profile manifest comes from; the SDK re-derives its hash (S8). */
  readonly manifestSource: ManifestSource;
  /** Defaults to the built-in registry. Injectable, which is what phase 1 uses. */
  readonly parsers?: ToolCallRegistry;
}
```

`confirmAssistantMessage` is synchronous and takes the same `ConfirmOutputParams`
(`{taskId, taskHash, checkpoint, receipt}`) as `confirmOutput`, for the same reason: the
chain read belongs to the caller. It re-parses from the checkpoint's verified chunks
rather than trusting anything retained from the provisional pass.

All three delegate to the existing `streamOutput` / `fetchTaskOutput` / `confirmOutput`
for transport, signature verification and reconciliation. **No verification logic is
duplicated**; if it were, the two copies would drift and only one would be covered by the
vectors.

### 5.1 Reporting "cannot parse here"

Whether this SDK is entitled to parse at all (S6, rows 2-5) is decided by the manifest,
which is known **before** any frame arrives. So it is not a stream event -- a stream
event carrying "and here is the whole text" would contradict streaming, and the text is
not available yet when the fact becomes known.

Instead it is resolved up front:

```ts
/** Resolve once, before streaming. Callers can cache it per (model, profileVersion). */
async resolveToolCalling(p: ToolCallParams): Promise<ToolCallSupport>;

export type ToolCallSupport =
  | { readonly supported: true;  readonly parser: ToolCallParser }
  | { readonly supported: false; readonly reason: UnsupportedReason };
```

`streamAssistantMessage` calls it internally; when unsupported it degrades to emitting
`content` events only, never synthesizing a tool call. An application that wants to fail
loudly on `manifest-hash-mismatch` calls `resolveToolCalling` itself first.

---

## 6. Failure Semantics

ADR-0022 enumerates five situations. They split by **when they become known**, which is
also what decides how each is reported:

| Situation | Known | Reported as |
|---|---|---|
| Marker never closes, argument JSON invalid | during parse | **plain text**, not an error |
| `tool_calling = {}` (profile pins no parser) | before streaming | `resolveToolCalling` -> `parser-not-pinned` |
| `(name, version)` unknown to this SDK build | before streaming | `resolveToolCalling` -> `parser-unknown` |
| Manifest cannot be retrieved | before streaming | `resolveToolCalling` -> `manifest-unavailable` |
| Re-derived `manifest_hash` disagrees with chain | before streaming | `resolveToolCalling` -> `manifest-hash-mismatch` |

```ts
export type UnsupportedReason =
  | 'parser-not-pinned'
  | 'parser-unknown'
  | 'manifest-unavailable'
  | 'manifest-hash-mismatch';
```

Row one is "the parse did not succeed" -- exactly what happens when calling an engine
directly, so it is not an error and the text flows through unchanged. The other four are
"this SDK is not entitled to parse", a different fact, and they are kept distinct because
callers treat them differently: `manifest-hash-mismatch` means something is wrong and a
deployment may want to refuse to start, while `parser-not-pinned` is an ordinary profile
that simply does not offer tool calling.

**No path guesses a format**, and every path still hands the application the original
text. Enabling tool calling can never lose data.

---

## 7. Streaming State Machine

```text
        +--------------------------------------+
        v                                      |
   +--------+  start marker   +-----------+    | closing marker
   |  Text  |---------------->| Buffering |----+ -> emit one tool call
   +--------+                 +-----------+
        | ordinary bytes            | Fin, still unclosed
        v emit as content           v flush buffer as plain text
```

Two things are easy to get wrong and are therefore stated as requirements:

1. **A marker can straddle a frame boundary** (`<tool_` then `call>`). Matching runs
   against the accumulated buffer, never per frame. Frame boundaries are chosen by the
   Worker and carry no semantics.
2. **Fin with an unclosed buffer flushes as plain text.** It is neither dropped nor an
   error -- a truncated generation (hit `max_output_tokens`) produces exactly this, and it
   is a normal outcome.

The return edge to `Text` is load-bearing: the chat path has no stop conditions (S13.3),
so generation continues past a closing marker. Content can follow a completed tool call,
and one output can contain several.

---

## 8. Manifest Verification

The chain holds only `manifest_hash` and a pointer, so the manifest must be fetched and
re-derived rather than trusted:

```text
chain ProfileState -> manifest_hash            (the only trusted anchor)
        |
fetch full manifest from pointer / indexer
        |
re-encode per S2.6 canonical rules            (field order, empty-value rules,
        |                                      reject unknown fields -- rule 11)
hash with domain TRUEOPEN_MODEL_MANIFEST_V3
        |
compare byte for byte with the chain's manifest_hash
        |                                      mismatch -> unsupported, never a fallback guess
validate output_decoding / tool_calling per S7
        |
read tool_calling.parser {name, version}
```

**The SDK needs no tokenizer and knows nothing about EOS.** Committed output already had
its trailing EOS stripped by the Worker per `output_decoding.strip_trailing_eos`. This is
the largest simplification ADR-0022 hands the SDK and it is worth defending explicitly:
`src/toolcall/` must not acquire a tokenizer dependency. If a future change appears to
require one, that is a signal the decoding rule moved, not that the SDK needs to catch up.

---

## 9. Upstream Blocker

**S8 cannot be validated today.**

The V3 cross-language canonical vectors do not exist yet. `03-models/03` S2.6 states that
its fixture is still generated at `manifest_version: 2` and that the V2 vectors are "for
historical reference only" until wire recomputes them for V3.

The ADR-0022 write-back matrix **does** assign this, to wire. Its row for
`03-models/03` S2.6 and `wire testdata/v1/hub/model_profile_canonical_*.json` reads, in
translation: a change to `manifest_hash` carries a change to `registration_digest`; all
three digests are to be recomputed by wire in one pass for V3, and until that recomputation
the V2 vectors serve only as historical reference.

The matrix opens by requiring its rows to be completed as one batch, at adoption. The ADR
was adopted 2026-09-23. As of wire v0.2.1 the recomputation has not happened:
`testdata/v1/hub/` still holds only `model_profile_canonical_v2.json`, and
`TRUEOPEN_MODEL_MANIFEST_V3` is not yet a row in `registry/v1/domains.json` either, so the
domain this would be computed under does not exist. Tracked in `monorepo#29`.

An earlier revision of this section claimed the matrix "does not list producing the V3
manifest vectors as work for anyone." That was wrong -- it was written without reading the
matrix. The distinction matters in practice: this is not an unowned problem needing an owner,
it is an assigned deliverable that did not ship with its batch.

Under this repository's golden-authority rule, byte-level cross-language agreement is
established against published vectors, never against a self-consistent local
implementation. A TypeScript canonical encoder written now could agree with itself and
still disagree with node's Go encoder, and nothing would reveal it until a profile failed
to resolve in production.

So `src/manifest/` waits. This does not block `src/toolcall/`, which is why S2 forbids a
dependency from the latter to the former.

---

## 10. Phasing

| Phase | Content | Blocked by | Status |
|---|---|---|---|
| **P1** | All of `src/toolcall/`: registry, state machine, event types. Parser supplied by explicit injection rather than read from a manifest. | nothing | **delivered** (`feat/toolcall-p1`) |
| **P2** | `src/manifest/`: fetch, canonical encoding, hash, validation | S9 -- wire must recompute the V3 vectors (`monorepo#29`) | waiting |
| **P3** | Wire them together: `manifestSource` drives the full verification chain; the two manifest `UnsupportedReason` values become reachable | P2 | waiting |
| **P4** | Provider layer: synthesize `id` per `tool_calling.call_id_format`, plus `type` / `index` / `finish_reason` / SSE | ADR's Provider boundary settling | waiting |

**P1 shipped without any concrete parser.** Parser behaviour specs and their shared vectors
belong to wire under ADR-0022 decision four and are unpublished (`monorepo#11`), so a parser
written today would be written twice: the marker syntax is stable, but the edges the vectors
pin -- streaming splits, malformed input -- are exactly what would change. The registry
models this state directly: an entry declares `conformance: 'unverified'` and `lookup`
refuses to report it as supported unless the caller passes `allowUnverified` explicitly.

### 10.1 Deliberately waiting, and what changes when each blocker clears

Standing decision: **do not implement against an undefined encoding.** Build it once the
definition exists, then follow that definition. Nothing here is a gap to be filled by a
locally-invented rule -- under the golden-authority rule (S9), a self-consistent local
implementation is worth nothing, because it can agree with itself and disagree with node's
Go implementation, and nothing reveals that until a task fails in production.

This posture is already what the code does; it costs nothing to hold.

| Blocker | What the SDK does meanwhile | What changes when it lands |
|---|---|---|
| **payload canonical encoding** (`monorepo#30`) | `task-order-input.ts` computes `inputHash: sha256(req.payload)` over a caller-supplied `Uint8Array`. The payload is opaque: never parsed, never re-serialized. | Add a canonical encoder for `ChatInferInput`, modelled on the existing `canonicalOrderEnvelopeJson`. `inputHash` then hashes the canonicalized bytes rather than whatever the caller passed, and the SDK gains a documented rule about which of the several legal serializations it emits. |
| **V3 manifest vectors** (`monorepo#29`) | `src/manifest/` does not exist. S2 forbids `src/toolcall/` from depending on it, which is why P1 was not blocked. | P2 becomes buildable; then P3 wires `manifestSource` through, and `manifest-unavailable` / `manifest-hash-mismatch` turn from declared-but-unreachable into reachable. |
| **`cortex.v1` released** (ADR-0022 owes `chat_input` an `output_decoding` block, a `tool_calling` block, and `manifest_version` 3) | The package is present in wire but withheld, so `buf.gen.yaml` excludes it from the codegen closure and says why. No types are generated from it. | Add `cortex.v1` to the closure and generate. Only then can the SDK construct a typed `ChatInferInput` rather than accepting opaque bytes. |
| **parser vectors** (`monorepo#11`) | No concrete parser ships. The registry can hold one as `'unverified'`, which is the honest state, but nothing is registered. | Write the parsers, run them against the published vectors, and only then flip an entry to `conformance: 'vector-verified'`. |

Two items found while building P1 are prerequisites for P3 specifically, and are recorded
here because nothing else in this document would carry them:

- **The EOS/end-marker collision guard is missing.** `deriveAssistantStream` runs the EOS
  stripper before the marker state machine. If a configured EOS marker overlaps the parser's
  end marker at the seam, the stripper withholds the characters that would have completed
  the end marker and the tool call is silently lost as plain text. In P1 both values are
  caller-supplied, so this is only reachable by deliberate misconfiguration; **in P3 both
  come from the manifest**, so a manifest could pin a colliding pair with nothing objecting.
  The guard must be symmetric -- reject when `endMarker.endsWith(m) || m.endsWith(endMarker)`
  for any EOS marker `m`. A one-sided check (only "EOS is a suffix of the end marker") misses
  the mirror case: with end `</tc>` and EOS `}</tc>`, the call is lost and a `}` eaten as
  well, yet `'</tc>'.endsWith('}</tc>')` is false. Do not reorder the two layers instead:
  running the parser first would feed it the trailing EOS, and S13.2 exists precisely so that
  no parser tolerates one.
- **S5.1's degradation path does not exist.** The design has `streamAssistantMessage` call
  `resolveToolCalling` internally and degrade to emitting `content` only when unsupported.
  P1 takes a non-optional `parser` instead, which is safer here -- the method is unreachable
  without having resolved support first -- but the wiring S5.1 describes still has to be
  written in P3, when the manifest is what resolves it.

---

## 11. Testing

Following this repository's existing practice:

- **Parser behaviour** -- the cross-language shared vectors wire publishes per ADR-0022
  decision four ("raw text -> content / tool_calls, including streaming-split cases").
  Not self-authored. A parser that has not passed the vectors must not claim to support
  that `(name, version)`.
- **Streaming state machine** -- split by byte, by token, and on a marker boundary, each
  as its own case; plus a marker straddling frames, and Fin with an unclosed buffer.
- **The execution gate** -- assert that the stream yields only `tool-call-provisional`,
  that executable calls are reachable solely through `confirmAssistantMessage`, and that
  it throws on a receipt whose root, leaf count or size disagrees with the checkpoint.
  This is a safety property, so the negative cases matter more than the happy path: a
  mismatched receipt, and a task whose receipt never arrives (S4.3) yielding nothing
  executable rather than eventually promoting.
- **Manifest validation** -- hash mismatch, unknown field, and `tool_calling = {}` as
  three distinct rejection paths.

---

## 12. The Input Side

Everything above is the output side: committed output -> `content` + `tool_calls`. A tool
call round trip also needs an input side -- somewhere to declare `tools[]`, and a way to
feed a `{role: "tool"}` result back for the next turn. That side is defined.

### 12.1 `ChatInferInput` (wire, withheld)

`proto/cortex/v1/chat_input.proto`. It is the structured payload a User places in
`InferRequest.input`, and it mirrors the OpenAI Chat Completions request body **field for
field and flat** (checked against openai-python v1.107.3), so an OpenAI-compatible client's
body is a valid `ChatInferInput` as-is.

It lived in `TrueOpen/cortex` (cortex#5) when this document was first written. wire v0.2.1
moved the whole `cortex.v1` package here, for the reason its CHANGELOG gives: two
repositories were reading one schema, and the second copy is the one that drifts --
`ChatInferInput` especially, since the SDK constructs it and Cortex parses it. No field
number, name or type changed in the move.

**It arrives withheld, not released**, so this SDK does not generate types from it yet.
wire's own reason: ADR-0022 is still open and its write-back matrix owes `chat_input`
further changes -- an `output_decoding` block, a `tool_calling` block, and
`manifest_version` 3. Generating types today would pin a shape wire has already announced
it will break. Verified 2026-09-26: those three are zero hits across both wire's and
cortex's `proto/`. `buf.gen.yaml` therefore excludes `cortex.v1` from the codegen closure,
and says why.

Fields are grouped by one question -- does this change what gets committed and verified?

| Group | Fields | Treatment |
|---|---|---|
| Content / intent | `messages`, `tools`, `tool_choice`, `response_format`, `parallel_tool_calls` | free to set |
| Generation params | `temperature`, `top_p`, `max_completion_tokens`, `max_tokens`, `seed`, `presence_penalty`, `frequency_penalty`, `stop` | **rejected** |
| Verification-breaking | `logprobs`, `top_logprobs`, `logit_bias`, `n` | **rejected** |
| Delivery hint | `stream` | transport only |
| Everything else | `model`, `user`, `metadata`, ... | accepted and dropped |

The rejected sampling parameters are exactly the `generation_params_digest` subset. They
are frozen on chain by the order and applied from that chain-bound generation context,
never from the request, so accepting them here would let the request diverge from the
committed parameters. Rejection is fail-closed rather than a silent drop, because
dropping them would answer a different request than the caller sent.

### 12.2 The chat template is not the SDK's concern

Cortex forwards `messages` to vLLM's `/v1/chat/completions` as an opaque
`json.RawMessage`; **vLLM applies the chat template server-side**. Nothing between the
application and the engine renders it.

This settles the one architectural question the output-side design could not answer on
its own, and it settles it the same way ADR-0022 settled decoding: the model-specific
transform stays on the side that holds the model. **The SDK needs neither a tokenizer
(S8) nor a chat-template engine.** Both would have to agree byte-for-byte with Go and
Python implementations, and neither is worth that.

### 12.3 What this means for the phases

`ChatInferInput` is content-addressed bytes as far as this SDK is concerned: the payload
is serialized, hashed into `input_hash`, and never interpreted locally. Supporting it is
a serialization concern, not a parsing one.

Two consequences for S10:

- The phases stay as written. Nothing in P1-P4 depends on the input side.
- But a **complete** tool call round trip needs the SDK to emit `ChatInferInput` with
  `tools[]` and `task_type = TASK_TYPE_CHAT`, which it does not today: `TASK_TYPE` has a
  `CHAT` constant, the live profile declares `TASK_TYPE_CHAT` among its `task_types`, and
  the SDK still sends `TASK_TYPE_TEXT_GENERATION` with an opaque byte payload. Until that
  lands, P1-P4 only cover the case where a model volunteers tool-call markers unprompted.

### 12.4 Open

Still undefined as of 2026-09-26. Both were raised under `monorepo#8`, whose own premise --
that the input side was undefined -- has since largely lapsed: `ChatInferInput` exists, it
now lives in wire (S12.1), and it rejects the sampling parameters that `#8` warned would
otherwise give generation params two sources of truth.

- **Canonical encoding of the payload** (`monorepo#30`). `input_hash = sha256(payload)`
  commits *bytes*, so key order, whitespace, number formatting and string escaping all
  change the hash, and `chat_input.proto` notes that protojson also accepts OpenAI's
  snake_case keys -- one meaning, several byte sequences. `input_hash` is therefore
  currently a function of how a request was serialized rather than of the request. That
  breaks three things: the Verifier cannot establish it is checking the same task, the
  idempotency rule (same key + same `input_hash` returns the same result, same key +
  different `input_hash` is rejected) misfires on a retry that re-serializes, and a
  TypeScript SDK and a Go Cortex serializing "the same" object diverge. Compare
  `canonical_order_envelope_json`, which already solves this shape for the order envelope.
- **How the Verifier reproduces the prompt** (`monorepo#8`). Prefill verification needs the
  same prompt tokens, and the template is applied inside vLLM. Downstream of the item
  above: even with the bytes pinned, what the Verifier compares against is still unsettled.
  A cortex/Verifier question, not an SDK one.

---

## 13. What Actually Arrives Today

Everything above describes the target. This section records what the producer emits right
now, because two of those facts change what P1 has to write. Checked against
`TrueOpen/cortex@5807069` on 2026-09-23; re-check before relying on it.

### 13.1 Raw text, no structure

From cortex's own `local_chat.go` header:

> Output is **NOT** the engine's detokenized `message.content`, **nor a ChatCompletion
> JSON envelope**: the delivered output, the streamed chunk text, `trace.Output` and
> `checkpoint.Output` are all the RAW TEXT decoded from the committed token_ids.
> **tool_calls are therefore not parsed out separately; any tool-call syntax the model
> emitted is just tokens in that raw text.**

So a frame carries exactly what the model wrote:

```json
{"seq":0,"text":"<tool_call>\n{\"name\": \"get_weather\",","mmr_root":"…","worker_signature":"…"}
{"seq":1,"text":" \"arguments\": {\"city\": \"London\"}}\n</tool_call>","mmr_root":"…","worker_signature":"…"}
```

This is the premise the whole design rests on, and it holds.

### 13.2 The committed text still carries a trailing EOS

cortex concatenates every token's bytes "**including the trailing EOS special token,
which the engine drops from message.content**".

ADR-0022 v1.4 says the opposite: `output_decoding.strip_trailing_eos` is fixed `true`, and
committed output is `decode(T)` with the trailing `eos_token_ids` removed.

**cortex will strip it; that change has simply not landed yet** (confirmed with the cortex
side, 2026-09-23). So this is not an open disagreement to be resolved -- the spec is
settled and the producer is behind it.

That makes the tolerance definitively temporary, which decides where it goes:

> **Handle the trailing EOS in exactly one place, outside the parsers.** A parser that
> tolerates a trailing marker is a parser written against a behaviour that is scheduled to
> disappear, and it will then disagree with the cross-language vectors, which are authored
> against the spec rather than against today's producer. Strip-if-present belongs in the
> layer that assembles committed text from frames, so that deleting it later is a one-line
> change and the parsers never encoded the divergence.

### 13.3 The chat path has no stop conditions

> chat generations terminate only by natural EOS or `max_output_tokens`; there is no stop
> condition

A generation context carrying `stop_sequences` or `stop_token_ids` is refused up front
(`rejectNonOpenAIChatGenerationParams`) rather than silently dropped.

Consequence for S7: **a closing marker does not end the generation.** The model keeps
producing tokens after `</tool_call>`, so ordinary content can follow a completed tool
call, and more than one tool call can appear in a single output. The state machine in S7
already returns to `Text` on the closing marker, which is the correct shape -- this
section is here so that behaviour reads as deliberate rather than incidental.
