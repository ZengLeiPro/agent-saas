/**
 * Cron Notification Channel Abstraction
 *
 * 通知通道接口：Cron 通知器只依赖此抽象，具体实现（DingTalk、Web 等）在外部注入。
 */

import type { NotifyConfig } from './types.js';

export interface NotifyChannel {
  readonly name: string;
  send(message: string, options?: NotifyChannelSendOptions): Promise<NotifySendResult>;
}

export interface NotifyChannelSendOptions {
  msgType?: 'text' | 'markdown';
  /** Web 通道使用的 job/run 元数据（DingTalk 通道忽略） */
  jobId?: string;
  jobName?: string;
  jobOwner?: string;
  runId?: string;
  runStatus?: 'ok' | 'error' | 'skipped';
  durationMs?: number;
}

export interface NotifySendResult {
  ok: boolean;
  error?: string;
}

/**
 * 根据任务通知配置，动态解析出应发送的通知通道列表。
 * 由 runtime.ts 在装配时提供具体实现。
 */
export type NotifyChannelResolver = (notifyConfig: NotifyConfig) => NotifyChannel[];
