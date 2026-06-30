/**
 * 钉钉 Webhook 路由
 *
 * 接收钉钉 HTTP 模式推送的消息，异步处理后通过 sessionWebhook 回复。
 * 路由：POST /webhook/:robotId
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { TTLCache } from '../../../utils/cache.js';
import { dingtalkLogger } from '../../../utils/logger.js';
import { verifyDingtalkSignature } from './signature.js';
import { extractMessageContent } from './messageExtractor.js';
import type { DingtalkChannel } from '../channel.js';
import type { DingtalkRobotConfig } from '../../../types/index.js';

export interface DingtalkWebhookRouterOptions {
  robots?: Record<string, DingtalkRobotConfig>;
  channel: DingtalkChannel;
}

/**
 * 创建钉钉 Webhook 路由
 */
export function createDingtalkWebhookRouter(options: DingtalkWebhookRouterOptions): Router {
  const { robots: configuredRobots, channel } = options;
  const router = Router();
  const robots = configuredRobots ?? {};

  // 消息去重缓存（5 分钟 TTL，每分钟清理一次）
  const processedMessages = new TTLCache(5 * 60 * 1000, 60 * 1000);

  router.post('/webhook/:robotId', async (req: Request, res: Response) => {
    const robotId = decodeURIComponent(req.params.robotId || '');

    // 1. 查找机器人配置
    const robotConfig: DingtalkRobotConfig | undefined = robots[robotId];
    if (!robotConfig) {
      res.status(404).json({ success: false, message: '未知的机器人', robotId });
      return;
    }
    if (robotConfig.enabled === false) {
      res.status(403).json({ success: false, message: '机器人已禁用', robotId });
      return;
    }

    // 2. 签名验证
    const shouldVerify = robotConfig.verifySignature !== false;
    const timestamp = req.headers['timestamp'] as string | undefined;
    const sign = req.headers['sign'] as string | undefined;

    if (shouldVerify) {
      if (!timestamp && !sign) {
        dingtalkLogger.warn(`签名验证已开启但未收到签名头 [${robotId}]`);
        res.status(403).json({ success: false, message: 'Missing signature headers' });
        return;
      }
      const result = verifyDingtalkSignature(timestamp, sign, robotConfig.appSecret);
      if (!result.valid) {
        dingtalkLogger.warn(`签名验证失败 [${robotId}]: ${result.reason}`);
        res.status(403).json({ success: false, message: 'Signature verification failed' });
        return;
      }
    }

    // 3. 校验请求体
    const body = req.body;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ success: false, message: '请求体必须为 JSON 对象' });
      return;
    }

    const conversationId: string | undefined = body.conversationId;
    const sessionWebhook: string | undefined = body.sessionWebhook;
    const senderNick: string | undefined = body.senderNick;
    const senderId: string = body.senderStaffId || body.senderId || '';
    const conversationType: string | undefined = body.conversationType;
    const msgId: string = body.msgId || `${body.chatbotCorpId}_${body.createAt}_${conversationId}`;
    const msgtype: string = body.msgtype || 'text';

    // 提取消息内容（支持多种消息类型）
    const extracted = extractMessageContent(body);
    const text = extracted.text;

    if (!conversationId || !text || !sessionWebhook) {
      res.status(400).json({
        success: false,
        message: '缺少必要字段',
        required: ['conversationId', 'content', 'sessionWebhook'],
      });
      return;
    }

    // sessionWebhook 格式校验
    if (!sessionWebhook.startsWith('https://oapi.dingtalk.com/')) {
      res.status(400).json({ success: false, message: '无效的 sessionWebhook' });
      return;
    }

    dingtalkLogger.info(`收到 [${robotConfig.name}] 消息: ${senderNick} (${conversationType === '1' ? '私聊' : '群聊'})`);
    dingtalkLogger.debug(`conversationId=${conversationId}, msgId=${msgId}`);
    dingtalkLogger.info(`[USER] ${senderNick}: ${text}`);

    // 4. 消息去重
    if (processedMessages.has(msgId)) {
      dingtalkLogger.debug(`跳过重复消息: ${msgId}`);
      res.json({ success: true, message: 'duplicate, skipped' });
      return;
    }
    processedMessages.set(msgId, 'processing');

    // 5. 立即返回 200，后台异步处理
    res.json({ success: true, message: '正在后台处理', robotId });

    // 6. 异步处理消息（通过 DingtalkChannel）
    channel.processMessage(
      {
        conversationId,
        content: text,
        sessionWebhook,
        senderNick,
        senderId,
        conversationType,
        msgtype,
        downloadCode: body.content?.downloadCode,
        fileName: body.content?.fileName,
        fileType: body.content?.fileType,
      },
      robotId,
    ).then(() => {
      dingtalkLogger.info(`消息处理完成: ${msgId}`);
    }).catch((err) => {
      dingtalkLogger.error(`处理钉钉消息失败 (${msgId}):`, err);
    });
  });

  return router;
}
