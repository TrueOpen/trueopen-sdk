import { expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { OutputStreamVerifier, outputChunkSigningDigest, OUTPUT_MMR_DOMAIN } from '../../src/output/output-commitment';
import { mmrRoot } from '../../src/codec/mmr';
import { serializeOutputStreamCheckpoint, deserializeOutputStreamCheckpoint } from '../../src/output/output-checkpoint-codec';
const key = new Uint8Array(32).fill(1);
const taskHash = new Uint8Array(32).fill(2);
const dispatchTicketHash = new Uint8Array(32).fill(3);
const config = { chainId: 'test', taskHash, dispatchTicketHash, workerServicePubKey: secp256k1.getPublicKey(key, true) };
const text = new TextEncoder().encode('output');
const root = mmrRoot(OUTPUT_MMR_DOMAIN, [text]);
function frame(ticket = dispatchTicketHash) {
  const fields = { ...config, dispatchTicketHash: ticket, seq: 0n, mmrRoot: root };
  return { ...fields, text, signature: secp256k1.sign(outputChunkSigningDigest(fields), key).toCompactRawBytes() };
}
it('rejects a correctly signed frame from another attempt before changing MMR state', () => {
  const v = new OutputStreamVerifier(config);
  expect(() => v.accept(frame(new Uint8Array(32).fill(4)))).toThrow(/dispatch_ticket_hash/);
  expect(v.leafCount).toBe(0n);
  v.accept(frame());
  expect(v.leafCount).toBe(1n);
});
it('persists attempt identity and refuses checkpoint reuse across attempts', () => {
  const v = new OutputStreamVerifier(config);
  v.accept(frame());
  const checkpoint = deserializeOutputStreamCheckpoint(serializeOutputStreamCheckpoint(v.checkpoint()));
  expect(checkpoint.dispatchTicketHash).toEqual(dispatchTicketHash);
  expect(() => new OutputStreamVerifier({ ...config, dispatchTicketHash: new Uint8Array(32).fill(4) }, checkpoint)).toThrow(/dispatch_ticket_hash/);
  expect(new OutputStreamVerifier(config, checkpoint).acceptOrDeduplicate(frame())).toBe('duplicate');
});
it('refuses legacy signatures without an attempt', () => {
  expect(() => outputChunkSigningDigest({ chainId: 'test', taskHash, seq: 0n, mmrRoot: root })).toThrow(/dispatch_ticket_hash/);
});
