/**
 * TASK-331 mobile V1 public surface.
 * Keep these named exports explicit so aliases and cross-platform contracts remain stable.
 */

export * from './telemetry/mobileTelemetry';

export * from './lib/ttsCapability';

export {
  ARTIFACT_TEXT_MAX_BYTES,
  ARTIFACT_VIEW_POLICY_VERSION,
  artifactViewerError,
  createArtifactViewerState,
  evaluateArtifactPolicy,
  isArtifactGrantExpired,
  parseArtifactReadGrant,
  reduceArtifactViewer,
} from './lib/artifactViewModel';

export type {
  ArtifactPolicyInput,
  ArtifactPolicyResult,
  ArtifactReadGrant,
  ArtifactViewKind,
  ArtifactViewModel,
  ArtifactViewerError,
  ArtifactViewerErrorCode,
  ArtifactViewerEvent,
  ArtifactViewerState,
  ArtifactViewPosition,
} from './lib/artifactViewModel';

export {
  AGENT_TARGET_BINDING_VERSION,
  NO_AVAILABLE_AGENT_TARGET,
  adaptAgentTargetCatalogResponse,
  agentTargetAuditFields,
  isAgentTargetAvailable,
  parseAgentTarget,
  resolveNewSessionAgentTarget,
  resolveTargetSessionAction,
  sameAgentTarget,
} from './lib/agentTarget';

export type {
  AgentTarget,
  AgentTargetAvailability,
  AgentTargetIdentitySnapshot,
  AgentTargetCatalog,
  AgentTargetCatalogAdapterResult,
  AgentTargetOption,
  AgentTargetSelection,
  AgentTargetUnavailableReason,
  AgentTargetUnavailableReasonCode,
} from './lib/agentTarget';

export {
  canCommitAgentTargetTransition,
  collectAgentTargetTransitionImpacts,
  createAgentTargetTransition,
  evaluateAgentTargetTransition,
  reduceAgentTargetTransition,
} from './lib/agentTargetTransition';

export type {
  AgentTargetSwitchChoice,
  AgentTargetTransitionDecision,
  AgentTargetTransitionEvent,
  AgentTargetTransitionImpact,
  AgentTargetTransitionInput,
  AgentTargetTransitionState,
  PersistentSessionAgentTarget,
} from './lib/agentTargetTransition';

export {
  beginSessionListRefresh,
  compareSessionListItems,
  createSessionListPagerState,
  mergeLegacyOffsetSessionPage,
  mergeSessionListPage,
  reduceSessionListInteraction,
  selectActiveInteraction,
  selectSessionListItems,
  tombstoneSessionListItem,
  upsertSessionListItem,
} from './lib/sessionListPager';

export type {
  SessionListInteractionEvent,
  SessionListPagerState,
} from './lib/sessionListPager';

export {
  createSessionMetadataState,
  reduceSessionMetadata,
  sessionMetadataEventFromWs,
} from './lib/sessionMetadataReducer';

export type {
  CanonicalSessionMetadata,
  SessionMetadataAction,
  SessionMetadataPatch,
  SessionMetadataState,
} from './lib/sessionMetadataReducer';

export {
  capabilityStatusToCanonicalError,
  evaluateCapability,
  reduceCapabilityStatus,
  unknownServerCapability,
  isSensitiveCapabilityAllowed,
  presentCapability,
} from './lib/authConnectionCapability';

export type {
  AuthConnectionCapabilityStatus,
  CapabilityAction,
  CapabilityChannel,
  CapabilityEvent,
  CapabilityKind,
  CapabilityMode,
  CapabilityObservation,
  CapabilityReasonCode,
  CapabilityPresentation,
} from './lib/authConnectionCapability';

export {
  fetchAuthConnectionCapability,
} from './lib/capabilityApi';

export {
  assertNoLocalVoiceReference,
  createVoiceIntent,
  reduceVoiceIntent,
  selectVoiceRenderCard,
  VOICE_MAX_DURATION_MS,
  VOICE_MAX_FILE_BYTES,
  VOICE_MIME_TYPES,
  VOICE_MIN_DURATION_MS,
} from './lib/voiceRecording';

export type {
  VoiceErrorCode,
  VoiceEvent,
  VoiceIntent,
  VoiceRenderCard,
  VoiceStatus,
  VoiceTranscriptMetadata,
} from './lib/voiceRecording';

