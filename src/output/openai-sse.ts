import { randomBytes } from '@noble/hashes/utils';
import { FinishReasonV1 } from '../gen/task/v1/evidence_pb.js';
import { TrueOpenError } from '../errors/errors';
import { bytesEqual } from '../util/bytes';
import { hash32Text, isHash32Text } from '../codec/hash32';
import type { ConfirmedOutputEvent } from './output-confirmation';

export interface VerifiedOutputChunkEvent {
  readonly type: 'chunk';
  readonly seq: bigint;
  readonly text: string;
  readonly mmrRoot: Uint8Array;
}

/**
 * A verified termination event. Build it only from an attested `streamOutput` fin
 * (`attested: true`), whose finish_reason the Worker signed; an unattested fin must never be
 * converted into this event.
 */
export interface VerifiedOutputFinEvent {
  readonly type: 'fin';
  readonly finalSeq: bigint;
  readonly outputMmrRoot: Uint8Array;
  readonly finishReason: FinishReasonV1;
}

export type VerifiedOutputEvent = VerifiedOutputChunkEvent | VerifiedOutputFinEvent | ConfirmedOutputEvent;

export interface OpenAIChatSseContext {
  /** OpenAI envelope id, supplied by the task context; the adapter does not guess it. */
  readonly id: string;
  /** TrueOpen task_id, used for confirmed-only context verification. */
  readonly taskId: string;
  /** accepted_task_hash, used for confirmed-only context verification. */
  readonly taskHash: string;
  /** OpenAI envelope model, supplied by the task context; the adapter does not guess it. */
  readonly model: string;
  /** Unix seconds. */
  readonly created: number;
  /** Defaults to 0. */
  readonly choiceIndex?: number;
  /**
   * OpenAI `system_fingerprint`, written on every chunk. The chain has no backend configuration
   * fingerprint, so the caller chooses it (for example one fixed value per model / profile
   * version); omitted or null writes `null`.
   */
  readonly systemFingerprint?: string | null;
}

export type OutputDeliveryMode = 'provisional' | 'confirmed-only';

export interface OpenAIChatSseOptions {
  /** Defaults to provisional: emits terminal + [DONE] immediately after verified Fin. */
  readonly delivery?: OutputDeliveryMode;
  /** Max in-memory buffered bytes for confirmed-only; defaults to 16 MiB. */
  readonly maxBufferedBytes?: number;
  /** Aborts consumption of upstream events; once aborted, fails closed and stops producing SSE. */
  readonly signal?: AbortSignal;
  /**
   * OpenAI `stream_options.include_obfuscation`: when true, every chunk carries an `obfuscation`
   * field of random padding, so chunk sizes do not reveal token sizes on the wire. Defaults to
   * false (OpenAI defaults to true): the padding is a network side-channel mitigation the caller
   * opts into, and leaving it off keeps the output deterministic.
   */
  readonly includeObfuscation?: boolean;
}

export type OpenAIFinishReason = 'stop' | 'length';

interface BufferedChunk {
  readonly text: string;
}

const encoder = new TextEncoder();
export const DEFAULT_CONFIRMED_ONLY_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

/** Bounds of the random `obfuscation` padding length, in characters. */
export const OPENAI_SSE_OBFUSCATION_MIN_LENGTH = 8;
export const OPENAI_SSE_OBFUSCATION_MAX_LENGTH = 48;

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Random alphanumeric padding of a random length in [MIN, MAX]. It is never derived from the
 * content. 62 * 4 = 248, so bytes >= 248 are rejected rather than biasing the draw.
 */
function obfuscationPadding(): string {
  const span = OPENAI_SSE_OBFUSCATION_MAX_LENGTH - OPENAI_SSE_OBFUSCATION_MIN_LENGTH + 1;
  let length = OPENAI_SSE_OBFUSCATION_MIN_LENGTH;
  for (;;) {
    const byte = randomBytes(1)[0]!;
    if (byte < 256 - (256 % span)) {
      length += byte % span;
      break;
    }
  }
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248 && out.length < length) out += ALNUM[byte % 62];
    }
  }
  return out;
}

export function sseError(code: string, message: string): TrueOpenError {
  return new TrueOpenError('DATA', code, message);
}

function abortError(): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'OPENAI_SSE_ABORTED', 'OpenAI SSE conversion aborted');
}

