// Platform abstraction
export { initPlatform, getPlatform } from "./platform/context";
export type {
  IStorage,
  ISecureStorage,
  IMessageCache,
  IPlatformConfig,
  PlatformDeps,
} from "./platform/types";

// Types - re-export everything from types/index
export {
  ACTIVITY_TYPES,
  formatTokenCount,
  baseNavItems,
  formatShortDate,
  sourceDisplayText,
  PLATFORM_TENANT_ID,
  LEGACY_TENANT_ID,
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SETTINGS,
  TENANT_SLUG_PATTERN,
  isInternalTenantId,
} from "./types/index";
export type {
  MessageItem,
  MessageItemInput,
  UploadedFile,
  ActivityGroup,
  RenderItem,
  SessionOwnerInfo,
  SessionParticipants,
  ApiSessionListItem,
  ApiSessionDetail,
  TokenUsage,
  ContextUsageData,
  PluginInstallData,
  NotificationData,
  MemoryRecallData,
  ApiTranscriptBlock,
  SessionSearchMatchKind,
  SessionSearchMatchRange,
  SessionSearchMatch,
  SessionSearchHit,
  SessionSearchResponse,
  WsBlockType,
  WsAskUserQuestion,
  WsEvent,
  AuthUser,
  LoginCredentials,
  SidebarLayoutPref,
  UserPreferences,
  TenantFeatureFlags,
  ModelItem,
  ModelGroup,
  ModelList,
  ChatSessionIndexItem,
  AppTab,
  SessionGroup,
  SessionListEntry,
  ScenarioMode,
  ScenarioRequirement,
  ScenarioRole,
  ScenarioSlot,
  ScenarioItem,
  ScenarioLibraryResponse,
  ScheduleAt,
  ScheduleEvery,
  ScheduleCron,
  CronSchedule,
  PayloadAgentTurn,
  PayloadSystemEvent,
  CronPayload,
  NotifyConfig,
  DingtalkSessionSummary,
  CronJobState,
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronRunLogEntry,
  CronServiceStatus,
  UserPermissions,
  UserInfo,
  CreateUserInput,
  UpdateUserInput,
  Tenant,
  CreateTenantInput,
  UpdateTenantInput,
  TenantSettings,
  LoginChannel,
  LoginEvent,
  LoginLogEntry,
  LoginLogQuery,
  LoginLogResponse,
  FileEntry,
  FileListResponse,
  FileSortKey,
  FileSortOrder,
  AgentProfile,
  AgentProfileDetail,
  SkillInfo,
  PlatformSkillExposure,
  TenantSkillMemberExposure,
  PlatformSkillSettings,
  TenantSkillSettings,
  PoolSkillInfo,
  TenantSkillInfo,
  TenantOwnSkillInfo,
  UserSkillInfo,
  MySkillsResponse,
  SkillPoolResponse,
  TenantSkillPoolResponse,
  TenantOwnSkillsResponse,
  CustomSkillsResponse,
  SkillImportResponse,
  SkillDocumentResponse,
  McpTransport,
  McpServerSummary,
  McpRiskLevel,
  McpSecretScope,
  McpSecretTarget,
  McpSecretRequirement,
  McpSecretStatus,
  MyMcpResponse,
  ManagedMcpServer,
  McpTemplate,
  McpTemplatesResponse,
  McpAdminServersResponse,
  McpDiagnosticTool,
  McpDiagnosticResponse,
} from "./types/index";
export { FILE_SORT_LABELS, buildScenarioPrompt } from "./types/index";
export { saveUserPreferences } from "./lib/preferencesApi";
export { GLOBAL_TENANT_ID } from "./types/index";

// Lib - constants
export {
  TOKEN_KEY,
  SESSION_STORAGE_KEY,
  INPUT_DRAFT_KEY,
  TTS_AUTOPLAY_KEY,
  MAX_UPLOAD_FILE_SIZE,
  MESSAGE_CACHE_TTL_MS,
} from "./lib/constants";

