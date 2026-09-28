import { describe, it, expect, vi } from 'vitest';
import type { CliConfig } from '../../src/cli/config';

const calls = { anchors: 0, fetches: [] as Record<string, unknown>[], streams: [] as Record<string, unknown>[] };
const ANCHORS = { taskId: 't', taskHash: 'c'.repeat(64), winnerWorker: 'w', workerServicePubKey: new Uint8Array(33), outputHash: 'e'.repeat(64) };

vi.mock('../../src/cli/context', () => ({
  queryAcrossNexus: vi.fn(),
  buildContext: vi.fn(async () => {
    const client = {
      resolveOutputTrustAnchors: async () => {
        calls.anchors += 1;
        return ANCHORS;
      },
      fetchTaskOutput: async (p: Record<string, unknown>) => {
        calls.fetches.push(p);
        if (p['builderAddress'] === 'b1') throw new Error('not here');
        return { taskHash: ANCHORS.taskHash, sizeBytes: 2n, mediaType: 'text/plain', outputHash: ANCHORS.outputHash, chunks: [new Uint8Array(2)], text: 'hi' };
      },
      async *streamOutput(p: Record<string, unknown>) {
        calls.streams.push(p);
        yield { kind: 'fin', attested: true, finishReason: 1 };
      },
      ingress: {},
    };
    return {
      client,
      clientFor: () => client,
      nexusEndpoints: [
        { serviceEndpoint: 'https://b1', tlsPubkeyHash: '', builderAddress: 'b1' },
        { serviceEndpoint: 'https://b2', tlsPubkeyHash: '', builderAddress: 'b2' },
      ],
      dispose: async () => {},
    };
  }),
}));

const { cmdOutputGet, cmdOutputStream } = await import('../../src/cli/commands/output');
const cfg = {} as unknown as CliConfig;

describe('output get / output stream', () => {
  it('output get reads the anchors from chain once and leaves the expiry to the SDK (height + 10)', async () => {
    const res = (await cmdOutputGet(cfg, 'm', 's', 't')) as { builderAddress: string; text: string };
    expect(res).toMatchObject({ builderAddress: 'b2', text: 'hi' });
    expect(calls.anchors).toBe(1);
    expect(calls.fetches.map((f) => f['builderAddress'])).toEqual(['b1', 'b2']);
    for (const f of calls.fetches) {
      expect(f['anchors']).toBe(ANCHORS);
      expect(f['expiresAtHeight']).toBeUndefined();
      expect(f['taskHash']).toBeUndefined();
    }
  });

  it('output get with both hashes given does not read the chain anchors', async () => {
    calls.anchors = 0;
    calls.fetches = [];
    await cmdOutputGet(cfg, 'm', 's', 't', 'a'.repeat(64), 'b'.repeat(64));
    expect(calls.anchors).toBe(0);
    expect(calls.fetches[0]).toMatchObject({ taskHash: 'a'.repeat(64), outputHash: 'b'.repeat(64) });
  });

  it('output stream needs no task hash or worker key from the user', async () => {
    await cmdOutputStream(cfg, 'm', 's', 't', undefined, undefined, true);
    expect(calls.streams[0]?.['taskHash']).toBeUndefined();
    expect(calls.streams[0]?.['workerServicePubKey']).toBeUndefined();
  });
});
