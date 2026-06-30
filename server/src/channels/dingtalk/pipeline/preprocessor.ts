import type { DingtalkRobotConfig, InboundMessage, ChannelContext, UserIdentity } from '../../../types/index.js';
import type { UserStore } from '../../../data/users/store.js';
import type { TenantStore } from '../../../data/tenants/store.js';
import { checkTenantAccess } from '../../../data/tenants/access.js';
import type { DingtalkMetadata } from '../services/sessionWebhookSender.js';
import type { DingtalkMessageContext } from '../types.js';
import { buildMediaSystemPrompt } from './mediaPostprocess.js';
import {
  DingtalkCardService,
  DingtalkMediaService,
} from '../services/index.js';
import type {
  DingtalkSessionService,
  DingtalkDeliveryService,
} from '../services/index.js';
import type { PreparedDingtalkMessage } from './types.js';

interface FollowupPayload {
  runId: string;
  question: string;
}

export interface FollowupContextResult {
  context: string;
  question: string;
}

export type ResolveFollowupContext = (
  runId: string,
  question: string,
) => Promise<FollowupContextResult>;

export interface DingtalkPreprocessorConfig {
  robots?: Record<string, DingtalkRobotConfig>;
  timezone?: string;
}

export class DingtalkPreprocessor {
  constructor(
    private readonly config: DingtalkPreprocessorConfig,
    private readonly sessionService: DingtalkSessionService,
    private readonly deliveryService: DingtalkDeliveryService,
    private readonly cardService: DingtalkCardService,
    private readonly mediaService: DingtalkMediaService,
    private readonly resolveFollowupContext?: ResolveFollowupContext,
    private readonly userStore?: UserStore,
    private readonly tenantStore?: TenantStore,
  ) {}

  async prepare(
    source: DingtalkMessageContext,
    robotId?: string,
  ): Promise<PreparedDingtalkMessage | null> {
    const robotConfig = this.resolveRobotConfig(robotId);
    const messageHelpers = this.deliveryService.createMessageHelpers(source);
    const existingSession = this.sessionService.getAgentSession(source.conversationId);
    const card = await this.cardService.createForMessage(source, robotConfig);

    const followup = this.parseFollowup(source.content);
    let followupContext = '';
    let userQuestion = source.content;

    if (followup && this.resolveFollowupContext) {
      const followupResult = await this.resolveFollowupContext(followup.runId, followup.question);
      followupContext = followupResult.context;
      userQuestion = followupResult.question;
    }

    const attachments = await this.mediaService.downloadInboundAttachments(source, robotConfig);

    // 处理缓冲合并的额外媒体消息
    if (source._bufferedMedia) {
      for (const mediaCtx of source._bufferedMedia) {
        const extra = await this.mediaService.downloadInboundAttachments(mediaCtx, robotConfig);
        attachments.push(...extra);
      }
    }

    const isResumedSession = !!existingSession;
    const systemContext = this.buildSystemContext(source, followupContext, isResumedSession);

    const inbound: InboundMessage = {
      channel: 'dingtalk',
      chatId: source.conversationId,
      content: userQuestion,
      senderId: source.senderId,
      senderName: source.senderNick,
      attachments: attachments.length > 0 ? attachments : undefined,
      metadata: {
        sessionWebhook: source.sessionWebhook,
        senderNick: source.senderNick,
        senderId: source.senderId,
        conversationType: source.conversationType,
        robotId,
      } as DingtalkMetadata,
    };

    let user: UserIdentity | undefined;
    if (this.userStore && source.senderId) {
      const record = this.userStore.findByDingtalkStaffId(source.senderId);
      if (record) {
        if (record.disabled) {
          return null;
        }
        const tenantAccess = checkTenantAccess(this.tenantStore, record.tenantId);
        if (!tenantAccess.ok) {
          return null;
        }
        user = {
          id: record.id,
          username: record.username,
          role: record.role,
          tenantId: record.tenantId,
          realName: record.realName,
          externalId: source.senderId,
          dingtalkStaffId: record.dingtalkStaffId,
          permissions: record.permissions,
        };
      }
    }

    const context: ChannelContext = {
      channel: 'dingtalk',
      resumeSessionId: existingSession,
      systemContext,
      timezone: this.config.timezone,
      ...(user ? { user } : {}),
    };

    const mediaTarget = source.conversationType === '1'
      ? { type: 'user' as const, userId: source.senderId || '' }
      : { type: 'group' as const, openConversationId: source.conversationId };

    return {
      inbound,
      context,
      source,
      robotId,
      robotConfig,
      robotCredentials: this.mediaService.resolveRobotCredentials(robotConfig),
      mediaTarget,
      messageHelpers,
      card,
    };
  }

  private resolveRobotConfig(robotId?: string): DingtalkRobotConfig | undefined {
    if (!robotId) return undefined;
    return this.config.robots?.[robotId];
  }

  /**
   * 构建注入到 user message 前的系统上下文。
   *
   * 恢复会话时只携带最小元数据（senderNick / conversationType），
   * 避免媒体规则、sessionWebhook 等静态内容在每轮对话中重复累积。
   */
  private buildSystemContext(
    source: DingtalkMessageContext,
    followupContext: string,
    isResumedSession: boolean,
  ): string {
    if (isResumedSession) {
      // 恢复会话：仅保留必要的每条消息元数据
      const meta = `[钉钉消息上下文]\nsenderNick: ${source.senderNick}\nconversationType: ${source.conversationType === '1' ? '私聊' : '群聊'}`;
      return followupContext ? `${meta}\n\n${followupContext}` : meta;
    }

    // 新会话首条消息：包含完整上下文
    const mediaPrompt = buildMediaSystemPrompt();
    return `[钉钉消息上下文]
sessionWebhook: ${source.sessionWebhook}
conversationId: ${source.conversationId}
senderNick: ${source.senderNick}
conversationType: ${source.conversationType === '1' ? '私聊' : '群聊'}
${followupContext ? `\n\n${followupContext}\n` : ''}

${mediaPrompt}`;
  }

  private parseFollowup(content: string): FollowupPayload | null {
    const text = String(content || '').trim();
    const match = /^追问\s+([0-9]{13}-[0-9a-fA-F-]{36})(?:\s+([\s\S]+))?$/.exec(text);
    if (!match) {
      return null;
    }

    return {
      runId: match[1],
      question: (match[2] || '').trim(),
    };
  }
}
