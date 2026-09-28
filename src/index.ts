export const SDK_WIRE_VERSION = 'SDK_WIRE_V1' as const;

export { TrueOpenError, dataError } from './errors/errors';
export type { ErrorFamily, ErrorCategory, TrueOpenErrorOptions } from './errors/errors';
export { classifyNexusError, classifyBroadcastError, nexusErrorCode } from './errors/classify';

// Task lifecycle enums come straight from the wire contract.
export { TaskPhase, AssignmentStatus, ReceiptStatus, VerificationStatus, SettlementStatus } from './gen/task/v1/assignment_pb.js';
export { TaskVerdict, TaskFailureClass } from './gen/task/v1/settlement_pb.js';
export { TaskFinalityStatusV1 } from './gen/shared/v1/common_pb.js';

export { u64ToString, stringToU64, bytesToBase64, base64ToBytes, hash32ToHex } from './codec/wire';

export type { StreamStateView, ChainTaskSnapshot, InferReceiptView } from './types/node';

export type {
  ChainReader,
  ChainClient,
  CreateSessionResult,
  CancelOrderInput,
  CancelOrderResult,
} from './transport/chain-client';
export { RestChainReader, withQueryRetry, DEFAULT_QUERY_RETRY } from './transport/rest-chain-reader';
export type { FetchLike, FetchResponse, RestChainReaderOptions, QueryRetryPolicy } from './transport/rest-chain-reader';

export { HubReader } from './transport/hub-reader';
export type { HubReaderOptions } from './transport/hub-reader';
export { BUILDER_DESCRIPTOR_SCHEMA_V1, SERVICE_ENDPOINT_KIND_NEXUS_GRPC, nexusGrpcUri, nexusGrpcEndpoint, nexusHttpBaseUri } from './types/hub';
export type { ParticipantType, BuilderInfo, ServiceEndpointV1, ServiceDescriptorRef, BuilderDescriptorDoc, BuilderEndpoint, ModelState, ProfileInfo, ProfilePricing, TaskGenerationLimits, BeaconView, ParameterBucketView } from './types/hub';
export { BUCKET_KIND, DEFAULT_PARAMETER_BUCKET_KEY, PARTICIPANT_TYPE } from './types/hub';
export type { ParticipantTypeName, ServiceKeyBinding } from './types/hub';
export { verifyAndParseBuilderDescriptor, resolveBuilderEndpoints } from './hub/builder-discovery';
export type {
  DescriptorDocFetch,
  ResolveBuilderEndpointsOptions,
  ResolveBuilderEndpointsResult,
} from './hub/builder-discovery';
export type { BuilderSetSnapshot } from './types/hub';
export { selectTaskBuilders, taskBuilderSeed, taskBuilderRank, BUILDERS_PER_TASK, DOMAIN_TASK_BUILDERS_V1, DOMAIN_TASK_BUILDER_RANK_V1 } from './hub/builder-selection';
export type { TaskBuilderSelectionInput, BuilderSetMember, SelectedBuilder } from './hub/builder-selection';
export { resolveTaskBuilderEndpoints } from './hub/stage1-routing';
export type { TaskBuilderReader, ResolveTaskBuilderInput, TaskBuilderEndpoint, ResolveTaskBuilderResult } from './hub/stage1-routing';
export { fanOutToEndpoints, TaskBuilderAllEndpointsFailedError } from './transport/fan-out-submit';
export { nexusIngressTransport, nexusTransportOptions, PinnedHttpsAgent, tlsPubkeyHashOfCertificate, isTLSPubkeyMismatch, tlsPubkeyHashRequiredByEnv, insecureHttpAllowedByEnv, NEXUS_TLS_PUBKEY_MISMATCH } from './transport/nexus-tls';
export type { NexusTransportPolicy } from './transport/nexus-tls';
export type { NexusTransportOptions } from './transport/nexus-tls';
export type { EndpointLike, AcceptedLike, FanOutResult, FanOutResultItem } from './transport/fan-out-submit';

export { ProtoWriter, ProtoReader } from './codec/protobuf';
export {
  TYPE_URL,
  encodeMsgCreateSession,
  encodeMsgCancelOrder,
  decodeMsgCreateSessionResponse,
  decodeMsgCancelOrderResponse,
} from './transport/task-msgs';
export type {
  MsgCreateSession,
  MsgCreateSessionResponse,
  MsgCancelOrder,
  MsgCancelOrderResponse,
} from './transport/task-msgs';

export { taskRegistry } from './transport/cosmjs-registry';
export { CosmjsChainWriter, composeChainClient } from './transport/cosmjs-chain-writer';
export type { TxBroadcaster, CosmjsChainWriterOptions, TxInclusionPolicy } from './transport/cosmjs-chain-writer';
export { DEFAULT_TX_INCLUSION } from './transport/cosmjs-chain-writer';

export { createTrueOpenChainClient, connectTrueOpenChainClient } from './transport/trueopen-chain-client';
export type {
  CreateTrueOpenChainClientConfig,
  ConnectTrueOpenChainClientOptions,
} from './transport/trueopen-chain-client';

