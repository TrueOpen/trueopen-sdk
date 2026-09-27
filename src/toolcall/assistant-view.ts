import {
  confirmOutputWithReceipt,
  type ConfirmOutputWithReceiptInput,
} from '../output/output-confirmation';
import { concatBytes } from '../util/bytes';
import { assertNoEndMarkerCollision, TrailingEosStripper, stripTrailingEos } from './committed-text';
import type {
  AssistantStreamEvent,
  ConfirmedAssistantMessage,
  DerivedAssistantMessage,
  ToolCallParser,
} from './types';

export interface DerivedViewOptions {
  /**
   * Resolved before streaming, by `resolveToolCalling`. Phase 1 injects it directly; phase 3
   * resolves it from the profile manifest's `tool_calling.parser {name, version}`.
   */
  readonly parser: ToolCallParser;
  /**
   * Decoded end-of-sequence markers to strip if present (design S13.2).
   *
   * Caller-supplied, permanently. Manifest S7.1 says the SDK is not EOS-aware and needs no
   * tokenizer, and the manifest's own `eos_token_ids` are `[]u32` token ids that nothing
   * here could turn into strings. So this is a tolerance for a producer that has not caught
   * up, not a placeholder for a later manifest lookup.
   *
   * Empty means strip nothing, which is the correct setting once Cortex strips the EOS
   * itself -- at which point this option should be deleted rather than defaulted.
   */
  readonly trailingEosMarkers?: readonly string[];
}

/**
 * Structurally what `streamOutput` yields. Declared here rather than imported from `client.ts`
 * so the derived-view layer does not create an import cycle with the facade.
 */
type OutputEventLike = { readonly kind: 'chunk'; readonly text: string } | { readonly kind: 'fin' };

/**
 * Stage one of the execution gate: content and **provisional** calls from locally verified
 * frames (design S4).
 *
 * Nothing here has been reconciled with the chain -- only the Worker's own frame signatures and
 * the running MMR root have been checked, which is what `streamOutput` guarantees and no more.
 * Every call this yields is `tool-call-provisional` and MUST NOT be executed. Promotion happens
 * in `confirmAssistantMessageWithReceipt`, and nowhere else: there is no timeout that promotes a
 * provisional call, and there must not be (design S4.3). "The receipt is taking a long time" and
 * "the bytes were committed" are unrelated facts.
 */
export async function* deriveAssistantStream(
  source: AsyncIterable<OutputEventLike>,
  opts: DerivedViewOptions,
): AsyncIterable<AssistantStreamEvent> {
  assertNoEndMarkerCollision(opts.parser.endMarkers ?? [], opts.trailingEosMarkers ?? []);
  const stripper = new TrailingEosStripper(opts.trailingEosMarkers ?? []);
  const state = opts.parser.createStreamState();
  for await (const event of source) {
    if (event.kind !== 'chunk') continue;
    const safe = stripper.push(event.text);
    if (safe !== '') yield* state.push(safe);
  }
  const tail = stripper.finish();
  if (tail !== '') yield* state.push(tail);
  yield* state.finish();
}

/**
 * Stage two: the executable result.
 *
 * It is reachable only through this function, and this function requires an on-chain
 * `InferReceipt`. A caller who forgets to call it has nothing to execute, which is the safe
 * outcome (design S4.2) -- the alternative, one type carrying `confirmed: boolean`, fails in the
 * wrong direction, because the cost of ignoring the flag is a side effect that cannot be taken
 * back.
 *
 * It re-parses from the checkpoint's verified chunks rather than trusting anything retained from
 * the provisional pass, and returns the **full list** rather than a delta: a caller that
 * buffered provisional calls discards them and acts on this alone.
 *
 * Reconciliation is delegated to `confirmOutputWithReceipt` -- root, leaf count and size are
 * checked there and nowhere else. Any mismatch throws before a call is produced.
 */
export function confirmAssistantMessageWithReceipt(
  input: ConfirmOutputWithReceiptInput,
  opts: DerivedViewOptions,
): ConfirmedAssistantMessage {
  const confirmation = confirmOutputWithReceipt(input);
  // Decode the concatenation, never chunk by chunk: a chunk boundary is the Worker's choice and
  // can fall inside a multi-byte UTF-8 sequence.
  const text = new TextDecoder().decode(
    concatBytes(...input.checkpoint.chunks.map((chunk) => Uint8Array.from(chunk))),
  );
  // Full-text path (no incremental seam), so the streaming EOS/end-marker collision guard is not needed here.
  const message = opts.parser.parseComplete(stripTrailingEos(text, opts.trailingEosMarkers ?? []));
  return { ...message, confirmation };
}

/**
 * The non-streaming path, which has no provisional stage (design S4.4).
 *
 * **Guarantee is conditional on the caller.** This function receives no receipt, checkpoint, or
 * hash and cannot itself verify that `text` comes from a verified source. However, if and only
 * if `text` is sourced exclusively from `fetchTaskOutput`, the bytes are already reconciled:
 * `fetchTaskOutput` requires the on-chain `InferReceipt.output_hash` as a required input and
 * retrieves content-addressed against it, so by the time its text exists, the bytes have already
 * been reconciled with the chain commitment. A parse over such text is confirmed by construction.
 *
 * Safe usage: source `text` only from `fetchTaskOutput`.
 */
export function deriveAssistantMessage(
  text: string,
  opts: DerivedViewOptions,
): DerivedAssistantMessage {
  // Full-text path (no incremental seam), so the streaming EOS/end-marker collision guard is not needed here.
  return opts.parser.parseComplete(stripTrailingEos(text, opts.trailingEosMarkers ?? []));
}
