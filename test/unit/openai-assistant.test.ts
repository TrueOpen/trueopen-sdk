import { describe, expect, it } from 'vitest';
import { FinishReasonV1 } from '../../src/gen/task/v1/evidence_pb.js';
import { newToolCallId, openAIFinishReasonOf } from '../../src/output/openai-assistant';
import type { ConfirmedAssistantMessage } from '../../src/toolcall/types';

function confirmed(finishReason: FinishReasonV1 | undefined, calls = 0): ConfirmedAssistantMessage {
  return {
    role: 'assistant', content: '',
    toolCalls: Array.from({ length: calls }, (_, i) => ({ name: `f${i}`, arguments: '{}' })),
    confirmation: {
      type: 'confirmed', taskId: 'a'.repeat(64), taskHash: 'b'.repeat(64), winnerWorker: 'w', inferReceiptHash: 'c'.repeat(64),
      outputHash: 'd'.repeat(64), outputMmrRoot: new Uint8Array(32), outputLeafCount: 1n, outputSizeBytes: 0n,
    },
    ...(finishReason !== undefined ? { finishReason } : {}),
  };
}

describe('openAIFinishReasonOf (sdk_详细设计 §5.5)', () => {
  const stopClass = [FinishReasonV1.EOS_TOKEN, FinishReasonV1.STOP_SEQUENCE, FinishReasonV1.STOP_TOKEN, FinishReasonV1.USER_STOP];

  it('maps a stop-class reason to stop, or tool_calls when the confirmed parse has calls', () => {
    for (const r of stopClass) {
      expect(openAIFinishReasonOf(confirmed(r))).toBe('stop');
      expect(openAIFinishReasonOf(confirmed(r, 2))).toBe('tool_calls');
    }
  });

  it('maps a cut-off output to length, even when closed calls were parsed', () => {
    for (const r of [FinishReasonV1.MAX_OUTPUT_TOKENS, FinishReasonV1.MAX_OUTPUT_DURATION]) {
      expect(openAIFinishReasonOf(confirmed(r))).toBe('length');
      expect(openAIFinishReasonOf(confirmed(r, 1))).toBe('length');
    }
  });

  it('is undefined when the protocol reason is unavailable, never a guess', () => {
    expect(openAIFinishReasonOf(confirmed(undefined))).toBeUndefined();
    expect(openAIFinishReasonOf(confirmed(undefined, 1))).toBeUndefined();
  });

  it('refuses a reason outside the closed set', () => {
    expect(() => openAIFinishReasonOf(confirmed(FinishReasonV1.UNSPECIFIED))).toThrow();
  });
});

describe('newToolCallId', () => {
  it('follows call_id_format', () => {
    expect(newToolCallId('OPENAI_CALL_PREFIX')).toMatch(/^call_[A-Za-z0-9]{24}$/);
    expect(newToolCallId('MISTRAL_ALNUM_9')).toMatch(/^[A-Za-z0-9]{9}$/);
  });

  it('is random per call', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newToolCallId('MISTRAL_ALNUM_9')));
    expect(ids.size).toBe(200);
  });

  it('refuses an unknown format', () => {
    expect(() => newToolCallId('UUID' as never)).toThrow(expect.objectContaining({ code: 'SDK_LOCAL_CALL_ID_FORMAT_INVALID' }));
  });
});
