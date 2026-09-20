import { MmrAccumulator } from '../codec/mmr';
import { TrueOpenError } from '../errors/errors';
import type { InferReceiptView } from '../types/node';
import { bytesEqual, toHex } from '../util/bytes';
import {
  OUTPUT_MMR_DOMAIN,
  outputHash,
  type OutputStreamVerifierCheckpoint,
} from './output-commitment';

const HASH32_HEX = /^[0-9a-f]{64}$/;

export interface ConfirmOutputWithReceiptInput {
  readonly chainId: string;
  readonly taskId: string;
  /** The on-chain accepted_task_hash, canonical lowercase 64-hex. */
  readonly taskHash: string;
  readonly checkpoint: OutputStreamVerifierCheckpoint;
  readonly receipt: InferReceiptView;
}

/** The confirmation event produced once all three authoritative facts from the Receipt match. */
export interface ConfirmedOutputEvent {
  readonly type: 'confirmed';
  readonly taskId: string;
  readonly taskHash: string;
  readonly winnerWorker: string;
  readonly inferReceiptHash: string;
  /** Canonical lowercase 64-hex. */
  readonly outputHash: string;
  /** The same raw 32 bytes as outputHash, for direct use by later protocol layers. */
  readonly outputMmrRoot: Uint8Array;
  readonly outputLeafCount: bigint;
  readonly outputSizeBytes: bigint;
}

function confirmationError(code: string, message: string): TrueOpenError {
  // A mismatch between the receipt and the locally verified prefix is a deterministic trust
  // failure and must not be silently retried by switching endpoints.
  return new TrueOpenError('DATA', code, message);
}

/**
 * Upgrades a Worker-authenticated provisional output to confirmed using the on-chain InferReceipt.
 *
 * Verification happens in two layers:
 * 1. Checkpoint self-consistency: context binding, leaf count, and peaks root all agree with
 *    the root recomputed from the retained chunks;
 * 2. Receipt authoritative facts: output_hash, output_leaf_count, and output_size_bytes all match.
 *
 * Any mismatch fails closed; the function never modifies the checkpoint or the receipt.
 */
export function confirmOutputWithReceipt(input: ConfirmOutputWithReceiptInput): ConfirmedOutputEvent {
  const { checkpoint, receipt } = input;
  if (checkpoint.schemaVersion !== 1 || checkpoint.workerServicePubKey.length !== 33) {
    throw confirmationError(
      'DATA_OUTPUT_CONFIRMATION_CHECKPOINT_MALFORMED',
      'output checkpoint schema or Worker service key is malformed',
    );
  }
  if (input.chainId === '' || checkpoint.chainId !== input.chainId) {
    throw confirmationError(
      'DATA_OUTPUT_CONFIRMATION_CHAIN_MISMATCH',
      `checkpoint chain_id ${checkpoint.chainId} does not match ${input.chainId}`,
    );
  }
  if (!HASH32_HEX.test(input.taskHash) || toHex(checkpoint.taskHash) !== input.taskHash) {
    throw confirmationError(
      'DATA_OUTPUT_CONFIRMATION_TASK_HASH_MISMATCH',
      `checkpoint task_hash ${toHex(checkpoint.taskHash)} does not match ${input.taskHash}`,
    );
  }
  if (input.taskId === '' || receipt.taskId !== input.taskId) {
    throw confirmationError(
      'DATA_OUTPUT_CONFIRMATION_TASK_ID_MISMATCH',
      `receipt task_id ${receipt.taskId} does not match ${input.taskId}`,
    );
  }
  if (checkpoint.chunks.length === 0) {
    throw confirmationError(
      'DATA_OUTPUT_CONFIRMATION_EMPTY_CHECKPOINT',
      'cannot confirm output before at least one chunk has been verified',
    );
  }

  let checkpointMmr: MmrAccumulator;
  try {
    checkpointMmr = new MmrAccumulator(OUTPUT_MMR_DOMAIN, checkpoint.mmr);
  } catch (cause) {
    throw new TrueOpenError('DATA', 'DATA_OUTPUT_CONFIRMATION_CHECKPOINT_MALFORMED', 'output checkpoint MMR state is malformed', {
      cause,
    });
  }
  const leafCount = BigInt(checkpoint.chunks.length);
  if (checkpointMmr.leafCount !== leafCount) {
    throw confirmationError(
      'DATA_OUTPUT_CONFIRMATION_CHECKPOINT_LEAF_COUNT_MISMATCH',
      `checkpoint MMR has ${checkpointMmr.leafCount} leaves but retains ${leafCount} chunks`,
    );
  }

  const outputMmrRoot = outputHash(checkpoint.chunks);
  if (!bytesEqual(checkpointMmr.root(), outputMmrRoot)) {
    throw confirmationError(
      'DATA_OUTPUT_CONFIRMATION_CHECKPOINT_ROOT_MISMATCH',
      'checkpoint MMR peaks do not match the retained verified chunks',
    );
  }
  const outputHashHex = toHex(outputMmrRoot);
  if (!HASH32_HEX.test(receipt.outputHash)) {
    throw confirmationError(
      'DATA_OUTPUT_CONFIRMATION_RECEIPT_HASH_MALFORMED',
      `receipt output_hash must be canonical lowercase 64-hex, got ${receipt.outputHash}`,
    );
  }
  if (receipt.outputHash !== outputHashHex) {
    throw confirmationError(
      'DATA_OUTPUT_CONFIRMATION_ROOT_MISMATCH',
      `local output MMR root ${outputHashHex} does not match receipt ${receipt.outputHash}`,
    );
  }
  if (receipt.outputLeafCount !== leafCount) {
    throw confirmationError(
      'DATA_OUTPUT_CONFIRMATION_LEAF_COUNT_MISMATCH',
      `local output has ${leafCount} leaves but receipt says ${receipt.outputLeafCount}`,
    );
  }
  const sizeBytes = checkpoint.chunks.reduce((total, chunk) => total + BigInt(chunk.length), 0n);
  if (receipt.outputSizeBytes !== sizeBytes) {
    throw confirmationError(
      'DATA_OUTPUT_CONFIRMATION_SIZE_MISMATCH',
      `local output has ${sizeBytes} bytes but receipt says ${receipt.outputSizeBytes}`,
    );
  }

  return {
    type: 'confirmed',
    taskId: input.taskId,
    taskHash: input.taskHash,
    winnerWorker: receipt.winnerWorker,
    inferReceiptHash: receipt.inferReceiptHash,
    outputHash: outputHashHex,
    outputMmrRoot: Uint8Array.from(outputMmrRoot),
    outputLeafCount: leafCount,
    outputSizeBytes: sizeBytes,
  };
}
