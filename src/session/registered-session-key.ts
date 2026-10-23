import { secp256k1 } from '@noble/curves/secp256k1';
import { ethAddressBytes } from '../signer/eth-secp256k1';
import { privateKeyTypedDataSigner } from '../signer/typed-data-signer';
import type { TypedDataSigner } from '../signer/typed-data-signer';
import { isHash32Text } from '../codec/hash32';
import { toHex } from '../util/bytes';
import { TrueOpenError } from '../errors/errors';

/**
 * Registered session keys (ADR-0037, wire SESSION_KEYS_V1).
 *
 * A registered key is a secp256k1 key whose 20-byte eth-style address the user registers on
 * chain for one session (MsgCreateSession.session_key / MsgUpdateSessionKey). Until it expires
 * or is cleared, it signs that session's orders and its session-allowed requests in place of the
 * wallet. The order's EIP-712 domain, types and digest are unchanged; only the recovered address
 * differs. A registered-key request carries signer_address = the user, sessionGrantHash = 32 zero
 * bytes and no SessionGrant: the on-chain registration authorizes it.
 *
 * The SDK generates the key from a CSPRNG (never derived from a signature) and keeps it in memory
 * only; the caller persists the 32-byte private key and reloads it with registeredSessionKey.
 */

/** A fresh or reloaded key pair. */
export interface SessionKeyMaterial {
  /** 32 bytes; the caller persists it. */
  readonly privateKey: Uint8Array;
  /** The 20-byte eth-style address of the key: what is registered on chain. */
  readonly address: Uint8Array;
}

function invalid(what: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_SESSION_KEY_INVALID', `session key: ${what}`);
}

/** A new session key from a CSPRNG. */
export function generateSessionKey(): SessionKeyMaterial {
  return sessionKeyFromPrivateKey(secp256k1.utils.randomPrivateKey());
}

/** The key pair of a persisted private key: exactly 32 bytes, in [1, n-1]. */
export function sessionKeyFromPrivateKey(privateKey: Uint8Array): SessionKeyMaterial {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
    throw invalid(`a private key is 32 bytes, got ${privateKey instanceof Uint8Array ? privateKey.length : typeof privateKey}`);
  }
  if (!secp256k1.utils.isValidPrivateKey(privateKey)) throw invalid('the private key is zero or not below the curve order');
  const key = Uint8Array.from(privateKey);
  return { privateKey: key, address: ethAddressBytes(secp256k1.getPublicKey(key, true)) };
}

/** A key loaded for one session: what signing code consumes. */
export interface RegisteredSessionKey {
  /** Hash32 text, `0x` + 64 lowercase hex. */
  readonly sessionId: string;
  /** The 20-byte address every signature must recover to. */
  readonly address: Uint8Array;
  readonly signer: TypedDataSigner;
}

/** Loads `privateKey` as the registered key of `sessionId`. */
export function registeredSessionKey(sessionId: string, privateKey: Uint8Array): RegisteredSessionKey {
  if (!isHash32Text(sessionId)) throw invalid(`session_id must be 0x + 64 lowercase hex, got ${JSON.stringify(sessionId)}`);
  const m = sessionKeyFromPrivateKey(privateKey);
  return { sessionId, address: m.address, signer: privateKeyTypedDataSigner(m.privateKey) };
}

