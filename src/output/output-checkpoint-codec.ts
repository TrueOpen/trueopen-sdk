import { base64ToBytes, bytesToBase64, stringToU64, u64ToString } from '../codec/wire';
import { TrueOpenError } from '../errors/errors';
import { bytesEqual, fromHex, toHex } from '../util/bytes';
import {
  OUTPUT_MMR_DOMAIN,
  outputHash,
  OutputStreamVerifier,
  type OutputStreamVerifierCheckpoint,
} from './output-commitment';

export const OUTPUT_STREAM_CHECKPOINT_JSON_FORMAT_V1 = 'trueopen-output-stream-checkpoint-v1';

interface CheckpointJsonPeakV1 {
  readonly height: number;
  readonly hash: string;
}

interface CheckpointJsonMmrV1 {
  readonly schema_version: 1;
  readonly domain: string;
  readonly leaf_count: string;
  readonly peaks: readonly CheckpointJsonPeakV1[];
}

export interface OutputStreamCheckpointJsonV1 {
  readonly format: typeof OUTPUT_STREAM_CHECKPOINT_JSON_FORMAT_V1;
  readonly schema_version: 1;
  readonly chain_id: string;
  readonly task_hash: string;
  readonly worker_service_pubkey: string;
  readonly mmr: CheckpointJsonMmrV1;
  readonly chunks_base64: readonly string[];
}

const HASH32_HEX = /^[0-9a-f]{64}$/;
const PUBKEY33_HEX = /^[0-9a-f]{66}$/;
const CANONICAL_U64 = /^(0|[1-9][0-9]*)$/;

function checkpointError(message: string, cause?: unknown): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', 'OUTPUT_STREAM_CHECKPOINT_JSON_INVALID', message, {
    ...(cause !== undefined ? { cause } : {}),
  });
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw checkpointError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw checkpointError(`${what} keys must be exactly ${expected.join(',')}`);
  }
}

function stringField(value: Record<string, unknown>, key: string, what: string): string {
  const field = value[key];
  if (typeof field !== 'string') throw checkpointError(`${what}.${key} must be a string`);
  return field;
}

function numberField(value: Record<string, unknown>, key: string, what: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isSafeInteger(field)) {
    throw checkpointError(`${what}.${key} must be a safe integer`);
  }
  return field;
}

function canonicalBase64(value: string, what: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(value);
  } catch (cause) {
    throw checkpointError(`${what} is not valid base64`, cause);
  }
  if (bytesToBase64(bytes) !== value) throw checkpointError(`${what} must use canonical padded base64`);
  return bytes;
}

function validateCheckpoint(checkpoint: OutputStreamVerifierCheckpoint): void {
  if (
    checkpoint.schemaVersion !== 1 ||
    checkpoint.chainId === '' ||
    checkpoint.taskHash.length !== 32 ||
    checkpoint.workerServicePubKey.length !== 33
  ) {
    throw checkpointError('checkpoint context or schema is malformed');
  }

  let verifier: OutputStreamVerifier;
  try {
    verifier = new OutputStreamVerifier({
      chainId: checkpoint.chainId,
      taskHash: checkpoint.taskHash,
      workerServicePubKey: checkpoint.workerServicePubKey,
    }, checkpoint);
  } catch (cause) {
    throw checkpointError('checkpoint verifier/MMR state is malformed', cause);
  }
  if (checkpoint.chunks.length > 0 && !bytesEqual(verifier.root(), outputHash(checkpoint.chunks))) {
    throw checkpointError('checkpoint MMR peaks do not match retained chunks');
  }
}

/** Stable JSON: bytes use lowercase hex/base64, u64 uses canonical decimal text. */
export function serializeOutputStreamCheckpoint(checkpoint: OutputStreamVerifierCheckpoint): string {
  validateCheckpoint(checkpoint);
  const value: OutputStreamCheckpointJsonV1 = {
    format: OUTPUT_STREAM_CHECKPOINT_JSON_FORMAT_V1,
    schema_version: 1,
    chain_id: checkpoint.chainId,
    task_hash: toHex(checkpoint.taskHash),
    worker_service_pubkey: toHex(checkpoint.workerServicePubKey),
    mmr: {
      schema_version: 1,
      domain: checkpoint.mmr.domain,
      leaf_count: u64ToString(checkpoint.mmr.leafCount),
      peaks: checkpoint.mmr.peaks.map((peak) => ({ height: peak.height, hash: toHex(peak.hash) })),
    },
    chunks_base64: checkpoint.chunks.map(bytesToBase64),
  };
  return JSON.stringify(value);
}

