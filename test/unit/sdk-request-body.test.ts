import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { bech32 } from '@scure/base';
import {
  SDK_BODY_DOMAIN,
  openTaskBodyDigest,
  openTaskPayloadRef,
  subscribeOutputBodyDigest,
  ackOutputBodyDigest,
  getTaskEventsBodyDigest,
  prepareChallengeBodyDigest,
  parseFromCursor,
} from '../../src/transport/sdk-request-body';
import { canonicalFrameBytes, canonicalHashBytes, optionalV1, uint64BE } from '../../src/codec/domain-hash';
import { fromHex, toHex } from '../../src/util/bytes';
import { TrueOpenError } from '../../src/errors/errors';

/**
 * Anchor: wire testdata/v1/task/sdk_request_body_v1.json. Every base, tamper and replay row is
 * reproduced twice where it can be: once through a generic H_FIELDS_V1 encoder driven by the
 * vector's typed fields (checks the framing), and once through the SDK's own per-method function
 * (checks the projection from transport values).
 */
const FILE = JSON.parse(readFileSync('third_party/wire/testdata/v1/task/sdk_request_body_v1.json', 'utf8'));
const enc = new TextEncoder();

interface TypedField {
  readonly name: string;
  readonly type: 'bytes' | 'uint64' | 'string' | 'address' | 'optional';
  readonly hex?: string;
  readonly value?: number;
  readonly utf8?: string;
  readonly bech32?: string;
  readonly present?: boolean;
  readonly fields?: readonly TypedField[];
}

interface Vector {
  readonly name: string;
  readonly domain: string;
  readonly fields: readonly TypedField[];
  readonly preimage_hex: string;
  readonly preimage_size_bytes: number;
  readonly digest_hex: string;
  readonly tamper: readonly { name: string; field: number; byte: number; bit: number; digest_hex: string }[];
  readonly replay: readonly {
    name: string;
    digest_hex: string;
    domain?: string;
    overrides?: readonly { field: number; value: TypedField }[];
  }[];
  readonly transport?: { payload_ref: string };
}

const VECTORS: readonly Vector[] = FILE.vectors;

/** The bytes a typed field contributes inside its outer frame. */
function encodeField(f: TypedField): Uint8Array {
  switch (f.type) {
    case 'bytes':
      return fromHex(f.hex!);
    case 'uint64':
      return uint64BE(BigInt(f.value!));
    case 'string':
      return enc.encode(f.utf8!);
    case 'address': {
      // Both columns are published; they must agree.
      const decoded = bech32.decode(f.bech32! as `${string}1${string}`);
      expect(toHex(Uint8Array.from(bech32.fromWords(decoded.words)))).toBe(f.hex);
      return fromHex(f.hex!);
    }
    case 'optional':
      return optionalV1(f.present === true ? encodeField(f.fields![0]!) : undefined);
  }
}

function genericDigest(domain: string, fields: readonly Uint8Array[]): string {
  return toHex(canonicalHashBytes(enc.encode(domain), ...fields));
}

const hexOf = (f: TypedField): string => f.hex!;
const bigOf = (f: TypedField): bigint => BigInt(f.value!);
const optBig = (f: TypedField): bigint | undefined => (f.present === true ? BigInt(f.fields![0]!.value!) : undefined);

/** The SDK call for one method, from typed fields (the inverse of the transport projection). */
const SDK_CALL: Readonly<Record<string, (f: readonly TypedField[]) => Uint8Array>> = {
  [SDK_BODY_DOMAIN.OpenTask]: (f) =>
    openTaskBodyDigest({
      taskHash: fromHex(hexOf(f[0]!)),
      sessionId: hexOf(f[1]!),
      orderSequence: bigOf(f[2]!),
      userAddress: f[3]!.bech32!,
      inputSizeBytes: bigOf(f[4]!),
      inputHash: hexOf(f[5]!),
      inputMediaType: f[6]!.utf8!,
      idempotencyKey: f[7]!.utf8!,
    }),
  [SDK_BODY_DOMAIN.SubscribeOutput]: (f) => subscribeOutputBodyDigest(hexOf(f[0]!), hexOf(f[1]!), optBig(f[2]!)),
  [SDK_BODY_DOMAIN.AckOutput]: (f) => ackOutputBodyDigest(hexOf(f[0]!), hexOf(f[1]!), bigOf(f[2]!)),
  [SDK_BODY_DOMAIN.GetTaskEvents]: (f) => {
    const cursor = optBig(f[2]!);
    return getTaskEventsBodyDigest(hexOf(f[0]!), hexOf(f[1]!), cursor === undefined ? '' : cursor.toString());
  },
  [SDK_BODY_DOMAIN.PrepareChallenge]: (f) =>
    prepareChallengeBodyDigest(
      hexOf(f[0]!),
      hexOf(f[1]!),
      f[2]!.utf8!,
      f[3]!.present === true ? fromHex(f[3]!.fields![0]!.hex!) : new Uint8Array(),
    ),
};

