import {
  confirmOutputWithReceipt,
  type ConfirmOutputWithReceiptInput,
} from '../output/output-confirmation';
import { concatBytes } from '../util/bytes';
import { FinishReasonV1 } from '../gen/task/v1/evidence_pb.js';
import type {
  AssistantStreamEvent,
  ConfirmedAssistantMessage,
  DerivedAssistantMessage,
  ToolCallParseOptions,
  ToolCallParser,
} from './types';
import type { ReasoningParser } from './reasoning';

export interface DerivedViewOptions {
  /**
   * Resolved before streaming, by `resolveToolCalling`. Phase 1 injects it directly; phase 3
   * resolves it from the profile manifest's `tool_calling.parser {name, version}`.
   */
  readonly parser: ToolCallParser;
  /**
   * Splits the leading reasoning span off before tool-call parsing (Manifest S7.3 rule 5), so a
   * tool-call marker written while reasoning is never a call (rule 7). Omit it when the profile
   * pins no reasoning parser.
   */
  readonly reasoning?: ReasoningParser;
  /**
   * The verified protocol finish reason of the output (the signed Fin), for the non-streaming
   * path, which receives text only. It decides how an unclosed final call is read (see
   * `unclosedCallRecovery`). The streaming and confirmation paths take it from the Fin itself.
   */
  readonly finishReason?: FinishReasonV1;
}

/**
 * Whether a final call missing its closing marker is recovered (design S7 requirement 6): only
 * when the signed Fin says the model stopped by itself. EOS_TOKEN and STOP_SEQUENCE end where the
 * model chose to; MAX_OUTPUT_TOKENS / MAX_OUTPUT_DURATION cut it off and USER_STOP interrupts it,
 * so a body that happens to parse there may not be the call the model meant. Unavailable means
 * no recovery: the reason is never guessed.
 */
export function unclosedCallRecovery(finishReason: FinishReasonV1 | undefined): ToolCallParseOptions {
  return {
    recoverUnclosedAtEnd:
      finishReason === FinishReasonV1.EOS_TOKEN || finishReason === FinishReasonV1.STOP_SEQUENCE,
  };
}

/** Tool-call parsing over the remainder only, with the reasoning attached (S7.3 rules 5, 7, 8). */
function parseWithReasoning(
  text: string,
  opts: DerivedViewOptions,
  finishReason: FinishReasonV1 | undefined,
): DerivedAssistantMessage {
  const parseOpts = unclosedCallRecovery(finishReason);
  if (opts.reasoning === undefined) return opts.parser.parseComplete(text, parseOpts);
  const { reasoningContent, remainder } = opts.reasoning.split(text);
  const message = opts.parser.parseComplete(remainder, parseOpts);
  return reasoningContent === '' ? message : { ...message, reasoningContent };
}

/**
 * Structurally what `streamOutput` yields. Declared here rather than imported from `client.ts`
 * so the derived-view layer does not create an import cycle with the facade.
 */
type OutputEventLike =
  | { readonly kind: 'chunk'; readonly text: string }
  | { readonly kind: 'fin'; readonly finishReason?: FinishReasonV1 | undefined };

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
  const state = opts.parser.createStreamState();
  // Chained, not parallel (S7.3 rule 10): reasoning first, the tool parser sees only the remainder.
  const reasoning = opts.reasoning?.createStreamState();
  function* feed(text: string): Iterable<AssistantStreamEvent> {
    if (reasoning === undefined) {
      yield* state.push(text);
      return;
    }
    for (const e of reasoning.push(text)) {
      if (e.kind === 'reasoning') yield e;
      else yield* state.push(e.text);
    }
  }
  let finishReason: FinishReasonV1 | undefined;
  for await (const event of source) {
    if (event.kind === 'fin') finishReason = event.finishReason;
    if (event.kind !== 'chunk') continue;
    yield* feed(event.text);
  }
  if (reasoning !== undefined) {
    for (const e of reasoning.finish()) {
      if (e.kind === 'reasoning') yield e;
      else yield* state.push(e.text);
    }
  }
  yield* state.finish(unclosedCallRecovery(finishReason));
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
  const message = parseWithReasoning(text, opts, confirmation.finishReason);
  return {
    ...message,
    confirmation,
    ...(confirmation.finishReason !== undefined ? { finishReason: confirmation.finishReason } : {}),
  };
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
  return parseWithReasoning(text, opts, opts.finishReason);
}
