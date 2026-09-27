import { TrueOpenError } from '../errors/errors';
import { compareUtf8 } from './canonical';
import { OUTPUT_DECODERS, TOOL_CALL_ID_FORMATS, type ModelProfileManifestV4 } from './types';

/**
 * Validation for the V4 model profile manifest: reject, never repair.
 *
 * This module is the value-level counterpart to `types.ts`. The types declare *which* fields
 * exist; this module asserts, for every block at every depth, that exactly those fields are
 * present (S2.6 rule 11 -- unknown keys are rejected, not ignored), that required fields are
 * non-null (rule 10), and that each value carries the shape its field rule demands (rules 7-9
 * and the S7 block rules). Nothing here sorts, fills in, or otherwise repairs a document: a
 * malformed manifest fails, and only a document that already equals its canonical form passes.
 *
 * Rule 9 (fixed empty values) would apply to nullable fields -- a nullable field is encoded as
 * its type's fixed empty representation (`bytes32` -> `0x` + 64 zeros, `string` -> `""`,
 * repeated -> `[]`) and never as `null`. `types.ts` declares no nullable field in the V4
 * surface, so there is nothing for it to apply to here; the rule is honoured by the fact that
 * `null` is rejected everywhere (rule 10) and empty strings/arrays pass only where the field is
 * a plain non-null string or array. If a future V5 adds a nullable field, its fixed empty value
 * must be asserted here rather than defaulting to accepting `null`.
 */

const BYTES32_RE = /^0x[0-9a-f]{64}$/;

function invalid(code: string, message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', code, message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Coerce a value to a plain object at `path`, rejecting arrays, primitives and null. */
function expectObject(v: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(v)) {
    throw invalid('MANIFEST_VALIDATE_NOT_OBJECT', `${path} must be an object`);
  }
  return v;
}

/** Reject any key at `path` not on the allow-list (rule 11). */
function expectFields(obj: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw invalid(
        'MANIFEST_VALIDATE_UNKNOWN_FIELD',
        `${path} contains unknown field ${JSON.stringify(key)}`,
      );
    }
  }
}

/** Fetch a required, non-null field (rule 10). */
function reqField(obj: Record<string, unknown>, key: string, path: string): unknown {
  if (!(key in obj)) {
    throw invalid('MANIFEST_VALIDATE_MISSING_FIELD', `${path}.${key} is required`);
  }
  const v = obj[key];
  if (v === null || v === undefined) {
    throw invalid('MANIFEST_VALIDATE_NULL_FIELD', `${path}.${key} must not be null`);
  }
  return v;
}

// String values are checked for type only; the canonical encoder is the final gate for
// encodability (lone surrogates), so a value validation accepts can still be refused by `manifestHash`.
function reqString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = reqField(obj, key, path);
  if (typeof v !== 'string') {
    throw invalid('MANIFEST_VALIDATE_NOT_STRING', `${path}.${key} must be a string`);
  }
  return v;
}

function reqBoolean(obj: Record<string, unknown>, key: string, path: string): boolean {
  const v = reqField(obj, key, path);
  if (typeof v !== 'boolean') {
    throw invalid('MANIFEST_VALIDATE_NOT_BOOLEAN', `${path}.${key} must be a boolean`);
  }
  return v;
}

/** A field typed `number` in `types.ts`: a JS number that is an integer within safe range. */
function reqNumber(obj: Record<string, unknown>, key: string, path: string): number {
  const v = reqField(obj, key, path);
  if (typeof v !== 'number' || !Number.isInteger(v) || !Number.isSafeInteger(v)) {
    throw invalid(
      'MANIFEST_VALIDATE_NOT_INTEGER',
      `${path}.${key} must be an integer within Number.MAX_SAFE_INTEGER`,
    );
  }
  return v;
}

/** A field typed `U64`: a safe-integer JS number, or a `bigint` for values above 2^53. */
function reqU64(obj: Record<string, unknown>, key: string, path: string): number | bigint {
  const v = reqField(obj, key, path);
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v) && Number.isSafeInteger(v)) return v;
  throw invalid(
    'MANIFEST_VALIDATE_NOT_U64',
    `${path}.${key} must be a safe integer number or a bigint`,
  );
}

