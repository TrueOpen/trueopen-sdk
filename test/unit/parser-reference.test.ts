/**
 * Differential corpus against vLLM's and Dynamo's own hermes / qwen3 parser tests.
 *
 * This is NOT conformance: wire's shared vectors are the authority, and hermes@1 / qwen3@1
 * stay `unverified`. Each case pins (a) what the SDK produces today and (b) the verdict of
 * comparing it with what the reference test asserts, so any behaviour change -- towards or
 * away from a reference -- fails here and has to be re-judged in the fixture.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compareWithReference,
  runCase,
  runComplete,
  runStream,
  splitFixed,
  type ReferenceCase,
} from '../helpers/parser-reference';

const fixturePath = fileURLToPath(new URL('../fixtures/reference/parser-reference-cases.json', import.meta.url));
const corpus = JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: ReferenceCase[] };

describe('parser reference corpus (vLLM / Dynamo)', () => {
  it('is well-formed', () => {
    const ids = new Set<string>();
    for (const c of corpus.cases) {
      expect(ids.has(c.id), `duplicate id ${c.id}`).toBe(false);
      ids.add(c.id);
      expect(['vllm', 'dynamo']).toContain(c.source);
      expect(['hermes@1', 'qwen3@1', 'qwen3+hermes']).toContain(c.parser);
      expect(['agree', 'divergent-by-spec', 'divergent-unexplained', 'not-applicable']).toContain(c.verdict);
      expect(c.reason.length, `${c.id}: every verdict carries a reason`).toBeGreaterThan(0);
      if (c.mode === 'complete') expect(typeof c.input).toBe('string');
      else expect(Array.isArray(c.input)).toBe(true);
    }
    expect(corpus.cases.length).toBeGreaterThan(0);
  });

  for (const c of corpus.cases) {
    describe(c.id, () => {
      it(`pins the SDK outcome and the verdict (${c.verdict})`, async () => {
        const run = await runCase(c);
        expect(run.actual).toEqual(c.sdk_actual);
        if (c.sdk_steps !== undefined) expect(run.steps).toEqual(c.sdk_steps);

        const mismatches = compareWithReference(c, run);
        if (c.verdict === 'agree') expect(mismatches).toEqual([]);
        else if (c.verdict !== 'not-applicable') expect(mismatches.length).toBeGreaterThan(0);
      });

      if (c.mode === 'stream' && c.finish !== false) {
        // Design S7 requirement 1: a frame boundary is the Worker's choice and must not change
        // the parse. Streaming with the reference's deltas must equal the full-text parse.
        it('streaming agrees with the full-text parse', async () => {
          const frames = c.input as readonly string[];
          const full = runComplete(c.parser, frames.join(''));
          expect((await runStream(c.parser, frames, true)).actual).toEqual(full);
          if (c.substituted_deltas === true) {
            // The reference's tokenizer deltas are substituted, so every fixed width must agree.
            for (let w = 1; w <= 8; w += 1) {
              expect((await runStream(c.parser, splitFixed(frames.join(''), w), true)).actual).toEqual(full);
            }
          }
        });
      }
    });
  }
});
