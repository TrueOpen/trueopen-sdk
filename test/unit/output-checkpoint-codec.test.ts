import { describe, expect, it } from 'vitest';
import {
  deserializeOutputStreamCheckpoint,
  OUTPUT_STREAM_CHECKPOINT_JSON_FORMAT_V1,
  serializeOutputStreamCheckpoint,
} from '../../src/output/output-checkpoint-codec';
import {
  OUTPUT_MMR_DOMAIN,
  OutputStreamVerifier,
  outputChunkSigningDigest,
} from '../../src/output/output-commitment';
import { mmrPrefixRoot } from '../../src/codec/mmr';
import { privKeySecp256k1DigestSigner, secp256k1PublicKey } from '../../src/signer/secp256k1';
import { fromHex, toHex } from '../../src/util/bytes';
import { TrueOpenError } from '../../src/errors/errors';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const CHAIN_ID = 'trueopen-localnet-1';
const TASK_HASH = 'ab'.repeat(32);
const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const PUB = secp256k1PublicKey(PRIV);
const CHUNKS = [utf8('a'), utf8('Zürich'), new Uint8Array(0)];

async function checkpoint() {
  const sign = privKeySecp256k1DigestSigner(PRIV);
  const verifier = new OutputStreamVerifier({
    chainId: CHAIN_ID,
    taskHash: fromHex(TASK_HASH),
    workerServicePubKey: PUB,
  });
  for (let i = 0; i < CHUNKS.length; i += 1) {
    const seq = BigInt(i);
    const mmrRoot = mmrPrefixRoot(OUTPUT_MMR_DOMAIN, CHUNKS, i + 1);
    verifier.accept({
      seq,
      text: CHUNKS[i]!,
      mmrRoot,
      signature: await sign(outputChunkSigningDigest({
        chainId: CHAIN_ID,
        taskHash: fromHex(TASK_HASH),
        seq,
        mmrRoot,
      })),
    });
  }
  return verifier.checkpoint();
}

function expectInvalid(run: () => unknown): void {
  try {
    run();
    throw new Error('expected invalid checkpoint');
  } catch (error) {
    expect(error).toBeInstanceOf(TrueOpenError);
    expect(error).toMatchObject({
      family: 'SDK_LOCAL', code: 'OUTPUT_STREAM_CHECKPOINT_JSON_INVALID', retriable: false,
    });
  }
}

