import { expect, it } from 'vitest';
import { createRouterTransport } from '@connectrpc/connect';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import { IngressClient } from '../../src/transport/ingress-client';
import { privateKeyTypedDataSigner } from '../../src/signer/typed-data-signer';
import { secp256k1PublicKey } from '../../src/signer/secp256k1';
import { ethSecp256k1Address } from '../../src/signer/eth-secp256k1';
import { resumeOutputBodyDigest, getDispatchRosterBodyDigest, subscribeOutputBodyDigest } from '../../src/transport/sdk-request-body';
const key = new Uint8Array(32).fill(1);
const sessionId = `0x${'01'.repeat(32)}`, taskId = `0x${'02'.repeat(32)}`;
const ticket = new Uint8Array(32).fill(3);
it('signs ResumeOutput and GetDispatchRoster with distinct methods and bound body fields', async () => {
  let resumed = false, roster = false;
  const transport = createRouterTransport(({ service }) => service(IngressAPI, {
    async *resumeOutput(req) {
      resumed = true;
      expect(req.resumeAfterSeq).toBe(0n);
      expect(req.dispatchTicketHash).toEqual(ticket);
      expect(req.requestEnvelope?.method).toBe('ResumeOutput');
      expect(req.requestEnvelope?.bodyDigest).toEqual(resumeOutputBodyDigest(sessionId, taskId, 0n, ticket));
      yield { frame: {} };
    },
    getDispatchRoster(req) {
      roster = true;
      expect(req.authentication.case).toBe('requestEnvelope');
      if (req.authentication.case === 'requestEnvelope') {
        expect(req.authentication.value.method).toBe('GetDispatchRoster');
        expect(req.authentication.value.bodyDigest).toEqual(getDispatchRosterBodyDigest(sessionId, taskId));
      }
      return { rounds: [] };
    },
  }));
  const client = new IngressClient(transport, { chainId: 'test', userAddress: ethSecp256k1Address(secp256k1PublicKey(key), 'trueopen'), wallet: privateKeyTypedDataSigner(key), signatureChainId: 1n, expiry: () => 1893456000000n, nonce: () => new Uint8Array(32).fill(4) });
  for await (const frame of client.resumeOutput({ sessionId, taskId, resumeAfterSeq: 0n, dispatchTicketHash: ticket })) expect(frame.frame).toBeDefined();
  await client.getDispatchRoster(sessionId, taskId);
  expect(resumed && roster).toBe(true);
});
it('distinguishes absent cursor, present zero, attempt and RPC domain', () => {
  expect(resumeOutputBodyDigest(sessionId, taskId)).not.toEqual(resumeOutputBodyDigest(sessionId, taskId, 0n));
  expect(resumeOutputBodyDigest(sessionId, taskId, 0n)).not.toEqual(resumeOutputBodyDigest(sessionId, taskId, 0n, ticket));
  expect(resumeOutputBodyDigest(sessionId, taskId, 0n, ticket)).not.toEqual(subscribeOutputBodyDigest(sessionId, taskId, 0n, ticket));
  expect(() => resumeOutputBodyDigest(sessionId, taskId, 0n, new Uint8Array(1))).toThrow();
});
