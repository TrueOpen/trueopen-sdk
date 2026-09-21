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

/**
 * Thrown when no selected Task Builder accepted the order.
 *
 * Carries the per-endpoint outcome, because the aggregate message cannot say
 * which Builder rejected and why. Three Builders all answering
 * NEXUS_DATA_EXPIRED is a different problem from three of them being
 * unreachable, and a caller should not have to parse a message to tell them
 * apart.
 */
export class TaskBuilderAllEndpointsFailedError<
  E extends EndpointLike,
  A extends AcceptedLike,
> extends TrueOpenError {
  /** One entry per endpoint, in the order they were tried. */
  readonly results: readonly FanOutResultItem<E, A>[];

  constructor(results: readonly FanOutResultItem<E, A>[]) {
    super(
      'NEXUS_INGRESS',
      'TASK_BUILDER_ALL_ENDPOINTS_FAILED',
      `TASK_BUILDER_ALL_ENDPOINTS_FAILED: no selected Task Builder accepted the order (${results.length} tried)`,
      // The cause is the first endpoint that threw in **endpoint order** --
      // results mirrors the endpoint list, not completion order -- so the
      // standard Error chain keeps working; every endpoint's outcome is on
      // results.
      { retriable: true, cause: results.find((r) => r.error !== undefined)?.error },
    );
    this.results = results;
    // TrueOpenError's constructor sets name to its own; without this the
    // subclass is invisible in stacks and in anything that reads err.name.
    this.name = 'TaskBuilderAllEndpointsFailedError';
    Object.setPrototypeOf(this, TaskBuilderAllEndpointsFailedError.prototype);
  }
}

/** Submitter for a single endpoint (the caller builds a transport + IngressClient from the endpoint's serviceEndpoint / tlsPubkeyHash). */
export type EndpointSubmit<E extends EndpointLike, Req, A extends AcceptedLike> = (endpoint: E, request: Req) => Promise<A>;

/**
 * Sends the same already-signed request concurrently to every selected Task Builder endpoint.
 * Any single accepted response counts as overall success.
 * If all fail, throws TaskBuilderAllEndpointsFailedError, whose results carry each
 * endpoint's ack or error.
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
  throw new TaskBuilderAllEndpointsFailedError(results);
}
