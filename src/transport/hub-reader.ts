import { stringToU64, base64ToBytes } from '../codec/wire';
import { toHex } from '../util/bytes';
import { TrueOpenError } from '../errors/errors';
import type { FetchLike, FetchResponse, QueryRetryPolicy } from './rest-chain-reader';
import { DEFAULT_QUERY_RETRY, withQueryRetry } from './rest-chain-reader';
import type {
  BuilderInfo,
  BuilderSetSnapshot,
  ServiceDescriptorRef,
  ServiceEndpointV1,
  ModelState,
  ProfileInfo,
  ProfilePricing,
  TaskGenerationLimits,
  ParticipantTypeName,
  ServiceKeyBinding,
  BeaconView,
  ParameterBucketView,
} from '../types/hub';
import { BUCKET_KIND, DEFAULT_PARAMETER_BUCKET_KEY } from '../types/hub';

/**
 * Hash32 field -> canonical lowercase hex (builder_set_hash / descriptor_hash / etc).
 *
 * node's gRPC gateway used to output the proto `bytes` field as base64; it now uses
 * canonical lowercase 64-hex instead (matching nexus's `nodecontract.Hash32Bytes`
 * convention). Both are accepted: a value that's already 64-hex is returned as-is,
 * otherwise it's base64-decoded and converted to hex -- base64-decoding a hex string
 * directly would just produce garbage.
 */
function hash32Hex(o: Record<string, unknown>, snakeKey: string): string {
  const v = o[snakeKey] ?? o[camelKey(snakeKey)];
  if (typeof v !== 'string') throw malformed(`field ${snakeKey}`);
  if (/^[0-9a-f]{64}$/.test(v)) return v;
  return toHex(base64ToBytes(v));
}

/** Optional 32-byte hash field: returns an empty string when absent or when the bytes are empty. */
function hash32HexOpt(o: Record<string, unknown>, snakeKey: string): string {
  const v = o[snakeKey] ?? o[camelKey(snakeKey)];
  if (v === undefined || v === null || v === '') return '';
  return hash32Hex(o, snakeKey);
}

export interface HubReaderOptions {
  /** gRPC gateway REST root, e.g. http://localhost:1317 */
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  /** Overrides DEFAULT_QUERY_RETRY; pass `{ attempts: 1 }` to opt out. */
  readonly retry?: Partial<QueryRetryPolicy>;
}

/**
 * Reads hub.v1.Query (builder / service descriptors) via the node's gRPC gateway REST API.
 * uint64 values are returned as decimal strings; field names are looked up as snake_case
 * first, falling back to camelCase.
 */
export class HubReader {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly retry: QueryRetryPolicy;

  constructor(opts: HubReaderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetch = opts.fetch;
    this.retry = { ...DEFAULT_QUERY_RETRY, ...opts.retry };
  }

  /** Lists all registered builders (QueryBuilders). */
  async listBuilders(): Promise<BuilderInfo[]> {
    const body = await this.getJson('/TrueOpen/hub/v1/builders');
    const list = body['builders'];
    if (!Array.isArray(list)) throw malformed('builders array');
    return list.map((b) => toBuilder(asObject(b)));
  }

  /** Looks up a single builder (QueryBuilder). */
  async getBuilder(address: string): Promise<BuilderInfo> {
    const body = await this.getJson(`/TrueOpen/hub/v1/builder/${encodeURIComponent(address)}`);
    return toBuilder(asObject(body['builder']));
  }

  /**
   * Looks up a service descriptor (QueryServiceDescriptor, new route from #41).
   * Route is `service_descriptor/{participant_type}/{operator_address}` (the version
   * segment is dropped); participant_type is the enum name (default
   * PARTICIPANT_TYPE_BUILDER); the response has endpoints[] inline.
   */
  async getServiceDescriptor(
    operatorAddress: string,
    participantType = 'PARTICIPANT_TYPE_BUILDER',
  ): Promise<ServiceDescriptorRef> {
    const path = `/TrueOpen/hub/v1/service_descriptor/${encodeURIComponent(participantType)}/${encodeURIComponent(operatorAddress)}`;
    const body = await this.getJson(path);
    return toDescriptorRef(asObject(body['descriptor']));
  }