function reqStringArray(obj: Record<string, unknown>, key: string, path: string): string[] {
  const v = reqField(obj, key, path);
  if (!Array.isArray(v)) {
    throw invalid('MANIFEST_VALIDATE_NOT_ARRAY', `${path}.${key} must be an array`);
  }
  return v.map((item, i) => {
    if (typeof item !== 'string') {
      throw invalid('MANIFEST_VALIDATE_NOT_STRING', `${path}.${key}[${i}] must be a string`);
    }
    return item;
  });
}

/** A bytes32 field: `0x` prefix plus exactly 64 lowercase hex characters (rules 7 and 10). */
function reqBytes32(obj: Record<string, unknown>, key: string, path: string): string {
  const v = reqString(obj, key, path);
  if (!BYTES32_RE.test(v)) {
    throw invalid(
      'MANIFEST_VALIDATE_BAD_BYTES32',
      `${path}.${key} must be 0x followed by exactly 64 lowercase hex characters`,
    );
  }
  return v;
}

function validateFileEntry(obj: Record<string, unknown>, path: string): void {
  expectFields(obj, ['digest', 'path', 'role', 'size_bytes'], path);
  reqString(obj, 'digest', path);
  reqString(obj, 'path', path);
  reqString(obj, 'role', path);
  reqU64(obj, 'size_bytes', path);
}

function validateArtifacts(obj: Record<string, unknown>, path: string): void {
  expectFields(
    obj,
    [
      'chat_template_hash',
      'file_manifest_hash',
      'files',
      'generation_config_hash',
      'model_config_hash',
      'model_weight_digest',
      'quant_config_hash',
      'tokenizer_config_hash',
      'tokenizer_hash',
    ],
    path,
  );
  reqBytes32(obj, 'chat_template_hash', path);
  reqBytes32(obj, 'file_manifest_hash', path);
  reqBytes32(obj, 'generation_config_hash', path);
  reqBytes32(obj, 'model_config_hash', path);
  reqBytes32(obj, 'model_weight_digest', path);
  reqBytes32(obj, 'quant_config_hash', path);
  reqBytes32(obj, 'tokenizer_config_hash', path);
  reqBytes32(obj, 'tokenizer_hash', path);

  const files = reqField(obj, 'files', path);
  if (!Array.isArray(files)) {
    throw invalid('MANIFEST_VALIDATE_NOT_ARRAY', `${path}.files must be an array`);
  }
  let prevPath: string | null = null;
  for (let i = 0; i < files.length; i += 1) {
    const entry = expectObject(files[i], `${path}.files[${i}]`);
    validateFileEntry(entry, `${path}.files[${i}]`);
    const p = entry['path'] as string;
    if (prevPath !== null && compareUtf8(prevPath, p) > 0) {
      throw invalid(
        'MANIFEST_VALIDATE_FILES_NOT_SORTED',
        `${path}.files must be sorted by path under UTF-8 byte order`,
      );
    }
    prevPath = p;
  }
}

function validateBatchVerification(obj: Record<string, unknown>, path: string): void {
  expectFields(
    obj,
    [
      'enabled',
      'min_sample_count',
      'min_valid_sample_count',
      'pass_min_sample_pass_ratio_bps',
      'reject_min_sample_reject_ratio_bps',
    ],
    path,
  );
  reqBoolean(obj, 'enabled', path);
  reqNumber(obj, 'min_sample_count', path);
  reqNumber(obj, 'min_valid_sample_count', path);
  reqNumber(obj, 'pass_min_sample_pass_ratio_bps', path);
  reqNumber(obj, 'reject_min_sample_reject_ratio_bps', path);
}

function validateIdentity(obj: Record<string, unknown>, path: string): void {
  expectFields(obj, ['display_name', 'model_id', 'previous_profile_version', 'profile_version'], path);
  reqString(obj, 'display_name', path);
  reqBytes32(obj, 'model_id', path);
  reqNumber(obj, 'previous_profile_version', path);
  reqNumber(obj, 'profile_version', path);
}

