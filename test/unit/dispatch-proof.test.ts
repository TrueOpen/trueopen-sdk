import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { secp256k1 } from '@noble/curves/secp256k1';
import { DispatchResultHeaderV1Schema } from '../../src/gen/nexus/v1/dispatch_pb.js';
import type { DispatchResultHeaderV1 } from '../../src/gen/nexus/v1/dispatch_pb.js';
import { DispatchAcceptV1Schema, DispatchRecordStatusV1 } from '../../src/gen/task/v1/dispatch_pb.js';
import {
  dispatchAcceptDigest,
  dispatchResultHeaderDigest,
  dispatchSigningDigest,
  dispatchSigningPreimage,
  dispatchTicketDigest,
  selectServiceProofKey,
  verifyDispatchResultHeader,
  verifyServiceDigestSignature,
} from '../../src/output/dispatch-proof';
import type { DispatchSignedMessageName, VerifyDispatchResultHeaderParams } from '../../src/output/dispatch-proof';
import type { ServiceKeyBinding } from '../../src/types/hub';
import { fromHex, toHex } from '../../src/util/bytes';
import { hash32Text } from '../../src/codec/hash32';

// Pinned by third_party/wire/testdata/v1/task/dispatch_v1.json: wire's published direct-dispatch
// projections (protobuf, preimage, digest, signature, public key) for the three messages.

interface Vector {
  readonly name: string;
  readonly message_name: DispatchSignedMessageName;
  readonly protobuf_hex: string;
  readonly preimage_hex: string;
  readonly digest_hex: string;
  readonly signature_hex: string;
  readonly public_key_hex: string;
}
interface RetainedCase {
  readonly name: string;
  readonly signed_nonce: number;
  readonly ticket_nonce: number;
  readonly current_nonce: number;
  readonly current_status: string;
  readonly previous_nonce: number;
  readonly earliest_submit_height?: number;
  readonly previous_retired_height: number;
  readonly bound_change_height: number;
  readonly revoked_height?: number;
  readonly allowed: boolean;
}

const doc = JSON.parse(readFileSync('third_party/wire/testdata/v1/task/dispatch_v1.json', 'utf8')) as { vectors: Vector[] };
const vector = (name: string): Vector => doc.vectors.find((v) => v.name === name)!;
const rotation = JSON.parse(readFileSync('third_party/wire/testdata/v1/shared/service_key_rotation_v1.json', 'utf8')) as {
  retained_message_cases: RetainedCase[];
  proof_cases: { name: string; earliest_submit_height: number; bound_change_height: number; previous_retired_height: number; allowed: boolean }[];
};

const VECTORS = ['nexus_v1_dispatchresultheaderv1', 'task_v1_dispatchticketv1', 'task_v1_dispatchacceptv1'];
// wire's vector key (dispatch tests sign with bytes.Repeat(1, 32)).
const VECTOR_PRIV = new Uint8Array(32).fill(1);
const OTHER_PRIV = new Uint8Array(32).fill(2);

