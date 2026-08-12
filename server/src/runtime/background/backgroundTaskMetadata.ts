import type { ChannelContext } from '../../types/index.js';
import { isModelOutputTransactionMode, resolveModelOutputTransactionMode } from '../modelOutputTransaction.js';
import type { RunRecord } from '../runStore.js';

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
  description: string;
  modelRef: string;
  cwd: string;
  workspaceId: string;
  mountSubPath?: string;
  sandboxScopeId?: string;
  sandboxPolicy?: { denyRead: string[] };
  timezone?: string;
  parentChannel: ChannelContext['channel'];
  parentOutputTransactionMode: NonNullable<ChannelContext['outputTransactionMode']>;
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
  const common: CommonBackgroundTaskMetadata = {
    parentRunId,
    parentSessionId,
    // 改造前入队的存量任务没有该字段，回落 parentSessionId：这些记录本就按
    // workspace 级 scope 运行（其 metadata.sandboxScopeId 已固化），语义不变。
    topLevelSessionId: metadataString(value, 'topLevelSessionId') ?? parentSessionId,
    parentToolCallId,
    description,
    modelRef,
    cwd,
    workspaceId,
    parentChannel,
    parentOutputTransactionMode: isModelOutputTransactionMode(value.parentOutputTransactionMode)
      ? value.parentOutputTransactionMode
      : resolveModelOutputTransactionMode(value),
    ...(metadataString(value, 'mountSubPath') ? { mountSubPath: metadataString(value, 'mountSubPath') } : {}),
    ...(metadataString(value, 'sandboxScopeId') ? { sandboxScopeId: metadataString(value, 'sandboxScopeId') } : {}),
    ...(metadataString(value, 'timezone') ? { timezone: metadataString(value, 'timezone') } : {}),
    ...(sandboxPolicy ? { sandboxPolicy } : {}),
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

export function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isSandboxPolicy(value: unknown): value is { denyRead: string[] } {
  return !!value && typeof value === 'object'
    && Array.isArray((value as { denyRead?: unknown }).denyRead)
    && (value as { denyRead: unknown[] }).denyRead.every((item) => typeof item === 'string');
}
