import { FinishReasonV1 } from '../gen/task/v1/evidence_pb.js';
import { TrueOpenError } from '../errors/errors';
import { bytesEqual, toHex } from '../util/bytes';
import type { ConfirmedOutputEvent } from './output-confirmation';

export interface VerifiedOutputChunkEvent {
  readonly type: 'chunk';
  readonly seq: bigint;
  readonly text: string;
  readonly mmrRoot: Uint8Array;
}

/**
 * A verified termination event. The current SDK cannot yet produce it from Wire v0.4.1:
 * callers must wait until Wire #35's Fin reason/signature verification lands before
 * converting a real stream into this event.
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
}

export type OutputDeliveryMode = 'provisional' | 'confirmed-only';

export interface OpenAIChatSseOptions {
  /** Defaults to provisional: emits terminal + [DONE] immediately after verified Fin. */
  readonly delivery?: OutputDeliveryMode;
  /** Max in-memory buffered bytes for confirmed-only; defaults to 16 MiB. */
  readonly maxBufferedBytes?: number;
  /** Aborts consumption of upstream events; once aborted, fails closed and stops producing SSE. */
  readonly signal?: AbortSignal;
}

export type OpenAIFinishReason = 'stop' | 'length';

interface BufferedChunk {
  readonly text: string;
}

const encoder = new TextEncoder();
const HASH32_HEX = /^[0-9a-f]{64}$/;
export const DEFAULT_CONFIRMED_ONLY_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

function sseError(code: string, message: string): TrueOpenError {
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
      return 'stop';
    case FinishReasonV1.MAX_OUTPUT_TOKENS:
    case FinishReasonV1.MAX_OUTPUT_DURATION:
      return 'length';
    case FinishReasonV1.UNSPECIFIED:
    default:
      throw sseError('DATA_OPENAI_SSE_FINISH_REASON_INVALID', `unsupported finish_reason ${reason}`);
  }
}

function validateContext(context: OpenAIChatSseContext): number {
  if (context.id === '' || context.model === '' || !HASH32_HEX.test(context.taskId) || !HASH32_HEX.test(context.taskHash)) {
    throw sseError(
      'DATA_OPENAI_SSE_CONTEXT_INVALID',
      'id/model must not be empty and taskId/taskHash must be canonical lowercase 64-hex',
    );
  }
  if (!Number.isSafeInteger(context.created) || context.created < 0) {
    throw sseError('DATA_OPENAI_SSE_CONTEXT_INVALID', 'created must be a non-negative safe integer Unix timestamp');
  }
  const choiceIndex = context.choiceIndex ?? 0;
  if (!Number.isSafeInteger(choiceIndex) || choiceIndex < 0) {
    throw sseError('DATA_OPENAI_SSE_CONTEXT_INVALID', 'choiceIndex must be a non-negative safe integer');
  }
  return choiceIndex;
}

function jsonData(context: OpenAIChatSseContext, choiceIndex: number, choice: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({
    id: context.id,
    object: 'chat.completion.chunk',
    created: context.created,
    model: context.model,
    choices: [{ index: choiceIndex, ...choice }],
  })}\n\n`);
}

function contentData(context: OpenAIChatSseContext, choiceIndex: number, text: string): Uint8Array {
  return jsonData(context, choiceIndex, { delta: { content: text }, finish_reason: null });
}

function terminalData(
  context: OpenAIChatSseContext,
  choiceIndex: number,
  reason: OpenAIFinishReason,
): Uint8Array {
  return jsonData(context, choiceIndex, { delta: {}, finish_reason: reason });
}

const doneData = (): Uint8Array => encoder.encode('data: [DONE]\n\n');

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
    confirmed.outputHash !== toHex(confirmed.outputMmrRoot)
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
          yield contentData(context, choiceIndex, event.text);
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
          yield terminalData(context, choiceIndex, openAIFinishReason(fin.finishReason));
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
        for (const chunk of buffered) yield contentData(context, choiceIndex, chunk.text);
        yield terminalData(context, choiceIndex, openAIFinishReason(fin.finishReason));
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