describe('dispatch signing projections match wire vectors', () => {
  for (const name of VECTORS) {
    it(name, () => {
      const v = vector(name);
      const raw = fromHex(v.protobuf_hex);
      expect(toHex(dispatchSigningPreimage(v.message_name, raw))).toBe(v.preimage_hex);
      const digest = dispatchSigningDigest(v.message_name, raw);
      expect(toHex(digest)).toBe(v.digest_hex);
      expect(verifyServiceDigestSignature(fromHex(v.public_key_hex), digest, fromHex(v.signature_hex))).toBe(true);
      // An unknown field never survives the projection.
      expect(() => dispatchSigningDigest(v.message_name, Uint8Array.from([...raw, 0xf8, 0x3e, 1]))).toThrow(/unknown/);
    });
  }

  it('digests the decoded protobuf-es messages the same way', () => {
    const header = fromBinary(DispatchResultHeaderV1Schema, fromHex(vector(VECTORS[0]!).protobuf_hex));
    expect(toHex(dispatchResultHeaderDigest(header))).toBe(vector(VECTORS[0]!).digest_hex);
    expect(toHex(dispatchTicketDigest(header.winnerTicket!))).toBe(vector(VECTORS[1]!).digest_hex);
    expect(toHex(dispatchAcceptDigest(header.accept!))).toBe(vector(VECTORS[2]!).digest_hex);
    // The accept names its ticket by the ticket's signing digest.
    expect(toHex(header.accept!.dispatchTicketHash)).toBe(vector(VECTORS[1]!).digest_hex);
  });

  it('refuses material wire refuses', () => {
    const raw = fromHex(vector('task_v1_dispatchacceptv1').protobuf_hex);
    // Duplicate singular field (schema_version again).
    expect(() => dispatchSigningDigest('task.v1.DispatchAcceptV1', Uint8Array.from([...raw, 0x08, 0x01]))).toThrow(/duplicate/);
    // Non-minimal varint: field 1 = 1 written as 0x81 0x00.
    const accept = fromBinary(DispatchAcceptV1Schema, raw);
    const withoutVersion = toBinary(DispatchAcceptV1Schema, { ...accept, schemaVersion: 0 });
    expect(() => dispatchSigningDigest('task.v1.DispatchAcceptV1', Uint8Array.from([0x08, 0x81, 0x00, ...withoutVersion]))).toThrow(/nonminimal/);
    // A hash field that is not 32 bytes.
    const short = toBinary(DispatchAcceptV1Schema, { ...accept, taskHash: new Uint8Array(31) });
    expect(() => dispatchSigningDigest('task.v1.DispatchAcceptV1', short)).toThrow(/raw32/);
    // A noncanonical address.
    const upper = toBinary(DispatchAcceptV1Schema, { ...accept, member: { ...accept.member!, operatorAddress: accept.member!.operatorAddress.toUpperCase() } });
    expect(() => dispatchSigningDigest('task.v1.DispatchAcceptV1', upper)).toThrow(/address/);
  });

  it('accepts only compact low-S signatures by a compressed key', () => {
    const v = vector('task_v1_dispatchticketv1');
    const digest = fromHex(v.digest_hex);
    const sig = secp256k1.sign(digest, VECTOR_PRIV);
    const pub = secp256k1.getPublicKey(VECTOR_PRIV, true);
    expect(verifyServiceDigestSignature(pub, digest, sig.toCompactRawBytes())).toBe(true);
    const highS = new secp256k1.Signature(sig.r, secp256k1.CURVE.n - sig.s).toCompactRawBytes();
    expect(verifyServiceDigestSignature(pub, digest, highS)).toBe(false);
    expect(verifyServiceDigestSignature(secp256k1.getPublicKey(VECTOR_PRIV, false), digest, sig.toCompactRawBytes())).toBe(false);
    expect(verifyServiceDigestSignature(pub, digest, Uint8Array.from([...sig.toCompactRawBytes(), 0]))).toBe(false);
  });
});

