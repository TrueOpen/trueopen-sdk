import { framedHashV1 } from '../codec/domain-hash';
import { canonicalJsonBytes, parseStrictJson } from '../codec/canonical-json';
import type { CanonicalJsonValue } from '../codec/canonical-json';
import { bytesEqual, toHex } from '../util/bytes';
import { TrueOpenError } from '../errors/errors';

/** H_V1 domain of manifest_hash. */
export const DOMAIN_MODEL_MANIFEST_V4 = 'TRUEOPEN_MODEL_MANIFEST_V4';
/** H_V1 domain of chain_projection_hash. */
export const DOMAIN_MODEL_CHAIN_PROJECTION_V3 = 'TRUEOPEN_MODEL_CHAIN_PROJECTION_V3';
/** H_V1 domain of ProfileState.registration_digest. */
export const DOMAIN_MODEL_REGISTRATION_DIGEST_V3 = 'TRUEOPEN_MODEL_REGISTRATION_DIGEST_V3';

/** Protocol constant max_manifest_bytes: 4 MiB, counted after decompression. */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

export const MANIFEST_VERSION_V4 = 4;

type JsonObject = { readonly [key: string]: CanonicalJsonValue };

/** Top-level sections of a V4 manifest; the key set must match exactly. */
const MANIFEST_V4_SECTIONS = [
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

const HASH32_0X = /^0x[0-9a-f]{64}$/;

/** A strictly parsed V4 manifest. `raw` is the full parsed document. */
export interface ModelManifestV4 {
  readonly raw: JsonObject;
  /** Canonical lowercase 64-hex, without the 0x prefix. */
  readonly modelId: string;
  readonly profileVersion: bigint;
  readonly previousProfileVersion: bigint;
}

function invalid(code: string, message: string): TrueOpenError {
  return new TrueOpenError('DATA', code, `model manifest: ${message}`);
}

function schemaError(message: string): TrueOpenError {
  return invalid('MANIFEST_SCHEMA_INVALID', message);
}

/** manifest_hash = H_V1("TRUEOPEN_MODEL_MANIFEST_V4", manifest bytes). Raw 32 bytes. */
export function modelManifestHash(bytes: Uint8Array): Uint8Array {
  return framedHashV1(DOMAIN_MODEL_MANIFEST_V4, bytes);
}

function isObject(v: CanonicalJsonValue | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function section(root: JsonObject, name: string): JsonObject {
  const v = root[name];
  if (!isObject(v)) throw schemaError(`${name} must be an object`);
  return v;
}

function uint(obj: JsonObject, path: string, key: string): bigint {
  const v = obj[key];
  if (typeof v !== 'bigint' || v < 0n) throw schemaError(`${path}.${key} must be a non-negative integer`);
  return v;
}

function hash32(obj: JsonObject, path: string, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || !HASH32_0X.test(v)) throw schemaError(`${path}.${key} must be 0x-prefixed lowercase 64-hex`);
  return v;
}

function text(obj: JsonObject, path: string, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string') throw schemaError(`${path}.${key} must be a string`);
  return v;
}

/** No value in a V4 manifest is signed; a negative integer anywhere is a schema error. */
function rejectNegative(v: CanonicalJsonValue, path: string): void {
  if (typeof v === 'bigint') {
    if (v < 0n) throw schemaError(`${path} must not be negative`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => rejectNegative(x, `${path}[${i}]`));
  } else if (isObject(v)) {
    for (const [k, x] of Object.entries(v)) rejectNegative(x, `${path}.${k}`);
  }
}

/**
 * Strictly parses manifest bytes and validates the V4 schema fields the SDK relies on:
 * the exact top-level section set, manifest_version 4, and the type of every field
 * that enters the chain projection. Canonical form is checked separately by
 * verifyManifestBytes (re-encode and compare bytes).
 */
export function parseModelManifestV4(bytes: Uint8Array): ModelManifestV4 {
  const doc = parseStrictJson(bytes);
  if (!isObject(doc)) throw schemaError('top level must be an object');

  const keys = Object.keys(doc).sort();
  const want = [...MANIFEST_V4_SECTIONS];
  const missing = want.filter((k) => !(k in doc));
  const unknown = keys.filter((k) => !(want as string[]).includes(k));
  if (missing.length > 0 || unknown.length > 0) {
    throw schemaError(`top-level sections differ from V4 (missing: [${missing.join(', ')}], unknown: [${unknown.join(', ')}])`);
  }
  if (doc['manifest_version'] !== BigInt(MANIFEST_VERSION_V4)) throw schemaError('manifest_version must be 4');
  rejectNegative(doc, 'manifest');

  for (const name of MANIFEST_V4_SECTIONS) {
    if (name !== 'manifest_version') section(doc, name);
  }

  const identity = section(doc, 'identity');
  const modelId = hash32(identity, 'identity', 'model_id');
  const profileVersion = uint(identity, 'identity', 'profile_version');
  if (profileVersion === 0n) throw schemaError('identity.profile_version must be positive');
  const previousProfileVersion = uint(identity, 'identity', 'previous_profile_version');
  text(identity, 'identity', 'display_name');

  hash32(section(doc, 'artifacts'), 'artifacts', 'tokenizer_hash');

  const runtime = section(doc, 'runtime_requirements');
  text(runtime, 'runtime_requirements', 'runtime_class');
  uint(runtime, 'runtime_requirements', 'required_top_k');

  const spec = section(doc, 'profile_spec');
  uint(spec, 'profile_spec', 'challenge_open_window_blocks');
  text(spec, 'profile_spec', 'generation_type');
  uint(spec, 'profile_spec', 'resource_tier');
  hash32(spec, 'profile_spec', 'schema_hash');
  const stake = spec['min_stake'];
  if (!isObject(stake)) throw schemaError('profile_spec.min_stake must be an object');
  uint(stake, 'profile_spec.min_stake', 'amount');
  text(stake, 'profile_spec.min_stake', 'denom');
  const taskTypes = spec['task_types'];
  if (!Array.isArray(taskTypes) || taskTypes.length === 0 || !taskTypes.every((t) => typeof t === 'string')) {
    throw schemaError('profile_spec.task_types must be a non-empty string array');
  }

  const pricing = section(doc, 'pricing_profile');
  for (const k of ['initial_output_price', 'min_order_value', 'verify_ratio_bps']) uint(pricing, 'pricing_profile', k);

  hash32(section(doc, 'verification_profile'), 'verification_profile', 'evidence_schema_hash');

  return { raw: doc, modelId: modelId.slice(2), profileVersion, previousProfileVersion };
}

/** Chain-side inputs of the projection that are not inside the manifest. */
export interface ProjectionChainInputs {
  /** Canonical lowercase 64-hex manifest_hash. */
  readonly manifestHash: string;
  /** ProfileState.manifest_uri, byte for byte. Never taken from the manifest. */
  readonly manifestUri: string;
  readonly registrationFee: { readonly amount: bigint; readonly denom: string };
}

/**
 * Rebuilds the canonical ModelProfileProjection (the TRUEOPEN_MODEL_CHAIN_PROJECTION_V3
 * payload) from a parsed manifest plus the chain-side inputs.
 */
export function projectionFromManifest(m: ModelManifestV4, chain: ProjectionChainInputs): JsonObject {
  const d = m.raw;
  const spec = section(d, 'profile_spec');
  const runtime = section(d, 'runtime_requirements');
  const identity = section(d, 'identity');
  return {
    batch_verification: section(d, 'batch_verification'),
    challenge_open_window_blocks: spec['challenge_open_window_blocks']!,
    generation_type: spec['generation_type']!,
    manifest_hash: `0x${chain.manifestHash}`,
    manifest_uri: chain.manifestUri,
    min_stake: spec['min_stake']!,
    model_id: identity['model_id']!,
    previous_profile_version: identity['previous_profile_version']!,
    pricing_profile: section(d, 'pricing_profile'),
    profile_version: identity['profile_version']!,
    reasoning_parser: section(d, 'reasoning_parsing'),
    registration_fee: { amount: chain.registrationFee.amount, denom: chain.registrationFee.denom },
    required_top_k: runtime['required_top_k']!,
    resource_tier: spec['resource_tier']!,
    runtime_class: runtime['runtime_class']!,
    schema_hash: spec['schema_hash']!,
    source: section(d, 'source'),
    task_types: spec['task_types']!,
    timeout_bootstrap_profile: section(d, 'timeout_bootstrap_profile'),
    tokenizer_hash: section(d, 'artifacts')['tokenizer_hash']!,
    tool_call_parser: section(d, 'tool_calling'),
    verification_profile: section(d, 'verification_profile'),
    verification_thresholds: section(d, 'verification_thresholds'),
  };
}

/** chain_projection_hash = H_V1("TRUEOPEN_MODEL_CHAIN_PROJECTION_V3", canonical_json_v1(projection)). */
export function chainProjectionHash(projection: JsonObject): Uint8Array {
  return framedHashV1(DOMAIN_MODEL_CHAIN_PROJECTION_V3, canonicalJsonBytes(projection));
}

export interface RegistrationDigestInput {
  readonly chainId: string;
  /** Raw 32 bytes. */
  readonly chainProjectionHash: Uint8Array;
  /** Canonical lowercase 64-hex. */
  readonly manifestHash: string;
  readonly profileVersion: bigint;
  readonly proposerAddress: string;
}

/** registration_digest = H_V1("TRUEOPEN_MODEL_REGISTRATION_DIGEST_V3", canonical_json_v1({...five keys})). */
export function registrationDigest(r: RegistrationDigestInput): Uint8Array {
  return framedHashV1(
    DOMAIN_MODEL_REGISTRATION_DIGEST_V3,
    canonicalJsonBytes({
      chain_id: r.chainId,
      chain_projection_hash: `0x${toHex(r.chainProjectionHash)}`,
      manifest_hash: `0x${r.manifestHash}`,
      profile_version: r.profileVersion,
      proposer_address: r.proposerAddress,
    }),
  );
}

/**
 * The on-chain ProfileState fields a fetched manifest is compared against. Hash32
 * values are canonical lowercase 64-hex; enum names are given without their type
 * prefix (for example "SAMPLED", "TEXT_GENERATION").
 */
export interface ProfileManifestState {
  readonly modelId: string;
  readonly profileVersion: bigint;
  readonly manifestHash: string;
  readonly manifestUri: string;
  readonly previousProfileVersion: bigint;
  readonly tokenizerHash: string;
  readonly schemaHash: string;
  readonly runtimeClass: string;
  readonly requiredTopK: bigint;
  readonly taskTypes: readonly string[];
  readonly generationType: string;
  readonly resourceTier: bigint;
  readonly minStake: bigint;
  readonly challengeOpenWindowBlocks: bigint;
  readonly pricing: { readonly initialOutputPrice: bigint; readonly minOrderValue: bigint; readonly verifyRatioBps: bigint };
  /** Canonical lowercase 64-hex; empty when the node did not return it. */
  readonly registrationDigest: string;
  readonly proposerAddress: string;
}

/**
 * Optional full-projection check: with the chain ID and the registration fee coin the
 * projection was registered with, the rebuilt projection's registration digest must
 * equal ProfileState.registration_digest. This binds every projection field, not only
 * the ones ProfileManifestState carries.
 */
export interface RegistrationCheck {
  readonly chainId: string;
  readonly registrationFee: { readonly amount: bigint; readonly denom: string };
}

export interface VerifiedManifest {
  /** The exact canonical bytes that hash to manifest_hash. */
  readonly bytes: Uint8Array;
  readonly manifest: ModelManifestV4;
}

/**
 * Verifies fetched manifest bytes against the chain, in the fixed order:
 *   1. H_V1("TRUEOPEN_MODEL_MANIFEST_V4", bytes) must equal manifest_hash;
 *   2. strict parse and V4 schema validation;
 *   3. canonical re-encoding must equal the fetched bytes exactly;
 *   4. the manifest's projection fields must match ProfileState (manifest_uri comes
 *      from the chain, never from the manifest).
 * The hash is checked first, on the raw bytes: parsing or re-canonicalizing before the
 * hash check could make a non-committed body pass.
 */
export function verifyManifestBytes(
  bytes: Uint8Array,
  state: ProfileManifestState,
  registration?: RegistrationCheck,
): VerifiedManifest {
  if (bytes.length > MAX_MANIFEST_BYTES) {
    throw invalid('MANIFEST_TOO_LARGE', `${bytes.length} bytes exceeds ${MAX_MANIFEST_BYTES}`);
  }
  const got = toHex(modelManifestHash(bytes));
  if (got !== state.manifestHash) {
    throw invalid('MANIFEST_HASH_MISMATCH', `hash ${got} does not match on-chain manifest_hash ${state.manifestHash}`);
  }

  const manifest = parseModelManifestV4(bytes);

  if (!bytesEqual(canonicalJsonBytes(manifest.raw), bytes)) {
    throw invalid('MANIFEST_NOT_CANONICAL', 'bytes are not the canonical JSON encoding of the manifest');
  }

  compareProjection(manifest, state);

  if (registration !== undefined) {
    const projection = projectionFromManifest(manifest, {
      manifestHash: state.manifestHash,
      manifestUri: state.manifestUri,
      registrationFee: registration.registrationFee,
    });
    const digest = toHex(
      registrationDigest({
        chainId: registration.chainId,
        chainProjectionHash: chainProjectionHash(projection),
        manifestHash: state.manifestHash,
        profileVersion: state.profileVersion,
        proposerAddress: state.proposerAddress,
      }),
    );
    if (digest !== state.registrationDigest) {
      throw invalid(
        'MANIFEST_PROJECTION_MISMATCH',
        `rebuilt registration digest ${digest} does not match on-chain ${state.registrationDigest || '(empty)'}`,
      );
    }
  }
  return { bytes, manifest };
}

function compareProjection(m: ModelManifestV4, s: ProfileManifestState): void {
  const d = m.raw;
  const spec = section(d, 'profile_spec');
  const runtime = section(d, 'runtime_requirements');
  const pricing = section(d, 'pricing_profile');
  const stake = spec['min_stake'] as JsonObject;
  const strip0x = (v: CanonicalJsonValue | undefined): string => String(v).slice(2);

  const checks: [string, unknown, unknown][] = [
    ['model_id', m.modelId, s.modelId],
    ['profile_version', m.profileVersion, s.profileVersion],
    ['previous_profile_version', m.previousProfileVersion, s.previousProfileVersion],
    ['tokenizer_hash', strip0x(section(d, 'artifacts')['tokenizer_hash']), s.tokenizerHash],
    ['schema_hash', strip0x(spec['schema_hash']), s.schemaHash],
    ['runtime_class', runtime['runtime_class'], s.runtimeClass],
    ['required_top_k', runtime['required_top_k'], s.requiredTopK],
    ['task_types', (spec['task_types'] as string[]).join(','), s.taskTypes.join(',')],
    ['generation_type', spec['generation_type'], s.generationType],
    ['resource_tier', spec['resource_tier'], s.resourceTier],
    ['min_stake', stake['amount'], s.minStake],
    ['challenge_open_window_blocks', spec['challenge_open_window_blocks'], s.challengeOpenWindowBlocks],
    ['pricing_profile.initial_output_price', pricing['initial_output_price'], s.pricing.initialOutputPrice],
    ['pricing_profile.min_order_value', pricing['min_order_value'], s.pricing.minOrderValue],
    ['pricing_profile.verify_ratio_bps', pricing['verify_ratio_bps'], s.pricing.verifyRatioBps],
  ];
  for (const [name, fromManifest, onChain] of checks) {
    if (fromManifest !== onChain) {
      throw invalid(
        'MANIFEST_PROJECTION_MISMATCH',
        `${name} differs: manifest ${String(fromManifest)}, chain ${String(onChain)}`,
      );
    }
  }
}
