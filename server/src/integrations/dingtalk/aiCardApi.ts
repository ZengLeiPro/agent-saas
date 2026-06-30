/**
 * 钉钉 AI Card 流式卡片模块
 *
 * 实现 AI Card 的创建、流式更新和完成功能。
 * 使用 createAndDeliver 合并接口 + streaming API。
 *
 * 模板变量：
 * - content (String/markdown): 主体流式内容
 * - preparations (Array<{name}>): 动态步骤列表（思考中、工具调用等）
 * - lastMessage (String): 卡片摘要
 * - config (Object): 布局配置
 */

import crypto from 'crypto';
import { getApiAccessToken, type DingtalkCredentials } from './mediaApi.js';
import { dingtalkLogger } from '../../utils/logger.js';
import { DINGTALK_API, AI_CARD_TEMPLATE_ID, API_TIMEOUT_MS } from './constants.js';

// ============ 超时辅助 ============

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = API_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ============ 类型定义 ============

export interface AICardInstance {
  outTrackId: string;
  credentials: DingtalkCredentials;
}

export type AICardTarget =
  | { type: 'user'; userId: string }
  | { type: 'group'; openConversationId: string };

// ============ 创建并投放 AI Card ============

/**
 * 创建 AI Card 实例并投放到目标用户/群（合并接口，一次 API 调用）
 */
