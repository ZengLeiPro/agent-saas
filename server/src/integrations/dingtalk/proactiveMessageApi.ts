/**
 * DingTalk 主动消息发送（直连钉钉 v1.0 API）
 *
 * 替代旧的 FC 函数网关中转方式，直接调用钉钉 Robot API。
 * 参考：dingtalk-moltbot-connector/plugin.ts 的 sendNormalToUser/sendNormalToGroup
 */

import { getApiAccessToken } from './mediaApi.js';
import { DINGTALK_API, API_TIMEOUT_MS } from './constants.js';

// ============ 超时辅助 ============

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = API_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ============ 类型定义 ============

export type DingtalkMsgType = 'text' | 'markdown' | 'link' | 'actionCard' | 'image';

export interface DingtalkSendCredentials {
  appKey: string;
  appSecret: string;
}

export interface SendResult {
  ok: boolean;
  processQueryKey?: string;
  error?: string;
}

export type DingtalkProactiveTarget =
  | { type: 'group'; openConversationId: string }
  | { type: 'user'; userId: string | string[] };

interface MsgPayload {
  msgKey: string;
  msgParam: Record<string, any>;
}

// ============ 消息载荷构建 ============

function buildMsgPayload(
  msgType: DingtalkMsgType,
  content: string,
  title?: string,
): MsgPayload | { error: string } {
  switch (msgType) {
    case 'markdown':
      return {
        msgKey: 'sampleMarkdown',
        msgParam: {
          title: title || content.split('\n')[0]?.replace(/^[#*\s\->]+/, '').slice(0, 20) || 'Message',
          text: content,
        },
      };
    case 'image':
      return {
        msgKey: 'sampleImageMsg',
        msgParam: { photoURL: content },
      };
    case 'link':
      try {
        return { msgKey: 'sampleLink', msgParam: JSON.parse(content) };
      } catch {
        return { error: 'link content must be valid JSON' };
      }
    case 'actionCard':
      try {
        return { msgKey: 'sampleActionCard', msgParam: JSON.parse(content) };
      } catch {
        return { error: 'actionCard content must be valid JSON' };
      }
    case 'text':
    default:
      return {
        msgKey: 'sampleText',
        msgParam: { content },
      };
  }
}

// ============ 自动检测 Markdown ============

function detectMsgType(content: string): DingtalkMsgType {
  // 块级元素
  if (/^#{1,6}\s/m.test(content)) return 'markdown';         // 标题
  if (/^[\-*+]\s/m.test(content)) return 'markdown';         // 无序列表
  if (/^\d+\.\s/m.test(content)) return 'markdown';          // 有序列表
  if (/^>/m.test(content)) return 'markdown';                 // 引用
  if (/^```/m.test(content)) return 'markdown';               // 代码块
  if (/^\|.+\|/m.test(content)) return 'markdown';            // 表格
  if (/^---$/m.test(content)) return 'markdown';              // 水平线
  // 行内元素
  if (/\*\*.+?\*\*|__.+?__/.test(content)) return 'markdown'; // 加粗
  if (/\[.+?\]\(.+?\)/.test(content)) return 'markdown';      // 链接
  if (/!\[.*?\]\(.+?\)/.test(content)) return 'markdown';     // 图片
  if (/`.+?`/.test(content)) return 'markdown';                // 行内代码
  return 'text';
}

export async function sendRawRobotMessage(
  credentials: DingtalkSendCredentials,
  target: DingtalkProactiveTarget,
  payload: MsgPayload,
): Promise<SendResult> {
  try {
    const token = await getApiAccessToken(credentials);

    let endpoint: string;
    let body: Record<string, unknown>;
    if (target.type === 'group') {
      endpoint = `${DINGTALK_API}/v1.0/robot/groupMessages/send`;
      body = {
        robotCode: credentials.appKey,
        openConversationId: target.openConversationId,
        msgKey: payload.msgKey,
        msgParam: JSON.stringify(payload.msgParam),
      };
    } else {
      endpoint = `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;
      const userIds = Array.isArray(target.userId) ? target.userId : [target.userId];
      body = {
        robotCode: credentials.appKey,
        userIds,
        msgKey: payload.msgKey,
        msgParam: JSON.stringify(payload.msgParam),
      };
    }

    const resp = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'x-acs-dingtalk-access-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json().catch(() => ({} as any)) as any;

    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}: ${data.message || data.code || 'Unknown error'}` };
    }

    if (data.processQueryKey) {
      return { ok: true, processQueryKey: data.processQueryKey };
    }
    if (!data.message && !data.errcode) {
      return { ok: true };
    }

    return { ok: false, error: data.message || data.errmsg || 'Unknown error' };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// ============ 直连发送函数 ============

/**
 * 主动发送单聊消息（直连钉钉 API）
 */
export async function sendToUser(
  credentials: DingtalkSendCredentials,
  userIds: string | string[],
  content: string,
  options: { msgType?: DingtalkMsgType; title?: string } = {},
): Promise<SendResult> {
  const msgType = options.msgType || detectMsgType(content);
  const payload = buildMsgPayload(msgType, content, options.title);
  if ('error' in payload) {
    return { ok: false, error: payload.error };
  }
  return sendRawRobotMessage(credentials, { type: 'user', userId: userIds }, payload);
}

/**
 * 主动发送群聊消息（直连钉钉 API）
 */
export async function sendToGroup(
  credentials: DingtalkSendCredentials,
  openConversationId: string,
  content: string,
  options: { msgType?: DingtalkMsgType; title?: string } = {},
): Promise<SendResult> {
  const msgType = options.msgType || detectMsgType(content);
  const payload = buildMsgPayload(msgType, content, options.title);
  if ('error' in payload) {
    return { ok: false, error: payload.error };
  }
  return sendRawRobotMessage(credentials, { type: 'group', openConversationId }, payload);
}

/**
 * 智能发送消息（自动检测目标类型）
 */
export async function sendProactive(
  credentials: DingtalkSendCredentials,
  target: { userId?: string; userIds?: string[]; chatId?: string },
  content: string,
  options: { msgType?: DingtalkMsgType; title?: string } = {},
): Promise<SendResult> {
  if (target.userId || target.userIds) {
    const ids = target.userIds || [target.userId!];
    return sendToUser(credentials, ids, content, options);
  }

  if (target.chatId) {
    return sendToGroup(credentials, target.chatId, content, options);
  }

  return { ok: false, error: 'Must specify userId, userIds, or chatId' };
}
