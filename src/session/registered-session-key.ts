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
   * block). A reused height is trusted only while it is below the key's expiry, so a height one
   * block stale still decides correctly; anything else is read again.
   */
  readonly heightMaxAgeMs?: number;
  /** Clock, for tests. */
  readonly now?: () => number;
}

/** The default of RegisteredSessionKeysOptions.heightMaxAgeMs: about one block. */
export const DEFAULT_REGISTERED_KEY_HEIGHT_MAX_AGE_MS = 1000;

/**
 * In-memory sessionId -> key map, with each key's expiry height as last seen on chain.
 *
 * Orders use `get`: the key always signs them, and openTask's prechecks refuse an expired one
 * (no wallet fallback). Requests use `forRequest`: the key signs them only while
 * `latest_height <= expiry_height`; after that the request falls back to the configured grant,
 * else the wallet, so the output of the last orders admitted before expiry stays readable.
 */
export class RegisteredSessionKeys {
  private readonly keys = new Map<string, { key: RegisteredSessionKey; expiryHeight: bigint | undefined }>();
  private observed: { height: bigint; at: number } | undefined;
  private readonly readLatestHeight: (() => Promise<bigint>) | undefined;
  private readonly heightMaxAgeMs: number;
  private readonly now: () => number;

  constructor(opts: RegisteredSessionKeysOptions = {}) {
    this.readLatestHeight = opts.latestHeight;
    this.heightMaxAgeMs = opts.heightMaxAgeMs ?? DEFAULT_REGISTERED_KEY_HEIGHT_MAX_AGE_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Loads `key`; `expiryHeight` is its registration's expiry (undefined: unknown, never checked). */
  set(key: RegisteredSessionKey, expiryHeight?: bigint): void {
    this.keys.set(key.sessionId, { key, expiryHeight });
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
  refreshExpiry(sessionId: string, address: Uint8Array | undefined, expiryHeight: bigint): void {
    const e = this.keys.get(sessionId);
    if (e === undefined || address === undefined || !sameBytes(e.key.address, address)) return;
    this.keys.set(sessionId, { key: e.key, expiryHeight });
  }

  /** Records a latest height the client just read (heights only grow, so the highest is kept). */
  observeHeight(height: bigint): void {
    if (this.observed === undefined || height >= this.observed.height) this.observed = { height, at: this.now() };
  }

  /**
   * The key that signs a session-allowed request of `sessionId`: the loaded key while the latest
   * height is at or before its expiry, else undefined (the caller falls back to the grant or the
   * wallet). A recently observed height below the expiry is reused; otherwise the height is read.
   */
  async forRequest(sessionId: string): Promise<RegisteredSessionKey | undefined> {
    const e = this.keys.get(sessionId);
    if (e === undefined) return undefined;
    if (e.expiryHeight === undefined || this.readLatestHeight === undefined) return e.key;
    const seen = this.observed;
    // Heights only grow: a height already past the expiry is final, however old.
    if (seen !== undefined && seen.height > e.expiryHeight) return undefined;
    // A recent height may lag the chain by a block, so it decides only with a block of slack.
    if (seen !== undefined && this.now() - seen.at <= this.heightMaxAgeMs && seen.height < e.expiryHeight) return e.key;
    const latest = await this.readLatestHeight();
    this.observeHeight(latest);
    return latest <= e.expiryHeight ? e.key : undefined;
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
