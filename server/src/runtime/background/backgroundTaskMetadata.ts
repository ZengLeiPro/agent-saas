import type { ChannelContext } from '../../types/index.js';
import type { SandboxWorkloadWireDescriptor } from '../../agent/toolRuntime.js';
import { isModelOutputTransactionMode, resolveModelOutputTransactionMode } from '../modelOutputTransaction.js';
import type { RunRecord } from '../runStore.js';
import { deriveRuntimeIsolationRequirement, type RuntimeIsolationRequirement } from '../runtimeIsolationEvidence.js';
import { parseSandboxResources, type SandboxResources } from '../sandboxProfile.js';

export interface BackgroundTaskDwsCompletionRoute {
  accountId: string;
  profileId: string;
  corpId: string;
  dingtalkUserId: string;
  conversationId: string;
  eventType: 'user_im_message_receive_at' | 'user_im_message_receive_o2o_all';
  messageId?: string;
  senderOpenDingtalkId?: string;
}

export interface LegacyBackgroundTaskDwsCompletionRoute {
  accountId: string;
  conversationId: string;
  eventType: 'user_im_message_receive_at' | 'user_im_message_receive_o2o_all';
  messageId?: string;
  senderOpenDingtalkId?: string;
}

export type ParsedBackgroundTaskDwsCompletionRoute =
  | { version: 'exact'; route: BackgroundTaskDwsCompletionRoute }
  | { version: 'legacy'; route: LegacyBackgroundTaskDwsCompletionRoute }
  | { version: 'invalid' };

interface CommonBackgroundTaskMetadata {
  parentRunId: string;
  parentSessionId: string;
  /**
   * 顶层会话 ID（per-session Sandbox，决策 7）。
   * ⚠️ 不能用 `parentSessionId` 代替：后台任务存在三层套娃
   * （顶层 → bg task 的 `sub-` 会话 → 其内部再派生的 subagent `sub-` 会话），
   * 在 execute 阶段 `parentSessionId` 指向的是中间层而非顶层。
   */
  topLevelSessionId?: string;
  parentToolCallId: string;
  shortTaskId?: string;
  description: string;
  orgAgentId?: string;
  executionMode?: 'direct' | 'dispatcher';
  executionRole?: 'worker';
  dwsCompletionRoute?: BackgroundTaskDwsCompletionRoute;
  legacyDwsCompletionRoute?: LegacyBackgroundTaskDwsCompletionRoute;
  dwsCompletionRouteVersion?: ParsedBackgroundTaskDwsCompletionRoute['version'];
  modelRef: string;
  cwd: string;
  workspaceId: string;
  mountSubPath?: string;
  sandboxScopeId?: string;
  workOrderId?: string;
  attemptId?: string;
  attemptNo?: number;
  parentAttemptId?: string;
  sharedReadOnlySubPath?: string;
  sandboxResources?: SandboxResources;
  workload?: SandboxWorkloadWireDescriptor;
  sandboxPolicy?: { denyRead: string[] };
  timezone?: string;
  parentChannel: ChannelContext['channel'];
  parentOutputTransactionMode: NonNullable<ChannelContext['outputTransactionMode']>;
  runtimeIsolationRequirement?: RuntimeIsolationRequirement;
  orgAgentChannel?: NonNullable<ChannelContext['orgAgentChannel']>;
}

export interface BackgroundAgentTaskMetadata extends CommonBackgroundTaskMetadata {
  taskType: 'agent';
  outputTransactionMode: NonNullable<ChannelContext['outputTransactionMode']>;
  basePrompt?: string;
  prompt: string;
  agentType: 'general' | 'explore';
  includeCompanyInfo: boolean;
}

export interface BackgroundCommandTaskMetadata extends CommonBackgroundTaskMetadata {
  taskType: 'command';
  commandHash: string;
  commandPreview: string;
  timeoutMs: number;
}

export type BackgroundTaskMetadata = BackgroundAgentTaskMetadata | BackgroundCommandTaskMetadata;