describe('service key generation selection follows wire rotation cases', () => {
  const OLD = secp256k1.getPublicKey(VECTOR_PRIV, true);
  const NEW = secp256k1.getPublicKey(OTHER_PRIV, true);
  for (const c of rotation.retained_message_cases) {
    it(c.name, () => {
      const binding: ServiceKeyBinding = {
        participantType: 'PARTICIPANT_TYPE_BUILDER', operatorAddress: 'b', serviceAddress: 'b',
        servicePubKey: NEW, status: c.current_status, serviceAuthorizationNonce: BigInt(c.current_nonce),
        previousServicePubKey: OLD, previousServiceAuthorizationNonce: BigInt(c.previous_nonce), previousRetiredHeight: BigInt(c.previous_retired_height),
        ...(c.revoked_height !== undefined ? { revokedHeight: BigInt(c.revoked_height) } : {}),
      };
      const esh = c.earliest_submit_height === undefined ? undefined : BigInt(c.earliest_submit_height);
      const height = esh === undefined ? undefined : (esh > BigInt(c.bound_change_height) ? esh : BigInt(c.bound_change_height));
      let allowed = c.ticket_nonce > 0 && c.signed_nonce >= c.ticket_nonce;
      if (allowed) {
        try {
          const key = selectServiceProofKey(binding, BigInt(c.signed_nonce), height);
          expect(key).toEqual(BigInt(c.signed_nonce) === BigInt(c.current_nonce) ? NEW : OLD);
        } catch (e) {
          expect(e).toMatchObject({ code: 'DATA_OUTPUT_DISPATCH_KEY_UNAVAILABLE' });
          allowed = false;
        }
      }
      expect(allowed).toBe(c.allowed);
    });
  }
  for (const c of rotation.proof_cases) {
    it(`previous key: ${c.name}`, () => {
      const binding: ServiceKeyBinding = {
        participantType: 'PARTICIPANT_TYPE_CORTEX', operatorAddress: 'w', serviceAddress: 'w', servicePubKey: NEW, status: 'ACTIVE',
        serviceAuthorizationNonce: 2n, previousServicePubKey: OLD, previousServiceAuthorizationNonce: 1n, previousRetiredHeight: BigInt(c.previous_retired_height),
      };
      const height = BigInt(Math.max(c.earliest_submit_height, c.bound_change_height));
      const ok = (() => { try { selectServiceProofKey(binding, 1n, height); return true; } catch { return false; } })();
      expect(ok).toBe(c.allowed);
    });
  }
});