  /** Lists registered models (Models, with optional status filter: REGISTERED/ACTIVE/FROZEN/EMERGENCY_FROZEN/DELISTED). */
  async listModels(status?: string): Promise<ModelState[]> {
    const q = status !== undefined && status !== '' ? `?status=${encodeURIComponent(status)}` : '';
    const body = await this.getJson(`/TrueOpen/hub/v1/models${q}`);
    const list = body['models'];
    if (!Array.isArray(list)) throw malformed('models array');
    return list.map((m) => toModel(asObject(m)));
  }

  /** Lists registered profiles (Profiles, with optional model_id / status filter). */
  /**
   * Looks up a single model profile. Placing an order must read this: the pricing's
   * min_order_value and verify_ratio_bps determine the lower bound for price_bid;
   * guessing too low means nexus accepts the order and only the chain rejects it later.
   */
  async getProfile(modelId: string, profileVersion: bigint): Promise<ProfileInfo> {
    const path = `/TrueOpen/hub/v1/profile/${encodeURIComponent(modelId)}/${profileVersion.toString()}`;
    const body = await this.getJson(path);
    return toProfile(asObject(body['profile'] ?? body));
  }

  async listProfiles(opts?: { modelId?: string; status?: string }): Promise<ProfileInfo[]> {
    const params: string[] = [];
    if (opts?.modelId !== undefined && opts.modelId !== '') params.push(`model_id=${encodeURIComponent(opts.modelId)}`);
    if (opts?.status !== undefined && opts.status !== '') params.push(`status=${encodeURIComponent(opts.status)}`);
    const q = params.length > 0 ? `?${params.join('&')}` : '';
    const body = await this.getJson(`/TrueOpen/hub/v1/profiles${q}`);
    const list = body['profiles'];
    if (!Array.isArray(list)) throw malformed('profiles array');
    return list.map((p) => toProfile(asObject(p)));
  }

  /** Looks up the builder set snapshot effective at a given block height. */
  async getBuilderSetAtHeight(height: bigint): Promise<BuilderSetSnapshot> {
    const body = await this.getJson(`/TrueOpen/hub/v1/builder_set/by_height/${height.toString()}`);
    return toBuilderSet(asObject(body['set']));
  }

  /** Looks up the currently effective builder set (uses the latest block height to get the set id + members + set_hash in one call). */
  async getActiveBuilderSet(): Promise<BuilderSetSnapshot> {
    return this.getBuilderSetAtHeight(await this.getLatestHeight());
  }

  /**
   * The **numeric EVM chain ID** registered on chain (`params.phase0.evm_chain_id`).
   *
   * This feeds the EIP-712 domain separator, and both order signing and the task-data
   * retrieval-credential signature depend on it. **Do not hardcode a default**: the wire
   * golden vectors use 424242, while devnet actually uses 31337 -- getting this wrong
   * produces a different domain separator so the signature fails to verify, and the
   * error will just say "invalid signature" with no pointer back to this value. The
   * node side reads it from the same place (`d.hub.GetHubParams(ctx).EVMChainID` in
   * app/account_ante.go).
   */
  async getEvmChainId(): Promise<bigint> {
    const body = await this.getJson('/TrueOpen/hub/v1/params');
    const phase0 = asObject(asObject(body['params'])['phase0']);
    return u64(phase0, 'evm_chain_id');
  }

  /**
   * The service key currently registered for a given participant.
   *
   * streamOutput needs this: OutputChunkV1.worker_signature is a raw64 signature over
   * the TRUEOPEN_OUTPUT_CHUNK_V1 digest made with the selected Worker's **service key**
   * (not its account key). The Worker's operator address comes from the on-chain task's
   * winner_worker (RestChainReader.queryTask); use participantType CORTEX -- the
   * Worker-side software's participant type is literally called CORTEX, there is no
   * PARTICIPANT_TYPE_WORKER value.
   */
  async getCurrentServiceKey(
    participantType: ParticipantTypeName,
    operatorAddress: string,
  ): Promise<ServiceKeyBinding> {
    const path = `/TrueOpen/hub/v1/current_service_key/${encodeURIComponent(participantType)}/${encodeURIComponent(operatorAddress)}`;
    const b = asObject((await this.getJson(path))['binding']);
    // The status field name varies by participant type (cortex_service_key_status /
    // builder_service_key_status), so look it up by suffix instead of a fixed key name.
    const statusKey = Object.keys(b).find((k) => k.endsWith('service_key_status'));
    return {
      participantType: str(b, 'participant_type'),
      operatorAddress: str(b, 'operator_address'),
      serviceAddress: str(b, 'service_address'),
      servicePubKey: pubKeyBytes(b, 'service_pubkey'),
      status: statusKey === undefined ? '' : String(b[statusKey] ?? '').replace(/^SERVICE_KEY_STATUS_/, ''),
      serviceAuthorizationNonce: u64opt(b, 'service_authorization_nonce'),
    };
  }