// Lib - refresh bus
export {
  registerRefresh,
  unregisterRefresh,
  refreshAll,
} from "./lib/refreshBus";

// Lib - auth fetch
export { authFetch, setOnUnauthorized } from "./lib/authFetch";

// Lib - 安全 JSON 解析（content-type 非 JSON 时抛带上下文错误）
export { parseJsonResponse } from "./lib/parseJsonResponse";

// Lib - activity reporter
export { reportActivity } from "./lib/activityReporter";
export type { ActivityLocation } from "./lib/activityReporter";

// Lib - WebSocket client
export { wsClient } from "./lib/wsClient";
export type {
  WsState,
  WsMessageHandler,
  WsStateHandler,
  WsChatMessage,
  WsRespondMessage,
  WsAbortMessage,
  WsResumeMessage,
  WsOutboundMessage,
  WsEnvelope,
} from "./lib/wsClient";

// Lib - sessions API (mapping functions)
export { mapSessionDetailToMessages } from "./lib/sessionsApi";
export { searchSessions } from "./lib/searchApi";
export type { SearchSessionsParams } from "./lib/searchApi";
export { mergeServerMessagesWithLocalTail } from "./lib/sessionMerge";

// Lib - groups API
export {
  fetchGroups,
  fetchGroupSessions,
  createGroup,
  deleteGroup,
  updateGroup,
  addSessionsToGroup,
  removeSessionsFromGroup,
  fetchGroupSorting,
  saveGroupSorting,
} from "./lib/groupsApi";
export type {
  ApiSessionGroup,
  GroupSortingMode,
  GroupSortingPref,
} from "./lib/groupsApi";

// Lib - agents API
export {
  fetchAgentProfile,
  fetchAllAgentProfiles,
  updateAgentProfile,
  fetchPersona,
  updatePersona,
  fetchAgentMemory,
  updateAgentMemory,
  uploadAgentAvatar,
  isEmojiAvatar,
  getAgentAvatarUrl,
} from "./lib/agentsApi";

// Lib - tenant-scoped company.md API
export {
  fetchTenantCompanyInfo,
  updateTenantCompanyInfo,
} from "./lib/tenantsApi";

// Lib - skills API
export {
  fetchMySkills,
  updateMySelections,
  deleteMySkill,
  fetchUserSkills,
  updateUserSelections,
  fetchSkillPool,
  updatePoolVisibility,
  updatePoolSkillSettings,
  fetchTenantSkillPool,
  updateTenantSkillSelections,
  updateTenantSkillSettings,
  fetchCustomSkills,
  promoteSkill,
  deleteCustomSkill,
  fetchCustomSkillDocument,
  updateCustomSkillDocument,
  importMySkill,
  importPoolSkill,
  importTenantSkill,
  fetchTenantOwnSkills,
  updateTenantOwnSkillSettings,
  fetchTenantOwnSkillDocument,
  updateTenantOwnSkillDocument,
  deleteTenantOwnSkill,
  promoteSkillToTenant,
  promoteTenantSkillToPool,
  syncSkills as syncSkillsApi,
} from "./lib/skillsApi";

// Lib - platform tool controls API
export {
  fetchToolControlsConfig,
  updateToolControlsConfig,
} from "./lib/toolControlsApi";
export type {
  ToolCatalogItem,
  ToolControlConfig,
  ToolControlsAdminResponse,
  ToolControlsConfig,
  UpdateToolControlsRequest,
  WebSearchProvider,
  WebToolsConfig,
  WebToolsEgressConfig,
  WebToolsFetchConfig,
  WebToolsSearchConfig,
} from "./lib/toolControlsApi";

// Lib - persona parser
export { parsePersona } from "./lib/parsePersona";

// Lib - tool display utilities (name resolution + description)
export {
  extractToolDescription,
  getToolDisplayLabel,
  getToolDisplayInfo,
  resolveDisplayToolName,
  isSkillTool,
  normalizeInternalToolNameStrategy,
  resolveMcpToolNameStrategy,
  resolveSkillToolNameStrategy,
  composeToolNameResolver,
} from "./lib/toolDisplay";
export type {
  ResolveToolNameParams,
  ToolNameResolver,
  ToolNameStrategy,
  ToolNameStrategyParams,
  ToolDisplayInfo,
} from "./lib/toolDisplay";

