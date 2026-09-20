import { TrueOpenError } from '../errors/errors';

/** Minimal endpoint constraint for fan-out: only requires a serviceEndpoint; tlsPubkeyHash is used to verify the certificate when connecting. */
export interface EndpointLike {
  readonly serviceEndpoint: string;
  readonly tlsPubkeyHash?: string;
}

/** Minimal constraint for an accept response. */
export interface AcceptedLike {
  readonly accepted: boolean;
}

export interface FanOutResultItem<E extends EndpointLike, A extends AcceptedLike> {
  readonly endpoint: E;
  readonly ack?: A;
  readonly error?: unknown;
}

export interface FanOutResult<E extends EndpointLike, A extends AcceptedLike> {
  readonly accepted: boolean;
  readonly acceptedBy?: E;
  readonly ack?: A;
  readonly results: FanOutResultItem<E, A>[];
}

/** Submitter for a single endpoint (the caller builds a transport + IngressClient from the endpoint's serviceEndpoint / tlsPubkeyHash). */
export type EndpointSubmit<E extends EndpointLike, Req, A extends AcceptedLike> = (endpoint: E, request: Req) => Promise<A>;

/**
 * Sends the same already-signed request concurrently to every selected Task Builder endpoint.
 * Any single accepted response counts as overall success.
 * If all fail, throws TASK_BUILDER_ALL_ENDPOINTS_FAILED (with per-endpoint detail attached).
 *
 * We send to all endpoints rather than just the top-ranked one: the order content is already
 * fixed by its signature, so who receives it doesn't change anything, and sending to more
 * endpoints only improves delivery odds.
 */
export async function fanOutToEndpoints<E extends EndpointLike, Req, A extends AcceptedLike>(
  request: Req,
  endpoints: readonly E[],
  submit: EndpointSubmit<E, Req, A>,
): Promise<FanOutResult<E, A>> {
  const settled = await Promise.allSettled(endpoints.map((e) => submit(e, request)));
  const results: FanOutResultItem<E, A>[] = settled.map((s, i) => {
    const endpoint = endpoints[i] as E;
    return s.status === 'fulfilled' ? { endpoint, ack: s.value } : { endpoint, error: s.reason };
  });
  const hit = results.find((r) => r.ack?.accepted === true);
  if (hit && hit.ack) return { accepted: true, acceptedBy: hit.endpoint, ack: hit.ack, results };
  throw new TrueOpenError(
    'NEXUS_INGRESS',
    'TASK_BUILDER_ALL_ENDPOINTS_FAILED',
    `TASK_BUILDER_ALL_ENDPOINTS_FAILED: no selected Task Builder accepted the order (${results.length} tried)`,
    { retriable: true },
  );
}