export { SessionManager } from './session/session-manager';
export type { SessionHandle } from './session/session-manager';

export {
  validateModelId,
  isValidModelId,
  deriveModelId,
  MODEL_ID_GRAMMAR,
  MODEL_PROVIDER,
  DOMAIN_MODEL_ID_V1,
} from './order/model-id';
export type { ModelIdInput } from './order/model-id';

// ---- Frozen TaskOrderV3 / SignedOrderV2 ----
export {
  taskOrderHash,
  taskOrderHashHex,
  DOMAIN_TASK_ORDER_V3,
  TASK_ORDER_SCHEMA_VERSION_V3,
  PAYLOAD_MODE,
  GENERATION_PARAMS_SCHEMA_VERSION_V1,
  TASK_TYPE,
  DEADLINE_LATENCY_CLASS,
} from './order/task-order';
export type {
  TaskOrderV3,
  AmountV1,
  GenerationParamsV1,
  DecodingParamsV1,
  DeadlinePolicyV1,
} from './order/task-order';
export {
  buildTaskOrder,
  resolveTaskOrderContext,
  defaultGenerationParams,
  payloadRefFor,
} from './order/task-order-input';
export type {
  TaskOrderChainContext,
  TaskOrderContextReader,
  TaskOrderRequest,
  TaskOrderIntent,
  TaskOrderAmounts,
} from './order/task-order-input';
export {
  signAndEncodeOrder,
  encodeSignedOrder,
  decodeSignedOrder,
  taskOrderEip712Digest,
  SIGNATURE_SCHEME,
  ORDER_EIP712_TYPES,
  ORDER_EIP712_DOMAIN_NAME,
  ORDER_EIP712_DOMAIN_VERSION,
} from './order/signed-order';
export type { EncodedSignedOrder, OrderEip712Context } from './order/signed-order';
export { buildOpenTaskRequest, OPEN_TASK_ENDPOINT, HEIGHT_EXPIRY_THRESHOLD } from './order/build-open-task';
export type { BuildOpenTaskInput, BuildOpenTaskResult } from './order/build-open-task';

export {
  domainHash,
  domainHashHex,
  canonicalFrameBytes,
  canonicalHashBytes,
  uint32BE,
  int32BE,
  uint64BE,
  boolByte,
  enumBE,
  optionalV1,
} from './codec/domain-hash';
export { canonicalOperatorAddressBytes } from './codec/address';
export { SIGN_DOMAINS } from './codec/domains';
export {
  orderEnvelopeSigningBytes,
  deriveTaskId,
} from './order/order-signing';

// ---- EVM-style identity and EIP-712 (on-chain accounts use this scheme) ----
export {
  eip712EncodeType,
  eip712TypeHash,
  eip712HashStruct,
  eip712DomainSeparator,
  eip712SigningDigest,
  eip712Digest,
} from './codec/eip712';
export type { Eip712Field, Eip712Types, Eip712Value, Eip712Struct } from './codec/eip712';
export {
  uncompressedXY,
  ethAddressBytes,
  ethAddress0x,
  ethSecp256k1Address,
  ethSecp256k1AddressMatches,
  privKeyEip712Signer,
  recoverEip712PubKey,
  recoverEip712Address,
  verifyEip712,
  TRUEOPEN_HD_PATH,
} from './signer/eth-secp256k1';
export type { Eip712Signer } from './signer/eth-secp256k1';
export {
  EthSecp256k1DirectSigner,
  ethSecp256k1SignerFromMnemonic,
  ethAccountParser,
  ETH_SECP256K1_PUBKEY_TYPE_URL,
  ETH_ACCOUNT_TYPE_URL,
} from './signer/eth-direct-signer';

export {
  privKeySecp256k1Signer,
  privKeySecp256k1DigestSigner,
  secp256k1PublicKey,
  verifyCosmosSecp256k1,
  verifySecp256k1Digest,
} from './signer/secp256k1';
export type { CosmosSecp256k1Signer, Secp256k1DigestSigner } from './signer/secp256k1';

export {
  SDK_REQUEST_DOMAIN,
  sdkRequestSignBytes,
  signSdkRequestEnvelope,
} from './transport/sdk-request-envelope';
export {
  SDK_BODY_DOMAIN,
  openTaskBodyDigest,
  openTaskPayloadRef,
  subscribeOutputBodyDigest,
  ackOutputBodyDigest,
  getTaskEventsBodyDigest,
  parseFromCursor,
  prepareChallengeBodyDigest,
} from './transport/sdk-request-body';
export type { OpenTaskBody } from './transport/sdk-request-body';
export type { SdkRequestEnvelopeFields, SignedSdkRequestEnvelope } from './transport/sdk-request-envelope';

