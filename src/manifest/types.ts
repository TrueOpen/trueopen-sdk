/**
 * The V4 model profile manifest: the sixteen top-level blocks the chain commits to as
 * `manifest_hash` (Manifest S7). This file only types the document; `validate.ts` (Task 5)
 * is what actually rejects an unknown field, a bad enum value or a malformed shape per
 * S2.6 rules 10-11 and the S7 block rules.
 *
 * Field names stay in `snake_case`, matching the manifest document byte for byte. Renaming
 * them to camelCase would put a mapping layer between the bytes being hashed and the type
 * describing them, and every such layer is a place for the two to disagree.
 *
 * Every block below is typed completely -- including the ones this SDK never reads
 * (`verification_profile`, `pricing_profile`, and so on) -- because S2.6 rule 11 requires
 * unknown fields to be **rejected**, not ignored, and rejection is only possible against a
 * complete field list. The per-block field counts mirror the checklist in the Task 4 brief;
 * a block whose type carries a different count would either reject a valid manifest or let
 * an unknown field through.
 */

/**
 * A field whose wire type is a u64. A JS `number` loses precision above 2^53
 * (`Number.MAX_SAFE_INTEGER`), so every such field also accepts a `bigint`; the canonical
 * encoder (`canonical.ts`) already accepts `bigint` for exactly this reason. Fields receive
 * `U64` because protocol-declared u64 values above `Number.MAX_SAFE_INTEGER` arriving as a
 * `number` have already lost precision by the time the canonical encoder sees them, and
 * silent precision loss in a hash input defeats the validation this module exists to prevent.
 */
export type U64 = number | bigint;

// ---------------------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------------------

/**
 * A Cosmos SDK coin: exactly `{ amount, denom }` and nothing else. Given its own interface,
 * rather than typed inline, so the next task's unknown-field check can treat it as a closed
 * shape -- an extra key inside a Coin would otherwise slip past rule 11 if it were typed as a
 * free-form object.
 */
export interface Coin {
  readonly amount: U64;
  readonly denom: string;
}

/**
 * Identifies a parser: `name` is TrueOpen's canonical name (NOT an engine's own parser name),
 * and `version` is the version of that canonical specification, `>= 1`. Shared by
 * `tool_calling.parser` (S7.2) and `reasoning_parsing.parser` (S7.3).
 */
export interface ParserRefV1 {
  readonly name: string;
  readonly version: number;
}

// ---------------------------------------------------------------------------------------
// artifacts (9 fields)
// ---------------------------------------------------------------------------------------

export interface FileEntryV1 {
  readonly digest: string;
  readonly path: string;
  readonly role: string;
  readonly size_bytes: U64;
}

export interface ArtifactsV1 {
  readonly chat_template_hash: string;
  readonly file_manifest_hash: string;
  readonly files: readonly FileEntryV1[];
  readonly generation_config_hash: string;
  readonly model_config_hash: string;
  readonly model_weight_digest: string;
  readonly quant_config_hash: string;
  readonly tokenizer_config_hash: string;
  readonly tokenizer_hash: string;
}

// ---------------------------------------------------------------------------------------
// batch_verification (5 fields)
// ---------------------------------------------------------------------------------------

export interface BatchVerificationV1 {
  readonly enabled: boolean;
  readonly min_sample_count: number;
  readonly min_valid_sample_count: number;
  readonly pass_min_sample_pass_ratio_bps: number;
  readonly reject_min_sample_reject_ratio_bps: number;
}

// ---------------------------------------------------------------------------------------
// identity (4 fields)
// ---------------------------------------------------------------------------------------

export interface IdentityV1 {
  readonly display_name: string;
  readonly model_id: string;
  readonly previous_profile_version: number;
  readonly profile_version: number;
}

// ---------------------------------------------------------------------------------------
// metadata (3 fields)
// ---------------------------------------------------------------------------------------

export interface MetadataV1 {
  readonly display_tag_hash: string;
  readonly license_ref: string;
  readonly metadata_uri: string;
}

// ---------------------------------------------------------------------------------------
// model_config_summary (8 fields)
// ---------------------------------------------------------------------------------------