describe('output checkpoint JSON codec', () => {
  it('bytes/bigint round-trip stably; the restored verifier preserves root/text/cursor', async () => {
    const original = await checkpoint();
    const json = serializeOutputStreamCheckpoint(original);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      format: OUTPUT_STREAM_CHECKPOINT_JSON_FORMAT_V1,
      schema_version: 1,
      chain_id: CHAIN_ID,
      task_hash: TASK_HASH,
    });
    expect((parsed['mmr'] as Record<string, unknown>)['leaf_count']).toBe('3');

    const restored = deserializeOutputStreamCheckpoint(json);
    expect(serializeOutputStreamCheckpoint(restored)).toBe(json);
    const verifier = new OutputStreamVerifier({
      chainId: CHAIN_ID, taskHash: fromHex(TASK_HASH), workerServicePubKey: PUB,
    }, restored);
    expect(verifier.resumeAfterSeq).toBe(2n);
    expect(verifier.text()).toBe('aZürich');
    expect(toHex(verifier.root())).toBe(toHex(new OutputStreamVerifier({
      chainId: CHAIN_ID, taskHash: fromHex(TASK_HASH), workerServicePubKey: PUB,
    }, original).root()));
  });

  it('an empty checkpoint also round-trips, for persisting before the first chunk', () => {
    const empty = new OutputStreamVerifier({
      chainId: CHAIN_ID, taskHash: fromHex(TASK_HASH), workerServicePubKey: PUB,
    }).checkpoint();
    const restored = deserializeOutputStreamCheckpoint(serializeOutputStreamCheckpoint(empty));
    expect(restored.mmr.leafCount).toBe(0n);
    expect(restored.chunks).toEqual([]);
  });

  it('rejects JSON syntax errors, unknown fields, and format/schema mismatches', async () => {
    expectInvalid(() => deserializeOutputStreamCheckpoint('{'));
    const value = JSON.parse(serializeOutputStreamCheckpoint(await checkpoint())) as Record<string, unknown>;
    expectInvalid(() => deserializeOutputStreamCheckpoint(JSON.stringify({ ...value, extra: true })));
    expectInvalid(() => deserializeOutputStreamCheckpoint(JSON.stringify({ ...value, format: 'v2' })));
    expectInvalid(() => deserializeOutputStreamCheckpoint(JSON.stringify({ ...value, schema_version: 2 })));
  });

  it('hash/pubkey must be canonical lowercase fixed-length hex', async () => {
    const value = JSON.parse(serializeOutputStreamCheckpoint(await checkpoint())) as Record<string, unknown>;
    expectInvalid(() => deserializeOutputStreamCheckpoint(JSON.stringify({
      ...value, task_hash: String(value['task_hash']).toUpperCase(),
    })));
    expectInvalid(() => deserializeOutputStreamCheckpoint(JSON.stringify({
      ...value, worker_service_pubkey: '00',
    })));
  });

  it('leaf_count must be canonical u64 text', async () => {
    const value = JSON.parse(serializeOutputStreamCheckpoint(await checkpoint())) as Record<string, unknown>;
    const mmr = value['mmr'] as Record<string, unknown>;
    for (const leaf_count of ['03', '-1', '18446744073709551616']) {
      expectInvalid(() => deserializeOutputStreamCheckpoint(JSON.stringify({
        ...value, mmr: { ...mmr, leaf_count },
      })));
    }
  });

  it('chunk base64 must be canonical and correctly padded', async () => {
    const value = JSON.parse(serializeOutputStreamCheckpoint(await checkpoint())) as Record<string, unknown>;
    const chunks = value['chunks_base64'] as string[];
    expect(chunks[0]).toBe('YQ==');
    expectInvalid(() => deserializeOutputStreamCheckpoint(JSON.stringify({
      ...value, chunks_base64: ['YQ', ...chunks.slice(1)],
    })));
    expectInvalid(() => deserializeOutputStreamCheckpoint(JSON.stringify({
      ...value, chunks_base64: ['!!!!', ...chunks.slice(1)],
    })));
  });

  it('rejects an inconsistent MMR peak structure or a peaks/chunks root mismatch', async () => {
    const value = JSON.parse(serializeOutputStreamCheckpoint(await checkpoint())) as Record<string, unknown>;
    const mmr = value['mmr'] as Record<string, unknown>;
    expectInvalid(() => deserializeOutputStreamCheckpoint(JSON.stringify({
      ...value, mmr: { ...mmr, peaks: [] },
    })));
    const chunks = [...(value['chunks_base64'] as string[])];
    chunks[0] = 'Yg==';
    expectInvalid(() => deserializeOutputStreamCheckpoint(JSON.stringify({
      ...value, chunks_base64: chunks,
    })));
  });

  it('serialize likewise rejects a checkpoint polluted by the caller', async () => {
    const original = await checkpoint();
    const chunks = original.chunks.map((chunk) => Uint8Array.from(chunk));
    chunks[0]![0] = 0x62;
    expectInvalid(() => serializeOutputStreamCheckpoint({ ...original, chunks }));
  });

  it('decode returns a defensive copy', async () => {
    const json = serializeOutputStreamCheckpoint(await checkpoint());
    const first = deserializeOutputStreamCheckpoint(json);
    const second = deserializeOutputStreamCheckpoint(json);
    first.chunks[0]![0] = 0xff;
    first.mmr.peaks[0]!.hash[0] = 0xff;
    expect(serializeOutputStreamCheckpoint(second)).toBe(json);
  });
});