function validateMetadata(obj: Record<string, unknown>, path: string): void {
  expectFields(obj, ['display_tag_hash', 'license_ref', 'metadata_uri'], path);
  reqBytes32(obj, 'display_tag_hash', path);
  reqString(obj, 'license_ref', path);
  reqString(obj, 'metadata_uri', path);
}

function validateModelMoe(obj: Record<string, unknown>, path: string): void {
  expectFields(obj, ['enabled', 'num_experts', 'num_experts_per_tok'], path);
  reqBoolean(obj, 'enabled', path);
  reqU64(obj, 'num_experts', path);
  reqU64(obj, 'num_experts_per_tok', path);
}

function validateModelQuantization(obj: Record<string, unknown>, path: string): void {
  expectFields(obj, ['bits', 'method'], path);
  reqU64(obj, 'bits', path);
  reqString(obj, 'method', path);
}

function validateModelConfigSummary(obj: Record<string, unknown>, path: string): void {
  expectFields(
    obj,
    [
      'active_params',
      'architecture',
      'context_length',
      'modality',
      'model_type',
      'moe',
      'quantization',
      'total_params',
    ],
    path,
  );
  reqU64(obj, 'active_params', path);
  reqString(obj, 'architecture', path);
  reqU64(obj, 'context_length', path);
  reqStringArray(obj, 'modality', path);
  reqString(obj, 'model_type', path);
  validateModelMoe(expectObject(reqField(obj, 'moe', path), `${path}.moe`), `${path}.moe`);
  validateModelQuantization(
    expectObject(reqField(obj, 'quantization', path), `${path}.quantization`),
    `${path}.quantization`,
  );
  reqU64(obj, 'total_params', path);
}

function validateOutputDecoding(obj: Record<string, unknown>, path: string): void {
  expectFields(
    obj,
    [
      'clean_up_tokenization_spaces',
      'decode_vectors_path',
      'decoder',
      'eos_token_ids',
      'render_special_tokens',
      'strip_trailing_eos',
    ],
    path,
  );

  const decoder = reqString(obj, 'decoder', path);
  if (!(OUTPUT_DECODERS as readonly string[]).includes(decoder)) {
    throw invalid(
      'MANIFEST_VALIDATE_BAD_ENUM',
      `${path}.decoder must be one of ${OUTPUT_DECODERS.join(', ')}`,
    );
  }

  const eos = reqField(obj, 'eos_token_ids', path);
  if (!Array.isArray(eos)) {
    throw invalid('MANIFEST_VALIDATE_NOT_ARRAY', `${path}.eos_token_ids must be an array`);
  }
  if (eos.length === 0) {
    throw invalid('MANIFEST_VALIDATE_BAD_EOS_TOKEN_IDS', `${path}.eos_token_ids must not be empty`);
  }
  let prev: number | null = null;
  for (let i = 0; i < eos.length; i += 1) {
    const id = eos[i];
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
      throw invalid('MANIFEST_VALIDATE_NOT_INTEGER', `${path}.eos_token_ids[${i}] must be an integer`);
    }
    if (prev !== null && id <= prev) {
      throw invalid(
        'MANIFEST_VALIDATE_BAD_EOS_TOKEN_IDS',
        `${path}.eos_token_ids must be strictly ascending and deduplicated`,
      );
    }
    prev = id;
  }

  if (reqBoolean(obj, 'strip_trailing_eos', path) !== true) {
    throw invalid('MANIFEST_VALIDATE_BAD_OUTPUT_DECODING', `${path}.strip_trailing_eos must be true`);
  }
  if (reqBoolean(obj, 'render_special_tokens', path) !== true) {
    throw invalid('MANIFEST_VALIDATE_BAD_OUTPUT_DECODING', `${path}.render_special_tokens must be true`);
  }
  if (reqBoolean(obj, 'clean_up_tokenization_spaces', path) !== false) {
    throw invalid(
      'MANIFEST_VALIDATE_BAD_OUTPUT_DECODING',
      `${path}.clean_up_tokenization_spaces must be false`,
    );
  }
  reqString(obj, 'decode_vectors_path', path);
}

