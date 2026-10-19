/**
 * Differential corpus runner: feeds a case extracted from vLLM's / Dynamo's own parser tests
 * through the SDK parser in the same mode and compares the outcome with what the reference
 * test asserts.
 *
 * The corpus is NOT an authority (wire's shared vectors are); it is a pinned record of where
 * the SDK agrees with and diverges from the two engines, so a later change is visible.
 */
import { FinishReasonV1 } from '../../src/gen/task/v1/evidence_pb.js';
import { deriveAssistantMessage, deriveAssistantStream } from '../../src/toolcall/assistant-view';
import { hermesParser } from '../../src/toolcall/parsers/hermes';
import { qwen3CoderParser } from '../../src/toolcall/parsers/qwen3-coder';
import { qwen3ReasoningParser, type ReasoningStreamEvent } from '../../src/toolcall/reasoning';
import type { AssistantStreamEvent } from '../../src/toolcall/types';
import type { ChatTool } from '../../src/order/chat-input';

export type ReferenceParser = 'hermes@1' | 'qwen3@1' | 'qwen3+hermes' | 'qwen3_coder@1' | 'qwen3+qwen3_coder';
export type Verdict = 'agree' | 'divergent-by-spec' | 'divergent-unexplained' | 'not-applicable';

/** A call as the reference asserts it. An omitted field is not asserted by the reference. */
export interface ReferenceCall {
  readonly name?: string;
  readonly arguments?: string;
}

/**
 * What the reference asserts, in SDK vocabulary. An omitted field is not asserted. The
 * reference's `None` content / reasoning is normalised to `""` (the SDK has no null).
 */
export interface ReferenceExpected {
  readonly content?: string;
  readonly reasoning_content?: string;
  readonly tool_calls?: readonly ReferenceCall[];
}

/** One `push`'s output, for references that assert per-chunk results. */
export interface StepOutput {
  readonly content?: string;
  readonly reasoning_content?: string;
}

export interface ContentAssertion {
  readonly op: 'contains' | 'not_contains' | 'trim_empty';
  readonly value?: string;
}

export interface SdkActual {
  readonly content: string;
  readonly reasoning_content: string;
  readonly tool_calls: readonly { readonly name: string; readonly arguments: string }[];
}

export interface ReferenceCase {
  readonly id: string;
  readonly source: 'vllm' | 'dynamo';
  readonly source_file: string;
  readonly source_test: string;
  readonly parser: ReferenceParser;
  readonly mode: 'complete' | 'stream';
  readonly input: string | readonly string[];
  /** The request's tools, for a schema-typed parser (qwen3_coder@1). */
  readonly tools?: readonly ChatTool[];
  /** Stream only: whether end-of-stream (`finish`) is signalled after the last push. Default true. */
  readonly finish?: boolean;
  /**
   * Stream only: the deltas are a substitute for tokenizer-produced deltas the reference
   * computes at run time (the tokenizer is not executed here); the runner additionally checks
   * that every fixed-width split gives the same result.
   */
  readonly substituted_deltas?: boolean;
  readonly reference_expected: ReferenceExpected;
  readonly reference_steps?: readonly StepOutput[];
  readonly content_assertions?: readonly ContentAssertion[];
  /**
   * `exact`: same count, each listed field equal. `first`: only the first call is asserted.
   * `includes-names`: at least as many calls, and every expected name present. `non-empty`:
   * at least one call.
   */
  readonly tool_calls_match?: 'exact' | 'first' | 'includes-names' | 'non-empty';
  /** `json`: the reference compares arguments by JSON value. `bytes`: exact string. */
  readonly args_compare?: 'json' | 'bytes';
  readonly note: string;
  readonly verdict: Verdict;
  readonly sdk_actual: SdkActual;
  readonly sdk_steps?: readonly StepOutput[];
  readonly reason: string;
}

export interface SdkRun {
  readonly actual: SdkActual;
  readonly steps?: readonly StepOutput[];
}

const inputText = (input: string | readonly string[]): string =>
  typeof input === 'string' ? input : input.join('');