export { IngressClient, DEFAULT_OPEN_TASK_CHUNK_BYTES } from './transport/ingress-client';
export {
  taskDataRequestSignBytes,
  taskDataRequestEip712Digest,
  taskDataMetadataBodyDigest,
  taskDataFetchBodyDigest,
  canonicalObjectRefFrame,
  TASK_DATA_BODY_DOMAIN,
  TASK_DATA_RPC_METHOD,
  TASK_DATA_OBJECT_KIND,
  TASK_DATA_REQUESTER_KIND,
  EVIDENCE_PRODUCER_KIND,
} from './transport/task-data-signbytes';
export type {
  TaskDataObjectRef,
  ByteRange,
  TaskDataRequestAuthFields,
} from './transport/task-data-signbytes';
export type { OpenTaskInput, OpenTaskAck, TaskStatusView, IngressAuth } from './transport/ingress-client';

// ---- MMR commitment for streamed output (wired into both the SubscribeOutput and retrieval paths) ----
export { mmrLeaf, mmrNode, mmrEmpty, mmrRoot, mmrPrefixRoot, MmrAccumulator } from './codec/mmr';
export type { MmrPeakCheckpoint, MmrAccumulatorCheckpoint } from './codec/mmr';
export {
  OUTPUT_MMR_DOMAIN,
  OUTPUT_CHUNK_DOMAIN,
  OUTPUT_FIN_DOMAIN,
  ACCEPTED_FINISH_REASONS,
  isAcceptedFinishReason,
  outputHash,
  outputChunkSigningDigest,
  verifyOutputChunkSignature,
  outputFinSigningDigest,
  verifyOutputFinSignature,
  OutputStreamVerifier,
} from './output/output-commitment';
export { confirmOutputWithReceipt } from './output/output-confirmation';
export type {
  ConfirmOutputWithReceiptInput,
  ConfirmedOutputEvent,
} from './output/output-confirmation';
export {
  DEFAULT_CONFIRMED_ONLY_MAX_BUFFERED_BYTES,
  openAIFinishReason,
  toOpenAIChatSSEIterable,
  toOpenAIChatSSE,
} from './output/openai-sse';
export type {
  VerifiedOutputChunkEvent,
  VerifiedOutputFinEvent,
  VerifiedOutputEvent,
  OpenAIChatSseContext,
  OpenAIChatSseOptions,
  OutputDeliveryMode,
  OpenAIFinishReason,
} from './output/openai-sse';
export { FinishReasonV1 } from './gen/task/v1/evidence_pb.js';
export {
  OUTPUT_STREAM_CHECKPOINT_JSON_FORMAT_V1,
  serializeOutputStreamCheckpoint,
  deserializeOutputStreamCheckpoint,
} from './output/output-checkpoint-codec';
export type { OutputStreamCheckpointJsonV1 } from './output/output-checkpoint-codec';
export type {
  OutputChunkSigningFields,
  OutputFinSigningFields,
  OutputFrame,
  OutputStreamVerifierConfig,
  OutputStreamVerifierCheckpoint,
  OutputFrameAcceptance,
} from './output/output-commitment';

export { TrueOpenClient, DEFAULT_MAX_RANGE_BYTES } from './client';
export { resolveFeeDenom } from './order/fee-denom';
export type {
  TrueOpenClientConfig,
  FacadeHubReader,
  OutputTaskReader,
  OutputTrustAnchors,
  OpenTaskBuilderResult,
  OpenTaskParams,
  OpenTaskResult,
  OutputStreamSource,
  StreamOutputParams,
  OutputStreamEvent,
  ConfirmOutputParams,
} from './client';

// ---- Model manifest retrieval. The SSRF-safe Node downloader lives in "trueopen-sdk/node". ----
export {
  ManifestSource,
  MemoryManifestCache,
  boundedWebFetch,
} from './manifest/manifest-source';
export type {
  ManifestSourceOptions,
  ManifestFetcher,
  ManifestFetchLimits,
  ManifestCache,
  ProfileManifestReader,
  ManifestFetchResult,
  ManifestAttempt,
  ManifestSourceKind,
} from './manifest/manifest-source';
export {
  verifyManifestBytes,
  parseModelManifestV4,
  modelManifestHash,
  projectionFromManifest,
  chainProjectionHash,
  registrationDigest,
  DOMAIN_MODEL_MANIFEST_V4,
  DOMAIN_MODEL_CHAIN_PROJECTION_V3,
  DOMAIN_MODEL_REGISTRATION_DIGEST_V3,
  MAX_MANIFEST_BYTES,
} from './manifest/model-manifest';
export type {
  ModelManifestV4,
  ProfileManifestState,
  ProjectionChainInputs,
  RegistrationCheck,
  RegistrationDigestInput,
  VerifiedManifest,
} from './manifest/model-manifest';
export { parseManifestUri, isValidManifestUri, DEFAULT_MAX_MANIFEST_URI_BYTES } from './manifest/manifest-uri';
export type { ManifestUri } from './manifest/manifest-uri';
export { isPublicAddress } from './manifest/address-policy';
export { canonicalJsonBytes, parseStrictJson } from './codec/canonical-json';
export type { CanonicalJsonValue } from './codec/canonical-json';
export { framedHashV1, framedV1Preimage } from './codec/domain-hash';
