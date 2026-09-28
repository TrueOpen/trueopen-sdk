import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';
import {
  taskOrderHash,
  taskOrderHashHex,
  DOMAIN_TASK_ORDER_V3,
  PAYLOAD_MODE,
  TASK_ORDER_SCHEMA_VERSION_V3,
} from '../../src/order/task-order';
import type { AmountV1, TaskOrderV3 } from '../../src/order/task-order';
import { canonicalFrameBytes, uint32BE, int32BE, uint64BE } from '../../src/codec/domain-hash';
import { fromHex, toHex } from '../../src/util/bytes';

/**
 * Cross-repo consistency gate for TaskOrderV3, driven entirely by
 * third_party/wire/testdata/v1/task/task_order_v3.json.
 *
 * Two independent paths must agree with the fixture:
 *   1. a generic encoder of the fixture's typed field list (this file) reproduces
 *      preimage_hex byte for byte, proving we read the framing the same way wire does;
 *   2. the SDK's taskOrderHash, fed the same values through the TaskOrderV3 view,
 *      reproduces digest_hex.
 * Do not "update the expected value in place" -- the fixture is the contract.
 */

interface FixtureField {
  readonly name: string;
  readonly type: string;
  readonly value?: number | string;
  readonly utf8?: string;
  readonly hex?: string;
  readonly bool?: boolean;
  readonly empty?: boolean;
  readonly fields?: readonly FixtureField[];
}

interface FixtureVector {
  readonly name: string;
  readonly domain: string;
  readonly digest_hex: string;
  readonly preimage_hex?: string;
  readonly preimage_size_bytes: number;
  readonly fields: readonly FixtureField[];
  readonly mutations?: readonly { readonly digest_hex?: string; readonly expect: string }[];
}

const fixture = JSON.parse(
  readFileSync('third_party/wire/testdata/v1/task/task_order_v3.json', 'utf8'),
) as { vectors: FixtureVector[] };
const orderVectors = fixture.vectors.filter((v) => v.domain === DOMAIN_TASK_ORDER_V3);
const openingVectors = fixture.vectors.filter((v) => v.domain === 'TRUEOPEN_ORDER_OPENING_V2');
const enc = new TextEncoder();

/** Encodes one fixture leaf exactly as its declared type says, independent of src/. */
function encodeFixtureField(f: FixtureField): Uint8Array {
  switch (f.type) {
    case 'uint32':
    case 'enum':
      return uint32BE(Number(f.value));
    case 'int32':
      return int32BE(Number(f.value));
    case 'uint64':
      return uint64BE(BigInt(f.value as number | string));
    case 'bool':
      return new Uint8Array([f.bool === true ? 1 : 0]);
    case 'string':
      return enc.encode(f.utf8 ?? '');
    case 'address':
    case 'bytes':
      return f.empty === true ? new Uint8Array(0) : fromHex(f.hex ?? '');
    case 'frame':
      return canonicalFrameBytes(...(f.fields ?? []).map(encodeFixtureField));
    default:
      throw new Error(`unknown fixture field type ${f.type}`);
  }
}

function byName(fields: readonly FixtureField[], name: string): FixtureField {
  const f = fields.find((x) => x.name === name);
  if (f === undefined) throw new Error(`fixture field ${name} missing`);
  return f;
}

const num = (fields: readonly FixtureField[], name: string): number => Number(byName(fields, name).value);
const big = (fields: readonly FixtureField[], name: string): bigint =>
  BigInt(byName(fields, name).value as number | string);
const bytes = (fields: readonly FixtureField[], name: string): Uint8Array => encodeFixtureField(byName(fields, name));
const amount = (fields: readonly FixtureField[], name: string): AmountV1 => ({
  atomicUnits: byName(byName(fields, name).fields ?? [], 'atomic_units').utf8 ?? '',
});

