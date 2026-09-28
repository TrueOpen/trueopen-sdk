import { secp256k1 } from '@noble/curves/secp256k1';
import { randomBytes } from '@noble/hashes/utils';
import { create } from '@bufbuild/protobuf';
import { SessionGrantV1Schema } from '../gen/nexus/v1/ingress_pb.js';
import type { SessionGrantV1 } from '../gen/nexus/v1/ingress_pb.js';
import { eip712HashStruct } from '../codec/eip712';
import type { Eip712Types } from '../codec/eip712';
import { canonicalOperatorAddressBytes } from '../codec/address';
import { SDK_REQUEST_EIP712_TYPES, sdkRequestEip712Domain } from '../transport/sdk-request-envelope';
export { SESSION_SDK_METHODS } from '../transport/sdk-request-envelope';
import { privateKeyTypedDataSigner, signTypedDataAs } from '../signer/typed-data-signer';
import type { TypedData, TypedDataSigner } from '../signer/typed-data-signer';
import { ethAddressBytes } from '../signer/eth-secp256k1';
import { TrueOpenError } from '../errors/errors';

/**
 * Session grants (SessionGrantV1): the user's wallet authorizes a short-lived client session key
 * once, and that key then signs the read and delivery-progress requests without a wallet prompt.
 *
 * The grant is EIP-712 typed data under the SDK Request domain ("TrueOpen SDK Request" v1,
 * chainId = evm_chain_id), always, including when a Task data request carries it:
 *   SessionGrant(string chainId,string user,address sessionKey,uint64 expiryHeight,bytes32 grantNonce)
 * A request carrying a grant binds it through sessionGrantHash = hashStruct(SessionGrant), and its
 * own signature recovers to sessionKey.
 *
 * A session key may sign only SubscribeOutput, AckOutput, GetTaskEvents, PrepareChallenge, and
 * GetTaskDataMetadata / FetchTaskData of an OUTPUT object. OpenTask and every other request are
 * signed by the wallet. A grant is valid while
 * current_height <= expiry_height <= current_height + max_session_grant_blocks; there is no
 * revocation, so a grant is reusable until it expires.
 *
 * The session key is generated here from the platform CSPRNG, kept in memory only, never
 * persisted and never derived from a signature.
 *
 * Vectors: wire testdata/v1/shared/account_signing_v1.json session_grant, sdk_request_session.
 */

export const SESSION_GRANT_EIP712_TYPES: Eip712Types = {
  EIP712Domain: SDK_REQUEST_EIP712_TYPES['EIP712Domain']!,
  SessionGrant: [
    { name: 'chainId', type: 'string' },
    { name: 'user', type: 'string' },
    { name: 'sessionKey', type: 'address' },
    { name: 'expiryHeight', type: 'uint64' },
    { name: 'grantNonce', type: 'bytes32' },
  ],
};

/** Task data rpc_method values a session key may sign, and only for an OUTPUT object. */
export const SESSION_TASK_DATA_METHODS: readonly string[] = [
  '/nexus.v1.IngressAPI/GetTaskDataMetadata',
  '/nexus.v1.IngressAPI/FetchTaskData',
];

/** The signed fields of a SessionGrantV1. */
export interface SessionGrantFields {
  readonly chainId: string;
  /** The granting user's canonical Bech32 address. */
  readonly user: string;
  /** The 20-byte address of the session key. */
  readonly sessionKey: Uint8Array;
  readonly expiryHeight: bigint;
  /** 32 bytes from a CSPRNG. */
  readonly grantNonce: Uint8Array;
}

export interface SignedSessionGrant extends SessionGrantFields {
  /** 65 bytes R||S||V by the user's wallet. */
  readonly userSignature: Uint8Array;
}

function malformed(what: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'SDK_LOCAL_SESSION_GRANT_MALFORMED', `session grant: ${what}`);
}

/** The SessionGrant typed data the wallet signs. */
export function sessionGrantTypedData(f: SessionGrantFields, evmChainId: bigint): TypedData {
  if (f.chainId === '') throw malformed('chain_id must not be empty');
  if (f.sessionKey.length !== 20) throw malformed(`session_key must be 20 bytes, got ${f.sessionKey.length}`);
  if (f.grantNonce.length !== 32) throw malformed(`grant_nonce must be 32 bytes, got ${f.grantNonce.length}`);
  if (f.expiryHeight <= 0n || f.expiryHeight >= 1n << 64n) throw malformed(`expiry_height ${f.expiryHeight} is outside (0, 2^64)`);
  return {
    types: SESSION_GRANT_EIP712_TYPES,
    primaryType: 'SessionGrant',
    domain: sdkRequestEip712Domain(evmChainId),
    message: {
      chainId: f.chainId,
      user: f.user,
      sessionKey: f.sessionKey,
      expiryHeight: f.expiryHeight,
      grantNonce: f.grantNonce,
    },
  };
}

/** sessionGrantHash = hashStruct(SessionGrant): what a request signs to bind the grant. */
export function sessionGrantHash(f: SessionGrantFields): Uint8Array {
  // The domain does not enter hashStruct; any chain ID gives the same value.
  return eip712HashStruct('SessionGrant', SESSION_GRANT_EIP712_TYPES, sessionGrantTypedData(f, 1n).message);
}

