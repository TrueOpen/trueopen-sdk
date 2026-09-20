import { describe, expect, it } from 'vitest';
import { confirmOutputWithReceipt } from '../../src/output/output-confirmation';
import {
  OUTPUT_MMR_DOMAIN,
  OutputStreamVerifier,
  outputChunkSigningDigest,
  outputHash,
} from '../../src/output/output-commitment';
import { mmrPrefixRoot } from '../../src/codec/mmr';
import { privKeySecp256k1DigestSigner, secp256k1PublicKey } from '../../src/signer/secp256k1';
import type { InferReceiptView } from '../../src/types/node';
import { fromHex, toHex } from '../../src/util/bytes';
import { TrueOpenError } from '../../src/errors/errors';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const CHAIN_ID = 'trueopen-localnet-1';
const TASK_ID = 'aa'.repeat(32);
const TASK_HASH = 'bb'.repeat(32);
const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const WORKER_PUB = secp256k1PublicKey(PRIV);
const CHUNKS = [utf8('hello '), utf8('Zürich'), utf8('!')];

async function checkpoint() {
  const sign = privKeySecp256k1DigestSigner(PRIV);
  const verifier = new OutputStreamVerifier({
    chainId: CHAIN_ID,
    taskHash: fromHex(TASK_HASH),
    workerServicePubKey: WORKER_PUB,
  });
  for (let i = 0; i < CHUNKS.length; i += 1) {
    const mmrRoot = mmrPrefixRoot(OUTPUT_MMR_DOMAIN, CHUNKS, i + 1);
    const seq = BigInt(i);
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

function receipt(overrides: Partial<InferReceiptView> = {}): InferReceiptView {
  return {
    taskId: TASK_ID,
    winnerWorker: 'trueopen1worker',
    inferReceiptHash: 'cc'.repeat(32),
    outputHash: toHex(outputHash(CHUNKS)),
    outputSizeBytes: CHUNKS.reduce((total, chunk) => total + BigInt(chunk.length), 0n),
    outputLeafCount: BigInt(CHUNKS.length),
    ...overrides,
  };
}

function confirm(cp: Awaited<ReturnType<typeof checkpoint>>, r = receipt()) {
  return confirmOutputWithReceipt({
    chainId: CHAIN_ID,
    taskId: TASK_ID,
    taskHash: TASK_HASH,
    checkpoint: cp,
    receipt: r,
  });
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(TrueOpenError);
    expect(error).toMatchObject({ family: 'DATA', code, retriable: false });
  }
}

describe('confirmOutputWithReceipt', () => {
  it('confirmed event is returned only when root / leaf count / size all match', async () => {
    const event = confirm(await checkpoint());
    expect(event).toEqual({
      type: 'confirmed',
      taskId: TASK_ID,
      taskHash: TASK_HASH,
      winnerWorker: 'trueopen1worker',
      inferReceiptHash: 'cc'.repeat(32),
      outputHash: toHex(outputHash(CHUNKS)),
      outputMmrRoot: outputHash(CHUNKS),
      outputLeafCount: 3n,
      outputSizeBytes: BigInt(CHUNKS.reduce((total, chunk) => total + chunk.length, 0)),
    });
  });

  it('rejects if any of chain / task hash / task id context mismatches', async () => {
    const cp = await checkpoint();
    expectCode(() => confirmOutputWithReceipt({
      chainId: 'other', taskId: TASK_ID, taskHash: TASK_HASH, checkpoint: cp, receipt: receipt(),
    }), 'DATA_OUTPUT_CONFIRMATION_CHAIN_MISMATCH');
    expectCode(() => confirmOutputWithReceipt({
      chainId: CHAIN_ID, taskId: TASK_ID, taskHash: 'dd'.repeat(32), checkpoint: cp, receipt: receipt(),
    }), 'DATA_OUTPUT_CONFIRMATION_TASK_HASH_MISMATCH');
    expectCode(() => confirm(cp, receipt({ taskId: 'ee'.repeat(32) })), 'DATA_OUTPUT_CONFIRMATION_TASK_ID_MISMATCH');
  });

  it('an empty checkpoint is not the same as empty output: cannot be confirmed with no verified chunks', async () => {
    const empty = new OutputStreamVerifier({
      chainId: CHAIN_ID,
      taskHash: fromHex(TASK_HASH),
      workerServicePubKey: WORKER_PUB,
    }).checkpoint();
    expectCode(() => confirm(empty), 'DATA_OUTPUT_CONFIRMATION_EMPTY_CHECKPOINT');
  });

  it('rejects if checkpoint leaf count does not match the retained chunks', async () => {
    const cp = await checkpoint();
    const broken = { ...cp, chunks: cp.chunks.slice(0, 2) };
    expectCode(() => confirm(broken), 'DATA_OUTPUT_CONFIRMATION_CHECKPOINT_LEAF_COUNT_MISMATCH');
  });

  it('rejects if recomputing the root from checkpoint peaks and retained chunks does not match', async () => {
    const cp = await checkpoint();
    const changed = cp.chunks.map((chunk) => Uint8Array.from(chunk));
    changed[1]![0] = (changed[1]![0] ?? 0) ^ 0x01;
    expectCode(
      () => confirm({ ...cp, chunks: changed }),
      'DATA_OUTPUT_CONFIRMATION_CHECKPOINT_ROOT_MISMATCH',
    );
  });

  it('rejects if the checkpoint MMR structure is malformed', async () => {
    const cp = await checkpoint();
    const broken = { ...cp, mmr: { ...cp.mmr, peaks: cp.mmr.peaks.slice(0, 1) } };
    expectCode(() => confirm(broken), 'DATA_OUTPUT_CONFIRMATION_CHECKPOINT_MALFORMED');
  });

  it('rejects if the checkpoint schema or Worker key is malformed', async () => {
    const cp = await checkpoint();
    expectCode(
      () => confirm({ ...cp, schemaVersion: 2 as 1 }),
      'DATA_OUTPUT_CONFIRMATION_CHECKPOINT_MALFORMED',
    );
    expectCode(
      () => confirm({ ...cp, workerServicePubKey: new Uint8Array(32) }),
      'DATA_OUTPUT_CONFIRMATION_CHECKPOINT_MALFORMED',
    );
  });

  it('rejects if Receipt output_hash is not canonical 64-hex', async () => {
    const cp = await checkpoint();
    expectCode(
      () => confirm(cp, receipt({ outputHash: 'AA'.repeat(32) })),
      'DATA_OUTPUT_CONFIRMATION_RECEIPT_HASH_MALFORMED',
    );
  });

  it('rejects if Receipt root does not match', async () => {
    const cp = await checkpoint();
    expectCode(
      () => confirm(cp, receipt({ outputHash: 'dd'.repeat(32) })),
      'DATA_OUTPUT_CONFIRMATION_ROOT_MISMATCH',
    );
  });

  it('rejects if Receipt leaf count does not match', async () => {
    const cp = await checkpoint();
    expectCode(
      () => confirm(cp, receipt({ outputLeafCount: 4n })),
      'DATA_OUTPUT_CONFIRMATION_LEAF_COUNT_MISMATCH',
    );
  });

  it('rejects if Receipt size does not match', async () => {
    const cp = await checkpoint();
    expectCode(
      () => confirm(cp, receipt({ outputSizeBytes: 999n })),
      'DATA_OUTPUT_CONFIRMATION_SIZE_MISMATCH',
    );
  });
});