function validatePricingProfile(obj: Record<string, unknown>, path: string): void {
  expectFields(obj, ['initial_output_price', 'min_order_value', 'verify_ratio_bps'], path);
  reqU64(obj, 'initial_output_price', path);
  reqU64(obj, 'min_order_value', path);
  reqNumber(obj, 'verify_ratio_bps', path);
}

function validateCoin(obj: Record<string, unknown>, path: string): void {
  // Rule 8: a Coin is exactly `{ amount, denom }` and nothing else, so it gets its own
  // allow-list rather than being treated as a free-form object (rule 11).
  expectFields(obj, ['amount', 'denom'], path);
  reqU64(obj, 'amount', path);
  reqString(obj, 'denom', path);
}

function validateProfileSpec(obj: Record<string, unknown>, path: string): void {
  expectFields(
    obj,
    [
      'challenge_open_window_blocks',
      'generation_type',
      'min_stake',
      'require_encrypted',
      'resource_tier',
      'schema_hash',
      'task_types',
    ],
    path,
  );
  reqU64(obj, 'challenge_open_window_blocks', path);
  reqString(obj, 'generation_type', path);
  validateCoin(expectObject(reqField(obj, 'min_stake', path), `${path}.min_stake`), `${path}.min_stake`);
  reqBoolean(obj, 'require_encrypted', path);
  reqNumber(obj, 'resource_tier', path);
  reqBytes32(obj, 'schema_hash', path);
  reqStringArray(obj, 'task_types', path);
}

function validateParserRef(obj: Record<string, unknown>, path: string): void {
  expectFields(obj, ['name', 'version'], path);
  const name = reqString(obj, 'name', path);
  if (name.length === 0) {
    throw invalid('MANIFEST_VALIDATE_BAD_PARSER', `${path}.name must be a non-empty string`);
  }
  const version = reqNumber(obj, 'version', path);
  if (version < 1) {
    throw invalid('MANIFEST_VALIDATE_BAD_PARSER', `${path}.version must be an integer >= 1`);
  }
}

function validateReasoningParsing(obj: Record<string, unknown>, path: string): void {
  expectFields(obj, ['parser'], path);
  // S7.3: `{}` is the only encoding for "no reasoning separation"; otherwise the block is
  // just its parser reference.
  if (Object.keys(obj).length === 0) return;
  const parser = reqField(obj, 'parser', path);
  validateParserRef(expectObject(parser, `${path}.parser`), `${path}.parser`);
}

function validateRuntimeRequirements(obj: Record<string, unknown>, path: string): void {
  expectFields(
    obj,
    ['recommended_engine', 'recommended_engine_version', 'required_capabilities', 'required_top_k', 'runtime_class'],
    path,
  );
  reqString(obj, 'recommended_engine', path);
  reqString(obj, 'recommended_engine_version', path);
  reqStringArray(obj, 'required_capabilities', path);
  reqNumber(obj, 'required_top_k', path);
  reqString(obj, 'runtime_class', path);
}

function validateSource(obj: Record<string, unknown>, path: string): void {
  expectFields(obj, ['provider', 'repo_id', 'repo_type', 'resolver_version', 'revision', 'source_uri'], path);
  reqString(obj, 'provider', path);
  reqString(obj, 'repo_id', path);
  reqString(obj, 'repo_type', path);
  reqString(obj, 'resolver_version', path);
  reqString(obj, 'revision', path);
  reqString(obj, 'source_uri', path);
}

function validateTimeoutBootstrapProfile(obj: Record<string, unknown>, path: string): void {
  expectFields(
    obj,
    [
      'bootstrap_valid_until_epoch',
      'commit_timeout_bootstrap_blocks',
      'infer_timeout_bootstrap_blocks',
      'verify_timeout_bootstrap_blocks',
    ],
    path,
  );
  reqU64(obj, 'bootstrap_valid_until_epoch', path);
  reqNumber(obj, 'commit_timeout_bootstrap_blocks', path);
  reqNumber(obj, 'infer_timeout_bootstrap_blocks', path);
  reqNumber(obj, 'verify_timeout_bootstrap_blocks', path);
}