/** Lifts the fixture's field list into the SDK's TaskOrderV3 view. */
function toTaskOrder(v: FixtureVector): TaskOrderV3 {
  const f = v.fields;
  const gen = byName(f, 'generation_params').fields ?? [];
  const dec = byName(gen, 'decoding_params').fields ?? [];
  const list = (name: string): readonly FixtureField[] => (byName(dec, name).fields ?? []).slice(1);
  return {
    schemaVersion: num(f, 'schema_version'),
    chainId: byName(f, 'chain_id').utf8 ?? '',
    userAddress: bech32.encode('trueopen', bech32.toWords(bytes(f, 'user_address'))),
    sessionId: bytes(f, 'session_id'),
    orderSequence: big(f, 'order_sequence'),
    modelId: bytes(f, 'model_id'),
    profileVersion: num(f, 'profile_version'),
    taskType: num(f, 'task_type'),
    inputHash: bytes(f, 'input_hash'),
    inputSizeBytes: big(f, 'input_size_bytes'),
    inputBucket: num(f, 'input_bucket'),
    outputBudgetBucket: num(f, 'output_budget_bucket'),
    generationParams: {
      generationParamsSchemaVersion: num(gen, 'generation_params_schema_version'),
      maxOutputTokens: big(gen, 'max_output_tokens'),
      maxOutputDuration: big(gen, 'max_output_duration'),
      decodingParams: {
        samplingEnabled: byName(dec, 'sampling_enabled').bool === true,
        temperatureMilli: num(dec, 'temperature_milli'),
        topPPpm: num(dec, 'top_p_ppm'),
        topK: num(dec, 'top_k'),
        seed: big(dec, 'seed'),
        presencePenaltyMilli: num(dec, 'presence_penalty_milli'),
        frequencyPenaltyMilli: num(dec, 'frequency_penalty_milli'),
        repetitionPenaltyPpm: num(dec, 'repetition_penalty_ppm'),
        stopSequences: list('stop_sequences').map((x) => x.utf8 ?? ''),
        stopTokenIds: list('stop_token_ids').map((x) => Number(x.value)),
      },
    },
    priceBid: amount(f, 'price_bid'),
    maxFee: amount(f, 'max_fee'),
    assignmentPriorityFee: amount(f, 'assignment_priority_fee'),
    txFeeReserve: amount(f, 'tx_fee_reserve'),
    earliestSubmitHeight: big(f, 'earliest_submit_height'),
    orderExpireHeight: big(f, 'order_expire_height'),
    deadlinePolicy: { latencyClass: num(byName(f, 'deadline_policy').fields ?? [], 'latency_class') },
    timeoutBucketVersion: big(f, 'timeout_bucket_version'),
    sessionAnchorHeight: big(f, 'session_anchor_height'),
    sessionAnchorBlockHash: bytes(f, 'session_anchor_block_hash'),
    builderSetId: byName(f, 'builder_set_id').utf8 ?? '',
    builderSetHash: bytes(f, 'builder_set_hash'),
    payloadMode: num(f, 'payload_mode'),
    inputKeyCommitment: bytes(f, 'input_key_commitment'),
    userRecipientPubkey: bytes(f, 'user_recipient_pubkey'),
  };
}

describe('TaskOrderV3 wire vectors (task_order_v3.json)', () => {
  it('covers the three TRUEOPEN_TASK_ORDER_V3 vectors with 28 top-level fields', () => {
    expect(orderVectors.map((v) => v.name)).toEqual([
      'task_order_v3_core',
      'task_order_v3_lower_bound',
      'task_order_v3_max_amounts',
    ]);
    for (const v of orderVectors) expect(v.fields).toHaveLength(28);
  });

  for (const v of orderVectors) {
    it(`${v.name}: fixture field list reproduces the published preimage and digest`, () => {
      const preimage = canonicalFrameBytes(enc.encode(v.domain), ...v.fields.map(encodeFixtureField));
      expect(preimage.length).toBe(v.preimage_size_bytes);
      if (v.preimage_hex !== undefined) expect(toHex(preimage)).toBe(v.preimage_hex);
      expect(toHex(sha256(preimage))).toBe(v.digest_hex);
    });

    it(`${v.name}: SDK taskOrderHash equals the published digest`, () => {
      const order = toTaskOrder(v);
      expect(order.schemaVersion).toBe(TASK_ORDER_SCHEMA_VERSION_V3);
      expect(taskOrderHashHex(order)).toBe(v.digest_hex);
    });
  }
});