export function parseBackgroundTaskMetadata(record: RunRecord): BackgroundTaskMetadata | null {
  const value = record.metadata;
  if (value?.backgroundTask !== true) return null;

  const parentRunId = metadataString(value, 'parentRunId');
  const parentSessionId = metadataString(value, 'parentSessionId');
  const parentToolCallId = metadataString(value, 'parentToolCallId');
  const description = metadataString(value, 'description');
  const modelRef = metadataString(value, 'modelRef');
  const cwd = metadataString(value, 'cwd');
  const workspaceId = metadataString(value, 'workspaceId');
  const parentChannel = value.parentChannel === 'dingtalk' || value.parentChannel === 'cron'
    ? value.parentChannel
    : 'web';

  if (!parentRunId || !parentSessionId || !parentToolCallId || !description || !modelRef || !cwd || !workspaceId) {
    return null;
  }

  const sandboxPolicy = isSandboxPolicy(value.sandboxPolicy) ? value.sandboxPolicy : undefined;
  const sandboxResources = parseSandboxResources(value.sandboxResources);
  const runtimeIsolationRequirement = parseRuntimeIsolationRequirement(value.runtimeIsolationRequirement);
  const orgAgentChannel = parseOrgAgentChannel(value.orgAgentChannel);
  // This metadata is durable and may predate the current ACS descriptor schema.
  const workload = parseWorkload(value.workload);
  const dwsCompletionRoute = parseDwsCompletionRoute(value.dwsCompletionRoute);
  const dwsCompletionRouteVersion = dwsCompletionRoute?.version
    ?? (value.dwsCompletionRouteVersion === 'invalid' ? 'invalid' as const : undefined);
  const executionMode = value.executionMode === 'dispatcher' ? 'dispatcher' as const
    : value.executionMode === 'direct' ? 'direct' as const
      : undefined;
  const common: CommonBackgroundTaskMetadata = {
    parentRunId,
    parentSessionId,
    // 改造前入队的存量任务没有该字段，回落 parentSessionId：这些记录本就按
    // workspace 级 scope 运行（其 metadata.sandboxScopeId 已固化），语义不变。
    topLevelSessionId: metadataString(value, 'topLevelSessionId') ?? parentSessionId,
    parentToolCallId,
    ...(metadataString(value, 'shortTaskId') ? { shortTaskId: metadataString(value, 'shortTaskId') } : {}),
    description,
    ...(metadataString(value, 'orgAgentId') ? { orgAgentId: metadataString(value, 'orgAgentId') } : {}),
    ...(executionMode ? { executionMode } : {}),
    ...(value.executionRole === 'worker' ? { executionRole: 'worker' as const } : {}),
    ...(dwsCompletionRoute?.version === 'exact' ? { dwsCompletionRoute: dwsCompletionRoute.route } : {}),
    ...(dwsCompletionRoute?.version === 'legacy' ? { legacyDwsCompletionRoute: dwsCompletionRoute.route } : {}),
    ...(dwsCompletionRouteVersion ? { dwsCompletionRouteVersion } : {}),
    modelRef,
    cwd,
    workspaceId,
    parentChannel,
    parentOutputTransactionMode: isModelOutputTransactionMode(value.parentOutputTransactionMode)
      ? value.parentOutputTransactionMode
      : resolveModelOutputTransactionMode(value),
    ...(metadataString(value, 'mountSubPath') ? { mountSubPath: metadataString(value, 'mountSubPath') } : {}),
    ...(metadataString(value, 'sandboxScopeId') ? { sandboxScopeId: metadataString(value, 'sandboxScopeId') } : {}),
    ...(metadataString(value, 'workOrderId') ? { workOrderId: metadataString(value, 'workOrderId') } : {}),
    ...(metadataString(value, 'attemptId') ? { attemptId: metadataString(value, 'attemptId') } : {}),
    ...(typeof value.attemptNo === 'number' && Number.isSafeInteger(value.attemptNo) && value.attemptNo > 0
      ? { attemptNo: value.attemptNo } : {}),
    ...(metadataString(value, 'parentAttemptId')
      ? { parentAttemptId: metadataString(value, 'parentAttemptId') } : {}),
    ...(metadataString(value, 'sharedReadOnlySubPath')
      ? { sharedReadOnlySubPath: metadataString(value, 'sharedReadOnlySubPath') } : {}),
    ...(sandboxResources ? { sandboxResources } : {}),
    ...(workload ? { workload } : {}),
    ...(metadataString(value, 'timezone') ? { timezone: metadataString(value, 'timezone') } : {}),
    ...(sandboxPolicy ? { sandboxPolicy } : {}),
    ...(runtimeIsolationRequirement ? { runtimeIsolationRequirement } : {}),
    ...(orgAgentChannel ? { orgAgentChannel } : {}),
  };

  if (value.backgroundTaskType === 'command') {
    const commandHash = metadataString(value, 'commandHash');
    const commandPreview = metadataString(value, 'commandPreview');
    const timeoutMs = typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs)
      ? value.timeoutMs
      : undefined;
    if (!commandHash || !commandPreview || !timeoutMs) return null;
    return { ...common, taskType: 'command', commandHash, commandPreview, timeoutMs };
  }

  const prompt = metadataString(value, 'prompt');
  const basePrompt = metadataString(value, 'basePrompt');
  const agentType = value.agentType === 'explore'
    ? 'explore'
    : value.agentType === 'general'
      ? 'general'
      : null;
  if (!prompt || !agentType) return null;

  return {
    ...common,
    taskType: 'agent',
    outputTransactionMode: isModelOutputTransactionMode(value.outputTransactionMode)
      ? value.outputTransactionMode
      : 'terminal_buffered',
    ...(basePrompt ? { basePrompt } : {}),
    prompt,
    agentType,
    includeCompanyInfo: value.includeCompanyInfo === true,
  };
}