export {
  assertNoLocalAttachmentReference,
  createAttachmentUploadIntent,
  recoverAttachmentUploadIntent,
  reduceAttachmentUpload,
  selectAttachmentRenderCard,
  validateAttachmentSelection,
} from './lib/attachmentUpload';

export type {
  AttachmentRenderCard,
  AttachmentSelectionMetadata,
  AttachmentUploadEvent,
  AttachmentUploadFenceReason,
  AttachmentUploadIntent,
  AttachmentUploadStatus,
  AttachmentValidationIssue,
  AttachmentValidationResult,
} from './lib/attachmentUpload';

export {
  INCOMING_SHARE_DRAFT_TTL_MS,
  INCOMING_SHARE_MAX_ITEMS,
  INCOMING_SHARE_MAX_TOTAL_BYTES,
  INCOMING_SHARE_STAGING_SAFETY_BYTES,
  assertIncomingSharePathFree,
  createIncomingShare,
  incomingShareKind,
  incomingShareUploadedAttachments,
  mergeIncomingShareText,
  projectIncomingShareStatus,
  reduceAttachmentDraft,
  shareError,
  validateIncomingShareMagic,
  validateIncomingShareSelection,
} from './lib/incomingShare';

export type {
  AttachmentDraft,
  AttachmentDraftEvent,
  IncomingShare,
  IncomingShareError,
  IncomingShareErrorCode,
  IncomingShareKind,
  IncomingShareSelection,
  IncomingShareStatus,
} from './lib/incomingShare';

export {
  buildInteractionResponseRequest,
  canInteract,
  createInteractionReducerState,
  createInteractionRequestId,
  interactionKey,
  isInteractionSubmitting,
  reduceInteraction,
  selectInteraction,
} from './lib/interactionProtocol';

export {
  isCanonicalPendingInteractionTimelineItem,
  redactInteractionCredentials,
  selectCanonicalInteractionFinalStatus,
  validateAskUserAnswers,
  selectCanonicalInteractionZone,
} from './lib/activeInteraction';

export type {
  ActiveInteractionQuestion,
  ActiveInteractionSummary,
  AskUserValidationResult,
  CanonicalInteractionFinalStatus,
  CanonicalInteractionKind,
  CanonicalInteractionReceipt,
  CanonicalInteractionZoneItem,
  CanonicalInteractionZoneState,
  SelectCanonicalInteractionZoneInput,
} from './lib/activeInteraction';

export type {
  InteractionAck,
  InteractionAckStatus,
  InteractionEvent,
  InteractionIdentity,
  InteractionOutcome,
  InteractionPhase,
  InteractionReducerState,
  InteractionResponse,
  InteractionResponseRequest,
  InteractionState,
} from './lib/interactionProtocol';

export type {
  TrustedUrlKind,
} from './platform/types';

export type {
  OrgAgentMineResponse,
  MessageAttachmentDisplay,
  SessionListActiveInteraction,
  SessionListPage,
  WsSyncOverflowRecovery,
  WsSyncPendingInteractionSnapshot,
  WsSyncRuntimeSnapshot,
  WsSyncSessionSnapshot,
} from './types/index';

export {
  CACHE_KEY_PREFIX,
  CACHE_MAX_BACKUP_BYTES,
  CACHE_MAX_JSON_BYTES,
  CACHE_MAX_KEY_LENGTH,
  CACHE_SCHEMA_VERSION,
  CacheKeyBuilder,
  CacheSchemaError,
  KeyValueAtomicCacheAdapter,
  assertCacheSendAllowed,
  cacheDigest,
  cacheKeyForIdentity,
  canonicalSerialize,
  createCacheBackup,
  createCacheSyncGate,
  markCacheFullSyncComplete,
  markCacheRestored,
  migrateKnownLegacyCache,
  parseCacheJson,
  restoreCacheBackup,
  verifyCacheBackup,
} from './lib/cacheSchemaV2';

export type {
  AtomicCacheAdapter,
  CacheBackup,
  CacheBackupEntry,
  CacheBackupManifest,
  CacheEntryInput,
  CacheManifestEntry,
  CacheMigrationResult,
  CacheKeyValueBackend,
  CacheOwner,
  CacheSyncGate,
  LegacyCacheRecord,
  ParsedCacheKey,
  VerifiedCacheBackup,
} from './lib/cacheSchemaV2';

export {
  DEFAULT_LOCAL_LOCK_BACKGROUND_MS,
  INITIAL_LOCAL_APP_LOCK_STATE,
  SYSTEM_PROMPT_GRACE_MS,
  canUseSensitiveTransport,
  localAppLockReducer,
} from './lib/localAppLock';

