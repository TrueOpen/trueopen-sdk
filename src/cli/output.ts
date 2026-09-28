import { TrueOpenError } from '../errors/errors';
import { toHex } from '../util/bytes';

/** JSON.stringify, with bigint -> decimal string and Uint8Array -> hex. */
export function toJsonSafe(value: unknown, indent = 2): string {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof Uint8Array) return toHex(v);
      return v;
    },
    indent,
  );
}

export interface FormattedError {
  readonly message: string;
  readonly code?: string;
  readonly family?: string;
  readonly category?: string;
  readonly retriable?: boolean;
  readonly switchSource?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly userAction?: string;
}

export function formatError(err: unknown): FormattedError {
  if (err instanceof TrueOpenError) {
    return {
      message: err.message,
      code: err.code,
      family: err.family,
      ...(err.category !== undefined ? { category: err.category } : {}),
      ...(err.retriable ? { retriable: true } : {}),
      ...(err.switchSource ? { switchSource: true } : {}),
      ...(err.details !== undefined ? { details: err.details } : {}),
      ...(err.userAction !== undefined ? { userAction: err.userAction } : {}),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { message };
}

/** Print the result to stdout (structured values are always shown as JSON). */
export function printResult(value: unknown): void {
  console.log(toJsonSafe(value));
}

/** Print the error to stderr: {error} JSON when --json is set, otherwise a human-readable form. */
export function printError(err: unknown, json: boolean): void {
  const f = formatError(err);
  if (json) {
    console.error(toJsonSafe({ error: f }));
  } else {
    console.error(`Error: ${f.code ? `[${f.code}] ` : ''}${f.message}`);
    if (f.userAction) console.error(`Suggestion: ${f.userAction}`);
  }
}
