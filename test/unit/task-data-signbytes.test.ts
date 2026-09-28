import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  canonicalObjectRefFrame,
  taskDataMetadataBodyDigest,
  taskDataFetchBodyDigest,
  taskDataRequestSignBytes,
  taskDataRequestEip712Digest,
  TASK_DATA_BODY_DOMAIN,
  TASK_DATA_RPC_METHOD,
  TASK_DATA_OBJECT_KIND,
  TASK_DATA_REQUESTER_KIND,
  EVIDENCE_KIND,
} from '../../src/transport/task-data-signbytes';
import type { TaskDataObjectRef } from '../../src/transport/task-data-signbytes';
import { bech32 } from '@scure/base';
import { canonicalFrameBytes } from '../../src/codec/domain-hash';
import { toHex, fromHex, concatBytes } from '../../src/util/bytes';

/** Anchor: wire's testdata/v1/task/task_data_auth_v1.json, read directly from the submodule. */
const auth = JSON.parse(readFileSync('third_party/wire/testdata/v1/task/task_data_auth_v1.json', 'utf8'));
const account = JSON.parse(readFileSync('third_party/wire/testdata/v1/shared/account_signing_v1.json', 'utf8'));

const vector = (name: string): Record<string, unknown> =>
  auth.vectors.find((v: { name: string }) => v.name === name) as Record<string, unknown>;

/** The OUTPUT object in the vector: not evidence, so producer kind/round are zero and operator is omitted. */
const REF: TaskDataObjectRef = {
  taskHash: '2222222222222222222222222222222222222222222222222222222222222222',
  sessionId: '3333333333333333333333333333333333333333333333333333333333333333',
  taskId: '1111111111111111111111111111111111111111111111111111111111111111',
  objectKind: TASK_DATA_OBJECT_KIND.OUTPUT,
  contentHash: '4444444444444444444444444444444444444444444444444444444444444444',
};

const OPERATOR = 'trueopen1crqu9s7ychrv0jxfet9uenwwelgdr5knutsmxe';