  /**
   * The task module's generation limits. **Note this route lives under task, not hub** --
   * it's placed here because it's only needed when assembling an order, which puts it in
   * the same "on-chain facts to read before placing an order" category as this class's
   * other methods.
   *
   * These values can change via governance, so resolveTaskOrderContext re-reads them
   * every time instead of caching: validating against a stale limit -- passing locally
   * but still getting rejected on chain -- is harder to debug than just re-reading.
   */
  async getTaskGenerationLimits(): Promise<TaskGenerationLimits> {
    const body = await this.getJson('/TrueOpen/task/v1/params');
    const g = asObject(asObject(body['params'])['generation']);
    // In REST, uint32 fields come back as bare numbers and uint64 fields as strings;
    // both forms need to be accepted.
    const num = (key: string): bigint => {
      const v = g[key];
      if (typeof v === 'number') {
        if (!Number.isSafeInteger(v) || v < 0) throw malformed(`field ${key}`);
        return BigInt(v);
      }
      if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v);
      throw malformed(`field ${key}`);
    };
    return {
      maxOutputTokens: num('max_output_tokens'),
      topKMax: num('top_k_max'),
      stopSequenceMaxItems: num('stop_sequence_max_items'),
      stopSequenceMaxBytesEach: num('stop_sequence_max_bytes_each'),
      stopSequenceMaxTotalBytes: num('stop_sequence_max_total_bytes'),
      stopTokenMaxItems: num('stop_token_max_items'),
    };
  }

  /** Latest block height (for choosing a session anchor and computing the order height window). */
  async getLatestHeight(): Promise<bigint> {
    const latest = await this.getJson('/cosmos/base/tendermint/v1beta1/blocks/latest');
    return u64(asObject(asObject(latest['block'])['header']), 'height');
  }

  /**
   * Looks up the beacon at a given height (QueryBeacon). Its block_hash is the only
   * session anchor the Keeper recognizes -- TaskOrderV1.session_anchor_block_hash must
   * match it byte for byte.
   */
  async getBeacon(height: bigint): Promise<BeaconView> {
    const body = await this.getJson(`/TrueOpen/hub/v1/beacon/${height.toString()}`);
    return toBeacon(asObject(body['beacon']));
  }

  /**
   * Looks up the currently effective version of a parameter bucket (QueryReferenceBucket /
   * QueryTimeoutBucket). The reference/timeout_bucket_version signed into the order must
   * equal currentVersion, or the Keeper reports "signed parameter bucket version is not
   * effective".
   */
  async getParameterBucket(
    kind: typeof BUCKET_KIND[keyof typeof BUCKET_KIND],
    bucketKey = DEFAULT_PARAMETER_BUCKET_KEY,
  ): Promise<ParameterBucketView> {
    const route = kind === BUCKET_KIND.REFERENCE ? 'reference_bucket' : 'timeout_bucket';
    const body = await this.getJson(`/TrueOpen/hub/v1/${route}/${encodeURIComponent(bucketKey)}`);
    const bucket = asObject(body['bucket']);
    return {
      bucketKind: str(bucket, 'bucket_kind'),
      bucketKey: str(bucket, 'bucket_key'),
      version: u64(bucket, 'version'),
      // current_version is at the top level of the response, not inside bucket.
      currentVersion: u64(body, 'current_version'),
      effectiveHeight: u64opt(bucket, 'effective_height'),
    };
  }

  private async getJson(path: string): Promise<Record<string, unknown>> {
    return withQueryRetry(this.retry, () => this.getJsonOnce(path));
  }

  private async getJsonOnce(path: string): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    let res: FetchResponse;
    try {
      res = await this.fetch(url);
    } catch (e) {
      throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_UNAVAILABLE', `hub query failed: ${url}`, {
        retriable: true,
        cause: e,
      });
    }
    if (!res.ok) {
      const notFound = res.status === 404;
      throw new TrueOpenError(
        'CHAIN_REJECT',
        notFound ? 'CHAIN_QUERY_NOT_FOUND' : `CHAIN_QUERY_HTTP_${res.status}`,
        `hub query ${url} -> HTTP ${res.status}`,
        { retriable: res.status >= 500 },
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      // The headers arrived and the body did not: a connection dropped mid-body
      // fails here rather than at fetch(), so it is the same transient fault one
      // step later and is classified the same way.
      throw new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_UNAVAILABLE', `hub query body failed: ${url}`, {
        retriable: true,
        cause: e,
      });
    }
    if (typeof body !== 'object' || body === null) throw malformed('response object');
    return body as Record<string, unknown>;
  }
}

