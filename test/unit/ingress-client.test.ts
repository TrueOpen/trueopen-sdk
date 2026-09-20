import { describe, it, expect } from 'vitest';
import { createRouterTransport } from '@connectrpc/connect';
import type { SubmitOrderRequest as GenSubmitOrderRequest } from '../../src/gen/nexus/v1/ingress_pb.js';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import { IngressClient } from '../../src/transport/ingress-client';
import type { SubmitOrderRequest } from '../../src/transport/ingress-client';
import { signSdkRequestEnvelope, submitOrderBodyDigest } from '../../src/transport/sdk-request-envelope';
import { fromHex, toHex } from '../../src/util/bytes';
import { privKeySecp256k1Signer, secp256k1PublicKey } from '../../src/signer/secp256k1';

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const signer = privKeySecp256k1Signer(PRIV);
const pub = secp256k1PublicKey(PRIV);

const PAYLOAD = new TextEncoder().encode('trueopen-input');
const PAYLOAD_HASH = 'ba07a45a431bd3b9c4c0490b8a312f5c919909b37477f1eb2c220946ed71dc79';
const PAYLOAD_REF = `nexus://sha256/${PAYLOAD_HASH}`;
// order_envelope is now the protobuf bytes of SignedOrderV1; this test only checks the proto
// field mapping, so fixed placeholder bytes are enough (the encoding itself is covered by
// signed-order.test.ts).
const ORDER_ENVELOPE = new Uint8Array([0x0a, 0x02, 0x08, 0x01]);
const ORDER_SIGNATURE = new Uint8Array(64).fill(0xcd);

/**
 * SubmitOrder is deprecated (the contract moved the order-submission entry point to OpenTask),
 * but IngressClient still keeps raw RPC access to it. This test case guards its proto field
 * mapping against drift.
 */
describe('IngressClient.submitOrder (in-memory router transport)', () => {
  it('maps the SDK request into proto and parses the response', async () => {
    const bodyDigest = submitOrderBodyDigest({
      orderEnvelope: ORDER_ENVELOPE,
      payloadRef: PAYLOAD_REF,
      signature: ORDER_SIGNATURE,
      sessionId: 'sess-1',
      orderSequence: 3n,
      userAddress: 'trueopen1testuser',
      signatureScheme: 'secp256k1',
      payload: PAYLOAD,
    });
    const requestEnvelope = await signSdkRequestEnvelope(
      {
        chainId: 'trueopen-devnet-1',
        method: 'SubmitOrder',
        endpoint: '/nexus.v1.IngressAPI/SubmitOrder',
        sessionId: 'sess-1',
        taskId: 'task-1',
        requestNonce: new Uint8Array([0xaa, 0xbb, 0xcc]),
        expiryHeightOrTime: 1893456000000n,
        bodyDigest,
      },
      'trueopen1testuser',
      pub,
      signer,
    );
    const request: SubmitOrderRequest = {
      orderEnvelope: ORDER_ENVELOPE,
      payloadRef: PAYLOAD_REF,
      signature: ORDER_SIGNATURE,
      requestEnvelope,
      sessionId: 'sess-1',
      orderSequence: 3n,
      userAddress: 'trueopen1testuser',
      signatureScheme: 'secp256k1',
      payload: PAYLOAD,
    };

    let captured: GenSubmitOrderRequest | undefined;
    const transport = createRouterTransport(({ service }) => {
      service(IngressAPI, {
        submitOrder(req) {
          captured = req;
          return { taskId: 'task-1', accepted: true, reason: '', sessionId: 'sess-1' };
        },
      });
    });

    const ack = await new IngressClient(transport).submitOrder(request);
    expect(ack).toEqual({ taskId: 'task-1', accepted: true, reason: '', sessionId: 'sess-1' });

    // The request maps correctly field by field
    const c = captured as GenSubmitOrderRequest;
    expect(c).toBeDefined();
    expect(c.payloadRef).toBe(PAYLOAD_REF);
    expect(c.payload).toEqual(PAYLOAD);
    expect(c.sessionId).toBe('sess-1');
    expect(c.orderSequence).toBe(3n);
    expect(c.userAddress).toBe('trueopen1testuser');
    expect(c.signatureScheme).toBe('secp256k1');
    expect(toHex(c.orderEnvelope)).toBe(toHex(ORDER_ENVELOPE));
    expect(toHex(c.signature)).toBe(toHex(ORDER_SIGNATURE));

    // The request envelope passes through unchanged (including signer_pubkey, proto field signerPubkey)
    expect(c.requestEnvelope?.requestDomain).toBe('TRUEOPEN_SDK_REQUEST_V1');
    expect(c.requestEnvelope?.expiryHeightOrTime).toBe(1893456000000n);
    expect(toHex(c.requestEnvelope?.bodyDigest as Uint8Array)).toBe(toHex(bodyDigest));
    expect(toHex(c.requestEnvelope?.signerPubkey as Uint8Array)).toBe(toHex(pub));
  });
});