export function deriveBackgroundRuntimeIsolationRequirement(
  metadata: BackgroundTaskMetadata,
  child: { runId: string; sessionId: string; workspaceId: string },
): RuntimeIsolationRequirement | undefined {
  return deriveRuntimeIsolationRequirement(metadata.runtimeIsolationRequirement, child);
}

function parseWorkload(value: unknown): SandboxWorkloadWireDescriptor | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!['interactive', 'taskboard', 'cron', 'memory'].includes(String(raw.class))) return undefined;
  if (raw.class !== 'taskboard') return { class: raw.class as 'interactive' | 'cron' | 'memory' };
  const taskKind = ['delivery', 'advisory', 'integration', 'remediation'].includes(String(raw.taskKind))
    ? raw.taskKind as SandboxWorkloadWireDescriptor['taskKind'] : undefined;
  const purpose = ['work', 'review', 'merge'].includes(String(raw.purpose))
    ? raw.purpose as SandboxWorkloadWireDescriptor['purpose'] : undefined;
  return {
    class: 'taskboard',
    ...(taskKind ? { taskKind } : {}),
    ...(purpose ? { purpose } : {}),
  };
}

export function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseRuntimeIsolationRequirement(value: unknown): RuntimeIsolationRequirement | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const fields = ['tenantId', 'taskId', 'runId', 'sessionId', 'workspaceId', 'policyDigest'] as const;
  if (fields.some((field) => !metadataString(record, field))) return undefined;
  return Object.fromEntries(fields.map((field) => [field, metadataString(record, field)!])) as unknown as RuntimeIsolationRequirement;
}

