import { describe, it, expect } from 'vitest';
import {
  sdkRequestSignBytes,
  submitOrderBodyDigest,
  signSdkRequestEnvelope,
} from '../../src/transport/sdk-request-envelope';
import { toHex, fromHex } from '../../src/util/bytes';
import { sha256 } from '../../src/codec/hash';
import { privKeySecp256k1Signer, secp256k1PublicKey, verifyCosmosSecp256k1 } from '../../src/signer/secp256k1';

// Golden values produced by an independent Python oracle (faithful to the nexus internal/sdkauth source).
// nexus PR#10: submitOrder body_digest appends the payload at the end. The golden aligns with submit-order.test.ts
// (payload='trueopen-input' -> payload_hash=ba07...; body_digest verified against the nexus sdkauth.BodyDigest source for isomorphism).
const GOLDEN_JSON =
  '{"schema_version":"trueopen-order-envelope-v1","model_id":"model-1","profile_version":1,"task_type":"inference","reward_bucket":1,"profile_resource_tier":1,"infer_input_unit_price_bid":2,"infer_output_unit_price_bid":3,"verify_unit_price_bid":4,"max_fee":1000,"tx_fee_reserve":0,"infer_fee_cap":600,"verify_fee_cap":300,"order_value":900,"valid_after_height":0,"deadline_height":100,"payload_hash":"ba07a45a431bd3b9c4c0490b8a312f5c919909b37477f1eb2c220946ed71dc79","infer_timeout_blocks":20}';
const PAYLOAD = new TextEncoder().encode('trueopen-input');
const PAYLOAD_REF = 'nexus://sha256/ba07a45a431bd3b9c4c0490b8a312f5c919909b37477f1eb2c220946ed71dc79';
const ORDER_SIG = '50c4c8cbd5b6b5864fb56438e75a0b45645faca86e8cd85d60fc801b4f4f7b4a2c7ea57689d20484113ea1b63e2f94ab231b93dea6849545c1a87e29dc81e67a';
const GOLDEN_BODY_DIGEST = '2f90d677ec27b7feb69699b46da15dd7d2fa45a1973de80739d312ec1fa4fe31';
const GOLDEN_SIGN_BYTES =
  '00000017545255454f50454e5f53444b5f524551554553545f563100000011747275656f70656e2d6465766e65742d310000000b5375626d69744f72646572000000202f6e657875732e76312e496e67726573734150492f5375626d69744f7264657200000006736573732d31000000067461736b2d3100000003aabbcc00000008000001b8dac5b400000000202f90d677ec27b7feb69699b46da15dd7d2fa45a1973de80739d312ec1fa4fe31';

describe('SDKRequestEnvelope / body_digest (independent nexus oracle golden)', () => {
  const bodyDigest = submitOrderBodyDigest({
    orderEnvelope: new TextEncoder().encode(GOLDEN_JSON),
    payloadRef: PAYLOAD_REF,
    signature: fromHex(ORDER_SIG),
    sessionId: 'sess-1',
    orderSequence: 3n,
    userAddress: 'trueopen1testuser',
    signatureScheme: 'secp256k1',
    payload: PAYLOAD,
  });
  const fields = {
    chainId: 'trueopen-devnet-1',
    method: 'SubmitOrder',
    endpoint: '/nexus.v1.IngressAPI/SubmitOrder',
    sessionId: 'sess-1',
    taskId: 'task-1',
    requestNonce: new Uint8Array([0xaa, 0xbb, 0xcc]),
    expiryHeightOrTime: 1893456000000n,
    bodyDigest,
  };

  it('submitOrderBodyDigest matches the oracle', () => {
    expect(toHex(bodyDigest)).toBe(GOLDEN_BODY_DIGEST);
  });

  it('sdkRequestSignBytes matches the oracle byte-for-byte (4-byte frames)', () => {
    expect(toHex(sdkRequestSignBytes(fields))).toBe(GOLDEN_SIGN_BYTES);
  });

  it('signed envelope: secp256k1(sha256(SignBytes)) verifies correctly in nexus style', async () => {
    const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
    const pub = secp256k1PublicKey(PRIV);
    const env = await signSdkRequestEnvelope(fields, 'trueopen1testuser', pub, privKeySecp256k1Signer(PRIV));
    expect(env.signature).toHaveLength(64);
    expect(env.signerPubKey).toEqual(pub);
    // nexus VerifySig verifies using sha256(SignBytes) + secp256k1
    const sb = sdkRequestSignBytes(fields);
    expect(verifyCosmosSecp256k1(sb, env.signature, pub)).toBe(true);
    expect(toHex(sha256(sb))).toBe('80b90b60ced8c8c78609dfcdb70f5a8137c73407cdd71d371914d46a92b0bb96');
  });
});