export interface ModelMoeV1 {
  readonly enabled: boolean;
  readonly num_experts: U64;
  readonly num_experts_per_tok: U64;
}

export interface ModelQuantizationV1 {
  readonly bits: U64;
  readonly method: string;
}

export interface ModelConfigSummaryV1 {
  readonly active_params: U64;
  readonly architecture: string;
  readonly context_length: U64;
  readonly modality: readonly string[];
  readonly model_type: string;
  readonly moe: ModelMoeV1;
  readonly quantization: ModelQuantizationV1;
  readonly total_params: U64;
}

// ---------------------------------------------------------------------------------------
// output_decoding (6 fields) -- S7.1. Declared for completeness and rule-11 validation; the
// SDK does not consume it -- S7.1 states outright that the SDK is not EOS-aware and needs no
// tokenizer, and `eos_token_ids` are token ids this SDK could not turn into text.
// ---------------------------------------------------------------------------------------

export const OUTPUT_DECODERS = ['HF_TOKENIZERS_V1'] as const;
export type OutputDecoder = (typeof OUTPUT_DECODERS)[number];

export interface OutputDecodingV1 {
  readonly decoder: OutputDecoder;
  readonly eos_token_ids: readonly number[];
  readonly strip_trailing_eos: boolean;
  readonly render_special_tokens: boolean;
  readonly clean_up_tokenization_spaces: boolean;
  readonly decode_vectors_path: string;
}

// ---------------------------------------------------------------------------------------
// pricing_profile (3 fields)
// ---------------------------------------------------------------------------------------

export interface PricingProfileV1 {
  readonly initial_output_price: U64;
  readonly min_order_value: U64;
  readonly verify_ratio_bps: number;
}

// ---------------------------------------------------------------------------------------
// profile_spec (7 fields)
// ---------------------------------------------------------------------------------------

export interface ProfileSpecV1 {
  readonly challenge_open_window_blocks: U64;
  readonly generation_type: string;
  readonly min_stake: Coin;
  readonly require_encrypted: boolean;
  readonly resource_tier: number;
  readonly schema_hash: string;
  readonly task_types: readonly string[];
}

// ---------------------------------------------------------------------------------------
// reasoning_parsing (0 fields in the vector) -- S7.3. An empty object is the only encoding
// for "this profile has no reasoning separation". Unlike `tool_calling`, S7.3 carries no
// `call_id_format`-equivalent: a populated block is just its parser reference.
// ---------------------------------------------------------------------------------------

export interface ReasoningParsingV1 {
  readonly parser?: ParserRefV1;
}

// ---------------------------------------------------------------------------------------
// runtime_requirements (5 fields)
// ---------------------------------------------------------------------------------------

export interface RuntimeRequirementsV1 {
  readonly recommended_engine: string;
  readonly recommended_engine_version: string;
  readonly required_capabilities: readonly string[];
  readonly required_top_k: number;
  readonly runtime_class: string;
}

// ---------------------------------------------------------------------------------------
// source (6 fields)
// ---------------------------------------------------------------------------------------

export interface SourceV1 {
  readonly provider: string;
  readonly repo_id: string;
  readonly repo_type: string;
  readonly resolver_version: string;
  readonly revision: string;
  readonly source_uri: string;
}

// ---------------------------------------------------------------------------------------
// timeout_bootstrap_profile (4 fields)
// ---------------------------------------------------------------------------------------

export interface TimeoutBootstrapProfileV1 {
  readonly bootstrap_valid_until_epoch: U64;
  readonly commit_timeout_bootstrap_blocks: number;
  readonly infer_timeout_bootstrap_blocks: number;
  readonly verify_timeout_bootstrap_blocks: number;
}

// ---------------------------------------------------------------------------------------
// tool_calling (0 fields in the vector) -- S7.2. An empty object is the only encoding for
// "this profile has no tool calling".
// ---------------------------------------------------------------------------------------

