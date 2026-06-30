/**
 * 钉钉媒体上传和语音消息发送模块
 * TypeScript 版本
 *
 * 使用全局 fetch（Node 18+）替代手写 https 模块，与项目其他模块保持一致。
 */

import * as fs from 'fs';
import * as path from 'path';
import { writeFile } from 'fs/promises';
import { dingtalkLogger } from '../../utils/logger.js';

// ============== 类型定义 ==============

/** 钉钉凭证（用于 API 认证） */
export interface DingtalkCredentials {
  appKey: string;
  appSecret: string;
}

/** 媒体类型 */
export type MediaType = 'voice' | 'image' | 'video' | 'file';

/** 钉钉 API 通用响应 */
interface DingtalkApiResponse {
  errcode?: number;
  errmsg?: string;
}

/** AccessToken 响应 */
interface AccessTokenResponse extends DingtalkApiResponse {
  access_token?: string;
}

/** 媒体上传响应 */
interface MediaUploadResponse extends DingtalkApiResponse {
  media_id?: string;
  type?: string;
  created_at?: number;
}

/** 发送消息响应 */
export interface SendMessageResponse {
  errcode?: number;
  errmsg?: string;
  processQueryKey?: string;
}

// ============== AccessToken 缓存 ==============

// oapi Token 缓存（按 appKey 分别缓存，支持多机器人）
const oapiTokenCache = new Map<string, { token: string; expiry: number }>();

// v1.0 API Token 缓存（按 appKey 分别缓存）
const apiTokenCache = new Map<string, { token: string; expiry: number }>();

// ============== 重试工具 ==============

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 200): Promise<T> {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries) throw err;
      const delay = baseDelay * Math.pow(2, i);
      dingtalkLogger.warn(`[Token] 请求失败，${delay}ms 后重试 (${i + 1}/${maxRetries}): ${err instanceof Error ? err.message : err}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('unreachable');
}

// ============== 核心功能函数 ==============

/**
 * 获取钉钉 oapi AccessToken（用于媒体上传等）
 * 带缓存（60s 安全余量），失败时指数退避重试（最多 3 次）
 */
export async function getAccessToken(
  appKey: string,
  appSecret: string,
): Promise<string> {
  const now = Date.now();
  const cached = oapiTokenCache.get(appKey);
  if (cached && cached.expiry > now + 60_000) {
    return cached.token;
  }

  return withRetry(async () => {
    const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
    const resp = await fetch(url);
    const result = await resp.json() as AccessTokenResponse;

    if (result.errcode === 0 && result.access_token) {
      oapiTokenCache.set(appKey, { token: result.access_token, expiry: Date.now() + 7200 * 1000 });
      return result.access_token;
    }
    throw new Error(`获取 AccessToken 失败: ${result.errmsg || JSON.stringify(result)}`);
  });
}

/**
 * 获取钉钉 v1.0 API AccessToken（用于 Robot API、AI Card 等）
 * 通过 POST /v1.0/oauth2/accessToken 获取，带缓存，失败时指数退避重试
 */
export async function getApiAccessToken(credentials: DingtalkCredentials): Promise<string> {
  const now = Date.now();
  const cached = apiTokenCache.get(credentials.appKey);
  if (cached && cached.expiry > now + 60_000) {
    return cached.token;
  }

  return withRetry(async () => {
    const resp = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appKey: credentials.appKey,
        appSecret: credentials.appSecret,
      }),
    });

    const data = await resp.json() as any;
    if (!data?.accessToken) {
      throw new Error(`获取 API Token 失败: ${JSON.stringify(data)}`);
    }

    apiTokenCache.set(credentials.appKey, {
      token: data.accessToken,
      expiry: Date.now() + (data.expireIn || 7200) * 1000,
    });

    return data.accessToken;
  });
}

/**
 * 从钉钉下载入站媒体文件（用户发送的图片/语音/视频/文件）
 *
 * 使用 v1.0 API 两步式下载：
 * 1. POST /v1.0/robot/messageFiles/download 获取临时下载 URL
 * 2. GET 下载 URL 拉取实际文件
 *
 * @param downloadCode - 钉钉消息中的 downloadCode
 * @param credentials - 机器人凭证（用于获取 v1.0 API Token + robotCode）
 * @param destPath - 保存到的本地路径
 * @returns 是否成功
 */
export async function downloadMedia(
  downloadCode: string,
  credentials: DingtalkCredentials,
  destPath: string,
): Promise<boolean> {
  try {
    // Step 1: 获取临时下载 URL
    const accessToken = await getApiAccessToken(credentials);
    const apiResp = await fetch('https://api.dingtalk.com/v1.0/robot/messageFiles/download', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken,
      },
      body: JSON.stringify({
        downloadCode,
        robotCode: credentials.appKey,
      }),
    });

    if (!apiResp.ok) {
      dingtalkLogger.error(`[Media] 获取下载URL失败: HTTP ${apiResp.status}`);
      return false;
    }

    const apiResult = await apiResp.json() as any;
    if (!apiResult.downloadUrl) {
      dingtalkLogger.error(`[Media] 获取下载URL失败: ${apiResult.message || JSON.stringify(apiResult)}`);
      return false;
    }

    // Step 2: 从临时 URL 下载实际文件
    const downloadUrl = apiResult.downloadUrl.replace(/^http:\/\//, 'https://');
    const fileResp = await fetch(downloadUrl);

    if (!fileResp.ok) {
      dingtalkLogger.error(`[Media] 文件下载失败: HTTP ${fileResp.status}`);
      return false;
    }

    const buffer = Buffer.from(await fileResp.arrayBuffer());
    await writeFile(destPath, buffer);
    return true;
  } catch (err: any) {
    dingtalkLogger.error(`[Media] 下载异常: ${err.message}`);
    try { fs.unlinkSync(destPath); } catch {}
    return false;
  }
}

/**
 * 上传媒体文件到钉钉
 * @param accessToken - AccessToken
 * @param filePath - 文件路径
 * @param mediaType - 媒体类型 (voice/image/video/file)
 * @returns mediaId
 */
export async function uploadMedia(
  accessToken: string,
  filePath: string,
  mediaType: MediaType = 'voice'
): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const url = `https://oapi.dingtalk.com/media/upload?access_token=${encodeURIComponent(accessToken)}`;

  const formData = new FormData();
  formData.append('type', mediaType);

  const fileBuffer = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const contentTypeMap: Record<MediaType, string> = {
    voice: 'audio/mpeg',
    image: 'image/jpeg',
    video: 'video/mp4',
    file: 'application/octet-stream',
  };
  const blob = new Blob([fileBuffer], { type: contentTypeMap[mediaType] });
  formData.append('media', blob, filename);

  const resp = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  const result = await resp.json() as MediaUploadResponse;
  if (result.errcode === 0 || result.media_id) {
    return result.media_id!;
  }
  throw new Error(`上传媒体失败: ${result.errmsg || JSON.stringify(result)}`);
}

