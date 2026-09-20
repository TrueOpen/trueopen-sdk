export type ErrorFamily =
  | 'SDK_LOCAL'
  | 'SDK_AUTH'
  | 'NEXUS_INGRESS'
  | 'CHAIN_REJECT'
  | 'DATA'
  | 'CREDENTIAL'
  | 'CHALLENGE';

export interface TrueOpenErrorOptions {
  readonly retriable?: boolean;
  readonly userAction?: string;
  readonly cause?: unknown;
}

export class TrueOpenError extends Error {
  readonly family: ErrorFamily;
  readonly code: string;
  readonly retriable: boolean;
  readonly userAction: string | undefined;

  constructor(family: ErrorFamily, code: string, message: string, opts?: TrueOpenErrorOptions) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'TrueOpenError';
    this.family = family;
    this.code = code;
    this.retriable = opts?.retriable ?? false;
    this.userAction = opts?.userAction;
    Object.setPrototypeOf(this, TrueOpenError.prototype);
  }
}

/** Convenience constructor for data-plane errors (used by §5.7). */
export function dataError(code: string, message?: string): TrueOpenError {
  return new TrueOpenError('DATA', code, message ?? code, { retriable: true });
}