describe('SDK request body digests (wire sdk_request_body_v1.json)', () => {
  it('covers exactly the five registered body domains', () => {
    expect(VECTORS.map((v) => v.domain).sort()).toEqual(Object.values(SDK_BODY_DOMAIN).sort());
  });

  for (const v of VECTORS) {
    describe(v.name, () => {
      const encoded = v.fields.map(encodeField);

      it('preimage and digest match through the generic encoder', () => {
        const preimage = canonicalFrameBytes(enc.encode(v.domain), ...encoded);
        expect(toHex(preimage)).toBe(v.preimage_hex);
        expect(preimage.length).toBe(v.preimage_size_bytes);
        expect(genericDigest(v.domain, encoded)).toBe(v.digest_hex);
      });

      it('digest matches through the SDK function for the method', () => {
        expect(toHex(SDK_CALL[v.domain]!(v.fields))).toBe(v.digest_hex);
      });

      for (const t of v.tamper) {
        it(`tamper ${t.name}`, () => {
          const fields = encoded.map((b) => Uint8Array.from(b));
          const target = fields[t.field]!;
          const at = t.byte < 0 ? target.length + t.byte : t.byte;
          target[at] = target[at]! ^ (1 << t.bit);
          const got = genericDigest(v.domain, fields);
          expect(got).toBe(t.digest_hex);
          expect(got).not.toBe(v.digest_hex);
        });
      }

      for (const r of v.replay) {
        it(`replay ${r.name}`, () => {
          const typed = [...v.fields];
          for (const o of r.overrides ?? []) typed[o.field] = o.value;
          const domain = r.domain ?? v.domain;
          expect(genericDigest(domain, typed.map(encodeField))).toBe(r.digest_hex);
          expect(r.digest_hex).not.toBe(v.digest_hex);
          // A same-domain row is also reachable through the SDK projection.
          if (r.domain === undefined) expect(toHex(SDK_CALL[domain]!(typed))).toBe(r.digest_hex);
        });
      }
    });
  }

  it('OpenTask payload_ref is derived from input_hash and matches the transport column', () => {
    const v = VECTORS.find((x) => x.domain === SDK_BODY_DOMAIN.OpenTask)!;
    expect(openTaskPayloadRef(v.fields[5]!.hex!)).toBe(v.transport!.payload_ref);
  });
});

describe('SDK request body projection refuses what cannot be projected', () => {
  const S = '77625100ba4faa1306ae6eaf5a872a661443aa94f87c5530c4b178614e3d62f7';
  const T = 'bce966ae829f212a35982bcd85aaea77d8893539afa04f32ea540c46ff8323b0';
  const refused = (fn: () => unknown): void => {
    expect(fn).toThrow(TrueOpenError);
    expect(fn).toThrow(/request body|64-character lowercase hex/);
  };

  it('Hash32 ids: uppercase and 0x-prefixed spellings', () => {
    refused(() => ackOutputBodyDigest(S.toUpperCase(), T, 1n));
    refused(() => ackOutputBodyDigest(S, `0x${T}`, 1n));
    refused(() => subscribeOutputBodyDigest(S.slice(2), T));
  });

  it('from_cursor: empty is absent, "0" is present, anything else non-canonical is refused', () => {
    expect(parseFromCursor('')).toBeUndefined();
    expect(parseFromCursor('0')).toBe(0n);
    expect(parseFromCursor('18446744073709551615')).toBe((1n << 64n) - 1n);
    for (const bad of ['007', '-1', '+1', ' 1', '1.0', 'abc', '18446744073709551616']) {
      refused(() => getTaskEventsBodyDigest(S, T, bad));
    }
  });

  it('local_evidence_digest: empty or exactly 32 bytes', () => {
    refused(() => prepareChallengeBodyDigest(S, T, 'USER_DISPUTE', new Uint8Array(16)));
    expect(toHex(prepareChallengeBodyDigest(S, T, 'USER_DISPUTE'))).toBe(
      toHex(prepareChallengeBodyDigest(S, T, 'USER_DISPUTE', new Uint8Array())),
    );
  });

  it('OpenTask: a user_address that is not canonical Bech32 is refused', () => {
    const base = {
      taskHash: new Uint8Array(32), sessionId: S, orderSequence: 7n, inputSizeBytes: 1n,
      inputHash: '22'.repeat(32), inputMediaType: 'application/json', idempotencyKey: 'k',
    };
    expect(() => openTaskBodyDigest({ ...base, userAddress: 'TRUEOPEN1RFJZ7R3U8T65TEAVH5UTQUJ3KWVSJ983P3JCLZ' })).toThrow(TrueOpenError);
    expect(() => openTaskBodyDigest({ ...base, userAddress: 'trueopen1rfjz7r3u8t65teavh5utquj3kwvsj983p3jclz' })).not.toThrow();
    // A 32-byte (module-style) address is not an account address.
    const long = bech32.encode('trueopen', bech32.toWords(new Uint8Array(32).fill(1)));
    expect(() => openTaskBodyDigest({ ...base, userAddress: long })).toThrow(/not 20/);
  });
});
