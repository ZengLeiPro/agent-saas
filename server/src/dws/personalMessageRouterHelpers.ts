import { createHash } from 'node:crypto';

import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import type { AgentDwsInboxRecord } from '../data/agentDwsMessages/index.js';
import type { PlatformEvent } from '../runtime/types.js';
import type { UserIdentity } from '../types/index.js';
import type { SharedGroupContext } from './orgAgentSharedGroupContext.js';
import type { DwsRequesterResolution } from './requesterIdentityResolver.js';

const MAX_SYSTEM_CONTEXT_FIELD = 500;

export function isV1InboxWithoutIdentity(item: AgentDwsInboxRecord): boolean {
  return (
    item.payload.schemaVersion === 1 &&
    !Object.prototype.hasOwnProperty.call(item.payload, 'accountIdentity')
  );
}

export function matchesInboxAccountIdentity(
  item: AgentDwsInboxRecord,
  account: AgentDwsAccountRecord,
): boolean {
  const rawIdentity = item.payload.accountIdentity;
  if (!rawIdentity || typeof rawIdentity !== 'object' || Array.isArray(rawIdentity)) return false;
  const identity = rawIdentity as Record<string, unknown>;
  return (
    identity.profileId === account.profileId &&
    identity.corpId === account.corpId &&
    identity.dingtalkUserId === account.dingtalkUserId
  );
}

export function buildSystemContext(
  account: AgentDwsAccountRecord,
  item: AgentDwsInboxRecord,
  shared?: SharedGroupContext,
): string {
  const isBackgroundCompletion = item.payload.source === 'background_task_completion';
  return [
    `你正在通过组织 Agent「${bounded(shared?.binding.effectiveConfig.identity.displayName?.trim() || account.displayName)}」的专属钉钉成员账号参与工作。`,
    '回复会由平台以该成员账号发回当前钉钉会话。不要声称自己是机器人，也不要泄露内部账号、事件或会话标识。',
    '需要澄清时直接用普通文本提问，不要调用 AskUserQuestion；当前钉钉通道不承载平台审批交互。',
    ...(isBackgroundCompletion
      ? [
          '当前消息是平台生成的 durable Worker 完成通知，不是用户的新请求。请播报其中的任务 ID、准确终态和精炼结果；不要再创建 Worker。',
        ]
      : []),
    ...(shared
      ? [
          `当前工作空间：${shared.binding.conversationSpaceId}；当前话题：${shared.workConversation.workConversationId}。`,
          `本轮调用者身份可信度：${shared.externalActor.kind === 'service_event' ? 'service' : shared.externalActor.assurance}。只能调用本群 effective config 明确开放的工具。`,
          ...(shared.binding.effectiveConfig.instructions.system.trim()
            ? [
                `当前群管理员指令：${bounded(shared.binding.effectiveConfig.instructions.system.trim(), 8_000)}`,
              ]
            : []),
          '这是组织共享会话。禁止读取请求者个人记忆、个人连接器或其他群内容；未映射身份只能处理本群允许的组织共享信息。',
          ...(shared.visibleWorkOrders.length
            ? [
                `当前话题任务（短号仅用于路由和歧义澄清）：${bounded(JSON.stringify(shared.visibleWorkOrders.map((work) => ({ shortId: work.shortId, title: work.title, state: work.state, attempt: work.currentAttemptNo }))), 8_000)}`,
                '需要操作既有任务时，用 BackgroundTask 的 amend/pause/resume/review/reassign/cancel；可直接把 W-短号作为 task_id。除非存在歧义，不要主动向用户展示内部短号。',
              ]
            : []),
          ...(shared.memories.length
            ? [
                `当前已治理记忆（只读）：${bounded(JSON.stringify(shared.memories.map((memory) => ({ scope: memory.memoryScope, content: memory.content }))), 12_000)}`,
              ]
            : []),
        ]
      : []),
    `当前入口：${item.eventType === 'user_im_message_receive_at' ? '群聊 @' : '单聊'}。`,
    ...(item.eventType === 'user_im_message_receive_at'
      ? ['当前钉钉接入只会收到群内 @ 消息；未 @ 的续话不会送达，请在需要时如实说明该限制。']
      : []),
  ].join('\n');
}

export function serviceIdentity(account: AgentDwsAccountRecord): UserIdentity {
  return {
    id: `adws-${account.accountId}`,
    username: `agent-dws:${account.agentId}`,
    role: 'user',
    tenantId: account.tenantId,
    realName: account.displayName,
  };
}

export function rejectionMessage(reason: string): string {
  switch (reason) {
    case 'REQUESTER_IDENTITY_MISSING':
    case 'REQUESTER_IDENTITY_UNMAPPED_OR_AMBIGUOUS':
      return '我暂时无法确认你的组织身份。请先完成账号绑定，或联系管理员开放本群的访客共享读取权限。';
    case 'ORG_AGENT_AUDIENCE_DENIED':
    case 'ORG_AGENT_TRIGGER_ROLE_DENIED':
      return '你目前不在这个 Agent 的可用范围内，请联系管理员调整成员范围。';
    case 'ORG_AGENT_UNAVAILABLE':
      return '这个 Agent 当前未启用，请联系管理员检查账号与 Agent 状态。';
    default:
      return '当前请求未通过组织权限检查。请联系管理员确认本群配置和你的访问范围。';
  }
}

export function collectAssistantText(events: PlatformEvent[]): string {
  return events
    .filter(
      (event): event is Extract<PlatformEvent, { type: 'assistant_message' }> =>
        event.type === 'assistant_message' && !event.incomplete,
    )
    .map((event) => event.content)
    .filter(Boolean)
    .join('');
}

export function normalizeEventTimestamp(value: number): Date {
  const millis = value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

export function deterministicId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

export function boundedPositive(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function bounded(value: string, maxLength = MAX_SYSTEM_CONTEXT_FIELD): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function boundedExternalId(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

export function safeLogId(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 100)
    : 'unknown';
}

export function compactError(error: unknown): string {
  return (
    (error instanceof Error ? error.message : String(error))
      .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(
        /((?:access_token|refresh_token|authorization|token)\s*[=:]\s*["']?)[^\s,"'}]+/gi,
        '$1[REDACTED]',
      )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500) || 'unknown_error'
  );
}

export async function legacyRequesterResolution(
  resolver: (
    account: AgentDwsAccountRecord,
    senderOpenDingtalkId: string,
    senderName?: string,
  ) => Promise<UserIdentity | null> | UserIdentity | null,
  account: AgentDwsAccountRecord,
  senderOpenDingtalkId: string,
  senderName?: string,
): Promise<DwsRequesterResolution> {
  const requester = await resolver(account, senderOpenDingtalkId, senderName);
  return requester
    ? { status: 'resolved', requester }
    : { status: 'unmapped', reason: 'REQUESTER_IDENTITY_UNMAPPED' };
}