export type {
  LocalAppAccess,
  LocalAppLockEvent,
  LocalAppLockState,
} from './lib/localAppLock';

export {
  INITIAL_IDENTITY_STATE,
  identityReducer,
  identityScope,
  migrateOwnedLegacyValue,
  samePrincipal,
  scopedSensitiveKey,
  selectGeneration,
  selectIdentity,
  selectPrincipal,
} from './lib/identity';

export type {
  AuthPrincipal,
  BoundaryIdentity,
  IdentityEvent,
  IdentityState,
  OwnedLegacyValue,
} from './lib/identity';

export {
  runIdentityBoundary,
} from './lib/identityBoundary';

export type {
  IdentityBoundaryHooks,
} from './lib/identityBoundary';

export {
  AUTH_LIFECYCLE_JOURNAL_KEY,
  AUTH_SESSION_KEY,
  AUTH_TERMINATION_STEPS,
  AuthLifecycleBusyError,
  AuthLifecycleTransaction,
  createStorageJournalStore,
} from './lib/authLifecycle';

export type {
  AuthLifecycleJournal,
  AuthLifecycleJournalStore,
  AuthLifecycleOperation,
  AuthLifecycleStatus,
  AuthLoginEffects,
  AuthSessionBinding,
  AuthTerminationEffects,
  AuthTerminationStep,
} from './lib/authLifecycle';

export {
  authFetchForLocalUnlockValidation,
  fenceAuthSideEffects,
  isSensitiveTransportAllowed,
  setSensitiveTransportAllowed,
} from './lib/authFetch';

export {
  ATTACHMENT_ID_PATTERN,
  CHAT_SUBMISSION_V1_CAPABILITY,
  CHAT_SUBMISSION_VERSION,
  canonicalChatAttachmentToDisplay,
  isValidAttachmentId,
  normalizeChatSubmission,
  normalizeChatSubmissionAttachment,
  normalizeChatSubmissionAttachments,
  parseCanonicalChatSubmission,
  toCanonicalChatSubmissionWireMessage,
} from './lib/chatSubmission';

export type {
  CanonicalChatAttachment,
  CanonicalChatAttachmentDisplay,
  CanonicalChatSubmission,
  CanonicalChatSubmissionWireMessage,
  CanonicalChatTarget,
  CanonicalVoiceSubmission,
  ChatClientCapability,
  ChatDeliveryMode as CanonicalChatDeliveryMode,
  ChatSubmissionAttachmentInput,
  ChatSubmissionInput,
  ChatSubmissionIssue,
  ChatSubmissionIssueCode,
  ChatSubmissionResult,
} from './lib/chatSubmission';

export {
  DEFAULT_LIFECYCLE_POLICY,
  createCanonicalLifecycleState,
  lifecycleAllowsDispatch,
  lifecycleBudgetUsage,
  presentCanonicalLifecycle,
  reduceCanonicalLifecycle,
} from './lib/appLifecycle';

export type {
  CanonicalAppState,
  CanonicalLifecycleEffect,
  CanonicalLifecycleEffectKind,
  CanonicalLifecycleEvent,
  CanonicalLifecycleInput,
  CanonicalLifecyclePhase,
  CanonicalLifecyclePolicy,
  CanonicalLifecycleState,
  CanonicalRecoveryStep,
  CanonicalWsLifecycleState,
  InternetReachability,
  LifecycleFence,
  LifecyclePresentation,
} from './lib/appLifecycle';

export {
  executeCanonicalLifecycleEffect,
} from './lib/appLifecycleEffects';

export type {
  CanonicalLifecycleEffectDependencies,
  CanonicalLifecycleEffectResult,
} from './lib/appLifecycleEffects';

export {
  PENDING_SUBMISSION_VERSION,
  authoritativeQueueOnly,
  recoverDurablePending,
  settlePendingAck,
} from './lib/pendingSubmissionRecovery';

export type {
  AuthoritativePendingAck,
  DurablePendingAttachmentSelection,
  DurablePendingStatus,
  DurablePendingSubmission,
  PendingRecoveryDecision,
  PendingRecoveryVersion,
} from './lib/pendingSubmissionRecovery';