async function nextEvent(
  iterator: AsyncIterator<VerifiedOutputEvent>,
  signal?: AbortSignal,
): Promise<IteratorResult<VerifiedOutputEvent>> {
  if (signal === undefined) return iterator.next();
  if (signal.aborted) throw abortError();
  return new Promise<IteratorResult<VerifiedOutputEvent>>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    iterator.next().then(
      (step) => {
        signal.removeEventListener('abort', onAbort);
        resolve(step);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Fixed FinishReasonV1 -> OpenAI finish_reason mapping. Unknown values and UNSPECIFIED are always rejected. */
export function openAIFinishReason(reason: FinishReasonV1): OpenAIFinishReason {
  switch (reason) {
    case FinishReasonV1.EOS_TOKEN:
    case FinishReasonV1.STOP_SEQUENCE:
    case FinishReasonV1.STOP_TOKEN:
    case FinishReasonV1.USER_STOP:
      return 'stop';
    case FinishReasonV1.MAX_OUTPUT_TOKENS:
    case FinishReasonV1.MAX_OUTPUT_DURATION:
      return 'length';
    case FinishReasonV1.UNSPECIFIED:
    default:
      throw sseError('DATA_OPENAI_SSE_FINISH_REASON_INVALID', `unsupported finish_reason ${reason}`);
  }
}

/** Checks the envelope context and returns the choice index. Shared with the assistant adapter. */
export function validateContext(context: OpenAIChatSseContext): number {
  if (context.id === '' || context.model === '' || !isHash32Text(context.taskId) || !isHash32Text(context.taskHash)) {
    throw sseError(
      'DATA_OPENAI_SSE_CONTEXT_INVALID',
      'id/model must not be empty and taskId/taskHash must be 0x followed by 64 lowercase hex characters',
    );
  }
  if (!Number.isSafeInteger(context.created) || context.created < 0) {
    throw sseError('DATA_OPENAI_SSE_CONTEXT_INVALID', 'created must be a non-negative safe integer Unix timestamp');
  }
  const choiceIndex = context.choiceIndex ?? 0;
  if (!Number.isSafeInteger(choiceIndex) || choiceIndex < 0) {
    throw sseError('DATA_OPENAI_SSE_CONTEXT_INVALID', 'choiceIndex must be a non-negative safe integer');
  }
  const fingerprint = context.systemFingerprint;
  if (fingerprint !== undefined && fingerprint !== null && (typeof fingerprint !== 'string' || fingerprint === '')) {
    throw sseError('DATA_OPENAI_SSE_CONTEXT_INVALID', 'systemFingerprint must be a non-empty string or null');
  }
  return choiceIndex;
}

/**
 * One `chat.completion.chunk` SSE line. Field order follows OpenAI's chat.completion.chunk:
 * index, delta, logprobs, finish_reason. Shared with the assistant adapter, which adds
 * `tool_calls` deltas and the `tool_calls` finish reason.
 */
export function jsonData(
  context: OpenAIChatSseContext,
  choiceIndex: number,
  delta: Record<string, unknown>,
  finishReason: OpenAIFinishReason | 'tool_calls' | null,
  obfuscate: boolean,
): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({
    id: context.id,
    object: 'chat.completion.chunk',
    created: context.created,
    model: context.model,
    system_fingerprint: context.systemFingerprint ?? null,
    choices: [{ index: choiceIndex, delta, logprobs: null, finish_reason: finishReason }],
    ...(obfuscate ? { obfuscation: obfuscationPadding() } : {}),
  })}\n\n`);
}

/** The first chunk of every stream, as OpenAI sends it: the role and an empty content. */
export function roleData(context: OpenAIChatSseContext, choiceIndex: number, obfuscate: boolean): Uint8Array {
  return jsonData(context, choiceIndex, { role: 'assistant', content: '' }, null, obfuscate);
}

export function contentData(context: OpenAIChatSseContext, choiceIndex: number, text: string, obfuscate: boolean): Uint8Array {
  return jsonData(context, choiceIndex, { content: text }, null, obfuscate);
}

function terminalData(
  context: OpenAIChatSseContext,
  choiceIndex: number,
  reason: OpenAIFinishReason,
  obfuscate: boolean,
): Uint8Array {
  return jsonData(context, choiceIndex, {}, reason, obfuscate);
}

export const doneData = (): Uint8Array => encoder.encode('data: [DONE]\n\n');

function validateFin(fin: VerifiedOutputFinEvent, expectedSeq: bigint, lastRoot: Uint8Array | undefined): void {
  if (lastRoot === undefined || expectedSeq === 0n) {
    throw sseError('DATA_OPENAI_SSE_FIN_WITHOUT_CHUNK', 'output Fin arrived before any chunk');
  }
  if (fin.finalSeq !== expectedSeq - 1n) {
    throw sseError(
      'DATA_OPENAI_SSE_FIN_SEQ_MISMATCH',
      `Fin final_seq ${fin.finalSeq} does not match last chunk ${expectedSeq - 1n}`,
    );
  }
  if (fin.outputMmrRoot.length !== 32 || !bytesEqual(fin.outputMmrRoot, lastRoot)) {
    throw sseError('DATA_OPENAI_SSE_FIN_ROOT_MISMATCH', 'Fin output_mmr_root does not match the last verified chunk');
  }
  openAIFinishReason(fin.finishReason);
}

function validateConfirmation(
  confirmed: ConfirmedOutputEvent,
  fin: VerifiedOutputFinEvent,
  context: OpenAIChatSseContext,
  leafCount: bigint,
  sizeBytes: bigint,
): void {
  if (confirmed.taskId !== context.taskId || confirmed.taskHash !== context.taskHash) {
    throw sseError('DATA_OPENAI_SSE_CONFIRMATION_CONTEXT_MISMATCH', 'confirmed event belongs to another task');
  }
  if (
    confirmed.outputMmrRoot.length !== 32 ||
    !bytesEqual(confirmed.outputMmrRoot, fin.outputMmrRoot) ||
    confirmed.outputHash !== hash32Text(confirmed.outputMmrRoot)
  ) {
    throw sseError('DATA_OPENAI_SSE_CONFIRMATION_ROOT_MISMATCH', 'confirmed root does not match verified Fin');
  }
  if (confirmed.outputLeafCount !== leafCount) {
    throw sseError(
      'DATA_OPENAI_SSE_CONFIRMATION_LEAF_COUNT_MISMATCH',
      `confirmed leaf count ${confirmed.outputLeafCount} does not match ${leafCount}`,
    );
  }
  if (confirmed.outputSizeBytes !== sizeBytes) {
    throw sseError(
      'DATA_OPENAI_SSE_CONFIRMATION_SIZE_MISMATCH',
      `confirmed size ${confirmed.outputSizeBytes} does not match ${sizeBytes}`,
    );
  }
}

/**
 * Node/generic-runtime path: encodes verified events into OpenAI Chat Completion SSE byte chunks.
 *
 * provisional ends immediately after a verified Fin; confirmed-only emits no bytes at all
 * before the Receipt is confirmed. MMR, signature and confirmation metadata are only used
 * for local verification and are never written into assistant content.
 *
 * The stream follows OpenAI's chunk shape: a first chunk with `{role: "assistant", content: ""}`,
 * then the content chunks, then a terminal chunk with an empty delta and the finish_reason, then
 * `[DONE]`. Every choice carries `logprobs: null` (the chain keeps no logprobs) and every chunk
 * carries `system_fingerprint` (the caller's value, else null).
 */
export async function* toOpenAIChatSSEIterable(
  events: AsyncIterable<VerifiedOutputEvent>,
  context: OpenAIChatSseContext,
  options: OpenAIChatSseOptions = {},
): AsyncIterable<Uint8Array> {
  const choiceIndex = validateContext(context);
  const delivery = options.delivery ?? 'provisional';
  if (delivery !== 'provisional' && delivery !== 'confirmed-only') {
    throw sseError('DATA_OPENAI_SSE_DELIVERY_INVALID', `unsupported delivery mode ${String(delivery)}`);
  }
  const obfuscate = options.includeObfuscation === true;
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_CONFIRMED_ONLY_MAX_BUFFERED_BYTES;
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 0) {
    throw sseError('DATA_OPENAI_SSE_BUFFER_LIMIT_INVALID', 'maxBufferedBytes must be a non-negative safe integer');
  }
  const buffered: BufferedChunk[] = [];
  let expectedSeq = 0n;
  let lastRoot: Uint8Array | undefined;
  let sizeBytes = 0n;
  let fin: VerifiedOutputFinEvent | undefined;
  const iterator = events[Symbol.asyncIterator]();
  let sourceDone = false;

  try {
    for (;;) {
      const step = await nextEvent(iterator, options.signal);
      if (step.done) {
        sourceDone = true;
        break;
      }
      if (options.signal?.aborted === true) throw abortError();
      const event = step.value;
      if (event.type === 'chunk') {
        if (fin !== undefined) throw sseError('DATA_OPENAI_SSE_CHUNK_AFTER_FIN', `chunk ${event.seq} arrived after Fin`);
        if (event.seq !== expectedSeq) {
          throw sseError('DATA_OPENAI_SSE_CHUNK_SEQ_MISMATCH', `expected chunk ${expectedSeq}, got ${event.seq}`);
        }
        if (event.mmrRoot.length !== 32) {
          throw sseError('DATA_OPENAI_SSE_CHUNK_ROOT_MALFORMED', `chunk ${event.seq} mmr_root must be 32 bytes`);
        }
        const textBytes = encoder.encode(event.text);
        const nextSizeBytes = sizeBytes + BigInt(textBytes.length);
        if (delivery === 'confirmed-only' && nextSizeBytes > BigInt(maxBufferedBytes)) {
          throw sseError(
            'DATA_OPENAI_SSE_BUFFER_LIMIT_EXCEEDED',
            `confirmed-only buffer would exceed ${maxBufferedBytes} bytes at chunk ${event.seq}`,
          );
        }
        sizeBytes = nextSizeBytes;
        lastRoot = Uint8Array.from(event.mmrRoot);
        expectedSeq += 1n;
        if (delivery === 'provisional') {
          if (event.seq === 0n) yield roleData(context, choiceIndex, obfuscate);
          yield contentData(context, choiceIndex, event.text, obfuscate);
        } else {
          buffered.push({ text: event.text });
        }
        continue;
      }

      if (event.type === 'fin') {
        if (fin !== undefined) throw sseError('DATA_OPENAI_SSE_DUPLICATE_FIN', 'output carries more than one Fin');
        validateFin(event, expectedSeq, lastRoot);
        fin = {
          type: 'fin',
          finalSeq: event.finalSeq,
          outputMmrRoot: Uint8Array.from(event.outputMmrRoot),
          finishReason: event.finishReason,
        };
        if (delivery === 'provisional') {
          yield terminalData(context, choiceIndex, openAIFinishReason(fin.finishReason), obfuscate);
          yield doneData();
          return;
        }
        continue;
      }

      if (event.type === 'confirmed') {
        if (delivery !== 'confirmed-only') {
          throw sseError('DATA_OPENAI_SSE_CONFIRMATION_BEFORE_DONE', 'confirmed event is not part of provisional SSE');
        }
        if (fin === undefined) {
          throw sseError('DATA_OPENAI_SSE_CONFIRMATION_BEFORE_FIN', 'confirmed event arrived before verified Fin');
        }
        validateConfirmation(event, fin, context, expectedSeq, sizeBytes);
        yield roleData(context, choiceIndex, obfuscate);
        for (const chunk of buffered) yield contentData(context, choiceIndex, chunk.text, obfuscate);
        yield terminalData(context, choiceIndex, openAIFinishReason(fin.finishReason), obfuscate);
        yield doneData();
        return;
      }

      const unreachable: never = event;
      throw sseError('DATA_OPENAI_SSE_EVENT_INVALID', `unsupported output event ${String(unreachable)}`);
    }
  } finally {
    if (!sourceDone) void iterator.return?.().catch(() => undefined);
  }

  if (fin === undefined) throw sseError('DATA_OPENAI_SSE_STREAM_INCOMPLETE', 'verified output ended without Fin');
  throw sseError('DATA_OPENAI_SSE_CONFIRMATION_MISSING', 'confirmed-only output ended before Receipt confirmation');
}

/** Browser/Web API path; fully reuses the AsyncIterable core encoding logic. */
export function toOpenAIChatSSE(
  events: AsyncIterable<VerifiedOutputEvent>,
  context: OpenAIChatSseContext,
  options: OpenAIChatSseOptions = {},
): ReadableStream<Uint8Array> {
  const iterator = toOpenAIChatSSEIterable(events, context, options)[Symbol.asyncIterator]();
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
