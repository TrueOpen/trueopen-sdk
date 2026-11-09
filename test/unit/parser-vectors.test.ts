/**
 * Wire's shared parser vectors (testdata/v1/parser), read in place from the pinned wire submodule.
 *
 * These are the conformance authority for hermes@1, qwen3_coder@1 (TOOL_CALL_PARSER_V1) and qwen3@1
 * (REASONING_PARSER_V1); passing them is what makes the built-in parsers `vector-verified`. Every
 * vector is run twice over:
 *
 * - complete: `deriveAssistantMessage` with the vector's verified finish reason -- the same
 *   computation `confirmAssistantMessage` performs on the reconciled text;
 * - streaming: `deriveAssistantStream`, fed by the vector's byte frames decoded the way
 *   `streamOutput` decodes them (one streaming `TextDecoder` across all frames, so a frame that
 *   ends inside a character yields the partial text and the rest comes with the next frame, and a
 *   leading U+FEFF is kept as text), then
 *   a Fin carrying the finish reason. Besides each `stream_splits` entry, the whole input as one
 *   frame and one frame per byte are run too: no split point may change the result.
 *
 * Parsers are resolved as the client resolves them (`resolveParsers`: registry lookup plus the
 * Support rule), without `allowUnverified`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveParsers } from '../../src/client';
import { FinishReasonV1 } from '../../src/gen/task/v1/evidence_pb.js';
import { deriveAssistantMessage, deriveAssistantStream } from '../../src/toolcall/assistant-view';
import type { ParserRef } from '../../src/toolcall/types';

const VECTOR_DIR = new URL('../../third_party/wire/testdata/v1/parser/', import.meta.url);

interface VectorCall {
  readonly name: string;
  readonly arguments: string;
}

interface Expected {
  readonly reasoning_content?: string | null;
  readonly content: string;
  readonly tool_calls: readonly VectorCall[];
}

interface Vector {
  readonly name: string;
  readonly input_utf8: string;
  readonly finish_reason?: string | null;
  /** Reasoning file only: the tool-call parser of a combination case; null = none pinned. */
  readonly tool_call_parser?: string | null;
  /** Tool-call files only: a reasoning parser pinned alongside, for the Support rule. */
  readonly reasoning_parser?: string | null;
  readonly expected: Expected;
  readonly stream_splits?: readonly (readonly number[])[];
}

interface VectorFile {
  readonly schema: string;
  readonly parser: string;
  readonly vectors: readonly Vector[];
}

type Kind = 'reasoning' | 'tool-call';

const FILES: readonly { readonly file: string; readonly kind: Kind }[] = [
  { file: 'reasoning_qwen3_v1.json', kind: 'reasoning' },
  { file: 'tool_call_hermes_v1.json', kind: 'tool-call' },
  { file: 'tool_call_qwen3_coder_v1.json', kind: 'tool-call' },
];

const NONE: ParserRef = { name: '', version: 0 };

/** `"hermes@1"` -> `{ name: "hermes", version: 1 }`; null / absent -> not pinned. */
function parseRef(ref: string | null | undefined): ParserRef {
  if (ref === null || ref === undefined) return NONE;
  const m = /^([^@]+)@([0-9]+)$/.exec(ref);
  if (m === null) throw new Error(`bad parser ref ${ref}`);
  return { name: m[1]!, version: Number(m[2]) };
}

/** A FinishReasonV1 enum name (`FINISH_REASON_V1_EOS_TOKEN`) -> the enum value; absent = none. */
function finishReason(name: string | null | undefined): FinishReasonV1 | undefined {
  if (name === null || name === undefined) return undefined;
  const short = name.replace(/^FINISH_REASON_V1_/, '');
  const value = (FinishReasonV1 as unknown as Record<string, number | undefined>)[short];
  if (value === undefined || short === name) throw new Error(`unknown finish reason ${name}`);
  return value as FinishReasonV1;
}

/** The vector's expectation, with reasoning_content present only when the vector has one. */
function want(e: Expected): Record<string, unknown> {
  return {
    ...(e.reasoning_content !== undefined && e.reasoning_content !== null ? { reasoning_content: e.reasoning_content } : {}),
    content: e.content,
    tool_calls: e.tool_calls.map((c) => ({ name: c.name, arguments: c.arguments })),
  };
}

