/**
 * 请求上下文（AsyncLocalStorage）
 *
 * 在 dispatch 中间件中注入，整个请求生命周期内可通过 getRequestContext() 获取。
 * Logger 自动读取 runId 附加到日志输出中，无需手动传参。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  runId: string;
  channel?: string;
  chatId?: string;
  /** 用户身份（MCP 工具权限校验用，由 dispatch 中间件从 ChannelContext.user 注入） */
  userId?: string;
  username?: string;
  userRole?: 'admin' | 'user';
  /** 租户 ID（多租户日志切分用，由 dispatch 中间件从 ChannelContext.user.tenantId 注入） */
  tenantId?: string;
  /** 会话 ID（运维按会话 grep 日志用，由内层 raw runtime 在 sessionId 确定后注入） */
  sessionId?: string;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/** 获取当前请求上下文，不在请求链路中返回 undefined */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}