function toBuilder(o: Record<string, unknown>): BuilderInfo {
  return {
    address: str(o, 'address'),
    status: str(o, 'status'),
    enrolledHeight: u64(o, 'enrolled_height'),
    lastActiveHeight: u64(o, 'last_active_height'),
    capabilityScore: u64(o, 'capability_score'),
    jailUntilHeight: u64(o, 'jail_until_height'),
    currentServiceKeyVersion: u64opt(o, 'current_service_key_version'),
    currentDescriptorVersion: u64(o, 'current_descriptor_version'),
    activeTerm: u64(o, 'active_term'),
  };
}

function toBuilderSet(o: Record<string, unknown>): BuilderSetSnapshot {
  const rawBuilders = o['active_builders'] ?? o['activeBuilders'];
  const builders = Array.isArray(rawBuilders)
    ? rawBuilders.filter((x): x is string => typeof x === 'string').join(',')
    : '';
  if (builders === '') throw malformed('active_builders array');
  const builderSetId = strOpt(o, 'builder_set_id');
  // This is signed directly into TaskOrderV2; signing the wrong value produces a
  // different task_hash, so it's better to throw here than fall back to a guessed value.
  if (builderSetId === '') throw malformed('builder_set_id');
  return {
    builderSetId,
    builderSetVersion: u64opt(o, 'builder_set_version'),
    effectiveHeight: u64opt(o, 'effective_height'),
    builders,
    // builder_set_hash -> lowercase hex (nexus's selection algorithm uses hex strings;
    // both hex and base64 are accepted).
    setHash: hash32Hex(o, 'builder_set_hash'),
  };
}

function toBeacon(o: Record<string, unknown>): BeaconView {
  return {
    height: u64(o, 'height'),
    blockHash: hash32Hex(o, 'block_hash'),
    randomnessHex: strOpt(o, 'randomness_hex'),
    sourceTag: strOpt(o, 'source_tag'),
    verified: o['verified'] === true,
  };
}

function toDescriptorRef(o: Record<string, unknown>): ServiceDescriptorRef {
  const rawEps = o['endpoints'];
  const endpoints: ServiceEndpointV1[] = Array.isArray(rawEps)
    ? rawEps.map((e) => {
        const eo = asObject(e);
        return {
          endpointKind: str(eo, 'endpoint_kind'),
          uri: str(eo, 'uri'),
          protocolVersion: strOpt(eo, 'protocol_version'),
          tlsPubkeyHash: hash32HexOpt(eo, 'tls_pubkey_hash'),
        };
      })
    : [];
  return {
    participantType: str(o, 'participant_type'),
    participantId: strAny(o, ['operator_address', 'participant_id']),
    descriptorVersion: u64(o, 'descriptor_version'),
    endpoints,
    descriptorHash: hash32Hex(o, 'descriptor_hash'),
    updatedHeight: u64opt(o, 'updated_height'),
  };
}

function asObject(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) throw malformed('object');
  return v as Record<string, unknown>;
}