describe('verifyDispatchResultHeader', () => {
  const v = vector('nexus_v1_dispatchresultheaderv1');
  const base = (): DispatchResultHeaderV1 => fromBinary(DispatchResultHeaderV1Schema, fromHex(v.protobuf_hex));
  const h0 = base();
  const BUILDER = h0.winnerTicket!.builderAddress;
  const pub = (priv: Uint8Array): Uint8Array => secp256k1.getPublicKey(priv, true);
  const binding = (pt: string, addr: string, key = pub(VECTOR_PRIV), extra: Partial<ServiceKeyBinding> = {}): ServiceKeyBinding => ({
    participantType: pt, operatorAddress: addr, serviceAddress: addr, servicePubKey: key, status: 'ACTIVE', serviceAuthorizationNonce: 1n, ...extra,
  });
  const reads: string[] = [];
  const keys = {
    async getCurrentServiceKey(pt: string, addr: string) { reads.push(`${pt}:${addr}`); return binding(pt, addr); },
  } as VerifyDispatchResultHeaderParams['keys'];
  const params = (over: Partial<VerifyDispatchResultHeaderParams> = {}): VerifyDispatchResultHeaderParams => ({
    chainId: h0.winnerTicket!.chainId,
    sessionId: hash32Text(h0.winnerTicket!.sessionId),
    taskId: hash32Text(h0.taskId),
    taskHash: hash32Text(h0.winnerTicket!.taskHash),
    builders: [BUILDER],
    keys,
    ...over,
  });
  const sign = (digest: Uint8Array, priv = VECTOR_PRIV): Uint8Array => secp256k1.sign(digest, priv).toCompactRawBytes();
  /** Re-sign the header (after changing its ticket or accept) with the Builder key. */
  const resignHeader = (h: DispatchResultHeaderV1, priv = VECTOR_PRIV): DispatchResultHeaderV1 => {
    h.builderServiceSignature = new Uint8Array();
    h.builderServiceSignature = sign(dispatchResultHeaderDigest(h), priv);
    return h;
  };

  it('verifies the wire vector header and reports the attempt it names', async () => {
    const r = await verifyDispatchResultHeader(base(), params());
    expect(r).toMatchObject({
      dispatchTicketHash: `0x${vector('task_v1_dispatchticketv1').digest_hex}`,
      dispatchAcceptDigest: `0x${vector('task_v1_dispatchacceptv1').digest_hex}`,
      builder: BUILDER,
      winnerWorker: h0.accept!.member!.operatorAddress,
      recordStatus: 'PENDING',
    });
    expect(r.workerServicePubKey).toEqual(pub(VECTOR_PRIV));
    expect(reads).toContain(`PARTICIPANT_TYPE_BUILDER:${BUILDER}`);
    expect(reads).toContain(`PARTICIPANT_TYPE_CORTEX:${h0.accept!.member!.operatorAddress}`);
  });

  it('refuses a header signed by another key', async () => {
    await expect(verifyDispatchResultHeader(resignHeader(base(), OTHER_PRIV), params())).rejects.toMatchObject({ code: 'DATA_OUTPUT_DISPATCH_SIGNATURE_INVALID' });
    const tampered = base();
    tampered.recordStatus = DispatchRecordStatusV1.RECORDED;
    await expect(verifyDispatchResultHeader(tampered, params())).rejects.toMatchObject({ code: 'DATA_OUTPUT_DISPATCH_SIGNATURE_INVALID' });
  });

  it('refuses a winner ticket Builder the order was not sent to', async () => {
    await expect(verifyDispatchResultHeader(base(), params({ builders: ['trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man'] }))).rejects.toMatchObject({ code: 'DATA_OUTPUT_DISPATCH_BUILDER_UNEXPECTED' });
  });

  it('refuses a ticket for another task_hash, session or chain', async () => {
    await expect(verifyDispatchResultHeader(base(), params({ taskHash: `0x${'ab'.repeat(32)}` }))).rejects.toMatchObject({ code: 'DATA_OUTPUT_DISPATCH_HEADER_INVALID' });
    await expect(verifyDispatchResultHeader(base(), params({ sessionId: `0x${'ab'.repeat(32)}` }))).rejects.toMatchObject({ code: 'DATA_OUTPUT_DISPATCH_HEADER_INVALID' });
    await expect(verifyDispatchResultHeader(base(), params({ chainId: 'other-chain' }))).rejects.toMatchObject({ code: 'DATA_OUTPUT_DISPATCH_HEADER_INVALID' });
  });

  it('refuses a bad ticket signature even under a valid header signature', async () => {
    const h = base();
    h.winnerTicket!.builderServiceSignature = sign(dispatchTicketDigest(h.winnerTicket!), OTHER_PRIV);
    // The ticket's signature is outside its digest, so the accept still names it.
    await expect(verifyDispatchResultHeader(resignHeader(h), params())).rejects.toMatchObject({ code: 'DATA_OUTPUT_DISPATCH_SIGNATURE_INVALID', message: expect.stringMatching(/DispatchTicketV1/) });
  });

  it('refuses a bad accept signature even under a valid header signature', async () => {
    const h = base();
    h.accept!.serviceSignature = sign(dispatchAcceptDigest(h.accept!), OTHER_PRIV);
    await expect(verifyDispatchResultHeader(resignHeader(h), params())).rejects.toMatchObject({ code: 'DATA_OUTPUT_DISPATCH_SIGNATURE_INVALID', message: expect.stringMatching(/DispatchAcceptV1/) });
  });

  it('refuses an accept of another ticket or by another member', async () => {
    const h = base();
    h.accept!.dispatchTicketHash = new Uint8Array(32).fill(9);
    h.accept!.serviceSignature = sign(dispatchAcceptDigest(h.accept!));
    await expect(verifyDispatchResultHeader(resignHeader(h), params())).rejects.toMatchObject({ code: 'DATA_OUTPUT_DISPATCH_HEADER_INVALID' });
    const m = base();
    m.accept!.member!.slot += 1;
    m.accept!.serviceSignature = sign(dispatchAcceptDigest(m.accept!));
    await expect(verifyDispatchResultHeader(resignHeader(m), params())).rejects.toMatchObject({ code: 'DATA_OUTPUT_DISPATCH_HEADER_INVALID' });
  });

  it('selects the header key by its signed nonce, never older than the ticket', async () => {
    // Re-signed after a rotation: nonce 2 with the new key verifies against the current key.
    const rotated = base();
    rotated.serviceAuthorizationNonce = 2n;
    resignHeader(rotated, OTHER_PRIV);
    const rotatedKeys = {
      async getCurrentServiceKey(pt: string, addr: string) {
        return pt === 'PARTICIPANT_TYPE_BUILDER'
          ? binding(pt, addr, pub(OTHER_PRIV), { serviceAuthorizationNonce: 2n, previousServicePubKey: pub(VECTOR_PRIV), previousServiceAuthorizationNonce: 1n, previousRetiredHeight: 100n })
          : binding(pt, addr);
      },
    } as VerifyDispatchResultHeaderParams['keys'];
    // The ticket (nonce 1) now needs the previous key, which needs the order height.
    await expect(verifyDispatchResultHeader(rotated, params({ keys: rotatedKeys }))).rejects.toMatchObject({ code: 'DATA_OUTPUT_DISPATCH_KEY_UNAVAILABLE' });
    await expect(verifyDispatchResultHeader(rotated, params({ keys: rotatedKeys, earliestSubmitHeight: 99n }))).resolves.toMatchObject({ recordStatus: 'PENDING' });
    await expect(verifyDispatchResultHeader(rotated, params({ keys: rotatedKeys, earliestSubmitHeight: 100n }))).rejects.toMatchObject({ code: 'DATA_OUTPUT_DISPATCH_KEY_UNAVAILABLE' });
    const zero = base();
    zero.serviceAuthorizationNonce = 0n;
    await expect(verifyDispatchResultHeader(resignHeader(zero), params())).rejects.toMatchObject({ code: 'DATA_OUTPUT_DISPATCH_KEY_UNAVAILABLE' });
  });

  it('refuses a key binding for another operator or participant type', async () => {
    const worker = h0.accept!.member!.operatorAddress;
    const cases: Array<[string, (pt: string, addr: string) => ServiceKeyBinding]> = [
      ['Builder binding of another operator', (pt, addr) => binding(pt, pt === 'PARTICIPANT_TYPE_BUILDER' ? 'trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man' : addr)],
      ['Builder binding of the Cortex type', (pt, addr) => binding(pt === 'PARTICIPANT_TYPE_BUILDER' ? 'PARTICIPANT_TYPE_CORTEX' : pt, addr)],
      ['Worker binding of the Builder type', (pt, addr) => binding(pt === 'PARTICIPANT_TYPE_CORTEX' ? 'PARTICIPANT_TYPE_BUILDER' : pt, addr)],
      ['Worker binding of another operator', (pt, addr) => binding(pt, pt === 'PARTICIPANT_TYPE_CORTEX' ? `${worker.slice(0, -1)}x` : addr)],
    ];
    for (const [name, make] of cases) {
      const wrong = { async getCurrentServiceKey(pt: string, addr: string) { return make(pt, addr); } } as VerifyDispatchResultHeaderParams['keys'];
      await expect(verifyDispatchResultHeader(base(), params({ keys: wrong })), name).rejects.toMatchObject({ code: 'DATA_OUTPUT_DISPATCH_KEY_UNAVAILABLE' });
    }
  });

  it('requires the Worker current key to be ACTIVE for live output', async () => {
    const revoked = {
      async getCurrentServiceKey(pt: string, addr: string) {
        return binding(pt, addr, pub(VECTOR_PRIV), pt === 'PARTICIPANT_TYPE_CORTEX' ? { status: 'REVOKED' } : {});
      },
    } as VerifyDispatchResultHeaderParams['keys'];
    await expect(verifyDispatchResultHeader(base(), params({ keys: revoked }))).rejects.toMatchObject({ code: 'OUTPUT_TRUST_ANCHOR_WORKER_KEY_INACTIVE' });
  });

  it('refuses a header without its ticket or accept', async () => {
    const h = create(DispatchResultHeaderV1Schema, { taskId: h0.taskId, recordStatus: DispatchRecordStatusV1.PENDING, serviceAuthorizationNonce: 1n });
    await expect(verifyDispatchResultHeader(h, params())).rejects.toMatchObject({ code: 'DATA_OUTPUT_DISPATCH_HEADER_INVALID' });
    const unspecified = base();
    unspecified.recordStatus = DispatchRecordStatusV1.UNSPECIFIED;
    await expect(verifyDispatchResultHeader(resignHeader(unspecified), params())).rejects.toMatchObject({ code: 'DATA_OUTPUT_DISPATCH_HEADER_INVALID' });
  });
});
