import { toHex } from '../util/bytes';
import { TrueOpenError } from '../errors/errors';
import {
  orderEnvelopeSigningBytes,
  cancelOrderSigningBytes,
  userChallengeSigningBytes,
} from '../order/order-signing';
import type { CosmosSecp256k1Signer } from './secp256k1';

/** Signs signing bytes -> a hex-encoded 64-byte detached signature (verified as hex on-chain). */
export async function signDetached(message: Uint8Array, signer: CosmosSecp256k1Signer): Promise<string> {
  const sig = await signer(message);
  if (sig.length !== 64 && sig.length !== 65) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'SDK_LOCAL_BAD_SIGNATURE_LEN',
      `secp256k1 signature must be 64 or 65 bytes, got ${sig.length}`,
    );
  }
  return toHex(sig.length === 65 ? sig.subarray(0, 64) : sig);
}

/** Signs an OrderEnvelope -> user_signature (hex). Signing bytes include owner/session/seq (aligned with nexus). */
export function signOrderEnvelope(
  chainId: string,
  ownerAddress: string,
  sessionId: string,
  orderSequence: bigint,
  canonicalOrderEnvelopeJson: string,
  signer: CosmosSecp256k1Signer,
): Promise<string> {
  return signDetached(
    orderEnvelopeSigningBytes(chainId, ownerAddress, sessionId, orderSequence, canonicalOrderEnvelopeJson),
    signer,
  );
}

/** Signs a CancelOrder -> owner_signature (hex). */
export function signCancelOrder(
  chainId: string,
  ownerAddress: string,
  sessionId: string,
  orderSequence: bigint,
  signer: CosmosSecp256k1Signer,
): Promise<string> {
  return signDetached(cancelOrderSigningBytes(chainId, ownerAddress, sessionId, orderSequence), signer);
}

/** Signs a UserChallenge -> challenger_signature (hex). */
export function signUserChallenge(
  args: {
    chainId: string;
    sessionId: string;
    taskId: string;
    settlementId: string;
    challengeKind: string;
    evidenceDigest: string;
    bondAmount: bigint;
    requestedEvidence: readonly string[];
  },
  signer: CosmosSecp256k1Signer,
): Promise<string> {
  return signDetached(
    userChallengeSigningBytes(
      args.chainId,
      args.sessionId,
      args.taskId,
      args.settlementId,
      args.challengeKind,
      args.evidenceDigest,
      args.bondAmount,
      args.requestedEvidence,
    ),
    signer,
  );
}