export {
  CHAT_QUEUE_SNAPSHOT_VERSION,
  chatQueueItemKey,
  chatQueueReducer,
  chatQueueStatusToMessageStatus,
  createChatQueueState,
  hydrateChatQueueSnapshot,
  isChatQueueTerminalStatus,
  reduceChatQueueEvent,
  selectCancellableChatQueueItems,
  selectChatQueueItem,
  selectChatQueueItemLiveness,
  selectChatQueueItems,
  selectChatQueueLocalIntents,
  selectChatQueueMessageStatus,
  selectPendingChatQueueItems,
  selectRunningChatQueueItem,
} from './lib/chatQueue';

export type {
  ChatQueueAttachment,
  ChatQueueDeliveryMode,
  ChatQueueItem,
  ChatQueueItemPatch,
  ChatQueueLocalIntent,
  ChatQueueReducerEvent,
  ChatQueueSnapshot,
  ChatQueueState,
  ChatQueueStatus,
  ChatQueueTerminalStatus,
} from './lib/chatQueue';

export {
  chatQueueReducerEventsFromWsEvent,
} from './lib/chatQueueWs';

export {
  compareHistorySemanticOrder,
  createHistoryPagerState,
  inferHistorySemanticOrder,
  mergeHistoryValues,
  reduceHistoryPager,
  selectHistoryItems,
  toHistorySemanticItem,
} from './lib/historyPager';

export type {
  HistoryPage,
  HistoryPagerAction,
  HistoryPagerState,
  HistorySemanticItem,
  HistorySemanticOrder,
} from './lib/historyPager';

export {
  captureHistoryAnchor,
  restoreHistoryAnchor,
} from './lib/historyAnchor';

export type {
  HistoryAnchor,
  HistoryAnchorRestore,
  HistoryLayoutSnapshot,
} from './lib/historyAnchor';

export {
  createSessionSeenCommit,
  selectSessionUnread,
} from './lib/sessionUnread';

export type {
  SemanticUnreadKind,
  SessionSeenState,
  SessionUnreadInput,
  SessionUnreadSelection,
  UnreadSemanticItem,
} from './lib/sessionUnread';

export {
  selectSessionRuntime,
} from './lib/sessionRuntime';

export type {
  CanonicalSessionRuntimeState,
  SessionRuntimeSelection,
  SessionRuntimeSelectorInput,
} from './lib/sessionRuntime';

export {
  RUN_LIVENESS_VERSION,
  UNKNOWN_RUN_LIVENESS,
  createRunLivenessProjectionState,
  mergeRunLiveness,
  normalizeRunLiveness,
  reduceRunLivenessProjection,
  selectProjectedRunLiveness,
  selectRunLivenessPresentation,
  selectRunLivenessRecovery,
} from './lib/runLiveness';

export type {
  RunLiveness,
  RunLivenessPresentation,
  RunLivenessProjectionAction,
  RunLivenessProjectionState,
  RunLivenessRecoveryAction,
  RunLivenessState,
  RunRecoveryGate,
  RunRecoverySelection,
} from './lib/runLiveness';

export {
  canSendChatIntent,
  captureChatClientFence,
  chatClientReducer,
  createChatClientState,
  isChatClientFenceCurrent,
  reduceChatClientState,
  selectChatClientQueue,
  selectChatClientQueueItems,
  selectChatClientRunLiveness,
} from './lib/chatClientState';

export type {
  ChatClientAction,
  ChatClientState,
  ChatSendGate,
} from './lib/chatClientState';

export {
  createSyncRecoveryState,
  reduceSyncRecovery,
  resetSyncRecovery,
  selectAppliedInteractionEvents,
  selectAppliedQueueEvents,
  selectAppliedRuntimeEvents,
  selectAppliedSessionUserEvents,
  selectFullRefreshRequired,
  selectRecoveredInteractions,
  selectRecoveredQueue,
  selectRecoveredRuntime,
  selectRecoveredSession,
  selectSyncRequest,
  syncRecoveryReducer,
} from './lib/syncRecovery';

export type {
  AppliedSyncEvent,
  FullRefreshRequired,
  SyncEventEnvelope,
  SyncInteractionProjection,
  SyncRecoveryAction,
  SyncRecoveryPhase,
  SyncRecoveryState,
  SyncRequest,
  SyncRuntimeProjection,
  SyncSessionProjection,
} from './lib/syncRecovery';

export type {
  CanonicalWsChatMessage,
  LegacyWsChatMessage,
  LegacyWsChatAttachment,
  WsQueueSnapshotMessage,
  WsAttachActiveStreamMessage,
  WsSyncMessage,
} from './lib/wsClient';

