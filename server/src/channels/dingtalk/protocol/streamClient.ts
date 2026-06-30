/**
 * 钉钉 Stream WebSocket 连接模块
 *
 * 通过钉钉 Stream SDK 建立 WebSocket 长连接接收消息，
 * 无需公网 IP，适合内网环境。与 HTTP Webhook 模式并存。
 */

import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import type { DingtalkRobotConfig } from '../../../types/index.js';
import type { DingtalkMessageContext } from '../types.js';
import { dingtalkLogger } from '../../../utils/logger.js';
import { MESSAGE_DEDUP_TTL } from '../../../integrations/dingtalk/constants.js';
import { extractMessageContent } from './messageExtractor.js';
import { TTLCache } from '../../../utils/cache.js';

// ============ 消息去重 ============

const processedMessages = new TTLCache(MESSAGE_DEDUP_TTL, 60_000);

function isMessageProcessed(messageId: string): boolean {
  if (!messageId) return false;
  return processedMessages.has(messageId);
}

function markMessageProcessed(messageId: string): void {
  if (!messageId) return;
  processedMessages.set(messageId, 'processed');
}

// ============ Stream 客户端管理 ============

const activeClients: Map<string, DWClient> = new Map();

/**
 * 消息处理回调类型
 * 由外部（DingtalkChannel）提供具体的消息处理函数
 */
export type MessageHandler = (
  context: DingtalkMessageContext,
  robotId: string,
) => Promise<void>;

export interface DingtalkStreamConfig {
  mode?: 'webhook' | 'stream';
  robots?: Record<string, DingtalkRobotConfig>;
}

/**
 * 带指数退避的重连循环
 *
 * 禁用 DWClient 内部 autoReconnect（其 setTimeout(connect) 无 .catch 导致
 * unhandled rejection），由此函数全权管理连接生命周期。
 */
async function connectWithRetry(
  client: DWClient,
  robotId: string,
  robotName: string,
): Promise<void> {
  let backoffMs = 1_000;
  const MAX_BACKOFF = 60_000;
  let reconnecting = false; // 防止多次 close 事件并发触发重连

  const attemptConnect = async (): Promise<void> => {
    if (reconnecting) return;
    reconnecting = true;
    try {
      while (true) {
        try {
          await client.connect();
          backoffMs = 1_000; // 成功后重置退避
          dingtalkLogger.info(`[Stream] 机器人 "${robotName}" (${robotId}) 已连接`);

          // DWClient._connect() 每次创建新 socket，需重新绑定 close listener
          // socket 是 private 属性，但运行时可访问
          (client as any).socket?.on('close', () => {
            dingtalkLogger.warn(
              `[Stream][${robotId}] WebSocket 断开，${backoffMs / 1000}s 后重连...`,
            );
            setTimeout(() => attemptConnect().catch(() => {}), backoffMs);
          });
          return; // 连接成功，退出重试循环
        } catch (err: any) {
          dingtalkLogger.error(
            `[Stream][${robotId}] 连接失败: ${err.message}，${backoffMs / 1000}s 后重试`,
          );
          await new Promise((r) => setTimeout(r, backoffMs));
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
        }
      }
    } finally {
      reconnecting = false;
    }
  };

  await attemptConnect();
}

/**
 * 启动一个机器人的 Stream 连接
 */
async function startStreamClient(
  robotId: string,
  robotConfig: { appKey: string; appSecret: string; name: string },
  onMessage: MessageHandler,
): Promise<void> {
  if (activeClients.has(robotId)) {
    dingtalkLogger.warn(`[Stream] 机器人 ${robotId} 的连接已存在，跳过`);
    return;
  }

  // autoReconnect 在运行时存在但 constructor 类型签名缺失，用 as any 绕过
  const client = new DWClient({
    clientId: robotConfig.appKey,
    clientSecret: robotConfig.appSecret,
    debug: false,
    autoReconnect: false, // 禁用库内部无 catch 的重连，由 connectWithRetry 全权管理
  } as any);

  // EventEmitter 兜底：防止未处理的 error 事件抛异常
  client.on('error', (err: any) => {
    dingtalkLogger.error(`[Stream][${robotId}] Client error: ${err.message}`);
  });

  client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
    const messageId = res.headers?.messageId;

    // 立即 ACK 确认（钉钉 Stream 要求 60 秒内响应，否则重发）
    if (messageId) {
      client.socketCallBackResponse(messageId, { success: true });
    }

    // 消息去重
    if (messageId && isMessageProcessed(messageId)) {
      dingtalkLogger.warn(`[Stream][${robotId}] 重复消息，跳过: ${messageId}`);
      return;
    }
    if (messageId) {
      markMessageProcessed(messageId);
    }

    // 异步处理消息
    try {
      const data = JSON.parse(res.data);

      const { text: textContent, msgtype } = extractMessageContent(data);

      if (!textContent) {
        dingtalkLogger.debug(`[Stream][${robotId}] 消息内容为空，跳过`);
        return;
      }

      if (!data.conversationId) {
        dingtalkLogger.warn(`[Stream][${robotId}] 缺少 conversationId，跳过`);
        return;
      }

      dingtalkLogger.info(`[Stream][${robotId}] 收到消息: from=${data.senderNick}, type=${data.conversationType}, msgtype=${msgtype}`);

      // 构建与 Webhook 模式相同的消息上下文
      const context: DingtalkMessageContext = {
        conversationId: data.conversationId,
        content: textContent,
        sessionWebhook: data.sessionWebhook || '',
        senderNick: data.senderNick,
        senderId: data.senderStaffId || data.senderId,
        conversationType: data.conversationType,
        msgtype,
        downloadCode: data.content?.downloadCode,
        fileName: data.content?.fileName,
        fileType: data.content?.fileType,
      };

      await onMessage(context, robotId);
    } catch (error: any) {
      dingtalkLogger.error(`[Stream][${robotId}] 处理消息异常: ${error.message}`);
    }
  });

  await connectWithRetry(client, robotId, robotConfig.name);
  activeClients.set(robotId, client);
}

/**
 * 启动所有配置的机器人的 Stream 连接
 */
export async function startAllStreamClients(
  config: DingtalkStreamConfig,
  onMessage: MessageHandler,
): Promise<void> {
  if (config.mode !== 'stream') {
    return;
  }

  const robots = config.robots;
  if (!robots || Object.keys(robots).length === 0) {
    dingtalkLogger.warn('[Stream] 未配置任何机器人');
    return;
  }

  dingtalkLogger.info('[Stream] 正在启动 Stream 模式...');

  for (const [robotId, robotConfig] of Object.entries(robots)) {
    if (robotConfig.enabled === false) {
      dingtalkLogger.info(`[Stream] 机器人 ${robotId} 已禁用，跳过`);
      continue;
    }

    try {
      await startStreamClient(robotId, robotConfig, onMessage);
    } catch (error: any) {
      dingtalkLogger.error(`[Stream] 机器人 ${robotId} 启动失败: ${error.message}`);
    }
  }
}

/**
 * 停止所有 Stream 连接
 */
export function stopAllStreamClients(): void {
  for (const [robotId, client] of activeClients.entries()) {
    dingtalkLogger.info(`[Stream] 停止机器人 ${robotId}`);
    try {
      client.disconnect();
    } catch (err: any) {
      dingtalkLogger.error(`[Stream] 断开 ${robotId} 失败: ${err.message}`);
    }
  }
  activeClients.clear();
}
