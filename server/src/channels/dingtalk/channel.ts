/**
 * DingTalk Channel
 *
 * 作为钉钉协议适配层：
 * - 注册 Webhook / Stream 入口
 * - 将消息交给 pipeline 处理
 * - 维护最小的通道级错误兜底
 */

import { dingtalkLogger } from '../../utils/logger.js';
import { createDingtalkWebhookRouter } from './protocol/webhookRouter.js';
import { startAllStreamClients, stopAllStreamClients } from './protocol/streamClient.js';
import {
  DingtalkCardService,
  DingtalkMediaService,
  DingtalkVoiceService,
  isResetCommand,
  handleResetCommand,
  isModelCommand,
  handleModelCommand,
} from './services/index.js';
import type {
  DingtalkSessionService,
  DingtalkDeliveryService,
  ModelResolver,
} from './services/index.js';
import {
  DingtalkPreprocessor,
  DingtalkEventStreamConsumer,
  DingtalkPostprocessor,
  type PreparedDingtalkMessage,
  type ResolveFollowupContext,
} from './pipeline/index.js';
import { DEFAULT_TENANT_ID } from '../../data/tenants/types.js';

import type { Express } from 'express';
import type {
  BaseChannel,
  SendOptions,
  DingtalkRobotConfig,
  DingtalkMessageDisplayConfig,
  TtsConfig,
} from '../../types/index.js';
import type { AgentRunDispatch } from '../../agent/types.js';
import type { PublicModelList } from '../../app/models.js';
import { toRunModelOptions } from '../../app/models.js';
import type { UserStore } from '../../data/users/store.js';
import type { TenantStore } from '../../data/tenants/store.js';
import type { TokenUsageStore } from '../../data/usage/store.js';
import type { DingtalkMessageContext } from './types.js';
import { MessageBuffer } from './services/messageBuffer.js';

export interface DingtalkChannelConfig {
  mode?: 'webhook' | 'stream';
  robots?: Record<string, DingtalkRobotConfig>;
  timezone?: string;
  displayConfig?: DingtalkMessageDisplayConfig;
  tts?: TtsConfig;
  uploadsDir?: string;
  messageBufferMs?: number;
  agentCwd?: string;
  modelResolver?: ModelResolver;
  modelList?: PublicModelList | null;
  tokenUsageStore?: TokenUsageStore;
}

export interface DingtalkChannelDeps {
  sessionService: DingtalkSessionService;
  deliveryService: DingtalkDeliveryService;
  resolveFollowupContext?: ResolveFollowupContext;
  userStore?: UserStore;
  tenantStore?: TenantStore;
}

export class DingtalkChannel implements BaseChannel {
  readonly name = 'dingtalk' as const;
  private readonly mode: 'webhook' | 'stream';
  private readonly sessionService: DingtalkSessionService;
  private readonly deliveryService: DingtalkDeliveryService;
  private readonly cardService: DingtalkCardService;
  private readonly preprocessor: DingtalkPreprocessor;
  private readonly streamConsumer: DingtalkEventStreamConsumer;
  private readonly postprocessor: DingtalkPostprocessor;
  private readonly messageBuffer?: MessageBuffer;

  constructor(
    private readonly config: DingtalkChannelConfig,
    private readonly dispatch: AgentRunDispatch,
    deps: DingtalkChannelDeps,
  ) {
    this.mode = config.mode || 'webhook';

    this.sessionService = deps.sessionService;
    this.deliveryService = deps.deliveryService;
    this.cardService = new DingtalkCardService({ displayConfig: config.displayConfig });
    const mediaService = new DingtalkMediaService({ uploadsDir: config.uploadsDir });
    const voiceService = new DingtalkVoiceService({ tts: config.tts });

    this.preprocessor = new DingtalkPreprocessor(
      {
        robots: config.robots,
        timezone: config.timezone,
      },
      this.sessionService,
      this.deliveryService,
      this.cardService,
      mediaService,
      deps.resolveFollowupContext,
      deps.userStore,
      deps.tenantStore,
    );
    this.streamConsumer = new DingtalkEventStreamConsumer(
      { displayConfig: config.displayConfig },
      this.cardService,
      this.deliveryService,
    );
    this.postprocessor = new DingtalkPostprocessor(
      this.sessionService,
      voiceService,
      this.cardService,
      config.agentCwd,
    );

    if (config.messageBufferMs) {
      this.messageBuffer = new MessageBuffer(
        config.messageBufferMs,
        (ctx, rid) => this.processMessage(ctx, rid),
      );
      dingtalkLogger.info(`[Buffer] 消息聚合缓冲已启用 (${config.messageBufferMs}ms)`);
    }
  }