export {
  createActivityMessageProjectionState,
  reduceActivityMessageProjection,
  selectModerationForTarget,
  selectProjectedMessages,
} from './lib/activityMessageProjection';

export type {
  ActivityMessageProjectionEvent,
  ActivityMessageProjectionState,
  ModerationOutcome,
  ModerationProjection,
  ProjectionActivityStatus,
  ProjectionDomain,
} from './lib/activityMessageProjection';

export {
  adaptWsEventToActivityMessageProjection,
} from './lib/wsActivityMessageProjection';

export {
  RENDER_MODEL_VERSION,
  renderSemanticSignature,
  selectRenderModel,
} from './lib/renderModel';

export {
  CANONICAL_ERROR_KINDS,
  canonicalErrorMapper,
  createOneTapRecovery,
  decideCanonicalRetry,
  executeCanonicalRecovery,
  mapCanonicalError,
  presentCanonicalError,
  restoreCanonicalSessionFailure,
  serializeCanonicalSessionFailure,
} from './lib/canonicalError';

export type {
  CanonicalError,
  CanonicalErrorInput,
  CanonicalErrorKind,
  CanonicalErrorPresentation,
  CanonicalErrorSource,
  CanonicalErrorTone,
  CanonicalRecoveryAction,
  CanonicalRecoveryActionKind,
  CanonicalRecoveryContext,
  CanonicalRecoveryResult,
  RetryDecision,
  RetryPolicyInput,
} from './lib/canonicalError';

export {
  PRESENTATION_STRUCTURE_BUDGET,
  SHARED_PRESENTATION_PRESENTERS,
  canShowRawPresentation,
  listSharedPresentationKinds,
  presentationSemanticSignature,
  selectBusinessStepPresentation,
  selectCanonicalErrorPresentation,
  selectErrorPresentation,
  selectPresentationCardViewModel,
  selectPresentationViewModel,
  selectSharedPresentation,
  selectToolPresentation,
} from './lib/presentationPresenter';

export {
  CARD_VIEW_MODEL_VERSION,
  cardSemanticSignature,
  sanitizeCardDetail,
  selectCardViewModelFromRenderItem,
  selectInteractionCardViewModel,
  selectToolCardViewModel,
  selectUnknownCardViewModel,
} from './lib/cardViewModel';

export type {
  RawPresentationGate,
  SharedPresentation,
  SharedPresentationKind,
  SharedPresentationOutcome,
  SharedPresentationPresenterInput,
  SharedPresentationRecoveryAction,
  SharedPresentationStatus,
} from './lib/presentationPresenter';

export type {
  ApprovalSurface,
  CardAccessibilityViewModel,
  CardActionKind,
  CardActionViewModel,
  CardKind,
  CardOutcomeViewModel,
  CardQuestionOptionViewModel,
  CardQuestionViewModel,
  CardStatus,
  CardTextDetail,
  CardViewModel,
  InteractionCardPresenterInput,
  InteractionCardStatus,
  InteractionQuestionInput,
  ToolCardPresenterInput,
  ToolCardStatus,
} from './lib/cardViewModel';

export {
  adaptLegacyInteractionState,
} from './lib/legacyCardAdapter';

export type {
  RenderAccessibility,
  RenderActionCapabilities,
  RenderContentSegment,
  RenderErrorDomain,
  RenderModel,
  RenderModelInput,
  RenderRetryability,
  RenderSource,
  RenderTimelineItem,
  RenderTimelineItemKind,
  RenderTimelineRole,
  RenderTimelineStatus,
  RuntimeTimelineProjectionItem,
} from './lib/renderModel';

export {
  setSyncRecoveryCallbacks,
} from './store/actions/wsHandler';

export type {
  SyncRecoveryCallbacks,
} from './store/actions/wsHandler';

export {
  OAUTH_CALLBACK_TRANSACTION_TTL_MS,
  constantTimeEqual,
  normalizeCallbackBase,
  parseOAuthCallbackUrl,
  validateOAuthCallback,
} from './lib/oauthCallbackBridge';

export type {
  NativeOAuthStartBinding,
  OAuthCallbackIdentity,
  OAuthCallbackPayload,
  OAuthCallbackTransaction,
  OAuthCallbackValidation,
} from './lib/oauthCallbackBridge';

export * from './mobileCompatibility/policy';

export * from './mobileCompatibility/contracts';