function camelKey(snakeKey: string): string {
  return snakeKey.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

function str(o: Record<string, unknown>, snakeKey: string): string {
  const v = o[snakeKey] ?? o[camelKey(snakeKey)];
  if (typeof v !== 'string') throw malformed(`field ${snakeKey}`);
  return v;
}

/** Returns the first string value among several candidate snake_case keys (for field-rename compatibility). */
function strAny(o: Record<string, unknown>, snakeKeys: readonly string[]): string {
  for (const k of snakeKeys) {
    const v = o[k] ?? o[camelKey(k)];
    if (typeof v === 'string') return v;
  }
  throw malformed(`field ${snakeKeys.join('|')}`);
}

function u64(o: Record<string, unknown>, snakeKey: string): bigint {
  const v = o[snakeKey] ?? o[camelKey(snakeKey)];
  if (typeof v !== 'string') throw malformed(`field ${snakeKey}`);
  return stringToU64(v);
}

/** Optional uint64 (string): returns fallback when the field is missing (gRPC gateway omits zero values / the proto field is reserved). */
function u64opt(o: Record<string, unknown>, snakeKey: string, fallback = 0n): bigint {
  const v = o[snakeKey] ?? o[camelKey(snakeKey)];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string') throw malformed(`field ${snakeKey}`);
  return stringToU64(v);
}

/** uint32: gRPC gateway returns this as a JSON number (numeric strings are also accepted); defaults to 0n. */
function u32(o: Record<string, unknown>, snakeKey: string): bigint {
  const v = o[snakeKey] ?? o[camelKey(snakeKey)];
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v);
  throw malformed(`field ${snakeKey}`);
}

/** Optional string. */
function strOpt(o: Record<string, unknown>, snakeKey: string, fallback = ''): string {
  const v = o[snakeKey] ?? o[camelKey(snakeKey)];
  return typeof v === 'string' ? v : fallback;
}

function toModel(o: Record<string, unknown>): ModelState {
  return {
    modelId: str(o, 'model_id'),
    proposerAddress: strOpt(o, 'proposer_address'),
    status: str(o, 'status'),
    activeProfileCount: u32(o, 'active_profile_count'),
    latestProfileVersion: u32(o, 'latest_profile_version'),
    statusSource: strOpt(o, 'status_source'),
    registrationFeePaid: u64opt(o, 'registration_fee_paid'),
    createdHeight: u64opt(o, 'created_height'),
    updatedHeight: u64opt(o, 'updated_height'),
  };
}

function toProfile(o: Record<string, unknown>): ProfileInfo {
  const raw = o['task_types'] ?? o['taskTypes'];
  const taskTypes = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  return {
    modelId: str(o, 'model_id'),
    profileVersion: u32(o, 'profile_version'),
    status: strOpt(o, 'status'),
    runtimeClass: strOpt(o, 'runtime_class'),
    resourceTier: u32(o, 'resource_tier'),
    requiredTopK: u32(o, 'required_top_k'),
    taskTypes,
    generationType: strOpt(o, 'generation_type'),
    pricing: toProfilePricing(o['pricing_profile'] ?? o['pricingProfile']),
  };
}

/** service_pubkey is a base64-encoded 33-byte compressed public key in REST responses. */
function pubKeyBytes(o: Record<string, unknown>, key: string): Uint8Array {
  const v = o[key];
  if (typeof v !== 'string' || v === '') throw malformed(`field ${key}`);
  const bytes = base64ToBytes(v);
  if (bytes.length !== 33) throw malformed(`field ${key} decodes to ${bytes.length} bytes, want 33`);
  return bytes;
}

function toProfilePricing(raw: unknown): ProfilePricing {
  // Return zero values instead of throwing when pricing_profile is missing: a read-only
  // command (e.g. listing profiles) shouldn't fail because of this. The order-placement
  // path is the one that actually needs it, and it validates against minOrderValue there,
  // so a zero value there won't wrongly let an order through.
  if (raw === undefined || raw === null) return { minOrderValue: 0n, verifyRatioBps: 0n, initialOutputPrice: 0n };
  const o = asObject(raw);
  // Note these fields come back as **JSON numbers** in REST, unlike heights which are
  // strings -- calling u64opt directly on them would report malformed. protojson uses
  // numbers for uint32 and strings for uint64, and either can show up here, so accept both.
  const num = (key: string): bigint => {
    const v = o[key];
    if (v === undefined || v === null || v === '') return 0n;
    if (typeof v === 'number') {
      if (!Number.isInteger(v) || v < 0) throw malformed(`field ${key}`);
      return BigInt(v);
    }
    if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v);
    throw malformed(`field ${key}`);
  };
  return {
    minOrderValue: num('min_order_value'),
    verifyRatioBps: num('verify_ratio_bps'),
    initialOutputPrice: num('initial_output_price'),
  };
}

function malformed(what: string): TrueOpenError {
  return new TrueOpenError('CHAIN_REJECT', 'CHAIN_QUERY_MALFORMED', `hub query returned malformed ${what}`);
}
