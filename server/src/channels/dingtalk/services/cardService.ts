import {
  createAICard,
  streamAICard,
  updateAICardData,
  finishAICard,
  failAICard,
  buildTargetFromCallback,
  type AICardInstance,
} from '../../../integrations/dingtalk/aiCardApi.js';
import { dingtalkLogger } from '../../../utils/logger.js';
import type { DingtalkRobotConfig, DingtalkMessageDisplayConfig } from '../../../types/index.js';
import type { DingtalkMessageContext } from '../types.js';

export interface DingtalkCardServiceConfig {
  displayConfig?: DingtalkMessageDisplayConfig;
}

export class DingtalkCardService {
  constructor(private readonly config: DingtalkCardServiceConfig) {}

  async createForMessage(
    ctx: Pick<DingtalkMessageContext, 'conversationType' | 'conversationId' | 'senderId'>,
    robotConfig?: Pick<DingtalkRobotConfig, 'appKey' | 'appSecret'>,
  ): Promise<AICardInstance | null> {
    const useAICard = this.config.displayConfig?.useAICard !== false;
    if (!useAICard || !robotConfig?.appKey || !robotConfig?.appSecret) {
      return null;
    }

    const target = buildTargetFromCallback({
      conversationType: ctx.conversationType,
      conversationId: ctx.conversationId,
      senderStaffId: ctx.senderId,
    });

    const card = await createAICard(
      { appKey: robotConfig.appKey, appSecret: robotConfig.appSecret },
      target,
    );

    if (card) {
      dingtalkLogger.info('[AICard] 创建成功，将使用流式卡片模式');
    } else {
      dingtalkLogger.warn('[AICard] 创建失败，降级为普通消息模式');
    }

    return card;
  }

  async stream(card: AICardInstance, key: string, content: string): Promise<void> {
    await streamAICard(card, key, content);
  }

  async updateData(card: AICardInstance, data: Record<string, string>): Promise<void> {
    await updateAICardData(card, data);
  }

  async finish(card: AICardInstance, content: string, lastMessage?: string): Promise<void> {
    await finishAICard(card, content, lastMessage);
  }

  async fail(card: AICardInstance, errorMessage: string): Promise<void> {
    await failAICard(card, errorMessage);
  }
}

export type { AICardInstance };
