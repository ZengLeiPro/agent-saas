import { apiLogger } from '../../utils/logger.js';

/**
 * 2026-08-01：钉钉企业内部机器人「单聊（oTo）」告警通道。
 *
 * 背景：自定义 webhook 机器人只能在钉钉客户端群设置里手工创建（无开放 API），
 * 曾磊拍板改用已有企业应用机器人（麦迪文）直接私聊接收人。链路（与
 * kaiyan.net tools/baidu-push 同款，生产已验证）：
 *   Step 1: POST /v1.0/oauth2/accessToken 用 appKey+appSecret 换 accessToken（2h 有效）
 *   Step 2: POST /v1.0/robot/oToMessages/batchSend 带 x-acs-dingtalk-access-token
 *
 * accessToken 按 appKey 进程内缓存，提前 5 分钟过期避免边界失败。
 */

export interface DingtalkRobotAlertConfig {
  appKey: string;
  appSecret: string;
  /** 机器人 robotCode；麦迪文应用恰好 = appKey，未配置时回退 appKey。 */
  robotCode?: string;
  receiverUserIds: string[];
}

const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_EARLY_EXPIRE_MS = 5 * 60_000;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

const tokenCache = new Map<string, CachedToken>();

/** 仅测试用：清空 accessToken 缓存。 */
export function clearDingtalkRobotTokenCache(): void {
  tokenCache.clear();
}

async function fetchAccessToken(
  appKey: string,
  appSecret: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const cached = tokenCache.get(appKey);
  if (cached && Date.now() < cached.expiresAtMs) return cached.token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey, appSecret }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as { accessToken?: string; expireIn?: number };
    if (!res.ok || !body.accessToken) {
      throw new Error(`dingtalk accessToken failed: status=${res.status}`);
    }
    const ttlMs = (typeof body.expireIn === 'number' && body.expireIn > 0 ? body.expireIn : 7200) * 1000;
    tokenCache.set(appKey, {
      token: body.accessToken,
      expiresAtMs: Date.now() + Math.max(60_000, ttlMs - TOKEN_EARLY_EXPIRE_MS),
    });
    return body.accessToken;
  } finally {
    clearTimeout(timer);
  }
}

export async function sendDingtalkRobotOtoAlert(
  config: DingtalkRobotAlertConfig,
  markdown: { title: string; text: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const accessToken = await fetchAccessToken(config.appKey, config.appSecret, fetchImpl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken,
      },
      body: JSON.stringify({
        robotCode: config.robotCode || config.appKey,
        userIds: config.receiverUserIds,
        msgKey: 'sampleMarkdown',
        msgParam: JSON.stringify({ title: markdown.title, text: markdown.text }),
      }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      invalidStaffIdList?: string[];
      flowControlledStaffIdList?: string[];
    };
    if (!res.ok) {
      // 401/token 失效场景：清缓存让下一轮重新换 token 自愈。
      if (res.status === 401 || res.status === 403) tokenCache.delete(config.appKey);
      throw new Error(`dingtalk robot oTo send failed: status=${res.status}`);
    }
    if (body.invalidStaffIdList?.length) {
      apiLogger.warn(`[alerting] 钉钉机器人私聊部分接收人无效: ${body.invalidStaffIdList.join(',')}`);
    }
    if (body.flowControlledStaffIdList?.length) {
      apiLogger.warn(`[alerting] 钉钉机器人私聊部分接收人被限流: ${body.flowControlledStaffIdList.join(',')}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