describe('body digest (H_FIELDS_V1)', () => {
  it('upload body object ref: evidence ref with an address-encoded producer_operator and evidence_kind', () => {
    // The upload vector is the only one that exercises the present producer_operator and a non-zero
    // evidence_kind, so check the object ref frame against its preimage segment.
    const v = vector('task_data_upload_body_v2') as { preimage_hex?: string; fields: { fields: unknown[] }[] };
    const ref: TaskDataObjectRef = {
      ...REF,
      objectKind: TASK_DATA_OBJECT_KIND.EVIDENCE_MANIFEST,
      evidenceProducerKind: 2,
      verifyRound: 2,
      producerOperator: OPERATOR,
      evidenceKind: EVIDENCE_KIND.VERIFIER_VALUE_OPENING,
    };
    expect(v.fields[0]!.fields).toHaveLength(9);
    expect(v.preimage_hex).toContain(toHex(canonicalObjectRefFrame(ref)));
  });

  it('GetTaskDataMetadata preimage and digest', () => {
    const v = vector('task_data_metadata_body_v2');
    expect(v['domain']).toBe(TASK_DATA_BODY_DOMAIN.METADATA);
    // Compare the preimage first, then the digest: if the digest doesn't match, the preimage pinpoints exactly which segment is wrong.
    const preimage = canonicalFrameBytes(
      new TextEncoder().encode(TASK_DATA_BODY_DOMAIN.METADATA),
      canonicalObjectRefFrame(REF),
    );
    expect(toHex(preimage)).toBe(v['preimage_hex']);
    expect(toHex(taskDataMetadataBodyDigest(REF))).toBe(v['digest_hex']);
  });

  it('FetchTaskData preimage and digest with a range', () => {
    const v = vector('task_data_fetch_body_v2');
    expect(v['domain']).toBe(TASK_DATA_BODY_DOMAIN.FETCH);
    const range = { offset: 64n, length: 128n };
    // present optional = 0x01 followed by a length-prefixed frame of the value itself; that value is in turn
    // offset and length, each a u64 wrapped in its own length-prefixed frame. Neither layer can be skipped --
    // omitting one turns 41 bytes into 25 bytes.
    const rangeValue = canonicalFrameBytes(fromHex('0000000000000040'), fromHex('0000000000000080'));
    const preimage = canonicalFrameBytes(
      new TextEncoder().encode(TASK_DATA_BODY_DOMAIN.FETCH),
      canonicalObjectRefFrame(REF),
      concatBytes(new Uint8Array([0x01]), canonicalFrameBytes(rangeValue)),
    );
    expect(toHex(preimage)).toBe(v['preimage_hex']);
    expect(toHex(taskDataFetchBodyDigest(REF, range))).toBe(v['digest_hex']);
  });

  it('a whole-object read (range omitted) and a present range of offset=0 are not the same digest', () => {
    // A semantic pitfall the contract calls out explicitly: omitted is a single 0x00 byte and must not be rewritten as a present zero-length range.
    const whole = taskDataFetchBodyDigest(REF);
    const zeroRange = taskDataFetchBodyDigest(REF, { offset: 0n, length: 0n });
    expect(toHex(whole)).not.toBe(toHex(zeroRange));
  });

  it('digest changes if any field of object_ref changes', () => {
    const base = toHex(taskDataMetadataBodyDigest(REF));
    expect(toHex(taskDataMetadataBodyDigest({ ...REF, objectKind: TASK_DATA_OBJECT_KIND.INPUT }))).not.toBe(base);
    expect(toHex(taskDataMetadataBodyDigest({ ...REF, verifyRound: 1 }))).not.toBe(base);
    // A present producer_operator is distinct from an omitted one, and must be a real address.
    expect(toHex(taskDataMetadataBodyDigest({ ...REF, producerOperator: OPERATOR }))).not.toBe(base);
    expect(() => taskDataMetadataBodyDigest({ ...REF, producerOperator: '' })).toThrow();
  });

  // The fixture's evidence_kind mutation rows are reject_before_hash: each +1 lands on a
  // kind that is illegal for that object, so the SDK must refuse it before hashing.
  it('refuses every reject_before_hash evidence_kind row the SDK computes a body for', () => {
    const rows = (auth.vectors as { name: string; mutations?: { expect: string; field_path: string }[] }[])
      .flatMap((v) => (v.mutations ?? []).map((m) => ({ vector: v.name, ...m })))
      .filter((m) => m.expect === 'reject_before_hash');
    expect(rows.map((r) => r.vector).sort()).toEqual([
      'task_data_fetch_body_v2',
      'task_data_finalize_result_body_v2',
      'task_data_metadata_body_v2',
      'task_data_upload_body_v2',
    ]);
    // metadata / fetch: evidence_kind 0 -> 1 on an OUTPUT object.
    const onOutput = { ...REF, evidenceKind: EVIDENCE_KIND.WORKER_VALUE_OPENING };
    expect(() => taskDataMetadataBodyDigest(onOutput)).toThrow(/non-evidence/);
    expect(() => taskDataFetchBodyDigest(onOutput)).toThrow(/non-evidence/);
    // upload: a Verifier evidence ref, evidence_kind 2 -> 3 (settlement root opening).
    const verifierRef: TaskDataObjectRef = {
      ...REF,
      objectKind: TASK_DATA_OBJECT_KIND.EVIDENCE_MANIFEST,
      evidenceProducerKind: 2,
      verifyRound: 2,
      producerOperator: OPERATOR,
      evidenceKind: EVIDENCE_KIND.VERIFIER_VALUE_OPENING,
    };
    expect(() => canonicalObjectRefFrame(verifierRef)).not.toThrow();
    expect(() => canonicalObjectRefFrame({ ...verifierRef, evidenceKind: EVIDENCE_KIND.SETTLEMENT_ROOT_OPENING })).toThrow(/data-plane/);
    // finalize_result is a Worker-side body the SDK does not build; its row is listed above only.
  });

  it('evidence objects need a kind their producer can produce', () => {
    const worker: TaskDataObjectRef = {
      ...REF, objectKind: TASK_DATA_OBJECT_KIND.EVIDENCE_ARTIFACT, evidenceProducerKind: 1, producerOperator: OPERATOR,
      evidenceKind: EVIDENCE_KIND.WORKER_TOKEN_OPENING,
    };
    expect(() => canonicalObjectRefFrame(worker)).not.toThrow();
    expect(() => canonicalObjectRefFrame({ ...worker, evidenceKind: EVIDENCE_KIND.WORKER_VALUE_OPENING })).not.toThrow();
    expect(() => canonicalObjectRefFrame({ ...worker, evidenceKind: EVIDENCE_KIND.VERIFIER_VALUE_OPENING })).toThrow();
    expect(() => canonicalObjectRefFrame({ ...worker, evidenceKind: EVIDENCE_KIND.UNSPECIFIED })).toThrow();
    expect(() => canonicalObjectRefFrame({ ...worker, evidenceProducerKind: 0 })).toThrow();
  });

  // "no producer kind" and "wrong kind for this producer" are different mistakes; folding
  // them together produced "evidence_kind 0 is not a data-plane evidence kind for producer
  // kind 0", which names neither.
  it('names the missing producer kind separately from a wrong evidence kind', () => {
    const evidence: TaskDataObjectRef = {
      ...REF, objectKind: TASK_DATA_OBJECT_KIND.EVIDENCE_ARTIFACT, producerOperator: OPERATOR,
      evidenceKind: EVIDENCE_KIND.WORKER_TOKEN_OPENING,
    };
    expect(() => canonicalObjectRefFrame({ ...evidence, evidenceProducerKind: 0 })).toThrow(
      /needs evidence_producer_kind WORKER or VERIFIER/,
    );
    expect(() => canonicalObjectRefFrame({ ...evidence, evidenceProducerKind: 2 })).toThrow(
      /is not a data-plane evidence kind for producer kind 2/,
    );
  });

  it('Hash32 must be canonical lowercase 64-hex', () => {
    expect(() => taskDataMetadataBodyDigest({ ...REF, taskHash: '22' })).toThrow(/64-hex/);
    // Only a value containing letters can actually test case sensitivity (the hashes in the vector are all digits, so uppercasing them leaves the string unchanged).
    expect(() => taskDataMetadataBodyDigest({ ...REF, taskHash: 'a'.repeat(64) })).not.toThrow();
    expect(() => taskDataMetadataBodyDigest({ ...REF, taskHash: 'A'.repeat(64) })).toThrow(/64-hex/);
  });
});