/** Decodes strictly and verifies structure, context, and MMR peaks/chunks self-consistency. */
export function deserializeOutputStreamCheckpoint(json: string): OutputStreamVerifierCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw checkpointError('checkpoint is not valid JSON', cause);
  }

  const top = record(parsed, 'checkpoint');
  exactKeys(
    top,
    ['format', 'schema_version', 'chain_id', 'task_hash', 'worker_service_pubkey', 'mmr', 'chunks_base64'],
    'checkpoint',
  );
  if (stringField(top, 'format', 'checkpoint') !== OUTPUT_STREAM_CHECKPOINT_JSON_FORMAT_V1) {
    throw checkpointError('unsupported checkpoint format');
  }
  if (numberField(top, 'schema_version', 'checkpoint') !== 1) throw checkpointError('unsupported checkpoint schema');
  const chainId = stringField(top, 'chain_id', 'checkpoint');
  if (chainId === '') throw checkpointError('checkpoint.chain_id must not be empty');
  const taskHashHex = stringField(top, 'task_hash', 'checkpoint');
  if (!HASH32_HEX.test(taskHashHex)) throw checkpointError('checkpoint.task_hash must be lowercase 64-hex');
  const pubkeyHex = stringField(top, 'worker_service_pubkey', 'checkpoint');
  if (!PUBKEY33_HEX.test(pubkeyHex)) {
    throw checkpointError('checkpoint.worker_service_pubkey must be lowercase 66-hex');
  }

  const mmr = record(top['mmr'], 'checkpoint.mmr');
  exactKeys(mmr, ['schema_version', 'domain', 'leaf_count', 'peaks'], 'checkpoint.mmr');
  if (numberField(mmr, 'schema_version', 'checkpoint.mmr') !== 1) {
    throw checkpointError('unsupported checkpoint MMR schema');
  }
  const domain = stringField(mmr, 'domain', 'checkpoint.mmr');
  if (domain !== OUTPUT_MMR_DOMAIN) throw checkpointError(`checkpoint.mmr.domain must be ${OUTPUT_MMR_DOMAIN}`);
  const leafCountText = stringField(mmr, 'leaf_count', 'checkpoint.mmr');
  if (!CANONICAL_U64.test(leafCountText)) throw checkpointError('checkpoint.mmr.leaf_count must be canonical u64 text');
  let leafCount: bigint;
  try {
    leafCount = stringToU64(leafCountText);
  } catch (cause) {
    throw checkpointError('checkpoint.mmr.leaf_count is outside uint64', cause);
  }
  if (!Array.isArray(mmr['peaks'])) throw checkpointError('checkpoint.mmr.peaks must be an array');
  const peaks = mmr['peaks'].map((item, i) => {
    const peak = record(item, `checkpoint.mmr.peaks[${i}]`);
    exactKeys(peak, ['height', 'hash'], `checkpoint.mmr.peaks[${i}]`);
    const height = numberField(peak, 'height', `checkpoint.mmr.peaks[${i}]`);
    if (height < 0) throw checkpointError(`checkpoint.mmr.peaks[${i}].height must be non-negative`);
    const hash = stringField(peak, 'hash', `checkpoint.mmr.peaks[${i}]`);
    if (!HASH32_HEX.test(hash)) throw checkpointError(`checkpoint.mmr.peaks[${i}].hash must be lowercase 64-hex`);
    return { height, hash: fromHex(hash) };
  });

  if (!Array.isArray(top['chunks_base64'])) throw checkpointError('checkpoint.chunks_base64 must be an array');
  const chunks = top['chunks_base64'].map((item, i) => {
    if (typeof item !== 'string') throw checkpointError(`checkpoint.chunks_base64[${i}] must be a string`);
    return canonicalBase64(item, `checkpoint.chunks_base64[${i}]`);
  });

  const checkpoint: OutputStreamVerifierCheckpoint = {
    schemaVersion: 1,
    chainId,
    taskHash: fromHex(taskHashHex),
    workerServicePubKey: fromHex(pubkeyHex),
    mmr: { schemaVersion: 1, domain, leafCount, peaks },
    chunks,
  };
  validateCheckpoint(checkpoint);
  // validateCheckpoint is read-only; copy again to ensure the return value doesn't share
  // arrays with the JSON helper's temporary values.
  return {
    ...checkpoint,
    taskHash: Uint8Array.from(checkpoint.taskHash),
    workerServicePubKey: Uint8Array.from(checkpoint.workerServicePubKey),
    mmr: {
      ...checkpoint.mmr,
      peaks: checkpoint.mmr.peaks.map((peak) => ({ height: peak.height, hash: Uint8Array.from(peak.hash) })),
    },
    chunks: checkpoint.chunks.map((chunk) => Uint8Array.from(chunk)),
  };
}