describe('TRUEOPEN_ORDER_OPENING_V2 vectors (task_order_v3.json)', () => {
  // The Keeper produces the opening; the SDK does not. These checks keep the SDK's reading
  // of the fixture honest: the opening is the 20-field light projection of the matching
  // order, with generation_params replaced by its digest (the SDK does not compute
  // generation_params_digest, so it is taken from the vector).
  it('pairs each opening vector with an order vector', () => {
    expect(openingVectors.map((v) => v.name)).toEqual([
      'order_opening_v2_core',
      'order_opening_v2_lower_bound',
      'order_opening_v2_max_amounts',
    ]);
    for (const v of openingVectors) expect(v.fields).toHaveLength(20);
  });

  for (const v of openingVectors) {
    it(`${v.name}: fixture field list reproduces the published preimage and digest`, () => {
      const preimage = canonicalFrameBytes(enc.encode(v.domain), ...v.fields.map(encodeFixtureField));
      expect(preimage.length).toBe(v.preimage_size_bytes);
      if (v.preimage_hex !== undefined) expect(toHex(preimage)).toBe(v.preimage_hex);
      expect(toHex(sha256(preimage))).toBe(v.digest_hex);
    });

    it(`${v.name}: every shared field is byte-identical to the matching order vector`, () => {
      const order = orderVectors.find((o) => o.name === v.name.replace('order_opening_v2', 'task_order_v3'))!;
      for (const f of v.fields) {
        if (f.name === 'generation_params_digest') continue;
        expect(toHex(encodeFixtureField(f)), f.name).toBe(toHex(encodeFixtureField(byName(order.fields, f.name))));
      }
    });
  }
});

describe('mutation rows (task_order_v3.json)', () => {
  // The mutated values are not published, so the digests cannot be recomputed; at least
  // every row must move the digest. (Rows can legitimately share a digest: changing a
  // single-leaf frame and changing that leaf is the same edit.)
  for (const v of [...orderVectors, ...openingVectors]) {
    it(`${v.name}: every mutation digest differs from the base`, () => {
      const digests = (v.mutations ?? []).filter((m) => m.expect === 'digest_changes').map((m) => m.digest_hex);
      expect(digests.length).toBeGreaterThan(0);
      expect(digests).not.toContain(v.digest_hex);
    });
  }
});

describe('TaskOrderV3 field binding (local mutations of the core vector)', () => {
  const base = (): TaskOrderV3 => toTaskOrder(orderVectors[0]!);
  const baseHex = toHex(taskOrderHash(base()));
  const flip = (b: Uint8Array): Uint8Array => {
    const out = b.slice();
    out[0] = out[0]! ^ 0x01;
    return out;
  };

  const mutations: [string, (o: TaskOrderV3) => TaskOrderV3][] = [
    ['model_id', (o) => ({ ...o, modelId: flip(o.modelId) })],
    ['session_id', (o) => ({ ...o, sessionId: flip(o.sessionId) })],
    ['input_hash', (o) => ({ ...o, inputHash: flip(o.inputHash) })],
    ['chain_id', (o) => ({ ...o, chainId: `${o.chainId}x` })],
    ['order_sequence', (o) => ({ ...o, orderSequence: o.orderSequence + 1n })],
    ['profile_version', (o) => ({ ...o, profileVersion: o.profileVersion + 1 })],
    ['max_fee', (o) => ({ ...o, maxFee: { atomicUnits: '150001' } })],
    ['builder_set_hash', (o) => ({ ...o, builderSetHash: flip(o.builderSetHash) })],
  ];
  for (const [name, mutate] of mutations) {
    it(`changing ${name} changes task_hash`, () => {
      expect(toHex(taskOrderHash(mutate(base())))).not.toBe(baseHex);
    });
  }

  it('user signature material is not part of task_hash (same order hashes the same)', () => {
    expect(toHex(taskOrderHash(base()))).toBe(baseHex);
  });
});

describe('TaskOrderV3 plaintext Phase 0 scope', () => {
  const base = (): TaskOrderV3 => toTaskOrder(orderVectors[0]!);
  const rejects: [string, (o: TaskOrderV3) => TaskOrderV3][] = [
    ['schema_version 2', (o) => ({ ...o, schemaVersion: 2 })],
    ['31-byte model_id', (o) => ({ ...o, modelId: o.modelId.slice(1) })],
    ['payload_mode UNSPECIFIED', (o) => ({ ...o, payloadMode: PAYLOAD_MODE.UNSPECIFIED })],
    ['payload_mode ENCRYPTED', (o) => ({ ...o, payloadMode: PAYLOAD_MODE.ENCRYPTED })],
    ['non-zero input_key_commitment', (o) => ({ ...o, inputKeyCommitment: new Uint8Array(32).fill(1) })],
    ['31-byte input_key_commitment', (o) => ({ ...o, inputKeyCommitment: new Uint8Array(31) })],
    ['non-empty user_recipient_pubkey', (o) => ({ ...o, userRecipientPubkey: new Uint8Array(33) })],
  ];
  for (const [name, mutate] of rejects) {
    it(`rejects ${name}`, () => {
      expect(() => taskOrderHash(mutate(base()))).toThrow(/scalar scope/);
    });
  }
});
