import { describe, it, expect } from 'vitest';
import {
  sdkRequestSignBytes,
  signSdkRequestEnvelope,
} from '../../src/transport/sdk-request-envelope';
import { toHex, fromHex } from '../../src/util/bytes';
import { sha256 } from '../../src/codec/hash';
import { privKeySecp256k1Signer, secp256k1PublicKey, verifyCosmosSecp256k1 } from '../../src/signer/secp256k1';

// Golden values produced by an independent Python oracle (faithful to the nexus internal/sdkauth source).
// The body digest is an opaque 32-byte input here; the per-method digests are pinned in ingress-methods.test.ts.
const GOLDEN_BODY_DIGEST = '2f90d677ec27b7feb69699b46da15dd7d2fa45a1973de80739d312ec1fa4fe31';
const GOLDEN_SIGN_BYTES =
  '00000017545255454f50454e5f53444b5f524551554553545f563100000011747275656f70656e2d6465766e65742d310000000b5375626d69744f72646572000000202f6e657875732e76312e496e67726573734150492f5375626d69744f7264657200000006736573732d31000000067461736b2d3100000003aabbcc00000008000001b8dac5b400000000202f90d677ec27b7feb69699b46da15dd7d2fa45a1973de80739d312ec1fa4fe31';

describe('SDKRequestEnvelope / body_digest (independent nexus oracle golden)', () => {
  const bodyDigest = fromHex(GOLDEN_BODY_DIGEST);
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
