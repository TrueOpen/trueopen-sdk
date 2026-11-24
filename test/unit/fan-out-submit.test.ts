import { describe, it, expect } from 'vitest';
import { fanOutToEndpoints, TaskBuilderAllEndpointsFailedError } from '../../src/transport/fan-out-submit';
import { TrueOpenError } from '../../src/errors/errors';
import type { OpenTaskAck } from '../../src/transport/ingress-client';

// fan-out is transparent to the request body (generic), so a minimal placeholder is enough.
const REQ = { marker: "req" };
const endpoints = [
  { address: 'A', rank: 1, serviceEndpoint: 'http://a:8080' },
  { address: 'B', rank: 2, serviceEndpoint: 'http://b:8080' },
  { address: 'C', rank: 3, serviceEndpoint: 'http://c:8080' },
];

describe('fanOutToEndpoints', () => {
  it('submits concurrently, succeeds if any one is accepted', async () => {
    const submit = async (endpoint: { serviceEndpoint: string }): Promise<OpenTaskAck> =>
      ({ taskId: 't', accepted: endpoint.serviceEndpoint.includes('b'), reason: '', sessionId: 's' });
    const res = await fanOutToEndpoints(REQ, endpoints, submit);
    expect(res.accepted).toBe(true);
    expect(res.results).toHaveLength(3);
    expect(res.acceptedBy?.serviceEndpoint).toBe('http://b:8080');
  });

  // This test used to assert only that the message matched, which is how the
  // thrown error came to carry no detail at all despite its name.
  it('throws with details when all fail/reject', async () => {
    const submit = async (endpoint: { serviceEndpoint: string }): Promise<OpenTaskAck> => {
      // One endpoint answers with a rejection ACK, the others throw: both
      // outcomes have to survive on the thrown error.
      if (endpoint.serviceEndpoint.includes('b')) {
        return { taskId: 't', accepted: false, reason: 'NEXUS_DATA_EXPIRED: request height', sessionId: 's' };
      }
      throw new Error(`unreachable ${endpoint.serviceEndpoint}`);
    };

    const err = await fanOutToEndpoints(REQ, endpoints, submit).then(
      () => { throw new Error('expected a rejection'); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TaskBuilderAllEndpointsFailedError);
    const failure = err as TaskBuilderAllEndpointsFailedError<(typeof endpoints)[number], OpenTaskAck>;
    expect(failure.code).toBe('TASK_BUILDER_ALL_ENDPOINTS_FAILED');
    expect(failure.retriable).toBe(true);
    // The base constructor sets name to TrueOpenError, so the subclass has to
    // restate it or it is invisible in stacks and to anything reading err.name.
    expect(failure.name).toBe('TaskBuilderAllEndpointsFailedError');
    // Subclassing must not break the family check callers switch on.
    expect(failure).toBeInstanceOf(TrueOpenError);

    // Every endpoint is inspectable, in the order they were tried.
    expect(failure.results).toHaveLength(3);
    expect(failure.results.map((r) => r.endpoint.serviceEndpoint)).toEqual([
      'http://a:8080', 'http://b:8080', 'http://c:8080',
    ]);

    // The rejection ACK is kept as an ack, not flattened into an error.
    const rejected = failure.results[1]!;
    expect(rejected.ack?.accepted).toBe(false);
    expect(rejected.ack?.reason).toBe('NEXUS_DATA_EXPIRED: request height');
    expect(rejected.error).toBeUndefined();

    // The thrown errors are kept verbatim.
    expect((failure.results[0]!.error as Error).message).toBe('unreachable http://a:8080');
    expect((failure.results[2]!.error as Error).message).toBe('unreachable http://c:8080');

    // And the standard Error chain still reaches one of them.
    expect((failure.cause as Error).message).toBe('unreachable http://a:8080');
  });

  it('names every Builder and its reason in the message and in details.rejections', async () => {
    const noCapacity = new TrueOpenError('NEXUS_INGRESS', 'NEXUS_INGRESS_NO_CAPACITY', 'NEXUS_INGRESS_NO_CAPACITY: no admitted handraise for model m profile 2');
    const bareCode = new TrueOpenError('NEXUS_INGRESS', 'NEXUS_INGRESS_TAKEOVER_PENDING', 'takeover pending');
    const submit = async (endpoint: { address: string }): Promise<OpenTaskAck> => {
      if (endpoint.address === 'A') throw noCapacity;
      if (endpoint.address === 'B') return { taskId: 't', accepted: false, reason: 'NEXUS_DATA_EXPIRED: request height', sessionId: 's' };
      throw bareCode;
    };
    const err = (await fanOutToEndpoints(REQ, endpoints, submit).catch((e: unknown) => e)) as TaskBuilderAllEndpointsFailedError<(typeof endpoints)[number], OpenTaskAck>;
    expect(err.message).toBe(
      'TASK_BUILDER_ALL_ENDPOINTS_FAILED: no selected Task Builder accepted the order (3 tried): ' +
        'A: NEXUS_INGRESS_NO_CAPACITY: no admitted handraise for model m profile 2; ' +
        'B: not accepted: NEXUS_DATA_EXPIRED: request height; ' +
        'C: NEXUS_INGRESS_TAKEOVER_PENDING: takeover pending',
    );
    expect(err.details?.rejections).toEqual([
      { endpoint: 'A', code: 'NEXUS_INGRESS_NO_CAPACITY', reason: 'NEXUS_INGRESS_NO_CAPACITY: no admitted handraise for model m profile 2' },
      { endpoint: 'B', reason: 'not accepted: NEXUS_DATA_EXPIRED: request height' },
      { endpoint: 'C', code: 'NEXUS_INGRESS_TAKEOVER_PENDING', reason: 'NEXUS_INGRESS_TAKEOVER_PENDING: takeover pending' },
    ]);
  });

  it('labels an endpoint without an address by its serviceEndpoint and clips long reasons in the message only', async () => {
    const long = 'x'.repeat(400);
    const err = (await fanOutToEndpoints(REQ, [{ serviceEndpoint: 'http://z:8080' }], async () => {
      throw new Error(long);
    }).catch((e: unknown) => e)) as TaskBuilderAllEndpointsFailedError<{ serviceEndpoint: string }, OpenTaskAck>;
    expect(err.message).toBe(`TASK_BUILDER_ALL_ENDPOINTS_FAILED: no selected Task Builder accepted the order (1 tried): http://z:8080: ${'x'.repeat(300)}...`);
    expect(err.details?.rejections).toEqual([{ endpoint: 'http://z:8080', reason: long }]);
  });
});
