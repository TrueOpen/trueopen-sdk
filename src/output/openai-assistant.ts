import { randomBytes } from '@noble/hashes/utils';
import { TrueOpenError } from '../errors/errors';
import type { ConfirmedAssistantMessage } from '../toolcall/types';
import type { ToolCallIdFormat } from '../manifest/model-manifest';
import { openAIFinishReason } from './openai-sse';

/**
 * The OpenAI-facing rules of sdk_详细设计 §5.5, kept beside the OpenAI SSE adapter and out of the
 * neutral assistant view.
 *
 * Division of work: the SDK supplies what the protocol fixes -- the finish_reason mapping and
 * tool call ids in the profile's `call_id_format` -- and the Provider builds the OpenAI envelope
 * around them: when to assign each id, `type: "function"`, `index` (the confirmed order), and the
 * ChatCompletion / Responses structure and SSE. Every input here is a confirmed message, so
 * nothing derived from unconfirmed frames can become an executable call.
 */

// The id is synthesized, never written by the model; the agent echoes it back next turn as
// `tool_calls[].id` / `tool_call_id`, and some chat templates validate it (Mistral requires nine
// alphanumerics), so its format follows the model's manifest.
export { TOOL_CALL_ID_FORMATS, type ToolCallIdFormat } from '../manifest/model-manifest';

export type OpenAIAssistantFinishReason = 'stop' | 'length' | 'tool_calls';

/**
 * The OpenAI finish_reason of a confirmed assistant message (§5.5):
 *
 *   EOS_TOKEN / STOP_SEQUENCE / STOP_TOKEN / USER_STOP -> "stop", or "tool_calls" when the
 *     confirmed parse has calls (the protocol's closed set has no tool_calls; it is a derived view)
 *   MAX_OUTPUT_TOKENS / MAX_OUTPUT_DURATION -> "length", even with calls: the output was cut off.
 *     The calls closed before the cut stay in `toolCalls`; whether to continue or retry is the
 *     caller's decision.
 *
 * Undefined when the protocol reason is unavailable (no signed Fin kept): the Provider maps that
 * to its own error and never to a guess. A reason outside the closed set throws.
 */
export function openAIFinishReasonOf(message: ConfirmedAssistantMessage): OpenAIAssistantFinishReason | undefined {
  if (message.finishReason === undefined) return undefined;
  const mapped = openAIFinishReason(message.finishReason);
  return mapped === 'stop' && message.toolCalls.length > 0 ? 'tool_calls' : mapped;
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Uniform alphanumerics: 62 * 4 = 248, so bytes >= 248 are rejected rather than biasing the draw. */
function randomAlnum(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248 && out.length < length) out += ALNUM[byte % 62];
    }
  }
  return out;
}

/**
 * A random tool call id in the given format: `call_` + 24 alphanumerics, or nine alphanumerics.
 * Random by design (ADR-0022): the id carries no model information and is not part of any
 * cross-language comparison. The Provider decides when to assign one per call.
 */
export function newToolCallId(format: ToolCallIdFormat): string {
  switch (format) {
    case 'OPENAI_CALL_PREFIX':
      return `call_${randomAlnum(24)}`;
    case 'MISTRAL_ALNUM_9':
      return randomAlnum(9);
    default:
      throw new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_CALL_ID_FORMAT_INVALID', `unknown call_id_format ${String(format)}`);
  }
}
