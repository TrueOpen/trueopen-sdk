/** Hub (node) view types related to builders / service descriptors. */

/** Schema of the builder service descriptor document (off-chain .well-known/trueopen-builder.json). */
export const BUILDER_DESCRIPTOR_SCHEMA_V1 = 'trueopen-builder-descriptor-v1';

/** ServiceDescriptor participant type (node MsgUpdateServiceDescriptor.participant_type). */
export type ParticipantType = 'BUILDER' | 'WORKER' | 'VERIFIER' | 'CORTEX_NODE';

/** SDK view of node hub.v1 BuilderState. */
export interface BuilderInfo {
  readonly address: string;
  readonly status: string; // ACTIVE / CANDIDATE / JAILED / ...
  readonly enrolledHeight: bigint;
  readonly lastActiveHeight: bigint;
  readonly capabilityScore: bigint;
  readonly jailUntilHeight: bigint;
  readonly currentServiceKeyVersion: bigint;
  readonly currentDescriptorVersion: bigint;
  readonly activeTerm: bigint;
}

/** node ServiceDescriptorV1 inline endpoint kind (since #41, endpoints are inlined directly on-chain instead of going through a well-known document). */
export const SERVICE_ENDPOINT_KIND_NEXUS_GRPC = 'SERVICE_ENDPOINT_KIND_NEXUS_GRPC';

/** A single endpoint from node hub.v1 ServiceDescriptorV1. */
export interface ServiceEndpointV1 {
  readonly endpointKind: string; // SERVICE_ENDPOINT_KIND_*
  readonly uri: string;
  readonly protocolVersion: string;
  /**
   * sha256 of the certificate public key (SubjectPublicKeyInfo DER), lowercase hex;
   * an empty string if not set on-chain. When non-empty, the client trusts only this
   * public key (see transport/nexus-tls).
   */
  readonly tlsPubkeyHash?: string;
}

/** Fetch the nexus gRPC endpoint from the descriptor's inline endpoints (undefined if none). */
export function nexusGrpcEndpoint(ref: ServiceDescriptorRef): ServiceEndpointV1 | undefined {
  return ref.endpoints.find((e) => e.endpointKind === SERVICE_ENDPOINT_KIND_NEXUS_GRPC);
}

/**
 * SDK view of node hub.v1 ServiceDescriptor (#41: inline endpoints[],
 * participant_type is the enum name PARTICIPANT_TYPE_BUILDER; there is no longer a
 * descriptor_uri -- endpoints come straight from the chain, with no need to fetch a
 * well-known document + verify its sha256).
 */
export interface ServiceDescriptorRef {
  readonly participantType: string;
  readonly participantId: string; // operator_address
  readonly descriptorVersion: bigint;
  readonly endpoints: readonly ServiceEndpointV1[];
  /** descriptor_hash (base64->hex), the on-chain commitment. */
  readonly descriptorHash: string;
  readonly updatedHeight: bigint;
}

/** Fetch the nexus gRPC endpoint uri from the descriptor's inline endpoints (empty string if none). */
export function nexusGrpcUri(ref: ServiceDescriptorRef): string {
  return ref.endpoints.find((e) => e.endpointKind === SERVICE_ENDPOINT_KIND_NEXUS_GRPC)?.uri ?? '';
}

/**
 * Normalize a service descriptor endpoint uri into a base URL usable over Connect-over-HTTP.
 * node's seed / on-chain ServiceDescriptorV1 endpoints use a gRPC scheme (e.g.
 * `grpc://host:8080`, see genesis_seed.go 0e22374), while the SDK's IngressAPI goes over
 * Connect-over-HTTP, and `createConnectTransport({ baseUrl })` only accepts http(s).
 * Mapping: `grpc://` -> `http://`, `grpcs://` -> `https://`; http(s) is returned as-is;
 * an unrecognized scheme is returned as-is (left to the caller to handle). An empty
 * string is returned as-is.
 */
export function nexusHttpBaseUri(uri: string): string {
  if (uri.startsWith('grpcs://')) return `https://${uri.slice('grpcs://'.length)}`;
  if (uri.startsWith('grpc://')) return `http://${uri.slice('grpc://'.length)}`;
  return uri;
}

/** Off-chain builder descriptor document (trueopen-builder-descriptor-v1). */
export interface BuilderDescriptorDoc {
  readonly schemaVersion: string;
  readonly builderAddress: string;
  /** Builder / nexus service endpoint (IngressAPI base address). */
  readonly serviceEndpoint: string;
  readonly moniker: string;
  readonly p2pHint: string;
}

/** SDK view of node hub.v1 ModelState (Models list query). */
export interface ModelState {
  readonly modelId: string;
  readonly proposerAddress: string;
  readonly status: string; // MODEL_PROFILE_STATUS_*
  readonly activeProfileCount: bigint;
  readonly latestProfileVersion: bigint;
  readonly statusSource: string;
  readonly registrationFeePaid: bigint;
  readonly createdHeight: bigint;
  readonly updatedHeight: bigint;
}

/** Trimmed-down SDK view of node hub.v1 ProfileState (Profiles list query; only discovery-relevant scalar fields, verification/pricing and other nested config are not expanded). */
export interface ProfileInfo {
  readonly modelId: string;
  readonly profileVersion: bigint;
  readonly status: string; // MODEL_PROFILE_STATUS_* (may be unset)
  readonly runtimeClass: string;
  readonly resourceTier: bigint;
  readonly requiredTopK: bigint;
  readonly taskTypes: readonly string[];
  readonly generationType: string;
  /**
   * The pricing constraint carried in the profile. The Keeper uses it to decide whether
   * an order's order_value is sufficient (node x/task/keeper's
   * "order_value is below the profile minimum"):
   *   worker      = floor(max_output_tokens x price_bid / 1_000_000)
   *   verifier    = floor(worker x verify_ratio_bps / 10_000)
   *   order_value = worker + verifier  must be >= min_order_value
   * These three values only exist on-chain; the SDK must not guess them -- guessing low
   * would let the order get rejected by the chain only after nexus has already accepted it.
   */
  readonly pricing: ProfilePricing;
}