export interface RegisteredSessionKeysOptions {
  /**
   * Reads the latest block height, for the request-side expiry check (forRequest). Without it
   * the expiry is not checked for requests and a loaded key always signs them.
   */
  readonly latestHeight?: () => Promise<bigint>;
  /**
   * How long an observed latest height may be reused, in milliseconds (default 1000, about one
   * block); an older one is read again. The expiry margin covers the blocks a reused height lags.
   */
  readonly heightMaxAgeMs?: number;
  /**
   * Blocks of margin before the expiry (default 3): a request is key-signed only while
   * `latest + margin <= expiry`. A request reaches a Builder a moment after it is signed, the
   * height it was judged against can be a block or two old (about 0.5 s blocks on testnet), and
   * the Builder refuses an expired key with a final error; inside the margin the request falls
   * back to the grant or the wallet instead.
   */
  readonly expiryMarginBlocks?: number;
  /** Clock, for tests. */
  readonly now?: () => number;
  /**
   * Delay before re-sending a key-signed request a Builder refused inside the key-change window
   * (see retryAfterKeyChange), in milliseconds; default DEFAULT_KEY_CHANGE_RETRY_DELAY_MS
   * (about one block).
   */
  readonly keyChangeRetryDelayMs?: number;
  /** Most re-sends of one request inside the key-change window; default DEFAULT_KEY_CHANGE_RETRY_ATTEMPTS. */
  readonly keyChangeRetryAttempts?: number;
  /** Sleep, for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * How many blocks a Builder (nexus) may keep using a session's cached key state after a key
 * change: nexus caps its session-key cache TTL at this many blocks (config
 * MaxSessionKeyCacheTTLBlocks; the default TTL is 5). Until the latest height reaches the change
 * height plus this, a Builder may still judge a key-signed request against the old key or the
 * old expiry.
 */
export const MAX_SESSION_KEY_CACHE_TTL_BLOCKS = 10n;

/** The default of RegisteredSessionKeysOptions.keyChangeRetryDelayMs: about one block. */
export const DEFAULT_KEY_CHANGE_RETRY_DELAY_MS = 1000;

/** The default of RegisteredSessionKeysOptions.keyChangeRetryAttempts. */
export const DEFAULT_KEY_CHANGE_RETRY_ATTEMPTS = 10;

/**
 * The answers a Builder gives a key-signed request while its cached session state predates a key
 * change: the new key is not the cached one (INVALID_SIGNATURE), or the cached expiry is the one
 * before a renew (GRANT_EXPIRED).
 */
const KEY_CHANGE_LAG_CODES: ReadonlySet<string> = new Set([
  'SDK_AUTH_INVALID_SIGNATURE',
  'DATA_ACCESS_INVALID_SIGNATURE',
  'SDK_AUTH_SESSION_GRANT_EXPIRED',
  'DATA_ACCESS_SESSION_GRANT_EXPIRED',
]);

/** The default of RegisteredSessionKeysOptions.heightMaxAgeMs: about one block. */
export const DEFAULT_REGISTERED_KEY_HEIGHT_MAX_AGE_MS = 1000;

/** The default of RegisteredSessionKeysOptions.expiryMarginBlocks. */
export const DEFAULT_REGISTERED_KEY_EXPIRY_MARGIN_BLOCKS = 3;

/**
 * In-memory sessionId -> key map, with each key's expiry height as last seen on chain.
 *
 * Orders use `get`: the key always signs them, and openTask's prechecks refuse an expired one
 * (no wallet fallback). Requests use `forRequest`: the key signs them only while
 * `latest_height + expiryMarginBlocks <= expiry_height`; after that the request falls back to the
 * configured grant, else the wallet, so the output of the last orders admitted before expiry stays
 * readable.
 */
export class RegisteredSessionKeys {
  private readonly keys = new Map<
    string,
    { key: RegisteredSessionKey; expiryHeight: bigint | undefined; keyChangeHeight: bigint | undefined }
  >();
  private observed: { height: bigint; at: number } | undefined;
  private readonly readLatestHeight: (() => Promise<bigint>) | undefined;
  private readonly heightMaxAgeMs: number;
  private readonly margin: bigint;
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly retryAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: RegisteredSessionKeysOptions = {}) {
    this.readLatestHeight = opts.latestHeight;
    this.heightMaxAgeMs = opts.heightMaxAgeMs ?? DEFAULT_REGISTERED_KEY_HEIGHT_MAX_AGE_MS;
    const margin = opts.expiryMarginBlocks ?? DEFAULT_REGISTERED_KEY_EXPIRY_MARGIN_BLOCKS;
    if (!Number.isSafeInteger(margin) || margin < 0) {
      throw invalid(`expiryMarginBlocks must be a non-negative integer, got ${margin}`);
    }
    this.margin = BigInt(margin);
    this.now = opts.now ?? (() => Date.now());
    const delay = opts.keyChangeRetryDelayMs ?? DEFAULT_KEY_CHANGE_RETRY_DELAY_MS;
    if (!Number.isFinite(delay) || delay < 0) throw invalid(`keyChangeRetryDelayMs must be a finite number >= 0, got ${delay}`);
    this.retryDelayMs = delay;
    const attempts = opts.keyChangeRetryAttempts ?? DEFAULT_KEY_CHANGE_RETRY_ATTEMPTS;
    if (!Number.isSafeInteger(attempts) || attempts < 0) {
      throw invalid(`keyChangeRetryAttempts must be a non-negative integer, got ${attempts}`);
    }
    this.retryAttempts = attempts;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Loads `key`; `expiryHeight` is its registration's expiry (undefined: unknown, never checked).
   * `keyChangeHeight` is the height of the last change to the registration (the set, rotate or
   * renew transaction, or the registration's set_height), which opens the key-change window
   * (retryAfterKeyChange); undefined: none known.
   */
  set(key: RegisteredSessionKey, expiryHeight?: bigint, keyChangeHeight?: bigint): void {
    this.keys.set(key.sessionId, { key, expiryHeight, keyChangeHeight });
  }

  /** The height of the loaded key's last known registration change, or undefined. */
  keyChangeHeight(sessionId: string): bigint | undefined {
    return this.keys.get(sessionId)?.keyChangeHeight;
  }

  /**
   * Records a change to the loaded key's registration at `height` (a renew), keeping the later
   * of it and the one already known. Nothing happens when no key is loaded.
   */
  noteKeyChange(sessionId: string, height: bigint): void {
    const e = this.keys.get(sessionId);
    if (e === undefined) return;
    if (e.keyChangeHeight === undefined || height > e.keyChangeHeight) this.keys.set(sessionId, { ...e, keyChangeHeight: height });
  }

  /** The loaded key, regardless of expiry: what an order is signed with. */
  get(sessionId: string): RegisteredSessionKey | undefined {
    return this.keys.get(sessionId)?.key;
  }

  /** The loaded key's expiry height as last seen, or undefined. */
  expiryHeight(sessionId: string): bigint | undefined {
    return this.keys.get(sessionId)?.expiryHeight;
  }

  /**
   * Records the chain's current expiry for `sessionId` when the loaded key is the registered one
   * (`address`); a chain read showing another key or none changes nothing here.
   */
  refreshExpiry(sessionId: string, address: Uint8Array | undefined, expiryHeight: bigint, setHeight?: bigint): void {
    const e = this.keys.get(sessionId);
    if (e === undefined || address === undefined || !sameBytes(e.key.address, address)) return;
    // A set_height later than the change already known is a registration this client did not see.
    const keyChangeHeight =
      setHeight !== undefined && setHeight > 0n && (e.keyChangeHeight === undefined || setHeight > e.keyChangeHeight)
        ? setHeight
        : e.keyChangeHeight;
    this.keys.set(sessionId, { key: e.key, expiryHeight, keyChangeHeight });
  }

  /** Records a latest height the client just read (heights only grow, so the highest is kept). */
  observeHeight(height: bigint): void {
    if (this.observed === undefined || height >= this.observed.height) this.observed = { height, at: this.now() };
  }

  /**
   * The key that signs a session-allowed request of `sessionId`: the loaded key while the latest
   * height plus the margin is at or before its expiry, else undefined (the caller falls back to
   * the grant or the wallet). A recently observed height is reused; otherwise the height is read.
   */
  async forRequest(sessionId: string): Promise<RegisteredSessionKey | undefined> {
    const e = this.keys.get(sessionId);
    if (e === undefined) return undefined;
    if (e.expiryHeight === undefined || this.readLatestHeight === undefined) return e.key;
    const usable = (height: bigint): boolean => height + this.margin <= e.expiryHeight!;
    const seen = this.observed;
    // Heights only grow: a height already inside the margin is final, however old.
    if (seen !== undefined && !usable(seen.height)) return undefined;
    // A recent height lags the chain by at most about a block; the margin covers that.
    if (seen !== undefined && this.now() - seen.at <= this.heightMaxAgeMs) return e.key;
    const latest = await this.readLatestHeight();
    this.observeHeight(latest);
    return usable(latest) ? e.key : undefined;
  }

  /**
   * Whether to re-send, re-signed with a fresh nonce, a request (or OpenTask) that `sessionId`'s
   * loaded key signed and a Builder refused with `err`; when true, it has already waited about a
   * block. Builders cache a session's key state for up to MAX_SESSION_KEY_CACHE_TTL_BLOCKS, so a
   * Builder may lag a key change by up to that many blocks and answer INVALID_SIGNATURE (a new key)
   * or SESSION_GRANT_EXPIRED (a renewed key) meanwhile. This is true only for those answers, only
   * while the latest height is below the last key change height plus
   * MAX_SESSION_KEY_CACHE_TTL_BLOCKS, and for at most keyChangeRetryAttempts re-sends (`attempt` is
   * the 0-based count of re-sends already made). Outside the window the answer stays final.
   */
  async retryAfterKeyChange(sessionId: string, err: unknown, attempt: number): Promise<boolean> {
    if (!(err instanceof TrueOpenError) || !KEY_CHANGE_LAG_CODES.has(err.code)) return false;
    if (attempt >= this.retryAttempts) return false;
    const change = this.keys.get(sessionId)?.keyChangeHeight;
    if (change === undefined || this.readLatestHeight === undefined) return false;
    const seen = this.observed;
    let latest: bigint;
    if (seen !== undefined && this.now() - seen.at <= this.heightMaxAgeMs) {
      latest = seen.height;
    } else {
      try {
        latest = await this.readLatestHeight();
      } catch {
        return false;
      }
      this.observeHeight(latest);
    }
    if (latest >= change + MAX_SESSION_KEY_CACHE_TTL_BLOCKS) return false;
    await this.sleep(this.retryDelayMs);
    return true;
  }

  delete(sessionId: string): void {
    this.keys.delete(sessionId);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** `0x` + 40 lowercase hex, for display and logging. */
export function sessionKeyAddressHex(address: Uint8Array): string {
  if (address.length !== 20) throw invalid(`an address is 20 bytes, got ${address.length}`);
  return `0x${toHex(address)}`;
}
