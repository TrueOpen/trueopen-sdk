import type { ConfirmedAssistantMessage } from '../toolcall/types';
import type { ToolCallIdFormat } from '../manifest/model-manifest';
import { newToolCallId, openAIFinishReasonOf } from './openai-assistant';
import {
  contentData,
  doneData,
  jsonData,
  roleData,
  sseError,
  validateContext,
  type OpenAIChatSseContext,
} from './openai-sse';

/**
 * The events this adapter reads: the shape `TrueOpenClient.assistantTurn` yields. Reasoning and
 * content arrive as frames verify; `confirmed` arrives once, after the receipt is reconciled.
 */
export type OpenAIAssistantSseEvent =
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'content'; readonly text: string }
  | { readonly kind: 'reset' }
  | { readonly kind: 'confirmed'; readonly message: ConfirmedAssistantMessage };

export interface OpenAIAssistantSseOptions {
  /**
   * The id format of the profile's manifest `tool_calling.call_id_format`
   * (`TrueOpenClient.toolCallIdFormat`). Required: some chat templates validate the id the agent
   * echoes back (Mistral wants nine alphanumerics), so the adapter does not pick one.
   */
  readonly toolCallIdFormat: ToolCallIdFormat;
  /** As `OpenAIChatSseOptions.includeObfuscation`: random padding on every chunk. Defaults to false. */
  readonly includeObfuscation?: boolean;
}

/**
 * Encodes one assistant turn (`TrueOpenClient.assistantTurn`) into OpenAI Chat Completion SSE,
 * following sdk_详细设计 §5.5:
 *
 *  - content is streamed as it verifies, after a first `{role: "assistant", content: ""}` chunk;
 *  - reasoning is dropped, as OpenAI's Chat Completions returns none;
 *  - tool calls and the finish_reason are sent only after the confirmed message arrives (the
 *    signed Fin verified and reconciled with the receipt), so a client never sees a call that was
 *    not confirmed. Each call is one chunk with its index, a fresh id in `toolCallIdFormat`,
 *    `type: "function"` and the name and arguments exactly as the model wrote them;
 *  - the finish_reason is `stop`, `length`, or `tool_calls` when the confirmed parse has calls.
 *
 * Fails closed, with no terminal chunk and no `[DONE]`, when the stream ends without a confirmed
 * message, when the confirmed message belongs to another task, when its content differs from the
 * content already streamed, when the protocol finish reason is unavailable, or when a voided
 * dispatch attempt is reset after content was streamed (`DATA_OPENAI_SSE_ATTEMPT_RESET`).
 */
export async function* toOpenAIAssistantSSEIterable(
  events: AsyncIterable<OpenAIAssistantSseEvent>,
  context: OpenAIChatSseContext,
  options: OpenAIAssistantSseOptions,
): AsyncIterable<Uint8Array> {
  const choiceIndex = validateContext(context);
  const obfuscate = options.includeObfuscation === true;
  // Checked up front, like the context, rather than at the first call.
  newToolCallId(options.toolCallIdFormat);
  let roleSent = false;
  let streamed = '';

  for await (const event of events) {
    switch (event.kind) {
      case 'reasoning':
        continue;
      case 'reset':
        // A voided dispatch attempt (Phase 1). SSE cannot take back content already sent, so the
        // stream fails closed; before any content there is nothing to take back.
        if (streamed !== '') {
          throw sseError('DATA_OPENAI_SSE_ATTEMPT_RESET', 'the dispatch attempt was replaced after its content was streamed');
        }
        continue;
      case 'content': {
        if (event.text === '') continue;
        if (!roleSent) {
          roleSent = true;
          yield roleData(context, choiceIndex, obfuscate);
        }
        streamed += event.text;
        yield contentData(context, choiceIndex, event.text, obfuscate);
        continue;
      }
      case 'confirmed': {
        const message = event.message;
        if (message.confirmation.taskId !== context.taskId || message.confirmation.taskHash !== context.taskHash) {
          throw sseError('DATA_OPENAI_SSE_CONFIRMATION_CONTEXT_MISMATCH', 'confirmed message belongs to another task');
        }
        if (message.content !== streamed) {
          throw sseError(
            'DATA_OPENAI_SSE_CONTENT_MISMATCH',
            'the confirmed content differs from the content already streamed',
          );
        }
        const finishReason = openAIFinishReasonOf(message);
        if (finishReason === undefined) {
          throw sseError(
            'DATA_OPENAI_SSE_FINISH_REASON_UNAVAILABLE',
            'the confirmed message has no protocol finish reason (no signed Fin kept); it is never guessed',
          );
        }
        if (!roleSent) {
          roleSent = true;
          yield roleData(context, choiceIndex, obfuscate);
        }
        for (const [index, call] of message.toolCalls.entries()) {
          yield jsonData(context, choiceIndex, {
            tool_calls: [{
              index,
              id: newToolCallId(options.toolCallIdFormat),
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            }],
          }, null, obfuscate);
        }
        yield jsonData(context, choiceIndex, {}, finishReason, obfuscate);
        yield doneData();
        return;
      }
      default: {
        const unreachable: never = event;
        throw sseError('DATA_OPENAI_SSE_EVENT_INVALID', `unsupported assistant event ${String(unreachable)}`);
      }
    }
  }
  throw sseError('DATA_OPENAI_SSE_CONFIRMATION_MISSING', 'the assistant turn ended without a confirmed message');
}

/** Browser/Web API path; reuses the AsyncIterable encoding. */
export function toOpenAIAssistantSSE(
  events: AsyncIterable<OpenAIAssistantSseEvent>,
  context: OpenAIChatSseContext,
  options: OpenAIAssistantSseOptions,
): ReadableStream<Uint8Array> {
  const iterator = toOpenAIAssistantSSEIterable(events, context, options)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const step = await iterator.next();
        if (step.done) controller.close();
        else controller.enqueue(step.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      void iterator.return?.().catch(() => undefined);
    },
  }, { highWaterMark: 0 });
}