/** S7.2: a closed enum. Provider synthesises an OpenAI tool call `id` per this value. */
export const TOOL_CALL_ID_FORMATS = ['OPENAI_CALL_PREFIX', 'MISTRAL_ALNUM_9'] as const;
export type ToolCallIdFormat = (typeof TOOL_CALL_ID_FORMATS)[number];

export interface ToolCallingV1 {
  readonly parser?: ParserRefV1;
  readonly call_id_format?: ToolCallIdFormat;
}

// ---------------------------------------------------------------------------------------
// verification_profile (14 fields, including a nested `evidence_schema` object)
// ---------------------------------------------------------------------------------------

export interface RequiredInferEvidenceV1 {
  readonly commitment_schema_version: number;
  readonly evidence_kind: string;
  readonly max_encoded_size_bytes: U64;
}

export interface EvidenceSchemaV1 {
  readonly required_infer_evidence: readonly RequiredInferEvidenceV1[];
  readonly schema_version: number;
}

export interface VerificationMetricsV1 {
  readonly compare_logprob_diff: boolean;
  readonly compare_rank_delta: boolean;
  readonly compare_topk_jaccard: boolean;
  readonly compare_union_js: boolean;
  readonly compared_top_k: number;
  readonly numeric_scale: string;
}

export interface VerificationProfileV1 {
  readonly canonical_encoding_version: string;
  readonly evidence_schema: EvidenceSchemaV1;
  readonly evidence_schema_hash: string;
  readonly include_generated_special_tokens: boolean;
  readonly include_padding_tokens: boolean;
  readonly include_prompt_tokens: boolean;
  readonly judgment_function_version: string;
  readonly metric_aggregate_proof_version: string;
  readonly metrics: VerificationMetricsV1;
  readonly require_finish_reason: boolean;
  readonly require_output_token_ids: boolean;
  readonly token_scope: string;
  readonly verification_mode: string;
  readonly verification_profile_id: number;
}

// ---------------------------------------------------------------------------------------
// verification_thresholds (14 fields, all pass_* / reject_* scalars)
// ---------------------------------------------------------------------------------------

export interface VerificationThresholdsV1 {
  readonly pass_abs_logprob_diff_p95_max: number;
  readonly pass_abs_logprob_diff_p99_max: number;
  readonly pass_max_missing_compared_count: number;
  readonly pass_mean_abs_logprob_diff_max: number;
  readonly pass_min_finite_count: number;
  readonly pass_rank_delta_nonzero_rate_max: number;
  readonly pass_topk_jaccard_mean_min: number;
  readonly pass_union_js_p99_max: number;
  readonly reject_abs_logprob_diff_p95_min: number;
  readonly reject_abs_logprob_diff_p99_min: number;
  readonly reject_mean_abs_logprob_diff_min: number;
  readonly reject_rank_delta_nonzero_rate_min: number;
  readonly reject_topk_jaccard_mean_max: number;
  readonly reject_union_js_p99_min: number;
}

// ---------------------------------------------------------------------------------------
// The document: sixteen blocks plus the version discriminant.
// ---------------------------------------------------------------------------------------

/**
 * The complete V4 model profile manifest. `manifest_hash` (recomputed by `hash.ts` from the
 * canonical encoding of exactly this document) is what the chain actually stores; this type
 * is what makes that recomputation possible and checkable.
 */
export interface ModelProfileManifestV4 {
  readonly artifacts: ArtifactsV1;
  readonly batch_verification: BatchVerificationV1;
  readonly identity: IdentityV1;
  readonly manifest_version: 4;
  readonly metadata: MetadataV1;
  readonly model_config_summary: ModelConfigSummaryV1;
  readonly output_decoding: OutputDecodingV1;
  readonly pricing_profile: PricingProfileV1;
  readonly profile_spec: ProfileSpecV1;
  readonly reasoning_parsing: ReasoningParsingV1;
  readonly runtime_requirements: RuntimeRequirementsV1;
  readonly source: SourceV1;
  readonly timeout_bootstrap_profile: TimeoutBootstrapProfileV1;
  readonly tool_calling: ToolCallingV1;
  readonly verification_profile: VerificationProfileV1;
  readonly verification_thresholds: VerificationThresholdsV1;
}
