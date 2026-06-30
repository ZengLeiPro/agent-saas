/**
 * DingTalk Message Delivery
 *
 * 钉钉消息投递：通过 sessionWebhook 发送文本/Markdown 消息。
 * 被 DingtalkChannel 和 Cron 通知共同使用，独立于通道类。
 */

import { dingtalkLogger } from '../../../utils/logger.js';
import { parseVoiceMarkers, dispatchVoiceMarkers } from './voiceService.js';
import type { SendDingtalkOptions } from './types.js';

// ============ 超时辅助 ============

const WEBHOOK_TIMEOUT_MS = 10_000;

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = WEBHOOK_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ============================================
// Types
// ============================================

/** 状态发送函数类型 */
export type SendStatusFn = (status: string) => Promise<void>;

/** 消息发送函数类型 */
export type SendMessageFn = (content: string, msgType: 'text' | 'markdown') => Promise<void>;

/** 钉钉消息元数据（附加在 InboundMessage.metadata 中） */
export interface DingtalkMetadata {
  sessionWebhook: string;
  senderNick?: string;
  senderId?: string;
  conversationType?: string;
  robotId?: string;
  [key: string]: unknown;
}

// ============================================
// Message Sending
// ============================================

/**
 * 发送钉钉消息（支持语音标记）
 */
export async function sendDingtalkMessage(opts: SendDingtalkOptions): Promise<void> {
  const { sessionWebhook, msgType, senderNick, conversationType, ttsConfig, credentials } = opts;
  let { content } = opts;

  const parsedVoice = parseVoiceMarkers(content);
  if (parsedVoice.markers.length > 0) {
    await dispatchVoiceMarkers({
      markers: parsedVoice.markers,
      sessionWebhook,
      ttsConfig,
      credentials,
    });

    if (!parsedVoice.cleanedText) {
      return;
    }
    content = parsedVoice.cleanedText;
  }

  // Add @ user in group chat
  let finalContent = content;
  if (conversationType === '2' && senderNick) {
    finalContent = `@${senderNick}\n${content}`;
  }

  const payload = msgType === 'markdown'
    ? { msgtype: 'markdown', markdown: { title: 'AI 回复', text: finalContent } }
    : { msgtype: 'text', text: { content: finalContent } };

  const response = await fetchWithTimeout(sessionWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`发送钉钉消息失败: ${response.status} ${text}`);
  }

  const bodyText = await response.text().catch(() => '');
  if (bodyText.trim()) {
    let body: any;
    try {
      body = JSON.parse(bodyText);
    } catch {
      // 非 JSON 响应，忽略（某些成功场景钉钉可能返回非 JSON）
    }

    if (body && typeof body.errcode === 'number' && body.errcode !== 0) {
      throw new Error(`钉钉返回错误: errcode=${body.errcode} errmsg=${String(body.errmsg ?? '')}`);
    }
  }

  dingtalkLogger.debug('消息发送成功');
}

/**
 * 创建消息发送辅助函数
 */
export function createMessageHelpers(
  sessionWebhook: string,
  senderNick?: string,
  conversationType?: string,
): { sendStatus: SendStatusFn; sendMessage: SendMessageFn } {
  const sendStatus: SendStatusFn = async (status: string) => {
    await sendDingtalkMessage({
      sessionWebhook,
      content: status,
      msgType: 'text',
      senderNick,
      conversationType,
    });
  };

  const sendMessage: SendMessageFn = async (content: string, msgType: 'text' | 'markdown') => {
    await sendDingtalkMessage({
      sessionWebhook,
      content,
      msgType,
      senderNick,
      conversationType,
    });
  };

  return { sendStatus, sendMessage };
}

