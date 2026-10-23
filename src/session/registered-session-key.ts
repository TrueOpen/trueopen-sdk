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

/** In-memory sessionId -> key map. */
export class RegisteredSessionKeys {
  private readonly keys = new Map<string, RegisteredSessionKey>();

  set(key: RegisteredSessionKey): void {
    this.keys.set(key.sessionId, key);
  }

  get(sessionId: string): RegisteredSessionKey | undefined {
    return this.keys.get(sessionId);
  }

  delete(sessionId: string): void {
    this.keys.delete(sessionId);
  }
}

/** `0x` + 40 lowercase hex, for display and logging. */
export function sessionKeyAddressHex(address: Uint8Array): string {
  if (address.length !== 20) throw invalid(`an address is 20 bytes, got ${address.length}`);
  return `0x${toHex(address)}`;
}