const inputFrames = (input: string | readonly string[]): readonly string[] =>
  typeof input === 'string' ? [input] : input;

/**
 * The references' finalize paths stand for a generation that ended by itself (EOS), so the SDK
 * runs as after a signed Fin of EOS_TOKEN: an unclosed final call whose body parses is recovered
 * (design S7 requirement 6).
 */
const ENDED_BY_MODEL = { recoverUnclosedAtEnd: true } as const;

/** Full-text run of the SDK parser the case names; `tools` reaches a schema-typed parser. */
export function runComplete(parser: ReferenceParser, text: string, tools?: readonly ChatTool[]): SdkActual {
  if (parser === 'qwen3@1') {
    const { reasoningContent, remainder } = qwen3ReasoningParser.split(text);
    return { content: remainder, reasoning_content: reasoningContent, tool_calls: [] };
  }
  const withTools = tools ? { tools } : {};
  const message =
    parser === 'hermes@1'
      ? hermesParser.parseComplete(text, ENDED_BY_MODEL)
      : parser === 'qwen3_coder@1'
        ? qwen3CoderParser.parseComplete(text, { ...ENDED_BY_MODEL, ...withTools })
        : deriveAssistantMessage(text, {
            parser: parser === 'qwen3+qwen3_coder' ? qwen3CoderParser : hermesParser,
            reasoning: qwen3ReasoningParser,
            finishReason: FinishReasonV1.EOS_TOKEN,
            ...withTools,
          });
  return {
    content: message.content,
    reasoning_content: message.reasoningContent ?? '',
    tool_calls: message.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
  };
}

interface Acc {
  content: string;
  reasoning: string;
  calls: { name: string; arguments: string }[];
}

function absorb(acc: Acc, events: readonly AssistantStreamEvent[]): void {
  for (const e of events) {
    if (e.kind === 'content') acc.content += e.text;
    else if (e.kind === 'reasoning') acc.reasoning += e.text;
    else acc.calls.push({ name: e.call.name, arguments: e.call.arguments });
  }
}

/** Streaming run: one `push` per frame, then `finish` unless the reference never ends the stream. */
export async function runStream(
  parser: ReferenceParser,
  frames: readonly string[],
  finish: boolean,
  tools?: readonly ChatTool[],
): Promise<SdkRun> {
  const total: Acc = { content: '', reasoning: '', calls: [] };
  const steps: StepOutput[] = [];

  if (parser === 'qwen3+hermes' || parser === 'qwen3+qwen3_coder') {
    // The real composition (S7.3 rule 10): reasoning first, the tool parser sees the remainder.
    // `deriveAssistantStream` always ends the stream, so `finish: false` is not supported here.
    async function* source() {
      for (const text of frames) yield { kind: 'chunk' as const, text };
      yield { kind: 'fin' as const, finishReason: FinishReasonV1.EOS_TOKEN };
    }
    for await (const e of deriveAssistantStream(source(), {
      parser: parser === 'qwen3+qwen3_coder' ? qwen3CoderParser : hermesParser,
      reasoning: qwen3ReasoningParser,
      ...(tools ? { tools } : {}),
    })) {
      absorb(total, [e]);
    }
    return { actual: { content: total.content, reasoning_content: total.reasoning, tool_calls: total.calls } };
  }

  if (parser === 'qwen3@1') {
    const state = qwen3ReasoningParser.createStreamState();
    const toEvents = (es: readonly ReasoningStreamEvent[]): AssistantStreamEvent[] =>
      es.map((e): AssistantStreamEvent => ({ kind: e.kind === 'reasoning' ? 'reasoning' : 'content', text: e.text }));
    for (const frame of frames) {
      const step: Acc = { content: '', reasoning: '', calls: [] };
      absorb(step, toEvents(state.push(frame)));
      steps.push({ content: step.content, reasoning_content: step.reasoning });
      total.content += step.content;
      total.reasoning += step.reasoning;
    }
    if (finish) absorb(total, toEvents(state.finish()));
  } else {
    const state =
      parser === 'qwen3_coder@1'
        ? qwen3CoderParser.createStreamState(tools ? { tools } : undefined)
        : hermesParser.createStreamState();
    for (const frame of frames) {
      const step: Acc = { content: '', reasoning: '', calls: [] };
      absorb(step, state.push(frame));
      steps.push({ content: step.content, reasoning_content: step.reasoning });
      total.content += step.content;
      total.calls.push(...step.calls);
    }
    if (finish) absorb(total, state.finish(ENDED_BY_MODEL));
  }
  return {
    actual: { content: total.content, reasoning_content: total.reasoning, tool_calls: total.calls },
    steps,
  };
}

