import { describe, it, expect } from 'vitest';
import { fromHex, toHex } from '../../src/util/bytes';
import {
  privKeySecp256k1Signer,
  secp256k1PublicKey,
  verifyCosmosSecp256k1,
} from '../../src/signer/secp256k1';
import { signOrderEnvelope } from '../../src/signer/order-signer';
import { orderEnvelopeSigningBytes } from '../../src/order/order-signing';

// Real golden values: fixed private key 0x01..0x20, produced by node's SignWithSecp256k1ForTest.
const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const GOLDEN_PUB = '0284bf7562262bbd6940085748f3be6afa52ae317155181ece31b66351ccffa4b0';
const GOLDEN_SIG =
  'a1f335cd4f057b0fececf5eec6ac633feb2ba0139ca07b26df6328aa8ec461e425f62e45b3b6197d873aab05d80613026abae933467399e7e4ba125da30a8eb3';

/**
 * The "envelope string" covered by the outer order signature.
 *
 * This golden value dates from the old canonical-JSON envelope era; the envelope builder
 * was removed as part of that migration, so the JSON string from that time is pinned here
 * verbatim. What it actually anchors is the **still-in-use** combination of
 * orderEnvelopeSigningBytes + signer — OpenTask's outer signature takes exactly the same
 * path, just with the input swapped for hex(SignedOrderV1 bytes). If the framing of the
 * signed bytes ever drifts, this test fails immediately.
 */
const ENVELOPE =
  '{"schema_version":"trueopen-order-envelope-v1","model_id":"model-1","profile_version":1,' +
  '"task_type":"inference","reward_bucket":1,"profile_resource_tier":1,' +
  '"infer_input_unit_price_bid":2,"infer_output_unit_price_bid":3,"verify_unit_price_bid":4,' +
  '"max_fee":1000,"tx_fee_reserve":0,"infer_fee_cap":600,"verify_fee_cap":300,"order_value":900,' +
  '"valid_after_height":0,"deadline_height":100,"payload_hash":"payload-hash","infer_timeout_blocks":20}';

describe('secp256k1 signer (real golden from chain)', () => {
  it('compressed public key matches the golden value', () => {
    expect(toHex(secp256k1PublicKey(PRIV))).toBe(GOLDEN_PUB);
  });

  it('user_signature matches the golden value byte-for-byte (deterministic RFC6979 + low-S)', async () => {
    const sig = await signOrderEnvelope('trueopen-devnet-1', 'trueopen1testuser', 'sess-1', 3n, ENVELOPE, privKeySecp256k1Signer(PRIV));
    expect(sig).toBe(GOLDEN_SIG);
  });

  it('local sign/verify round trip passes', async () => {
    const message = orderEnvelopeSigningBytes('trueopen-devnet-1', 'trueopen1testuser', 'sess-1', 3n, ENVELOPE);
    const sig = await privKeySecp256k1Signer(PRIV)(message);
    expect(verifyCosmosSecp256k1(message, sig, secp256k1PublicKey(PRIV))).toBe(true);
    // Tampering with the message should fail verification
    const tampered = orderEnvelopeSigningBytes('other-chain', 'trueopen1testuser', 'sess-1', 3n, ENVELOPE);
    expect(verifyCosmosSecp256k1(tampered, sig, secp256k1PublicKey(PRIV))).toBe(false);
  });
});