/**
 * 通过 sessionWebhook 发送语音消息
 * @param sessionWebhook - 会话的 webhook 地址
 * @param mediaId - 媒体文件 ID
 * @param duration - 语音时长（毫秒）
 * @returns 发送结果
 */
export async function sendVoiceBySession(
  sessionWebhook: string,
  mediaId: string,
  duration?: number | string
): Promise<SendMessageResponse> {
  const resp = await fetch(sessionWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'audio',
      audio: {
        mediaId,
        duration: String(duration || 0),
      },
    }),
  });

  return resp.json() as Promise<SendMessageResponse>;
}

/**
 * 通过群聊 API 发送语音消息
 * @param accessToken - AccessToken
 * @param openConversationId - 群会话 ID
 * @param robotCode - 机器人 Code
 * @param mediaId - 媒体文件 ID
 * @param duration - 语音时长（毫秒）
 * @returns 发送结果
 */
export async function sendVoiceToGroup(
  accessToken: string,
  openConversationId: string,
  robotCode: string,
  mediaId: string,
  duration?: number | string
): Promise<SendMessageResponse> {
  const resp = await fetch('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
    method: 'POST',
    headers: {
      'x-acs-dingtalk-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      msgParam: JSON.stringify({ mediaId, duration: String(duration || 0) }),
      msgKey: 'sampleAudio',
      openConversationId,
      robotCode,
    }),
  });

  return resp.json() as Promise<SendMessageResponse>;
}

/**
 * 通过私聊 API 发送语音消息
 * @param accessToken - AccessToken
 * @param robotCode - 机器人 Code
 * @param userIds - 用户 ID 或 ID 数组
 * @param mediaId - 媒体文件 ID
 * @param duration - 语音时长（毫秒）
 * @returns 发送结果
 */
export async function sendVoiceToUser(
  accessToken: string,
  robotCode: string,
  userIds: string | string[],
  mediaId: string,
  duration?: number | string
): Promise<SendMessageResponse> {
  const userIdList = Array.isArray(userIds) ? userIds : [userIds];
  const resp = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
    method: 'POST',
    headers: {
      'x-acs-dingtalk-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      robotCode,
      userIds: userIdList,
      msgKey: 'sampleAudio',
      msgParam: JSON.stringify({ mediaId, duration: String(duration || 0) }),
    }),
  });

  return resp.json() as Promise<SendMessageResponse>;
}

// ============== 便捷函数 ==============

/**
 * 自动获取 AccessToken 并上传媒体
 */
export async function uploadMediaWithCredentials(
  filePath: string,
  mediaType: MediaType,
  credentials: DingtalkCredentials,
): Promise<string> {
  const accessToken = await getAccessToken(credentials.appKey, credentials.appSecret);
  return uploadMedia(accessToken, filePath, mediaType);
}

/**
 * 上传语音文件并返回 mediaId（自动获取 AccessToken）
 * @param filePath - 语音文件路径
 * @param credentials - 钉钉凭证
 * @returns mediaId
 */
export async function uploadVoice(filePath: string, credentials: DingtalkCredentials): Promise<string> {
  return uploadMediaWithCredentials(filePath, 'voice', credentials);
}

/**
 * 上传图片文件并返回 mediaId（自动获取 AccessToken）
 * @param filePath - 图片文件路径
 * @param credentials - 钉钉凭证
 * @returns mediaId
 */
export async function uploadImage(filePath: string, credentials: DingtalkCredentials): Promise<string> {
  return uploadMediaWithCredentials(filePath, 'image', credentials);
}
