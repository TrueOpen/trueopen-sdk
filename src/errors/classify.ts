import { ConnectError, Code } from '@connectrpc/connect';
import { TrueOpenError } from './errors';
import type { ErrorCategory, ErrorFamily } from './errors';

interface Rule {
  readonly category: ErrorCategory;
  readonly retriable: boolean;
  readonly switchSource: boolean;
}

const rule = (category: ErrorCategory, retriable: boolean, switchSource: boolean): Rule => ({ category, retriable, switchSource });

/**
 * nexus puts a stable code at the start of its error messages ("NEXUS_DATA_EXPIRED: ...").
 * That code is more precise than the Connect code, so it wins when present.
 */
const BY_NEXUS_CODE: Readonly<Record<string, Rule>> = {
  SDK_AUTH_INVALID_SIGNATURE: rule('auth', false, false),
  SDK_AUTH_EXPIRED: rule('expired', true, false),
  // A replayed nonce: a new request with a fresh nonce is fine.
  SDK_AUTH_REPLAY: rule('auth', true, false),
  NEXUS_DATA_UNAUTHORIZED: rule('auth', false, false),
  NEXUS_OUTPUT_UNAUTHORIZED: rule('auth', false, false),
  NEXUS_DATA_EXPIRED: rule('expired', true, false),
  NEXUS_DATA_NOT_FOUND: rule('not-found', false, true),
  // This Builder was not selected for the task; the selected ones have it.
  NEXUS_INGRESS_NOT_SELECTED_BUILDER: rule('not-found', false, true),
  NEXUS_DATA_NOT_READY: rule('data-unavailable', true, false),
  NEXUS_DATA_SERVICE_KEY_UNAVAILABLE: rule('data-unavailable', true, true),
  NEXUS_DATA_AUTHORITY_UNAVAILABLE: rule('data-unavailable', true, true),
  NEXUS_INGRESS_STAGE1_UNAVAILABLE: rule('data-unavailable', true, true),
  NEXUS_INGRESS_SERVICE_KEY_AUTHORITY_UNAVAILABLE: rule('data-unavailable', true, true),
  NEXUS_DATA_STREAM_INTERRUPTED: rule('transport', true, true),
  NEXUS_OUTPUT_STREAM_STOPPED: rule('data-unavailable', true, true),
  NEXUS_OUTPUT_STREAM_DISABLED: rule('data-unavailable', false, true),
  NEXUS_DATA_CAPACITY: rule('capacity', true, true),
  NEXUS_OUTPUT_SUBSCRIBER_OVERFLOW: rule('capacity', true, false),
  NEXUS_DATA_MALFORMED: rule('invalid', false, false),
  NEXUS_INGRESS_MALFORMED: rule('invalid', false, false),
  NEXUS_DATA_RANGE_INVALID: rule('invalid', false, false),
  NEXUS_INGRESS_ORDER_HAS_NO_TASK_HASH: rule('invalid', false, false),
  NEXUS_DATA_CONFLICT: rule('conflict', false, false),
  NEXUS_DATA_HASH_MISMATCH: rule('data-corrupt', false, true),
  NEXUS_DATA_STORAGE: rule('internal', false, true),
};

/** Fallback by Connect code when the message carries no nexus code (or an unknown one). */
function byConnectCode(code: Code): Rule {
  switch (code) {
    case Code.Unavailable:
    case Code.Aborted:
      return rule('transport', true, true);
    case Code.DeadlineExceeded:
      // nexus maps an expired request window to DeadlineExceeded too; either way a new
      // request is the fix.
      return rule('expired', true, false);
    case Code.ResourceExhausted:
      return rule('capacity', true, true);
    case Code.Unauthenticated:
    case Code.PermissionDenied:
      return rule('auth', false, false);
    case Code.NotFound:
      return rule('not-found', false, true);
    case Code.AlreadyExists:
      return rule('conflict', false, false);
    case Code.InvalidArgument:
    case Code.OutOfRange:
    case Code.FailedPrecondition:
    case Code.Unimplemented:
      return rule('invalid', false, false);
    case Code.DataLoss:
      return rule('data-corrupt', false, true);
    case Code.Canceled:
      return rule('transport', false, false);
    default:
      // Internal / Unknown: the peer failed without saying why.
      return rule('internal', false, true);
  }
}

/**
 * A failure that never reached a server answer. Connect wraps the local error as
 * Unknown/Internal with the original as `cause` (for example a TLS failure), except that
 * connect-node reports a socket error (refused connection, reset, unreachable host) as
 * Unavailable, again with the socket error as `cause`. An error decoded from the server's
 * response has no cause, so a server-sent Unavailable is not mistaken for a local one.
 */