  async start(app: Express): Promise<void> {
    const robots = this.config.robots ?? {};
    const robotCount = Object.keys(robots).length;
    const enabledCount = Object.values(robots).filter((robot) => robot.enabled !== false).length;

    if (this.mode === 'webhook') {
      // 消息入口路由由通道自行注册；控制面查询路由统一在 app/routes.ts 注册。
      app.use('/api/dingtalk', createDingtalkWebhookRouter({
        robots,
        channel: this,
      }));
      dingtalkLogger.info(`Webhook 模式已启用 (${enabledCount}/${robotCount} 个机器人)`);
    }

    if (this.mode === 'stream') {
      await startAllStreamClients(
        {
          mode: this.mode,
          robots,
        },
        async (ctx, robotId) => {
          await this.processMessage(ctx, robotId);
        },
      );
      dingtalkLogger.info(`Stream 模式已启用 (${enabledCount}/${robotCount} 个机器人)`);
    }
  }

  async stop(): Promise<void> {
    this.messageBuffer?.dispose();
    stopAllStreamClients();
  }

  async send(options: SendOptions): Promise<void> {
    const session = this.sessionService.loadSessions()[options.chatId];
    if (!session?.sessionWebhook) {
      dingtalkLogger.warn(`send() 失败: chatId=${options.chatId} 无可用 sessionWebhook`);
      return;
    }

    await this.deliveryService.sendMessage({
      sessionWebhook: session.sessionWebhook,
      content: options.content,
      msgType: options.msgType || 'markdown',
    });
  }

  async processMessage(ctx: DingtalkMessageContext, robotId?: string): Promise<void> {
    const resetHelpers = this.deliveryService.createMessageHelpers(ctx);
    let prepared: PreparedDingtalkMessage | null = null;

    try {
      if (isResetCommand(ctx.content)) {
        await handleResetCommand(
          ctx.conversationId,
          resetHelpers.sendStatus,
          (id) => this.sessionService.clearSession(id),
        );
        return;
      }

      if (isModelCommand(ctx.content)) {
        await handleModelCommand(ctx.content, ctx.conversationId, resetHelpers.sendStatus, {
          getModelRef: (id) => this.sessionService.getModelRef(id),
          saveModelRef: (id, ref) => this.sessionService.saveModelRef(id, ref),
          modelList: this.config.modelList ?? null,
          modelResolver: this.config.modelResolver,
        });
        return;
      }

      // 媒体消息缓冲：等待后续文字消息合并
      if (this.messageBuffer && this.messageBuffer.receive(ctx, robotId)) {
        return;
      }

      prepared = await this.preprocessor.prepare(ctx, robotId);
      if (!prepared) return;

      dingtalkLogger.separator();
      dingtalkLogger.info('开始处理消息...');

      // 读取会话级模型选择
      const modelRef = this.sessionService.getModelRef(ctx.conversationId);
      const resolved = modelRef && this.config.modelResolver
        ? this.config.modelResolver(modelRef)
        : undefined;
      const modelOptions = resolved ? toRunModelOptions(resolved) : {};

      const events = this.dispatch(prepared.inbound, prepared.context, modelOptions, {
        onResult: (meta) => {
          const user = prepared?.context.user;
          const tokenStore = this.config.tokenUsageStore;
          if (!tokenStore || !user || !meta.modelUsage || Object.keys(meta.modelUsage).length === 0) return;
          try {
            tokenStore.recordResult({
              username: user.username,
              tenantId: user.tenantId ?? DEFAULT_TENANT_ID,
              channel: 'dingtalk',
              modelUsage: meta.modelUsage,
              occurredAtMs: Date.now(),
            });
          } catch (err) {
            dingtalkLogger.warn(`[token-usage] dingtalk record failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      });
      const consumed = await this.streamConsumer.consume(events, prepared);

      dingtalkLogger.info(`处理完成 | 已发送文本: ${consumed.hasSentText} | 最终文本长度: ${consumed.finalText.length}`);
      dingtalkLogger.separator();

      await this.postprocessor.process({ prepared, consumed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dingtalkLogger.error('处理消息错误:', error);

      if (prepared?.card) {
        try {
          await this.cardService.fail(prepared.card, `处理出错: ${message}`);
        } catch (failErr: any) {
          dingtalkLogger.error('[AICard] 设置错误状态也失败:', failErr.message);
        }
      }

      try {
        await this.deliveryService.sendMessage({
          sessionWebhook: ctx.sessionWebhook,
          content: `处理消息时出错: ${message}`,
          msgType: 'text',
          senderNick: ctx.senderNick,
          conversationType: ctx.conversationType,
        });
      } catch (deliveryErr) {
        dingtalkLogger.error(
          `[Undelivered] 错误消息无法送达用户 (conversationId=${ctx.conversationId}): ${message}`,
        );
      }
    }
  }
}