function validateToolCalling(obj: Record<string, unknown>, path: string): void {
  expectFields(obj, ['parser', 'call_id_format'], path);
  // S7.2 rule 1: `{}` is the only encoding for "no tool calling".
  if (Object.keys(obj).length === 0) return;
  // S7.2 rule 2: parser.name, parser.version and call_id_format must all be present together.
  const parser = reqField(obj, 'parser', path);
  validateParserRef(expectObject(parser, `${path}.parser`), `${path}.parser`);
  const format = reqString(obj, 'call_id_format', path);
  if (!(TOOL_CALL_ID_FORMATS as readonly string[]).includes(format)) {
    throw invalid(
      'MANIFEST_VALIDATE_BAD_ENUM',
      `${path}.call_id_format must be one of ${TOOL_CALL_ID_FORMATS.join(', ')}`,
    );
  }
}

function validateRequiredInferEvidence(obj: Record<string, unknown>, path: string): void {
  expectFields(obj, ['commitment_schema_version', 'evidence_kind', 'max_encoded_size_bytes'], path);
  reqNumber(obj, 'commitment_schema_version', path);
  reqString(obj, 'evidence_kind', path);
  reqU64(obj, 'max_encoded_size_bytes', path);
}

function validateEvidenceSchema(obj: Record<string, unknown>, path: string): void {
  expectFields(obj, ['required_infer_evidence', 'schema_version'], path);
  const evidence = reqField(obj, 'required_infer_evidence', path);
  if (!Array.isArray(evidence)) {
    throw invalid('MANIFEST_VALIDATE_NOT_ARRAY', `${path}.required_infer_evidence must be an array`);
  }
  for (let i = 0; i < evidence.length; i += 1) {
    validateRequiredInferEvidence(
      expectObject(evidence[i], `${path}.required_infer_evidence[${i}]`),
      `${path}.required_infer_evidence[${i}]`,
    );
  }
  reqNumber(obj, 'schema_version', path);
}

function validateVerificationMetrics(obj: Record<string, unknown>, path: string): void {
  expectFields(
    obj,
    [
      'compare_logprob_diff',
      'compare_rank_delta',
      'compare_topk_jaccard',
      'compare_union_js',
      'compared_top_k',
      'numeric_scale',
    ],
    path,
  );
  reqBoolean(obj, 'compare_logprob_diff', path);
  reqBoolean(obj, 'compare_rank_delta', path);
  reqBoolean(obj, 'compare_topk_jaccard', path);
  reqBoolean(obj, 'compare_union_js', path);
  reqNumber(obj, 'compared_top_k', path);
  reqString(obj, 'numeric_scale', path);
}

function validateVerificationProfile(obj: Record<string, unknown>, path: string): void {
  expectFields(
    obj,
    [
      'canonical_encoding_version',
      'evidence_schema',
      'evidence_schema_hash',
      'include_generated_special_tokens',
      'include_padding_tokens',
      'include_prompt_tokens',
      'judgment_function_version',
      'metric_aggregate_proof_version',
      'metrics',
      'require_finish_reason',
      'require_output_token_ids',
      'token_scope',
      'verification_mode',
      'verification_profile_id',
    ],
    path,
  );
  reqString(obj, 'canonical_encoding_version', path);
  validateEvidenceSchema(
    expectObject(reqField(obj, 'evidence_schema', path), `${path}.evidence_schema`),
    `${path}.evidence_schema`,
  );
  reqBytes32(obj, 'evidence_schema_hash', path);
  reqBoolean(obj, 'include_generated_special_tokens', path);
  reqBoolean(obj, 'include_padding_tokens', path);
  reqBoolean(obj, 'include_prompt_tokens', path);
  reqString(obj, 'judgment_function_version', path);
  reqString(obj, 'metric_aggregate_proof_version', path);
  validateVerificationMetrics(
    expectObject(reqField(obj, 'metrics', path), `${path}.metrics`),
    `${path}.metrics`,
  );
  reqBoolean(obj, 'require_finish_reason', path);
  reqBoolean(obj, 'require_output_token_ids', path);
  reqString(obj, 'token_scope', path);
  reqString(obj, 'verification_mode', path);
  reqNumber(obj, 'verification_profile_id', path);
}