describe('CORTEX_SERVICE branch (H_FIELDS_V1 outer layer)', () => {
  it('reproduces the task_data_request_v1_cortex_service digest', () => {
    const v = vector('task_data_request_v1_cortex_service');
    const f = Object.fromEntries(
      (v['fields'] as { name: string; [k: string]: unknown }[]).map((x) => [x.name, x]),
    );
    // The address field vector provides both bech32 and 20-byte hex: the SDK accepts bech32, but the preimage must use the hex form.
    // Here we **re-encode bech32 from the hex** instead of using the vector's bech32 annotation directly:
    // an earlier fixture revision carried a broken checksum in the requester_address annotation (see the dedicated test case below),
    // and since the digest is computed from hex, re-encoding from hex sidesteps the annotation defect without touching the authoritative value.
    const val = (name: string): unknown => f[name]?.['value'] ?? f[name]?.['utf8'] ?? f[name]?.['hex'];
    const addr = (name: string): string =>
      bech32.encode('trueopen', bech32.toWords(fromHex(String(f[name]?.['hex']))));
    expect(
      toHex(
        taskDataRequestSignBytes({
          schemaVersion: Number(val('schema_version')),
          chainId: String(val('chain_id')),
          builderOperatorAddress: addr('builder_operator_address'),
          rpcMethod: String(val('rpc_method')),
          bodyDigest: fromHex(String(val('body_digest'))),
          requesterKind: Number(val('requester_kind')),
          requesterAddress: addr('requester_address'),
          serviceAuthorizationNonce: BigInt(String(val('service_authorization_nonce'))),
          requestNonce: fromHex(String(val('request_nonce'))),
          expiryHeight: BigInt(String(val('expiry_height'))),
        }),
      ),
    ).toBe(v['digest_hex']);
  });

  it('every address\'s bech32 annotation in the vector is self-consistent with its hex', () => {
    // This was previously a snapshot of a known defect: an earlier task_data_auth_v1.json carried a broken checksum in
    // the requester_address's bech32 annotation (hex is authoritative and the digest only consumes hex, so the digest
    // itself is unaffected). wire has since fixed the bech32 column, so this is now a positive
    // assertion: both addresses must re-encode from hex into an identical bech32, and both must decode successfully.
    const v = vector('task_data_request_v1_cortex_service');
    const f = Object.fromEntries((v['fields'] as { name: string }[]).map((x) => [x.name, x])) as Record<
      string,
      { hex?: string; bech32?: string }
    >;
    const reencode = (hex: string): string => bech32.encode('trueopen', bech32.toWords(fromHex(hex)));
    for (const name of ['builder_operator_address', 'requester_address']) {
      expect(reencode(f[name]!.hex!)).toBe(f[name]!.bech32);
      expect(() => bech32.decode(f[name]!.bech32 as `${string}1${string}`)).not.toThrow();
    }
  });

  it('the address that goes into the preimage is the raw 20-byte codec bytes, not the bech32 text', () => {
    const v = vector('task_data_request_v1_cortex_service');
    const f = Object.fromEntries((v['fields'] as { name: string }[]).map((x) => [x.name, x])) as Record<
      string,
      { hex?: string; bech32?: string }
    >;
    const hex = f['builder_operator_address']?.hex ?? '';
    expect(hex).toHaveLength(40);
    // What appears in the preimage is the 20-byte hex with a u64be(20)=0x14 length prefix, not the bech32 text string.
    expect(String(v['preimage_hex'])).toContain(`0000000000000014${hex}`);
    expect(String(v['preimage_hex'])).not.toContain(toHex(new TextEncoder().encode(f['builder_operator_address']?.bech32 ?? '')));
  });
});

