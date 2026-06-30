/**
 * DingTalk Notification Channel for Cron
 *
 * 支持三种模式：session（sessionWebhook）、user（主动单聊）、chat（主动群聊）。
 * 封装 DingTalk 发送细节，对 Cron notifier 暴露 NotifyChannel 接口。
 */

import type { NotifyChannel, NotifySendResult, NotifyChannelSendOptions } from '../notifyChannel.js';
import type { AppConfig } from '../../types/index.js';
import { cronLogger } from '../../utils/logger.js';

const logger = cronLogger.child('DingTalkNotify');

// ============================================
// Types
// ============================================

type DingtalkSessionStore = Record<string, { sessionWebhook?: string }>;

interface SendMessageOptions {
  sessionWebhook: string;
  content: string;
  msgType: 'text' | 'markdown';
  senderNick?: string;
  conversationType?: string;
}

interface SendResult {
  ok: boolean;
  error?: string;
}

export interface DingtalkNotifyChannelDeps {
  dingtalkConfig: AppConfig['dingtalk'];
  dingtalkSendMessageConfig: AppConfig['dingtalkSendMessage'];
  loadSessions: () => DingtalkSessionStore;
  sendMessage: (opts: SendMessageOptions) => Promise<void>;
  sendToUser: (
    credentials: { appKey: string; appSecret: string },
    userIds: string | string[],
    message: string,
    options?: { msgType?: 'text' | 'markdown'; title?: string },
  ) => Promise<SendResult>;
  sendToGroup: (
    credentials: { appKey: string; appSecret: string },
    chatId: string,
    message: string,
    options?: { msgType?: 'text' | 'markdown'; title?: string },
  ) => Promise<SendResult>;
}

interface DingtalkNotifyConfig {
  mode?: 'session' | 'user' | 'chat';
  conversationId?: string;
  userId?: string | string[];
  chatId?: string;
}

// ============================================
// Helpers
// ============================================

function resolveSendCredentials(
  deps: DingtalkNotifyChannelDeps,
): { appKey: string; appSecret: string } | null {
  if (deps.dingtalkSendMessageConfig?.appKey && deps.dingtalkSendMessageConfig?.appSecret) {
    return {
      appKey: deps.dingtalkSendMessageConfig.appKey,
      appSecret: deps.dingtalkSendMessageConfig.appSecret,
    };
  }
  if (deps.dingtalkConfig?.robots) {
    for (const robot of Object.values(deps.dingtalkConfig.robots)) {
      if (robot.enabled !== false && robot.appKey && robot.appSecret) {
        return { appKey: robot.appKey, appSecret: robot.appSecret };
      }
    }
  }
  return null;
}

// ============================================
// Send Modes
// ============================================

async function sendViaSession(
  deps: DingtalkNotifyChannelDeps,
  notifyConfig: DingtalkNotifyConfig | undefined,
  message: string,
  msgType: 'text' | 'markdown',
): Promise<NotifySendResult> {
  if (!deps.dingtalkConfig?.enabled) {
    logger.warn(
      `Job requested DingTalk(sessionWebhook) notify but config.dingtalk.enabled is false; skip.`,
    );
    return { ok: false, error: 'dingtalk not enabled' };
  }

  const conversationId = String(notifyConfig?.conversationId || '').trim();
  if (!conversationId) {
    logger.warn(
      `mode=session but notify.dingtalk.conversationId is missing; skip.`,
    );
    return { ok: false, error: 'missing conversationId' };
  }

  const sessions = deps.loadSessions();
  const target = sessions[conversationId];
  if (!target?.sessionWebhook) {
    logger.warn(
      `sessionWebhook target missing or expired (conversationId=${conversationId}).`,
    );
    return { ok: false, error: 'sessionWebhook missing or expired' };
  }

  await deps.sendMessage({
    sessionWebhook: target.sessionWebhook,
    content: message,
    msgType,
  });
  return { ok: true };
}

async function sendViaUser(
  deps: DingtalkNotifyChannelDeps,
  notifyConfig: DingtalkNotifyConfig | undefined,
  message: string,
  msgType: 'text' | 'markdown',
): Promise<NotifySendResult> {
  const credentials = resolveSendCredentials(deps);
  if (!credentials) {
    logger.warn(`mode=user requires credentials; skip.`);
    return { ok: false, error: 'missing credentials' };
  }

  const userId = notifyConfig?.userId;
  const userIdText =
    typeof userId === 'string'
      ? userId.trim()
      : Array.isArray(userId)
        ? userId.map(String).map((s) => s.trim()).filter(Boolean)
        : [];
  const finalUserId = typeof userIdText === 'string' ? userIdText : userIdText.length ? userIdText : null;
  if (!finalUserId) {
    logger.warn(`mode=user but notify.dingtalk.userId is missing; skip.`);
    return { ok: false, error: 'missing userId' };
  }

  const userIds = Array.isArray(finalUserId) ? finalUserId : [finalUserId];
  return deps.sendToUser(credentials, userIds, message, { msgType });
}

async function sendViaChat(
  deps: DingtalkNotifyChannelDeps,
  notifyConfig: DingtalkNotifyConfig | undefined,
  message: string,
  msgType: 'text' | 'markdown',
): Promise<NotifySendResult> {
  const credentials = resolveSendCredentials(deps);
  if (!credentials) {
    logger.warn(`mode=chat requires credentials; skip.`);
    return { ok: false, error: 'missing credentials' };
  }

  const chatId = String(notifyConfig?.chatId || '').trim();
  if (!chatId) {
    logger.warn(`mode=chat but notify.dingtalk.chatId is missing; skip.`);
    return { ok: false, error: 'missing chatId' };
  }

  return deps.sendToGroup(credentials, chatId, message, { msgType });
}

// ============================================
// Factory
// ============================================

export function createDingtalkNotifyChannel(
  deps: DingtalkNotifyChannelDeps,
  notifyConfig: DingtalkNotifyConfig | undefined,
): NotifyChannel {
  const mode = notifyConfig?.mode ?? 'session';

  return {
    name: `dingtalk:${mode}`,

    async send(message: string, options?: NotifyChannelSendOptions): Promise<NotifySendResult> {
      const msgType = options?.msgType ?? 'markdown';

      if (mode === 'session') {
        return sendViaSession(deps, notifyConfig, message, msgType);
      }

      if (mode === 'user') {
        return sendViaUser(deps, notifyConfig, message, msgType);
      }

      if (mode === 'chat') {
        return sendViaChat(deps, notifyConfig, message, msgType);
      }

      logger.warn(`Unknown DingTalk notify mode: ${String(mode)}; skip.`);
      return { ok: false, error: `unknown mode: ${String(mode)}` };
    },
  };
}