export function parseDwsCompletionRoute(value: unknown): ParsedBackgroundTaskDwsCompletionRoute | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { version: 'invalid' };
  const route = value as Record<string, unknown>;
  const accountId = metadataString(route, 'accountId');
  const profileId = metadataString(route, 'profileId');
  const corpId = metadataString(route, 'corpId');
  const dingtalkUserId = metadataString(route, 'dingtalkUserId');
  const conversationId = metadataString(route, 'conversationId');
  const eventType = route.eventType === 'user_im_message_receive_at'
    || route.eventType === 'user_im_message_receive_o2o_all'
    ? route.eventType
    : undefined;
  if (!accountId || !conversationId || !eventType) return { version: 'invalid' };
  const optional = {
    ...(metadataString(route, 'messageId') ? { messageId: metadataString(route, 'messageId') } : {}),
    ...(metadataString(route, 'senderOpenDingtalkId')
      ? { senderOpenDingtalkId: metadataString(route, 'senderOpenDingtalkId') }
      : {}),
  };
  if (profileId && corpId && dingtalkUserId && profileId === `${corpId}:${dingtalkUserId}`) {
    return {
      version: 'exact',
      route: { accountId, profileId, corpId, dingtalkUserId, conversationId, eventType, ...optional },
    };
  }
  const hasIdentityField = ['profileId', 'corpId', 'dingtalkUserId']
    .some(key => Object.hasOwn(route, key));
  if (!hasIdentityField) {
    return { version: 'legacy', route: { accountId, conversationId, eventType, ...optional } };
  }
  return { version: 'invalid' };
}

function isSandboxPolicy(value: unknown): value is { denyRead: string[] } {
  return !!value && typeof value === 'object'
    && Array.isArray((value as { denyRead?: unknown }).denyRead)
    && (value as { denyRead: unknown[] }).denyRead.every((item) => typeof item === 'string');
}

function parseOrgAgentChannel(value: unknown): NonNullable<ChannelContext['orgAgentChannel']> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const bindingId = metadataString(raw, 'bindingId');
  const accountId = metadataString(raw, 'accountId');
  const agentId = metadataString(raw, 'agentId');
  const conversationSpaceId = metadataString(raw, 'conversationSpaceId');
  const workConversationId = metadataString(raw, 'workConversationId');
  const policyRevision = typeof raw.policyRevision === 'number' && Number.isInteger(raw.policyRevision)
    && raw.policyRevision >= 1 ? raw.policyRevision : undefined;
  const assurance = ['mapped', 'unmapped', 'ambiguous'].includes(String(raw.externalActorAssurance))
    || raw.externalActorAssurance === 'service'
    ? raw.externalActorAssurance as NonNullable<ChannelContext['orgAgentChannel']>['externalActorAssurance'] : undefined;
  const allowedToolNames = Array.isArray(raw.allowedToolNames)
    && raw.allowedToolNames.every(item => typeof item === 'string') ? raw.allowedToolNames as string[] : undefined;
  const allowedSkillIds = Array.isArray(raw.allowedSkillIds)
    && raw.allowedSkillIds.every(item => typeof item === 'string') ? raw.allowedSkillIds as string[] : undefined;
  const allowedSourceIds = Array.isArray(raw.allowedSourceIds)
    && raw.allowedSourceIds.every(item => typeof item === 'string') ? raw.allowedSourceIds as string[] : undefined;
  const triggerRoles = parseGovernanceRoles(raw.triggerRoles);
  const approvalRoles = parseGovernanceRoles(raw.approvalRoles);
  const taskVisibility = raw.taskVisibility === 'conversation' || raw.taskVisibility === 'requester_only'
    ? raw.taskVisibility : undefined;
  const externalActor = parseExternalActor(raw.externalActor);
  const channelPrincipal = parseChannelPrincipal(raw.channelPrincipal);
  const agentPrincipal = parseAgentPrincipal(raw.agentPrincipal);
  if (!accountId || !agentId || !bindingId || !conversationSpaceId || !workConversationId
    || !policyRevision || !assurance || !allowedToolNames || !allowedSkillIds || !allowedSourceIds
    || !triggerRoles || !approvalRoles
    || !taskVisibility || !externalActor || !channelPrincipal
    || !agentPrincipal) return undefined;
  const actorRole = raw.actorRole === 'member' || raw.actorRole === 'org_admin'
    ? raw.actorRole : undefined;
  if (agentPrincipal.accountId !== accountId || agentPrincipal.agentId !== agentId
    || channelPrincipal.accountId !== accountId) return undefined;
  if (externalActor.kind === 'service_event') {
    if (assurance !== 'service' || actorRole) return undefined;
  } else if (assurance !== externalActor.assurance
    || (externalActor.assurance === 'mapped'
      ? !externalActor.mappedUserId || !externalActor.role || actorRole !== externalActor.role
      : Boolean(externalActor.mappedUserId || externalActor.role || actorRole))) return undefined;
  return { accountId, agentId, bindingId, conversationSpaceId, workConversationId, policyRevision,
    agentPrincipal, externalActorAssurance: assurance, allowedToolNames, allowedSkillIds, allowedSourceIds,
    contextEnabled: raw.contextEnabled === true,
    taskVisibility,
    ...(actorRole ? { actorRole } : {}),
    triggerRoles,
    approvalRoles,
    externalActor, channelPrincipal };
}