describe('USER branch (EIP-712 outer layer)', () => {
  const t = account.task_data_request;
  const m = t.message;
  const fields = {
    schemaVersion: Number(m.schemaVersion),
    chainId: m.chainId as string,
    builderOperatorAddress: m.builderOperatorAddress as string,
    rpcMethod: m.rpcMethod as string,
    bodyDigest: fromHex(m.bodyDigest),
    requesterKind: Number(m.requesterKind),
    requesterAddress: m.requesterAddress as string,
    serviceAuthorizationNonce: BigInt(m.serviceAuthorizationNonce),
    requestNonce: fromHex(m.requestNonce),
    expiryHeight: BigInt(m.expiryHeight),
  };

  it('signing digest matches the vector', () => {
    expect(toHex(taskDataRequestEip712Digest(fields, t.domain.chain_id))).toBe(t.signing_digest);
  });

  it('the vector\'s body_digest is exactly the fetch body one', () => {
    // The vector itself declares this chain: body_digest_source = task_data_fetch_body_v1.
    expect(m.bodyDigest).toBe(vector('task_data_fetch_body_v2')['digest_hex']);
    expect(m.rpcMethod).toBe(TASK_DATA_RPC_METHOD.FetchTaskData);
    expect(Number(m.requesterKind)).toBe(TASK_DATA_REQUESTER_KIND.USER);
  });

  it('USER must carry service_authorization_nonce = 0', () => {
    expect(() => taskDataRequestEip712Digest({ ...fields, serviceAuthorizationNonce: 1n }, t.domain.chain_id)).toThrow(
      /service_authorization_nonce 0/,
    );
  });

  it('rpc_method must be a fully qualified name', () => {
    expect(() => taskDataRequestEip712Digest({ ...fields, rpcMethod: 'FetchTaskData' }, t.domain.chain_id)).toThrow(
      /fully qualified/,
    );
  });

  it('request_nonce must be exactly 32 bytes', () => {
    expect(() =>
      taskDataRequestEip712Digest({ ...fields, requestNonce: new Uint8Array(16) }, t.domain.chain_id),
    ).toThrow(/request_nonce must be 32 bytes/);
  });

  it('the two branches give different digests for the same set of fields (they must not be mixed)', () => {
    const userDigest = toHex(taskDataRequestEip712Digest(fields, t.domain.chain_id));
    const serviceDigest = toHex(taskDataRequestSignBytes(fields));
    expect(userDigest).not.toBe(serviceDigest);
  });
});
