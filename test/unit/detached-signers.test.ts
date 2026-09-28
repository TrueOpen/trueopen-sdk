import { describe, it, expect } from 'vitest';
import { fromHex } from '../../src/util/bytes';
import { privKeySecp256k1Signer, secp256k1PublicKey, verifyCosmosSecp256k1 } from '../../src/signer/secp256k1';
import { signOrderEnvelope } from '../../src/signer/order-signer';
import { orderEnvelopeSigningBytes } from '../../src/order/order-signing';

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const signer = privKeySecp256k1Signer(PRIV);
const pub = secp256k1PublicKey(PRIV);

describe('detached signers', () => {
  it('signOrderEnvelope produces a verifiable hex signature (against orderEnvelopeSigningBytes)', async () => {
    const sig = await signOrderEnvelope('trueopen-devnet-1', 'trueopen1owner', 'sess-1', 7n, 'aabb', signer);
    expect(/^[0-9a-f]{128}$/.test(sig)).toBe(true);
    const msg = orderEnvelopeSigningBytes('trueopen-devnet-1', 'trueopen1owner', 'sess-1', 7n, 'aabb');
    expect(verifyCosmosSecp256k1(msg, fromHex(sig), pub)).toBe(true);
    // Changing any bound parameter fails verification.
    const other = orderEnvelopeSigningBytes('trueopen-devnet-1', 'trueopen1owner', 'sess-1', 8n, 'aabb');
    expect(verifyCosmosSecp256k1(other, fromHex(sig), pub)).toBe(false);
  });
});