function isClientSideFailure(err: ConnectError): boolean {
  if (err.cause === undefined) return false;
  if (err.code === Code.Unknown || err.code === Code.Internal) return true;
  return err.code === Code.Unavailable && isSocketError(err.cause);
}

/** A Node.js system error from the socket layer: it carries a `syscall` or an `E...` errno code. */
function isSocketError(cause: unknown): boolean {
  if (cause === null || typeof cause !== 'object') return false;
  const c = cause as { syscall?: unknown; code?: unknown };
  return typeof c.syscall === 'string' || (typeof c.code === 'string' && /^E[A-Z]+$/.test(c.code));
}

/**
 * Transport failure. Retriable, unless the SDK refused the connection on purpose (a
 * TrueOpenError in the cause chain, for example a certificate that does not match the
 * on-chain fingerprint): that fails the same way until the peer changes.
 */
function clientSideRule(err: ConnectError): Rule {
  let current: unknown = err.cause;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof TrueOpenError) return rule('transport', false, true);
    current = (current as { cause?: unknown }).cause;
  }
  return rule('transport', true, true);
}

/** The leading `NEXUS_*` / `SDK_*` code of a nexus error message, if any. */
export function nexusErrorCode(message: string): string | undefined {
  const m = /^(?:\[[a-z_]+\]\s*)?((?:NEXUS|SDK)_[A-Z0-9_]+)(?::|$|\s)/.exec(message);
  return m?.[1];
}

/**
 * Turns an error from a nexus call into a typed TrueOpenError.
 *
 * `code` is the nexus code from the message when there is one (for example
 * `NEXUS_DATA_EXPIRED`), `NEXUS_TRANSPORT_FAILED` for a local failure that got no answer, and
 * `NEXUS_CONNECT_<CONNECT_CODE>` otherwise. `category`, `retriable` and
 * `switchSource` say what to do about it. The original error stays as `cause`, so a
 * certificate mismatch underneath is still found by walking the cause chain. A TrueOpenError
 * is returned unchanged, and anything that is not a Connect error is left alone.
 */
export function classifyNexusError(err: unknown): unknown {
  if (err instanceof TrueOpenError) return err;
  if (!(err instanceof ConnectError)) return err;
  // A local failure's message is not a nexus answer, so no code is read from it.
  const local = isClientSideFailure(err);
  const nexusCode = local ? undefined : nexusErrorCode(err.rawMessage);
  const known = nexusCode !== undefined ? BY_NEXUS_CODE[nexusCode] : undefined;
  const r = known ?? (local ? clientSideRule(err) : byConnectCode(err.code));
  const family: ErrorFamily = r.category === 'auth' ? 'SDK_AUTH' : r.category === 'data-corrupt' ? 'DATA' : 'NEXUS_INGRESS';
  const code = local
    ? 'NEXUS_TRANSPORT_FAILED'
    : nexusCode ?? `NEXUS_CONNECT_${Code[err.code]?.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase() ?? String(err.code)}`;
  return new TrueOpenError(family, code, err.rawMessage || err.message, {
    retriable: r.retriable,
    switchSource: r.switchSource,
    category: r.category,
    details: { connectCode: Code[err.code] ?? err.code },
    cause: err,
  });
}

/** CosmJS BroadcastTxError, matched by shape so a second copy of @cosmjs/stargate still matches. */
interface BroadcastTxErrorLike {
  readonly code: number;
  readonly codespace: string;
  readonly log: string | undefined;
}

function isBroadcastTxError(e: unknown): e is Error & BroadcastTxErrorLike {
  if (!(e instanceof Error)) return false;
  const o = e as unknown as Record<string, unknown>;
  return (e.name === 'BroadcastTxError' || e.constructor?.name === 'BroadcastTxError') &&
    typeof o['code'] === 'number' && typeof o['codespace'] === 'string';
}

/**
 * Turns a CheckTx failure (CosmJS `BroadcastTxError`) into `CHAIN_TX_REJECTED`, keeping the
 * codespace, code and log in `details`. The transaction never entered the mempool, so an
 * account sequence mismatch (sdk code 32) is safe to re-sign and retry; everything else will
 * be rejected the same way again. Other errors are returned unchanged.
 */
export function classifyBroadcastError(err: unknown): unknown {
  if (!isBroadcastTxError(err)) return err;
  const sequenceMismatch = err.codespace === 'sdk' && err.code === 32;
  return new TrueOpenError(
    'CHAIN_REJECT',
    'CHAIN_TX_REJECTED',
    `tx rejected by CheckTx (codespace ${err.codespace}, code ${err.code}): ${err.log ?? ''}`,
    {
      retriable: sequenceMismatch,
      category: 'chain-rejected',
      details: { codespace: err.codespace, code: err.code, log: err.log },
      cause: err,
    },
  );
}
