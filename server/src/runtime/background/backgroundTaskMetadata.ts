import { createHash } from 'node:crypto';
import type { ChannelContext } from '../../types/index.js';
import { automationFenceFromMetadata } from '../automationFence.js';
import { isModelOutputTransactionMode, resolveModelOutputTransactionMode } from '../modelOutputTransaction.js';
import type { RunRecord } from '../runStore.js';
import type { RunContext } from '../types.js';
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
  sandboxResources?: SandboxResources;
  sandboxPolicy?: { denyRead: string[] };
  timezone?: string;
  parentChannel: ChannelContext['channel'];
  parentOutputTransactionMode: NonNullable<ChannelContext['outputTransactionMode']>;
  runtimeIsolationRequirement?: RuntimeIsolationRequirement;
  /** Root authority plus this durable background task's invoking run identity. */
  automationFence?: RunContext['automationFence'];
  /** Durable identity reserved for the agent execution child before it creates resources. */
  executionChildSessionId?: string;
  executionChildRunId?: string;
}

export interface BackgroundAgentTaskMetadata extends CommonBackgroundTaskMetadata {
  taskType: 'agent';
  outputTransactionMode: NonNullable<ChannelContext['outputTransactionMode']>;
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


export function resolvePreparedChildIdentity(
  record: RunRecord, metadata: BackgroundTaskMetadata,
): { childSessionId: string; childRunId: string } {
  if (metadata.executionChildSessionId && metadata.executionChildRunId) {
    return { childSessionId: metadata.executionChildSessionId, childRunId: metadata.executionChildRunId };
  }
  const fence = metadata.automationFence;
  const digest = createHash('sha256')
    .update([record.runId, fence?.automationId, fence?.incarnationId, fence?.generation, fence?.executionId].join(':'))
    .digest('hex');
  return { childSessionId: `sub-${digest.slice(0, 32)}`, childRunId: `bg-child-${digest.slice(0, 32)}` };
}

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
  const automationFence = automationFenceFromMetadata(value);
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
    ...(sandboxResources ? { sandboxResources } : {}),
    ...(metadataString(value, 'timezone') ? { timezone: metadataString(value, 'timezone') } : {}),
    ...(sandboxPolicy ? { sandboxPolicy } : {}),
    ...(runtimeIsolationRequirement ? { runtimeIsolationRequirement } : {}),
    ...(automationFence ? { automationFence } : {}),
    ...(metadataString(value, 'executionChildSessionId')
      ? { executionChildSessionId: metadataString(value, 'executionChildSessionId') }
      : {}),
    ...(metadataString(value, 'executionChildRunId')
      ? { executionChildRunId: metadataString(value, 'executionChildRunId') }
      : {}),
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