function parseExternalActor(value: unknown): NonNullable<ChannelContext['orgAgentChannel']>['externalActor'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'service_event') {
    const workOrderId = metadataString(raw, 'workOrderId'); const attemptId = metadataString(raw, 'attemptId');
    const fence = typeof raw.fence === 'number' && Number.isSafeInteger(raw.fence) && raw.fence >= 0 ? raw.fence : undefined;
    return workOrderId && attemptId && fence !== undefined
      ? { kind: 'service_event', issuer: 'runtime', workOrderId, attemptId, fence } : undefined;
  }
  const kind = raw.kind === 'external_user' ? 'external_user' : undefined;
  const assurance = ['mapped', 'unmapped', 'ambiguous'].includes(String(raw.assurance))
    ? raw.assurance as 'mapped' | 'unmapped' | 'ambiguous' : undefined;
  const corpId = metadataString(raw, 'corpId'); const openId = metadataString(raw, 'openId');
  if (!kind || raw.provider !== 'dingtalk' || !assurance || !corpId || !openId) return undefined;
  return { kind, provider: 'dingtalk', corpId, openId, assurance,
    ...(metadataString(raw, 'displayName') ? { displayName: metadataString(raw, 'displayName') } : {}),
    ...(metadataString(raw, 'mappedUserId') ? { mappedUserId: metadataString(raw, 'mappedUserId') } : {}),
    ...(raw.role === 'member' || raw.role === 'org_admin' ? { role: raw.role } : {}) };
}

function parseGovernanceRoles(value: unknown): Array<'member' | 'org_admin'> | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(item => item === 'member' || item === 'org_admin'))
    return undefined;
  return value;
}

function parseAgentPrincipal(value: unknown): NonNullable<ChannelContext['orgAgentChannel']>['agentPrincipal'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const tenantId = metadataString(raw, 'tenantId'); const agentId = metadataString(raw, 'agentId');
  const accountId = metadataString(raw, 'accountId'); const workspaceId = metadataString(raw, 'workspaceId');
  return raw.kind === 'org_agent' && tenantId && agentId && accountId && workspaceId
    ? { kind: 'org_agent', tenantId, agentId, accountId, workspaceId } : undefined;
}

function parseChannelPrincipal(value: unknown): NonNullable<ChannelContext['orgAgentChannel']>['channelPrincipal'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>; const accountId = metadataString(raw, 'accountId');
  const conversationId = metadataString(raw, 'conversationId');
  const kind = raw.kind === 'group' ? 'group' : raw.kind === 'direct' ? 'direct' : undefined;
  if (raw.provider !== 'dingtalk' || !accountId || !conversationId || !kind) return undefined;
  return { provider: 'dingtalk', accountId, conversationId, kind,
    ...(metadataString(raw, 'peerOpenId') ? { peerOpenId: metadataString(raw, 'peerOpenId') } : {}) };
}
