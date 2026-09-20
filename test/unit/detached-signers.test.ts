import { describe, it, expect } from 'vitest';
import { fromHex } from '../../src/util/bytes';
import { privKeySecp256k1Signer, secp256k1PublicKey, verifyCosmosSecp256k1 } from '../../src/signer/secp256k1';
import { signCancelOrder, signUserChallenge } from '../../src/signer/order-signer';
import { cancelOrderSigningBytes, userChallengeSigningBytes } from '../../src/order/order-signing';

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const signer = privKeySecp256k1Signer(PRIV);
const pub = secp256k1PublicKey(PRIV);

describe('detached signers', () => {
  it('signCancelOrder produces a verifiable hex signature (against cancelOrderSigningBytes)', async () => {
    const sig = await signCancelOrder('trueopen-devnet-1', 'trueopen1owner', 'sess-1', 7n, signer);
    expect(/^[0-9a-f]{128}$/.test(sig)).toBe(true);
    const msg = cancelOrderSigningBytes('trueopen-devnet-1', 'trueopen1owner', 'sess-1', 7n);
    expect(verifyCosmosSecp256k1(msg, fromHex(sig), pub)).toBe(true);
    // Changing any parameter fails verification (replay-protection binding)
    const other = cancelOrderSigningBytes('trueopen-devnet-1', 'trueopen1owner', 'sess-1', 8n);
    expect(verifyCosmosSecp256k1(other, fromHex(sig), pub)).toBe(false);
  });

  it('signUserChallenge produces a verifiable hex signature (against userChallengeSigningBytes)', async () => {
    const args = {
      chainId: 'trueopen-devnet-1', sessionId: 'sess-1', taskId: 'task-1', settlementId: 'settle-1',
      challengeKind: 'USER_REVALIDATION', evidenceDigest: 'evi-digest', bondAmount: 1000n,
      requestedEvidence: [] as string[],
    };
    const sig = await signUserChallenge(args, signer);
    const msg = userChallengeSigningBytes(
      args.chainId, args.sessionId, args.taskId, args.settlementId,
      args.challengeKind, args.evidenceDigest, args.bondAmount, args.requestedEvidence,
    );
    expect(verifyCosmosSecp256k1(msg, fromHex(sig), pub)).toBe(true);
  });
});
