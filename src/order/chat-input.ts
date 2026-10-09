import { canonicalJsonBytes } from '../codec/canonical-json';
import type { CanonicalJsonValue } from '../codec/canonical-json';
import { TrueOpenError } from '../errors/errors';

/**
 * The payload bytes of a chat task (`TASK_TYPE_CHAT`): a cortex.v1 ChatInferInput, encoded
 * once with canonical_json_v1.
 *
 * `input_hash` commits the bytes, not the request: the same request written with another key
 * order, whitespace or escaping is another input. Builders, Cortex and Verifiers hash the bytes
 * they receive and never re-encode them, so the SDK's only obligation is to produce one byte
 * sequence per request and reuse it on every retry (monorepo#30, sdk_详细设计 §2.4 step 0).
 *
 * **Not yet cross-checked.** The rule is canonical_json_v1 with snake_case keys; wire has not
 * published `chat_infer_input_canonical_v1`, so these bytes are self-consistent but have not
 * been compared against another implementation. Revisit when the vectors ship.
 *
 * The shape is the OpenAI Chat Completions request body, as Cortex forwards it to vLLM:
 * `tools[].function.parameters` is a JSON Schema object, not the JSON string the proto
 * comment describes. Only the content/intent fields are accepted. The sampling parameters
 * belong to the order's generation params, and Cortex refuses a chat input that carries them.
 *
 * canonical_json_v1 has no floats and no null, so neither may appear anywhere in the input,
 * including inside a tool's parameter schema.
 */
export interface ChatInferInput {
  /** The conversation, oldest first. At least one. */
  readonly messages: readonly ChatMessage[];
  /** Function tools the model may call. */
  readonly tools?: readonly ChatTool[];
  /** "none" | "auto" | "required", or `{ type: "function", function: { name } }`. */
  readonly tool_choice?: string | { readonly type: 'function'; readonly function: { readonly name: string } };
  readonly parallel_tool_calls?: boolean;
  readonly response_format?: ChatJsonObject;
}

export interface ChatMessage {
  /** "system" | "developer" | "user" | "assistant" | "tool". */
  readonly role: string;
  /** Text, or OpenAI content parts. Omit it on an assistant turn that only made tool calls. */
  readonly content?: string | readonly ChatJsonObject[];
  readonly name?: string;
  /** On an assistant turn, the calls it made (replayed history). */
  readonly tool_calls?: readonly ChatToolCall[];
  /** On a "tool" turn, the call this message answers. */
  readonly tool_call_id?: string;
}

export interface ChatTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    /** The argument JSON Schema, as an object. */
    readonly parameters?: ChatJsonObject;
    readonly strict?: boolean;
  };
}

export interface ChatToolCall {
  readonly id: string;
  readonly type: 'function';
  /** `arguments` is the JSON-encoded string the model produced, as OpenAI carries it. */
  readonly function: { readonly name: string; readonly arguments: string };
}

/** A JSON object of strings, integers, booleans, arrays and objects (no float, no null). */
export interface ChatJsonObject {
  readonly [key: string]: ChatJsonValue;
}
export type ChatJsonValue = string | number | bigint | boolean | readonly ChatJsonValue[] | ChatJsonObject;

/** Top-level fields a chat input may carry: content and intent only. */
const ACCEPTED_FIELDS: ReadonlySet<string> = new Set(['messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format']);

/**
 * Fields Cortex refuses on a chat input (internal/modelservice/local_chat.go
 * chatRejectedInputFields): the generation_params_digest subset, which the order freezes, and
 * the fields the verification profile owns. Named here so the error says where they belong.
 */
const GENERATION_PARAM_FIELDS: ReadonlySet<string> = new Set([
  'temperature', 'top_p', 'max_completion_tokens', 'max_tokens', 'seed', 'presence_penalty', 'frequency_penalty', 'stop',
]);
const PROFILE_OWNED_FIELDS: ReadonlySet<string> = new Set(['logprobs', 'top_logprobs', 'logit_bias', 'n']);

function invalid(message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_CHAT_INPUT_INVALID', `chat input: ${message}`, { category: 'invalid' });
}

/** Drops keys whose value is undefined, so an optional field left unset is simply absent. */
function withoutUndefined(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutUndefined);
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = withoutUndefined(x);
    return out;
  }
  return v;
}

/**
 * Encodes a chat input as its canonical payload bytes. Call it once per request and keep the
 * bytes: a retry must resend these exact bytes (TrueOpenClient refuses a different input under
 * a used idempotency key).
 */
export function chatInferInputBytes(input: ChatInferInput): Uint8Array {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid('must be an object');
  for (const key of Object.keys(input)) {
    if ((input as unknown as Record<string, unknown>)[key] === undefined) continue;
    if (GENERATION_PARAM_FIELDS.has(key)) {
      throw invalid(`${key} is a generation parameter: set it in the order's generationParams, which the order signs`);
    }
    if (PROFILE_OWNED_FIELDS.has(key)) throw invalid(`${key} is fixed by the model profile and may not be set`);
    if (!ACCEPTED_FIELDS.has(key)) {
      throw invalid(`${key} is not a chat input field (accepted: ${[...ACCEPTED_FIELDS].join(', ')})`);
    }
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) throw invalid('messages must be a non-empty array');
  try {
    return canonicalJsonBytes(withoutUndefined(input) as CanonicalJsonValue);
  } catch (e) {
    if (e instanceof TrueOpenError) throw invalid(e.message.replace(/^canonical JSON: /, ''));
    throw e;
  }
}
