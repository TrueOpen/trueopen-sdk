import { describe, it, expect } from 'vitest';
import { fanOutToEndpoints } from '../../src/transport/fan-out-submit';
import type { SubmitOrderAck } from '../../src/transport/ingress-client';

// fan-out is transparent to the request body (generic), so a minimal placeholder is enough.
const REQ = { marker: "req" };
const endpoints = [
  { address: 'A', rank: 1, serviceEndpoint: 'http://a:8080' },
  { address: 'B', rank: 2, serviceEndpoint: 'http://b:8080' },
  { address: 'C', rank: 3, serviceEndpoint: 'http://c:8080' },
];

describe('fanOutToEndpoints', () => {
  it('submits concurrently, succeeds if any one is accepted', async () => {
    const submit = async (endpoint: { serviceEndpoint: string }): Promise<SubmitOrderAck> =>
      ({ taskId: 't', accepted: endpoint.serviceEndpoint.includes('b'), reason: '', sessionId: 's' });
    const res = await fanOutToEndpoints(REQ, endpoints, submit);
    expect(res.accepted).toBe(true);
    expect(res.results).toHaveLength(3);
    expect(res.acceptedBy?.serviceEndpoint).toBe('http://b:8080');
  });

  it('throws with details when all fail/reject', async () => {
    const submit = async (): Promise<SubmitOrderAck> => { throw new Error('unreachable'); };
    await expect(fanOutToEndpoints(REQ, endpoints, submit)).rejects.toThrow(/TASK_BUILDER_ALL_ENDPOINTS_FAILED/);
  });
});
