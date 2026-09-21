export const SDK_WIRE_VERSION = 'SDK_WIRE_V1' as const;

export { TrueOpenError, dataError } from './errors/errors';
export type { ErrorFamily, TrueOpenErrorOptions } from './errors/errors';

export type { TaskState, TaskPhase, TaskVerdict } from './types/task';
export type {
  ChallengeKind,
  OptimisticFinalityStatus,
  EvidenceRequestStatus,
  ChallengeOutcome,
} from './types/challenge';
export type { CredentialUsage, OutputRef, RawChunk, VerifiedChunk, ChunkBoundary } from './types/dataplane';

export { ChunkVerifier } from './output/chunk-verifier';

export { phaseToState } from './task/phase-map';

export { u64ToString, stringToU64, bytesToBase64, base64ToBytes } from './codec/wire';

export type { TaskFailureClass, StreamStateView, SettlementFinalityView, SettlementView, ChainTaskSnapshot, InferReceiptView } from './types/node';
export { CHAIN_ENABLED_CHALLENGE_KINDS, isChallengeKindEnabled } from './types/node';

export type {
  ChainReader,
  ChainClient,
  CreateSessionResult,
  CancelOrderInput,
  CancelOrderResult,
  UserChallengeInput,
  UserChallengeResult,
} from './transport/chain-client';
export { RestChainReader } from './transport/rest-chain-reader';
export type { FetchLike, FetchResponse, RestChainReaderOptions } from './transport/rest-chain-reader';

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
export { nexusIngressTransport, nexusTransportOptions, PinnedHttpsAgent, PlaintextFallbackAgent, tlsPubkeyHashOfCertificate, isTLSPubkeyMismatch, isPlaintextServerError, tlsPubkeyHashRequiredByEnv, NEXUS_TLS_PUBKEY_MISMATCH } from './transport/nexus-tls';
export type { NexusTransportPolicy } from './transport/nexus-tls';
export type { NexusTransportOptions } from './transport/nexus-tls';
export type { EndpointLike, AcceptedLike, FanOutResult, FanOutResultItem } from './transport/fan-out-submit';

export { ProtoWriter, ProtoReader } from './codec/protobuf';
export {
  TYPE_URL,
  encodeMsgCreateSession,
  encodeMsgCancelOrder,
  encodeMsgUserChallenge,
  decodeMsgCreateSessionResponse,
  decodeMsgCancelOrderResponse,
  decodeMsgUserChallengeResponse,
} from './transport/task-msgs';
export type {
  MsgCreateSession,
  MsgCreateSessionResponse,
  MsgCancelOrder,
  MsgCancelOrderResponse,
  MsgUserChallenge,
  MsgUserChallengeResponse,
} from './transport/task-msgs';

export { taskRegistry } from './transport/cosmjs-registry';
export { CosmjsChainWriter, composeChainClient } from './transport/cosmjs-chain-writer';
export type { TxBroadcaster, CosmjsChainWriterOptions } from './transport/cosmjs-chain-writer';

export { createTrueOpenChainClient, connectTrueOpenChainClient } from './transport/trueopen-chain-client';
export type {
  CreateTrueOpenChainClientConfig,
  ConnectTrueOpenChainClientOptions,
} from './transport/trueopen-chain-client';

export { reduce, initialState } from './state/local-state';
export type { LocalTaskState, TaskEvent, AttentionIssue } from './state/local-state';
export { reconcile } from './state/reconcile';
export type { ChainTaskView } from './state/reconcile';
export { settlementFinalityToChainView } from './state/finality-map';

export { SessionManager } from './session/session-manager';
export type { SessionHandle } from './session/session-manager';

export { validateModelId, isValidModelId, MODEL_ID_GRAMMAR } from './order/model-id';

// ---- Frozen TaskOrderV2 / SignedOrderV2 (wire v0.4.1) ----
export {
  taskOrderHash,
  taskOrderHashHex,
  DOMAIN_TASK_ORDER_V2,
  TASK_ORDER_SCHEMA_VERSION_V2,
  GENERATION_PARAMS_SCHEMA_VERSION_V1,
  TASK_TYPE,
  DEADLINE_LATENCY_CLASS,
} from './order/task-order';
export type {
  TaskOrderV2,
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
} from './codec/domain-hash';
export { canonicalOperatorAddressBytes } from './codec/address';
export { SIGN_DOMAINS } from './codec/domains';
export {
  orderEnvelopeSigningBytes,
  deriveTaskId,
  cancelOrderSigningBytes,
  userChallengeSigningBytes,
} from './order/order-signing';

// ---- EVM-style identity and EIP-712 (on-chain accounts use this scheme from wire v0.4.1) ----
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
  secp256k1Address,
  secp256k1AddressMatches,
} from './signer/secp256k1';
export type { CosmosSecp256k1Signer, Secp256k1DigestSigner } from './signer/secp256k1';
export { signDetached, signOrderEnvelope, signCancelOrder, signUserChallenge } from './signer/order-signer';

export { frame4, i64be, u64be } from './codec/frame';
export {
  SDK_REQUEST_DOMAIN,
  sdkRequestSignBytes,
  bodyDigest,
  submitOrderBodyDigest,
  openTaskBodyDigest,
  fetchOutputRefBodyDigest,
  getTaskEventsBodyDigest,
  refreshCredentialBodyDigest,
  prepareChallengeBodyDigest,
  subscribeOutputBodyDigest,
  ackOutputBodyDigest,
  signSdkRequestEnvelope,
} from './transport/sdk-request-envelope';
export type { SdkRequestEnvelopeFields, SignedSdkRequestEnvelope, AccessLevelName } from './transport/sdk-request-envelope';

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
export type { OpenTaskInput, OpenTaskAck, SubmitOrderAck, TaskStatusView, IngressAuth } from './transport/ingress-client';

// ---- MMR commitment for streamed output (ADR-0017, wired into both the SubscribeOutput and retrieval paths) ----
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

export { TrueOpenClient } from './client';
export type {
  TrueOpenClientConfig,
  OpenTaskParams,
  OpenTaskResult,
  ChallengeParams,
  OutputStreamSource,
  StreamOutputParams,
  ConfirmOutputParams,
} from './client';
