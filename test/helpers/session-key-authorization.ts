/**
 * Reads wire testdata/v1/task/session_key_authorization_v1.json (ADR-0037 registered session
 * keys). Its EIP-712 sections share the account_signing_v1.json shape, so fixtureTypedData from
 * account-signing.ts builds their typed data; order_payload is lifted into the SDK's TaskOrderV3
 * view straight from its typed field list.
 */
import { readFileSync } from 'node:fs';
import { bech32 } from '@scure/base';
import type { Section } from './account-signing';
import type { AmountV1, TaskOrderV3 } from '../../src/order/task-order';
import { fromHex } from '../../src/util/bytes';

export const SESSION_KEY_AUTH = JSON.parse(
  readFileSync('third_party/wire/testdata/v1/task/session_key_authorization_v1.json', 'utf8'),
) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** An EIP-712 section: "delegated_order", "wallet_order", "registered_sdk_request" or "registered_data_request". */
export const skSection = (name: string): Section => SESSION_KEY_AUTH[name] as Section;

/** The raw private key of a key block: "account", "session_key" or "wrong_key". */
export const skKey = (name: string): Uint8Array => fromHex(SESSION_KEY_AUTH[name].private_key as string);

/** The 20 address bytes of a key block. */
export const skAddress = (name: string): Uint8Array => fromHex(SESSION_KEY_AUTH[name].address_bytes as string);

interface Field {
  readonly name: string;
  readonly type: string;
  readonly value?: number | string;
  readonly utf8?: string;
  readonly hex?: string;
  readonly bool?: boolean;
  readonly empty?: boolean;
  readonly fields?: readonly Field[];
}

function byName(fields: readonly Field[], name: string): Field {
  const f = fields.find((x) => x.name === name);
  if (f === undefined) throw new Error(`fixture field ${name} missing`);
  return f;
}

const num = (fs: readonly Field[], n: string): number => Number(byName(fs, n).value);
const big = (fs: readonly Field[], n: string): bigint => BigInt(byName(fs, n).value as number | string);
const str = (fs: readonly Field[], n: string): string => byName(fs, n).utf8 ?? '';
const bytes = (fs: readonly Field[], n: string): Uint8Array => {
  const f = byName(fs, n);
  return f.empty === true ? new Uint8Array(0) : fromHex(f.hex ?? '');
};
const amount = (fs: readonly Field[], n: string): AmountV1 => ({ atomicUnits: str(byName(fs, n).fields ?? [], 'atomic_units') });

/** order_payload as the SDK's TaskOrderV3 view. */
export function fixtureOrder(): TaskOrderV3 {
  const f = (SESSION_KEY_AUTH.order_payload as { fields: readonly Field[] }).fields;
  const gen = byName(f, 'generation_params').fields ?? [];
  const dec = byName(gen, 'decoding_params').fields ?? [];
  const list = (n: string): readonly Field[] => (byName(dec, n).fields ?? []).slice(1);
  return {
    schemaVersion: num(f, 'schema_version'),
    chainId: str(f, 'chain_id'),
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
    builderSetId: str(f, 'builder_set_id'),
    builderSetHash: bytes(f, 'builder_set_hash'),
    payloadMode: num(f, 'payload_mode'),
    inputKeyCommitment: bytes(f, 'input_key_commitment'),
    userRecipientPubkey: bytes(f, 'user_recipient_pubkey'),
  };
}