function validateVerificationThresholds(obj: Record<string, unknown>, path: string): void {
  expectFields(
    obj,
    [
      'pass_abs_logprob_diff_p95_max',
      'pass_abs_logprob_diff_p99_max',
      'pass_max_missing_compared_count',
      'pass_mean_abs_logprob_diff_max',
      'pass_min_finite_count',
      'pass_rank_delta_nonzero_rate_max',
      'pass_topk_jaccard_mean_min',
      'pass_union_js_p99_max',
      'reject_abs_logprob_diff_p95_min',
      'reject_abs_logprob_diff_p99_min',
      'reject_mean_abs_logprob_diff_min',
      'reject_rank_delta_nonzero_rate_min',
      'reject_topk_jaccard_mean_max',
      'reject_union_js_p99_min',
    ],
    path,
  );
  for (const key of Object.keys(obj)) {
    reqNumber(obj, key, path);
  }
}

const TOP_LEVEL_FIELDS = [
  'artifacts',
  'batch_verification',
  'identity',
  'manifest_version',
  'metadata',
  'model_config_summary',
  'output_decoding',
  'pricing_profile',
  'profile_spec',
  'reasoning_parsing',
  'runtime_requirements',
  'source',
  'timeout_bootstrap_profile',
  'tool_calling',
  'verification_profile',
  'verification_thresholds',
] as const;

/**
 * Validates a V4 model profile manifest, rejecting (never repairing) anything that would not
 * hash to its own canonical form. Returns the typed manifest; the cast is safe because every
 * value-level check above has already been performed.
 */
export function validateManifestV4(doc: unknown): ModelProfileManifestV4 {
  const root = expectObject(doc, '$');
  expectFields(root, TOP_LEVEL_FIELDS, '$');

  validateArtifacts(expectObject(reqField(root, 'artifacts', '$'), '$.artifacts'), '$.artifacts');
  validateBatchVerification(
    expectObject(reqField(root, 'batch_verification', '$'), '$.batch_verification'),
    '$.batch_verification',
  );
  validateIdentity(expectObject(reqField(root, 'identity', '$'), '$.identity'), '$.identity');

  const manifestVersion = reqField(root, 'manifest_version', '$');
  if (typeof manifestVersion !== 'number' || manifestVersion !== 4) {
    throw invalid('MANIFEST_VALIDATE_BAD_VERSION', '$.manifest_version must be 4');
  }

  validateMetadata(expectObject(reqField(root, 'metadata', '$'), '$.metadata'), '$.metadata');
  validateModelConfigSummary(
    expectObject(reqField(root, 'model_config_summary', '$'), '$.model_config_summary'),
    '$.model_config_summary',
  );
  validateOutputDecoding(
    expectObject(reqField(root, 'output_decoding', '$'), '$.output_decoding'),
    '$.output_decoding',
  );
  validatePricingProfile(
    expectObject(reqField(root, 'pricing_profile', '$'), '$.pricing_profile'),
    '$.pricing_profile',
  );
  validateProfileSpec(
    expectObject(reqField(root, 'profile_spec', '$'), '$.profile_spec'),
    '$.profile_spec',
  );
  validateReasoningParsing(
    expectObject(reqField(root, 'reasoning_parsing', '$'), '$.reasoning_parsing'),
    '$.reasoning_parsing',
  );
  validateRuntimeRequirements(
    expectObject(reqField(root, 'runtime_requirements', '$'), '$.runtime_requirements'),
    '$.runtime_requirements',
  );
  validateSource(expectObject(reqField(root, 'source', '$'), '$.source'), '$.source');
  validateTimeoutBootstrapProfile(
    expectObject(reqField(root, 'timeout_bootstrap_profile', '$'), '$.timeout_bootstrap_profile'),
    '$.timeout_bootstrap_profile',
  );
  validateToolCalling(
    expectObject(reqField(root, 'tool_calling', '$'), '$.tool_calling'),
    '$.tool_calling',
  );
  validateVerificationProfile(
    expectObject(reqField(root, 'verification_profile', '$'), '$.verification_profile'),
    '$.verification_profile',
  );
  validateVerificationThresholds(
    expectObject(reqField(root, 'verification_thresholds', '$'), '$.verification_thresholds'),
    '$.verification_thresholds',
  );

  return doc as unknown as ModelProfileManifestV4;
}