export async function createAICard(
  credentials: DingtalkCredentials,
  target: AICardTarget,
): Promise<AICardInstance | null> {
  try {
    const token = await getApiAccessToken(credentials);
    const outTrackId = `card_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    const body: Record<string, unknown> = {
      cardTemplateId: AI_CARD_TEMPLATE_ID,
      outTrackId,
      callbackType: 'STREAM',
      cardData: {
        cardParamMap: {
          content: '',
          preparations: '[]',
          lastMessage: '',
          config: JSON.stringify({ autoLayout: true }),
        },
      },
      userIdType: 1,
    };

    if (target.type === 'group') {
      body.openSpaceId = `dtv1.card//IM_GROUP.${target.openConversationId}`;
      body.imGroupOpenSpaceModel = { supportForward: true };
      body.imGroupOpenDeliverModel = { robotCode: credentials.appKey };
    } else {
      body.openSpaceId = `dtv1.card//IM_ROBOT.${target.userId}`;
      body.imRobotOpenSpaceModel = { supportForward: true };
      body.imRobotOpenDeliverModel = { spaceType: 'IM_ROBOT' };
    }

    const resp = await fetchWithTimeout(`${DINGTALK_API}/v1.0/card/instances/createAndDeliver`, {
      method: 'POST',
      headers: {
        'x-acs-dingtalk-access-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      dingtalkLogger.error(`[AICard] 创建投放失败: ${resp.status} ${errText}`);
      return null;
    }
    await resp.text();

    dingtalkLogger.info(`[AICard] 创建投放成功: outTrackId=${outTrackId}`);
    return { outTrackId, credentials };
  } catch (err: any) {
    dingtalkLogger.error(`[AICard] 创建异常: ${err.message}`);
    return null;
  }
}

// ============ 更新卡片数据（非流式） ============

/**
 * 通过 PUT /v1.0/card/instances 按 key 增量更新卡片变量
 *
 * 用于 preparations、lastMessage 等不走流式通道的变量。
 * updateCardDataByKey: true 确保只更新传入的字段，不影响其他变量和流式内容。
 */
export async function updateAICardData(
  card: AICardInstance,
  data: Record<string, string>,
): Promise<void> {
  try {
    const token = await getApiAccessToken(card.credentials);

    const body = {
      outTrackId: card.outTrackId,
      cardData: { cardParamMap: data },
      cardUpdateOptions: { updateCardDataByKey: true },
    };

    dingtalkLogger.debug(`[AICard] updateData keys=${Object.keys(data).join(',')}`);
    const resp = await fetchWithTimeout(`${DINGTALK_API}/v1.0/card/instances`, {
      method: 'PUT',
      headers: {
        'x-acs-dingtalk-access-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const respText = await resp.text();
    if (!resp.ok) {
      dingtalkLogger.error(`[AICard] updateData 失败: ${resp.status} ${respText}`);
    }
  } catch (err: any) {
    dingtalkLogger.error(`[AICard] updateData 异常: ${err.message}`);
  }
}

// ============ 流式更新 AI Card ============

/**
 * 流式更新 AI Card 的 content 变量（打字机效果）
 *
 * 根据钉钉文档：markdown 内容必须全量更新（isFull: true），且语法完整。
 * 单次 content 不超过 1KB，总大小建议不超过 3KB。
 */
export async function streamAICard(
  card: AICardInstance,
  key: string,
  content: string,
  finished: boolean = false,
): Promise<void> {
  try {
    const token = await getApiAccessToken(card.credentials);

    const streamBody = {
      outTrackId: card.outTrackId,
      guid: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      key,
      content,
      isFull: true,
      isFinalize: finished,
      isError: false,
    };

    dingtalkLogger.debug(`[AICard] streaming key=${key} contentLen=${content.length} isFinalize=${finished}`);
    const resp = await fetchWithTimeout(`${DINGTALK_API}/v1.0/card/streaming`, {
      method: 'PUT',
      headers: {
        'x-acs-dingtalk-access-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(streamBody),
    }, 30_000);
    const respText = await resp.text();
    if (!resp.ok) {
      dingtalkLogger.error(`[AICard] streaming 更新失败: ${resp.status} ${respText}`);
    }
  } catch (err: any) {
    dingtalkLogger.error(`[AICard] 流式更新异常: ${err.message}`);
  }
}

// ============ 完成 AI Card ============

/**
 * 完成 AI Card：设置摘要并关闭流式通道
 *
 * isFinalize=true 会让卡片从「输入中」切换为「完成」状态，
 * 卡片自动保留最后一次流式内容。
 */
export async function finishAICard(
  card: AICardInstance,
  content: string,
  lastMessage?: string,
): Promise<void> {
  dingtalkLogger.info(`[AICard] 完成卡片: outTrackId=${card.outTrackId} contentLen=${content.length}`);
  if (lastMessage) {
    await updateAICardData(card, { lastMessage });
  }
  await streamAICard(card, 'content', content, true);
}

// ============ AI Card 错误状态 ============

/**
 * 将 AI Card 设置为错误状态（通过 streaming API 的 isError 标志）
 */
export async function failAICard(
  card: AICardInstance,
  errorMessage: string,
): Promise<void> {
  try {
    const token = await getApiAccessToken(card.credentials);

    const streamBody = {
      outTrackId: card.outTrackId,
      guid: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      key: 'content',
      content: errorMessage,
      isFull: true,
      isFinalize: false,
      isError: true,
    };

    const resp = await fetchWithTimeout(`${DINGTALK_API}/v1.0/card/streaming`, {
      method: 'PUT',
      headers: {
        'x-acs-dingtalk-access-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(streamBody),
    }, 30_000);

    if (!resp.ok) {
      const errText = await resp.text();
      dingtalkLogger.error(`[AICard] 错误状态设置失败: ${resp.status} ${errText}`);
    }
  } catch (err: any) {
    dingtalkLogger.error(`[AICard] 设置错误状态异常: ${err.message}`);
  }
}

// ============ 从钉钉回调数据构建目标 ============

/**
 * 从钉钉 Webhook 回调数据构建 AICardTarget
 */
export function buildTargetFromCallback(data: {
  conversationType?: string;
  conversationId?: string;
  senderStaffId?: string;
  senderId?: string;
}): AICardTarget {
  const isDirect = data.conversationType === '1';
  if (isDirect) {
    return { type: 'user', userId: data.senderStaffId || data.senderId || '' };
  } else {
    return { type: 'group', openConversationId: data.conversationId || '' };
  }
}
