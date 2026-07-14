/**
 * UserActivityList 工具（2026-07-14 记忆轮询批次）
 *
 * safe 只读：列出当前用户自己最近时间窗内的主动消息（web/dingtalk 发起的
 * user_message，跨会话聚合）。
 *
 * 安全边界：不接受 userId/tenantId 入参——身份只从 ChannelContext
 * （user ?? sessionOwner）解析，模型无法查询其他用户。数据源不可用
 * （文件后端）或无身份时返回明确说明，不抛栈。
 */

import { z } from 'zod';

import type { UserActivityService, UserActivityResult } from '../runtime/userActivityService.js';
import { loadToolDescription } from './tools/descriptionLoader.js';
import type { AuthorizedToolCall, ToolCallContext, ToolDescriptor, ToolProvider, ToolResult } from './toolRuntime.js';

const DEFAULT_LOOKBACK_HOURS = 48;
const MAX_LOOKBACK_HOURS = 168;

type UserActivityListInput = {
  hours?: number;
  maxSessions?: number;
  maxMessagesPerSession?: number;
};

export const userActivityListToolDescriptor: ToolDescriptor<UserActivityListInput> = {
  id: 'UserActivityList',
  name: 'UserActivityList',
  displayName: 'User Activity List',
  description: loadToolDescription('UserActivityList'),
  schema: z.object({
    hours: z.number().int().positive().max(MAX_LOOKBACK_HOURS).optional()
      .describe(`Lookback window in hours (default ${DEFAULT_LOOKBACK_HOURS}, max ${MAX_LOOKBACK_HOURS}).`),
    maxSessions: z.number().int().positive().max(100).optional()
      .describe('Max sessions to scan (default 30).'),
    maxMessagesPerSession: z.number().int().positive().max(200).optional()
      .describe('Max messages kept per session (default 50).'),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'memory.activity',
};

export class UserActivityToolProvider implements ToolProvider {
  constructor(private readonly userActivityService: UserActivityService) {}

  list(): ToolDescriptor[] {
    return [userActivityListToolDescriptor];
  }

  async invoke(call: AuthorizedToolCall, context: ToolCallContext): Promise<ToolResult | undefined> {
    if (call.toolId !== userActivityListToolDescriptor.id) return undefined;
    const input = userActivityListToolDescriptor.schema.parse(call.input) as UserActivityListInput;

    // 身份只从 context 解析（user 优先；cron / wake 路径用 sessionOwner）
    const identity = context.channelContext.user ?? context.channelContext.sessionOwner;
    if (!identity?.id || !identity.tenantId) {
      return { content: 'UserActivityList 不可用：当前会话缺少用户身份（需要 user/sessionOwner）。' };
    }
    if (!this.userActivityService.available) {
      return { content: 'UserActivityList 不可用：当前部署未启用 PG runtime event store（文件后端不支持跨会话活动查询）。' };
    }

    const hours = input.hours ?? DEFAULT_LOOKBACK_HOURS;
    const sinceIso = new Date(Date.now() - hours * 3_600_000).toISOString();
    const result = await this.userActivityService.listActivity({
      tenantId: identity.tenantId,
      userId: identity.id,
      sinceIso,
      ...(input.maxSessions ? { maxSessions: input.maxSessions } : {}),
      ...(input.maxMessagesPerSession ? { maxMessagesPerSession: input.maxMessagesPerSession } : {}),
    });
    return { content: formatActivity(result, hours) };
  }
}

function formatActivity(result: UserActivityResult, hours: number): string {
  if (result.sessions.length === 0) {
    return `最近 ${hours} 小时内没有用户主动消息（已扫描 ${result.scannedSessions} 个会话）。`;
  }
  const parts: string[] = [
    `最近 ${hours} 小时用户主动消息（${result.sessions.length} 个会话，时间窗 ${result.sinceIso} ~ ${result.untilIso}）：`,
  ];
  for (const session of result.sessions) {
    const title = session.title ? ` ${session.title}` : '';
    parts.push(`\n## 会话 ${session.sessionId.slice(0, 8)}${title}（updated ${session.updatedAt}）`);
    for (const message of session.messages) {
      parts.push(`- [${message.timestamp} ${message.channel}] ${message.content}`);
    }
  }
  if (result.truncated) {
    parts.push('\n[结果按预算截断，未包含全部消息]');
  }
  return parts.join('\n');
}