// Lib - format utilities
export { truncateContent, formatJson, formatFileSize } from "./lib/format";

// Lib - coordinate transform (WGS-84 → GCJ-02)
export { wgs84ToGcj02 } from "./lib/coordTransform";

// Lib - file utilities (cross-platform pure functions)
export {
  parseToolResult,
  MD_PATH_RE,
  HTML_PATH_RE,
  resolveImageSrc,
  getPreviewFileType,
} from "./lib/fileUtils";
export type {
  ParsedImage,
  ParsedToolResult,
  PreviewFileType,
} from "./lib/fileUtils";

// Lib - file type visual
export { getFileTypeVisual } from "./lib/fileTypeVisual";
export type { FileTypeCategory, FileTypeVisual } from "./lib/fileTypeVisual";

// Lib - runtime error messages
export {
  DEFAULT_RUNTIME_FAILURE_MESSAGE,
  MODEL_REQUEST_FAILURE_MESSAGE,
  formatRuntimeFailureMessage,
  isModelRequestFailure,
} from "./lib/runtimeErrorMessage";

// Lib - message grouping (pure function)
export { groupMessages } from "./lib/groupMessages";

// Lib - WS event processor (pure functions)
export {
  processWsEvent,
  finalizeRunningSubagents,
  finalizeStreamingMessages,
  removeRuntimeStatusMessages,
  resolvePlanModeDisplay,
  upsertRuntimeStatusMessage,
} from "./lib/wsEventProcessor";
export type {
  MessagesController,
  WsProcessingContext,
  WsBlockState,
} from "./lib/wsEventProcessor";

// Hooks
export { useConnectionState } from "./hooks/useConnectionState";
export type {
  ConnectionState as LegacyConnectionState,
  ConnectionAction as LegacyConnectionAction,
} from "./hooks/useConnectionState";
export {
  useGroups,
  clearGroupsCache,
  applyGroupOrder,
  sortGroupsBySortingPref,
  getSortedGroupItems,
} from "./hooks/useGroups";
export type { GroupsEditingState, GroupMenuItem } from "./hooks/useGroups";
export { useGroupedSessions } from "./hooks/useGroupedSessions";

// Store
export {
  getChatStore,
  useChatStore,
  resetChatStore,
  INITIAL_BLOCK_STATE,
} from "./store/index";
export type {
  ChatStore,
  ChatStoreApi,
  ConnectionState,
  ConnectionAction,
} from "./store/index";
export { switchSession, newSession } from "./store/actions/switchSession";
export { sendChatViaWs } from "./store/actions/sendChat";
export type { SendChatOptions } from "./store/actions/sendChat";
export {
  detachFromStream,
  cancelActiveStream,
  subscribeToActiveStream,
} from "./store/actions/streamControl";
export {
  setupWsHandler,
  setVoiceCallback,
  setGroupsRefreshCallback,
  setOnNewSession,
} from "./store/actions/wsHandler";
export {
  handleReconnected,
  handleDisconnecting,
  handleDisconnected,
  resetWatchdog,
  clearWatchdog,
  onStreamEvent,
} from "./store/actions/wsReconnect";
export {
  loadSessions,
  loadMoreSessions,
  loadSessionDetail,
  refreshCurrentSession,
  fetchTokenUsage,
  debouncedLoadSessions,
} from "./store/actions/sessionLoader";

export {
  fetchMcpTemplates,
  fetchMyMcp,
  updateMyMcpSelections,
  bindMyMcpSecret,
  bindAdminMcpSecret,
  diagnoseMyMcp,
  fetchMcpAdminServers,
  upsertMcpServer,
  deleteMcpServer,
  upsertMyMcpServer,
  deleteMyMcpServer,
} from "./lib/mcpApi";
