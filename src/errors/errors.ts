export type ErrorFamily =
  | 'SDK_LOCAL'
  | 'SDK_AUTH'
  | 'NEXUS_INGRESS'
  | 'CHAIN_REJECT'
  | 'DATA'
  | 'CHALLENGE';

/**
 * What kind of failure this is, independent of which component raised it. Set on errors the
 * SDK classifies (nexus Connect errors, chain CheckTx failures); undefined elsewhere.
 */
export type ErrorCategory =
  /** The request did not get an answer: connection, timeout, overload on the wire. */
  | 'transport'
  /** Signature, identity or permission refused. */
  | 'auth'
  /** The request's validity window passed; a freshly signed request can succeed. */
  | 'expired'
  /** The peer does not have it; another peer might. */
  | 'not-found'
  /** The peer has it or will, but cannot serve it right now. */
  | 'data-unavailable'
  /** The peer is out of capacity for now. */
  | 'capacity'
  /** The request itself is wrong; repeating it anywhere fails the same way. */
  | 'invalid'
  /** It already exists under different content. */
  | 'conflict'
  /** The peer served data that does not verify. */
  | 'data-corrupt'
  /** The chain refused a transaction. */
  | 'chain-rejected'
  /** A peer failure without a more specific class. */
  | 'internal';

export interface TrueOpenErrorOptions {
  readonly retriable?: boolean;
  /**
   * The peer that answered cannot be trusted or cannot serve this: move to another source
   * (another Builder) instead of repeating the call against the same one.
   */
  readonly switchSource?: boolean;
  readonly category?: ErrorCategory;
  /** Structured details from the underlying failure (for example a chain code and log). */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly userAction?: string;
  readonly cause?: unknown;
}

export class TrueOpenError extends Error {
  readonly family: ErrorFamily;
  readonly code: string;
  /** Repeating the same call against the same peer may succeed. */
  readonly retriable: boolean;
  /** Repeating against the same peer will not help, but another source might. */
  readonly switchSource: boolean;
  readonly category: ErrorCategory | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly userAction: string | undefined;

  constructor(family: ErrorFamily, code: string, message: string, opts?: TrueOpenErrorOptions) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'TrueOpenError';
    this.family = family;
    this.code = code;
    this.retriable = opts?.retriable ?? false;
    this.switchSource = opts?.switchSource ?? false;
    this.category = opts?.category;
    this.details = opts?.details;
    this.userAction = opts?.userAction;
    Object.setPrototypeOf(this, TrueOpenError.prototype);
  }
}

/**
 * Convenience constructor for data-plane errors: the peer served something that does not
 * verify, or does not have the object. Retrying the same peer returns the same bytes, so
 * these are not retriable; they say to switch to another source.
 */
export function dataError(code: string, message?: string): TrueOpenError {
  return new TrueOpenError('DATA', code, message ?? code, { switchSource: true, category: 'data-corrupt' });
}