function refs(kind: Kind, file: VectorFile, v: Vector): { toolCallParser: ParserRef; reasoningParser: ParserRef } {
  return kind === 'reasoning'
    ? { toolCallParser: parseRef(v.tool_call_parser), reasoningParser: parseRef(file.parser) }
    : { toolCallParser: parseRef(file.parser), reasoningParser: parseRef(v.reasoning_parser) };
}

/** The input's UTF-8 bytes cut at `cuts`, each frame decoded as `streamOutput` decodes it. */
async function* frames(input: string, cuts: readonly number[], reason: FinishReasonV1 | undefined) {
  const bytes = new TextEncoder().encode(input);
  const bounds = [0, ...cuts, bytes.length];
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    yield { kind: 'chunk' as const, text: decoder.decode(bytes.subarray(bounds[i], bounds[i + 1]), { stream: true }) };
  }
  yield { kind: 'fin' as const, finishReason: reason };
}

async function streamed(
  input: string,
  cuts: readonly number[],
  reason: FinishReasonV1 | undefined,
  opts: ReturnType<typeof resolveParsers>,
): Promise<Record<string, unknown>> {
  let reasoning: string | undefined;
  let content = '';
  const calls: VectorCall[] = [];
  for await (const e of deriveAssistantStream(frames(input, cuts, reason), opts)) {
    if (e.kind === 'reasoning') reasoning = (reasoning ?? '') + e.text;
    else if (e.kind === 'content') content += e.text;
    else if (e.kind === 'tool-call-provisional') calls.push({ name: e.call.name, arguments: e.call.arguments });
  }
  return { ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}), content, tool_calls: calls };
}

for (const { file, kind } of FILES) {
  const data = JSON.parse(readFileSync(fileURLToPath(new URL(file, VECTOR_DIR)), 'utf8')) as VectorFile;

  describe(`wire parser vectors: ${file}`, () => {
    it('is the file this test expects', () => {
      expect(data.schema).toBe(kind === 'reasoning' ? 'trueopen-parser-reasoning-v1' : 'trueopen-parser-tool-call-v1');
      expect(data.vectors.length).toBeGreaterThan(0);
      expect(new Set(data.vectors.map((v) => v.name)).size).toBe(data.vectors.length);
    });

    for (const v of data.vectors) {
      describe(v.name, () => {
        const r = refs(kind, data, v);
        const reason = finishReason(v.finish_reason);
        const opts = resolveParsers(r);
        const expected = want(v.expected);

        it('resolves the parsers as the client does', () => {
          const reasoningSupported = r.reasoningParser.name === '' || r.reasoningParser.name === 'qwen3';
          // The Support rule: an unusable pinned reasoning parser takes the tool-call parser with it.
          expect(opts.parser.name).toBe(reasoningSupported ? r.toolCallParser.name : '');
          expect(opts.reasoning?.name).toBe(r.reasoningParser.name === 'qwen3' ? 'qwen3' : undefined);
        });

        it('complete path (deriveAssistantMessage)', () => {
          const m = deriveAssistantMessage(v.input_utf8, { ...opts, ...(reason !== undefined ? { finishReason: reason } : {}) });
          expect({
            ...(m.reasoningContent !== undefined ? { reasoning_content: m.reasoningContent } : {}),
            content: m.content,
            tool_calls: m.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
          }).toStrictEqual(expected);
        });

        for (const cuts of v.stream_splits ?? []) {
          it(`streaming path, splits ${JSON.stringify(cuts)}`, async () => {
            expect(await streamed(v.input_utf8, cuts, reason, opts)).toStrictEqual(expected);
          });
        }

        it('streaming path, one frame and one frame per byte', async () => {
          const n = new TextEncoder().encode(v.input_utf8).length;
          expect(await streamed(v.input_utf8, [], reason, opts)).toStrictEqual(expected);
          const everyByte = Array.from({ length: Math.max(n - 1, 0) }, (_, i) => i + 1);
          expect(await streamed(v.input_utf8, everyByte, reason, opts)).toStrictEqual(expected);
        });
      });
    }
  });
}
