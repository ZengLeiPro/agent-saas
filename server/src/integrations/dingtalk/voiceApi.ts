/**
 * 语音发送整合模块
 * 整合 TTS 和钉钉媒体上传功能，提供一站式语音消息发送
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { textToSpeechWithConfig } from '../tts/ttsClient.js';
import type { TTSGlobalConfig } from '../tts/ttsClient.js';
import { uploadVoice, sendVoiceBySession } from './mediaApi.js';
import type { DingtalkCredentials } from './mediaApi.js';

// ============== 类型定义 ==============

/** 语音发送选项 */
export interface VoiceSendOptions {
  /** 要转为语音的文本 */
  text: string;
  /** 钉钉 sessionWebhook */
  sessionWebhook: string;
  /** 音色，默认 cancan */
  voice?: string;
  /** 语速 0.5-2.0，默认 1.2 */
  speed?: number;
  /** TTS 配置（从 config.json 注入） */
  ttsConfig?: TTSGlobalConfig;
  /** 钉钉凭证（用于上传语音到钉钉） */
  credentials?: DingtalkCredentials;
}

/** 语音发送结果 */
export interface VoiceSendResult {
  /** 是否成功 */
  success: boolean;
  /** 钉钉媒体 ID */
  mediaId?: string;
  /** 音频时长（毫秒） */
  duration?: number;
  /** 错误信息 */
  error?: string;
}

// ============== 常量 ==============

/** 临时文件目录 */
const TEMP_DIR = path.join(os.tmpdir(), 'dingtalk-voice');

// ============== 内部函数 ==============

/**
 * 确保临时目录存在
 */
function ensureTempDir(): void {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

/**
 * 生成临时文件路径
 * @returns 临时文件路径
 */
function generateTempFilePath(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return path.join(TEMP_DIR, `voice_${timestamp}_${random}.mp3`);
}

/**
 * 安全删除文件
 * @param filePath - 文件路径
 */
function safeDeleteFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // 忽略删除失败的错误
  }
}

// ============== 导出函数 ==============

/**
 * 发送语音消息
 * 将文本转换为语音并通过钉钉 sessionWebhook 发送
 *
 * @param options - 发送选项
 * @returns 发送结果
 *
 * @example
 * ```typescript
 * const result = await sendVoiceMessage({
 *   text: '你好，这是一条语音消息',
 *   sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=xxx',
 *   voice: 'cancan',
 *   speed: 1.2
 * });
 *
 * if (result.success) {
 *   console.log('发送成功，mediaId:', result.mediaId);
 * } else {
 *   console.error('发送失败:', result.error);
 * }
 * ```
 */
export async function sendVoiceMessage(options: VoiceSendOptions): Promise<VoiceSendResult> {
  const { text, sessionWebhook, voice = 'cancan', speed = 1.2, ttsConfig, credentials } = options;

  // 验证参数
  if (!text || text.trim().length === 0) {
    return { success: false, error: '文本内容不能为空' };
  }

  if (!sessionWebhook) {
    return { success: false, error: 'sessionWebhook 不能为空' };
  }

  if (!ttsConfig) {
    return { success: false, error: 'ttsConfig 未提供' };
  }

  if (!credentials) {
    return { success: false, error: 'credentials 未提供' };
  }

  // 生成临时文件路径
  ensureTempDir();
  const tempFilePath = generateTempFilePath();

  try {
    // 1. 文本转语音
    const ttsResult = await textToSpeechWithConfig(text, tempFilePath, ttsConfig, {
      voice,
      speed,
    });

    // 2. 上传到钉钉
    const mediaId = await uploadVoice(ttsResult.filePath, credentials);

    // 3. 发送语音消息
    const sendResult = await sendVoiceBySession(sessionWebhook, mediaId, ttsResult.duration);

    // 检查发送结果
    if (sendResult.errcode && sendResult.errcode !== 0) {
      return {
        success: false,
        mediaId,
        duration: ttsResult.duration,
        error: `发送失败: ${sendResult.errmsg || '未知错误'}`,
      };
    }

    // 4. 清理临时文件
    safeDeleteFile(tempFilePath);

    return {
      success: true,
      mediaId,
      duration: ttsResult.duration,
    };
  } catch (err) {
    // 确保清理临时文件
    safeDeleteFile(tempFilePath);

    // 返回错误信息
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * 批量发送语音消息
 * 将相同文本发送到多个 sessionWebhook
 *
 * @param text - 要转为语音的文本
 * @param sessionWebhooks - sessionWebhook 数组
 * @param options - 可选配置
 * @returns 发送结果数组
 */
export async function sendVoiceMessageBatch(
  text: string,
  sessionWebhooks: string[],
  options?: { voice?: string; speed?: number; ttsConfig?: TTSGlobalConfig; credentials?: DingtalkCredentials }
): Promise<VoiceSendResult[]> {
  const { voice = 'cancan', speed = 1.2, ttsConfig, credentials } = options || {};

  if (!text || text.trim().length === 0) {
    return sessionWebhooks.map(() => ({ success: false, error: '文本内容不能为空' }));
  }

  if (!sessionWebhooks || sessionWebhooks.length === 0) {
    return [];
  }

  if (!ttsConfig || !credentials) {
    return sessionWebhooks.map(() => ({ success: false, error: 'ttsConfig 或 credentials 未提供' }));
  }

  // 生成临时文件路径
  ensureTempDir();
  const tempFilePath = generateTempFilePath();

  try {
    // 1. 文本转语音（只转换一次）
    const ttsResult = await textToSpeechWithConfig(text, tempFilePath, ttsConfig, {
      voice,
      speed,
    });

    // 2. 上传到钉钉（只上传一次）
    const mediaId = await uploadVoice(ttsResult.filePath, credentials);

    // 3. 发送到所有 sessionWebhook
    const results: VoiceSendResult[] = [];

    for (const webhook of sessionWebhooks) {
      try {
        const sendResult = await sendVoiceBySession(webhook, mediaId, ttsResult.duration);

        if (sendResult.errcode && sendResult.errcode !== 0) {
          results.push({
            success: false,
            mediaId,
            duration: ttsResult.duration,
            error: `发送失败: ${sendResult.errmsg || '未知错误'}`,
          });
        } else {
          results.push({
            success: true,
            mediaId,
            duration: ttsResult.duration,
          });
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        results.push({
          success: false,
          mediaId,
          duration: ttsResult.duration,
          error: errorMessage,
        });
      }
    }

    // 4. 清理临时文件
    safeDeleteFile(tempFilePath);

    return results;
  } catch (err) {
    // 确保清理临时文件
    safeDeleteFile(tempFilePath);

    // 返回错误信息
    const errorMessage = err instanceof Error ? err.message : String(err);
    return sessionWebhooks.map(() => ({
      success: false,
      error: errorMessage,
    }));
  }
}