export async function runCase(c: ReferenceCase): Promise<SdkRun> {
  if (c.mode === 'complete') return { actual: runComplete(c.parser, inputText(c.input), c.tools) };
  return runStream(c.parser, inputFrames(c.input), c.finish !== false, c.tools);
}

/** Splits `text` into fixed-width frames (by UTF-16 code unit; the corpus inputs are BMP-only). */
export function splitFixed(text: string, width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
  return out;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function argsEqual(expected: string, actual: string, mode: 'json' | 'bytes'): boolean {
  if (mode === 'bytes') return expected === actual;
  try {
    return JSON.stringify(canonical(JSON.parse(expected))) === JSON.stringify(canonical(JSON.parse(actual)));
  } catch {
    return false;
  }
}

function callMatches(e: ReferenceCall, a: { name: string; arguments: string } | undefined, mode: 'json' | 'bytes'): boolean {
  if (a === undefined) return false;
  if (e.name !== undefined && e.name !== a.name) return false;
  if (e.arguments !== undefined && !argsEqual(e.arguments, a.arguments, mode)) return false;
  return true;
}

/** Every way the SDK outcome differs from what the reference asserts; empty means agreement. */
export function compareWithReference(c: ReferenceCase, run: SdkRun): string[] {
  const { actual } = run;
  const exp = c.reference_expected;
  const mismatches: string[] = [];
  const argsMode = c.args_compare ?? 'json';

  if (exp.content !== undefined && exp.content !== actual.content) mismatches.push('content');
  if (exp.reasoning_content !== undefined && exp.reasoning_content !== actual.reasoning_content) {
    mismatches.push('reasoning_content');
  }
  if (exp.tool_calls !== undefined) {
    const mode = c.tool_calls_match ?? 'exact';
    const ok = (() => {
      switch (mode) {
        case 'exact':
          return (
            exp.tool_calls.length === actual.tool_calls.length &&
            exp.tool_calls.every((e, i) => callMatches(e, actual.tool_calls[i], argsMode))
          );
        case 'first': {
          const first = exp.tool_calls[0];
          return first === undefined ? actual.tool_calls.length === 0 : callMatches(first, actual.tool_calls[0], argsMode);
        }
        case 'includes-names':
          return (
            actual.tool_calls.length >= exp.tool_calls.length &&
            exp.tool_calls.every((e) => e.name === undefined || actual.tool_calls.some((a) => a.name === e.name))
          );
        case 'non-empty':
          return actual.tool_calls.length > 0;
      }
    })();
    if (!ok) mismatches.push('tool_calls');
  }
  for (const a of c.content_assertions ?? []) {
    const v = a.value ?? '';
    const ok =
      a.op === 'contains' ? actual.content.includes(v) : a.op === 'not_contains' ? !actual.content.includes(v) : actual.content.trim() === '';
    if (!ok) mismatches.push(`content_assertion:${a.op}${a.value !== undefined ? `(${JSON.stringify(a.value)})` : ''}`);
  }
  if (c.reference_steps !== undefined) {
    const steps = run.steps ?? [];
    c.reference_steps.forEach((s, i) => {
      const got = steps[i];
      if (got === undefined) {
        mismatches.push(`step${i}:missing`);
        return;
      }
      if (s.content !== undefined && s.content !== got.content) mismatches.push(`step${i}:content`);
      if (s.reasoning_content !== undefined && s.reasoning_content !== got.reasoning_content) {
        mismatches.push(`step${i}:reasoning_content`);
      }
    });
  }
  return mismatches;
}