/** SessionGrantV1 on the wire. */
export function sessionGrantMessage(g: SignedSessionGrant): SessionGrantV1 {
  return create(SessionGrantV1Schema, {
    chainId: g.chainId,
    user: g.user,
    sessionKey: g.sessionKey,
    expiryHeight: g.expiryHeight,
    grantNonce: g.grantNonce,
    userSignature: g.userSignature,
  });
}

/** A grant in force and the in-memory key it authorizes. */
export interface ActiveSession {
  readonly grant: SignedSessionGrant;
  /** hashStruct(SessionGrant). */
  readonly grantHash: Uint8Array;
  /** Signs as grant.sessionKey. */
  readonly key: TypedDataSigner;
}

/** What IngressClient needs to session-sign a request. */
export interface SessionAuthority {
  /** A grant valid for a while longer, renewed first when it is about to expire. */
  current(): Promise<ActiveSession>;
  /** The Builder refused this grant as expired: forget it, so the next current() makes a new one. */
  expired(grant: SignedSessionGrant): void;
}

export interface SessionKeyManagerOptions {
  readonly chainId: string;
  /** The granting user's canonical Bech32 address. */
  readonly userAddress: string;
  /** The user's wallet: signs each grant (one prompt per grant). */
  readonly wallet: TypedDataSigner;
  readonly evmChainId: () => Promise<bigint>;
  readonly latestHeight: () => Promise<bigint>;
  /**
   * The Builders' max_session_grant_blocks (off-chain configuration, the same on every Task
   * Builder). A grant expires at most this many blocks after the height it is made at.
   */
  readonly maxGrantBlocks: number;
  /**
   * Grant lifetime in blocks; at most maxGrantBlocks. Defaults to maxGrantBlocks - 2, which
   * leaves room for a Builder whose view of the chain is a block or two behind.
   */
  readonly grantBlocks?: number;
  /** Renew when the grant has this many blocks or fewer left. Defaults to a quarter of its lifetime, at least 1. */
  readonly renewBeforeBlocks?: number;
}

/**
 * Keeps one session key and its grant in memory, renewing both before the grant runs out.
 *
 * Each renewal generates a fresh key: a grant is bounded only by its expiry, so an old key is
 * simply left to lapse. Concurrent callers share one renewal (one wallet prompt).
 */
export class SessionKeyManager implements SessionAuthority {
  private active: ActiveSession | undefined;
  private renewing: Promise<ActiveSession> | undefined;
  private readonly grantBlocks: bigint;
  private readonly renewBefore: bigint;

  constructor(private readonly opts: SessionKeyManagerOptions) {
    const max = opts.maxGrantBlocks;
    if (!Number.isInteger(max) || max < 1) throw malformed('maxGrantBlocks must be a positive integer');
    const blocks = opts.grantBlocks ?? Math.max(1, max - 2);
    if (!Number.isInteger(blocks) || blocks < 1 || blocks > max) {
      throw malformed(`grantBlocks must be an integer in [1, maxGrantBlocks=${max}], got ${blocks}`);
    }
    const renew = opts.renewBeforeBlocks ?? Math.max(1, Math.floor(blocks / 4));
    if (!Number.isInteger(renew) || renew < 0 || renew >= blocks) {
      throw malformed(`renewBeforeBlocks must be an integer in [0, grantBlocks=${blocks}), got ${renew}`);
    }
    this.grantBlocks = BigInt(blocks);
    this.renewBefore = BigInt(renew);
  }

  async current(): Promise<ActiveSession> {
    const active = this.active;
    if (active === undefined) return this.renew();
    const height = await this.opts.latestHeight();
    if (height + this.renewBefore < active.grant.expiryHeight) return active;
    try {
      return await this.renew();
    } catch (e) {
      // The wallet refused (or failed) an early renewal: the old grant is still good until its
      // expiry height, so keep using it and try again on the next request.
      if (this.active === active && height <= active.grant.expiryHeight) return active;
      throw e;
    }
  }

  expired(grant: SignedSessionGrant): void {
    if (this.active?.grant === grant) this.active = undefined;
  }

  /** Makes a new session key and has the wallet grant it. */
  renew(): Promise<ActiveSession> {
    this.renewing ??= this.makeGrant().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  private async makeGrant(): Promise<ActiveSession> {
    const privKey = secp256k1.utils.randomPrivateKey();
    const fields: SessionGrantFields = {
      chainId: this.opts.chainId,
      user: this.opts.userAddress,
      sessionKey: ethAddressBytes(secp256k1.getPublicKey(privKey, true)),
      expiryHeight: (await this.opts.latestHeight()) + this.grantBlocks,
      grantNonce: randomBytes(32),
    };
    const data = sessionGrantTypedData(fields, await this.opts.evmChainId());
    const userSignature = await signTypedDataAs(
      this.opts.wallet,
      data,
      canonicalOperatorAddressBytes('user', this.opts.userAddress),
    );
    const grant: SignedSessionGrant = { ...fields, userSignature };
    const session: ActiveSession = { grant, grantHash: sessionGrantHash(grant), key: privateKeyTypedDataSigner(privKey) };
    this.active = session;
    return session;
  }
}