export interface ProfilePricing {
  readonly minOrderValue: bigint;
  readonly verifyRatioBps: bigint;
  readonly initialOutputPrice: bigint;
}

/** A resolved and verified builder endpoint (can be used to build an nexus Connect Transport). */
export interface BuilderEndpoint {
  readonly builderAddress: string;
  readonly serviceEndpoint: string;
  /** On-chain tls_pubkey_hash (hex); an empty string means it isn't registered. */
  readonly tlsPubkeyHash?: string;
  readonly descriptorHash: string;
  readonly descriptorVersion: bigint;
}

/**
 * Trimmed-down SDK view of node hub.v1 BeaconState.
 * block_hash is the only session anchor the Keeper recognizes: TaskOrderV1.session_anchor_block_hash
 * must equal GetBlockAnchorHash(height), and the latter reads exactly the value persisted
 * here (node x/hub/keeper/beacon_runtime.go:178-193, sourced from ABCI's sdkCtx.HeaderHash()).
 * So the anchor **must** come from a beacon query -- it cannot be read from a block header directly.
 */
export interface BeaconView {
  readonly height: bigint;
  /** canonical lowercase 64-hex. */
  readonly blockHash: string;
  readonly randomnessHex: string;
  readonly sourceTag: string;
  readonly verified: boolean;
}

/** node hub.v1 parameter bucket kind (TaskOrderV1 fields 25/26 sign in its version). */
export const BUCKET_KIND = {
  REFERENCE: 'BUCKET_KIND_REFERENCE',
  TIMEOUT: 'BUCKET_KIND_TIMEOUT',
} as const;

/** Default key for a parameter bucket (node hubtypes.DefaultParameterBucketKey). */
export const DEFAULT_PARAMETER_BUCKET_KEY = 'default';

/**
 * Parameter bucket version view. The Keeper resolves the **currently effective
 * version** via ResolveEffectiveParameterBucket(kind, "default", currentHeight) and
 * requires it to match the value signed into the order
 * (msg_server_worker_handraises.go:494-502), so use currentVersion.
 */
export interface ParameterBucketView {
  readonly bucketKind: string;
  readonly bucketKey: string;
  /** The version recorded on the bucket itself. */
  readonly version: bigint;
  /** The currently effective version -- this is the one signed into the order. */
  readonly currentVersion: bigint;
  readonly effectiveHeight: bigint;
}

/** SDK view of node hub.v1 BuilderSetSnapshot (a term-frozen snapshot). */
export interface BuilderSetSnapshot {
  /**
   * builder_set_id: signed directly into TaskOrderV2 field 24.
   *
   * Note it is **not a number**: on wire v0.4.1, on-chain values look like
   * `"genesis-1"`. In earlier versions this was a decimal term string, but that term
   * model (term_id / term_start_height / term_end_height / snapshot_height) was
   * removed along with bonds when Builder registration changed.
   */
  readonly builderSetId: string;
  /** builder_set_version: the version number under the same set id. */
  readonly builderSetVersion: bigint;
  /** The block height at which this set became effective; the session anchor must not be earlier than it. */
  readonly effectiveHeight: bigint;
  /** Comma-joined list of canonical bech32 builder addresses. */
  readonly builders: string;
  /** The snapshot's set_hash (hex), used as part of the Stage-1 selection seed. */
  readonly setHash: string;
}

/** REST value of shared.v1.ParticipantType. The Worker-side software's name for itself is CORTEX. */
export const PARTICIPANT_TYPE = {
  CORTEX: 'PARTICIPANT_TYPE_CORTEX',
  BUILDER: 'PARTICIPANT_TYPE_BUILDER',
} as const;
export type ParticipantTypeName = (typeof PARTICIPANT_TYPE)[keyof typeof PARTICIPANT_TYPE];

/**
 * The current service key binding registered on-chain.
 * Streaming subscriptions use it to verify a Worker's frame signature: OutputChunkV1.worker_signature
 * is a raw64 signature by the selected Worker's service key over the TRUEOPEN_OUTPUT_CHUNK_V1 digest.
 */
export interface ServiceKeyBinding {
  readonly participantType: string;
  readonly operatorAddress: string;
  readonly serviceAddress: string;
  /** 33-byte compressed public key. */
  readonly servicePubKey: Uint8Array;
  /** Value of SERVICE_KEY_STATUS_* with the prefix stripped; should not be used to verify signatures when not ACTIVE. */
  readonly status: string;
  readonly serviceAuthorizationNonce: bigint;
}

/**
 * Generation limits from the task module params (the `generation` field of `/TrueOpen/task/v1/params`).
 *
 * Uniform across the whole chain, and not the same thing as a model profile's
 * GenerationLimitParamsV1 -- the latter only governs top_k and stop sequences, and
 * **does not include max_output_tokens**. These values can change via governance, so
 * they must be re-read before every order and never cached.
 */
export interface TaskGenerationLimits {
  readonly maxOutputTokens: bigint;
  readonly topKMax: bigint;
  readonly stopSequenceMaxItems: bigint;
  readonly stopSequenceMaxBytesEach: bigint;
  readonly stopSequenceMaxTotalBytes: bigint;
  readonly stopTokenMaxItems: bigint;
}
