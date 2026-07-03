import { shouldSendDingtalkBlockStart, shouldSendDingtalkBlockComplete, getDingtalkDisplayConfig } from './displayFilter.js';
import { dingtalkLogger } from '../../../utils/logger.js';
import { createEventConsumer, type EventHandler } from '../../eventConsumer.js';
import type { OutboundEvent, DingtalkMessageDisplayConfig } from '../../../types/index.js';
import {
  AI_CARD_THROTTLE,
  MEDIA_MARKER_CLEAN_RE,
  LOCAL_IMAGE_RE,
  BARE_IMAGE_PATH_RE,
} from '../../../integrations/dingtalk/constants.js';
import { DingtalkCardService } from '../services/index.js';
import type { DingtalkDeliveryService } from '../services/index.js';
import type { DingtalkConsumeSummary, PreparedDingtalkMessage } from './types.js';

/**
 * 清理媒体标记和本地路径，避免暴露给用户。
 * Card 模式：流式展示时隐藏未处理的媒体引用。
 * 非 Card 模式：发送前清除标记（媒体由 postprocessor 独立发送）。
 */
function cleanMediaForDisplay(text: string): string {
  return text
    .replace(MEDIA_MARKER_CLEAN_RE, '')
    .replace(LOCAL_IMAGE_RE, '')
    .replace(BARE_IMAGE_PATH_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface DingtalkEventStreamConsumerConfig {
  displayConfig?: DingtalkMessageDisplayConfig;
}

export class DingtalkEventStreamConsumer {
  constructor(
    private readonly config: DingtalkEventStreamConsumerConfig,
    private readonly cardService: DingtalkCardService,
    private readonly deliveryService: DingtalkDeliveryService,
  ) {}

  async consume(
    events: AsyncGenerator<OutboundEvent>,
    prepared: PreparedDingtalkMessage,
  ): Promise<DingtalkConsumeSummary> {
    const cardService = this.cardService;
    const deliveryService = this.deliveryService;
    const displayConfig = getDingtalkDisplayConfig(this.config.displayConfig);
    const { sendStatus, sendMessage } = prepared.messageHelpers;
    const card = prepared.card;

    let aiCardAccumulated = '';
    let lastAICardUpdate = 0;
    let hasSentText = false;
    let hasStartedThinking = false;
    let needsBlockSeparator = false;
    const sentToolStarts = new Set<string>();
    const sentToolResults = new Set<string>();

    // Card 模式：
    // - 状态信息通过 preparations 变量在卡片内展示步骤列表
    // - 文本由 content 变量流式展示，不走 sendMessage 避免重复
    // 非 Card 模式：状态通过 sendStatus 发独立消息，文本通过 sendMessage 发送
    //
    // 立即发送空的 streaming 事件激活卡片，使其从初始化状态进入「输入中」状态，
    // 这样后续通过 updateData 更新的 preparations 才能即时可见。
    if (card) {
      await cardService.stream(card, 'content', '');
    }

    const preparations: Array<{name: string}> = [];
    const effectiveSendStatus = card
      ? async (status: string) => {
          preparations.push({ name: status });
          await cardService.updateData(card, { preparations: JSON.stringify(preparations) });
        }
      : sendStatus;
    const effectiveSendMessage = card ? async (_content: string, _msgType: 'text' | 'markdown') => {} : sendMessage;

    const handler: EventHandler = {
      onSessionInit(sessionId) {
        dingtalkLogger.debug(`Session: ${sessionId}`);
      },

      async onThinkingStart() {
        if (!hasStartedThinking && shouldSendDingtalkBlockStart('thinking', undefined, displayConfig)) {
          hasStartedThinking = true;
          await effectiveSendStatus('正在思考...');
        }
      },

      async onTextDelta(content) {
        if (!card) return;

        // 多个文本块之间插入换行，让每轮输出在卡片中视觉分隔
        if (needsBlockSeparator && aiCardAccumulated) {
          aiCardAccumulated += '\n\n';
          needsBlockSeparator = false;
        }
        aiCardAccumulated += content;
        const now = Date.now();
        if (now - lastAICardUpdate < AI_CARD_THROTTLE) {
          return;
        }

        const displayContent = cleanMediaForDisplay(aiCardAccumulated);
        await cardService.stream(card, 'content', displayContent);
        lastAICardUpdate = now;
      },

      async onTextEnd(blockText) {
        needsBlockSeparator = true;
        if (!blockText || !blockText.trim()) {
          return;
        }
        // 非 Card 模式：清理媒体标记后再发送，避免暴露原始标记和本地路径
        const textToSend = card ? blockText : cleanMediaForDisplay(blockText);
        if (!textToSend) {
          return;
        }
        dingtalkLogger.debug(`发送文本 (${textToSend.length}字): ${textToSend}`);
        hasSentText = true;
        await effectiveSendMessage(textToSend, 'markdown');
      },

      async onToolStart(toolId, toolName) {
        if (toolName === 'Skill' || sentToolStarts.has(toolId)) {
          return;
        }
        if (!shouldSendDingtalkBlockStart('tool_use', toolName, displayConfig)) {
          return;
        }
        sentToolStarts.add(toolId);
        await effectiveSendStatus(`正在调用 ${toolName}...`);
      },

      async onToolEnd(toolId, resolvedToolName) {
        if (sentToolStarts.has(toolId)) {
          return;
        }
        if (!shouldSendDingtalkBlockStart('tool_use', resolvedToolName, displayConfig)) {
          return;
        }
        sentToolStarts.add(toolId);
        await effectiveSendStatus(`正在调用 ${resolvedToolName}...`);
      },

      async onToolResult(toolId, toolName, result) {
        if (sentToolResults.has(toolId)) {
          return;
        }
        sentToolResults.add(toolId);
        dingtalkLogger.debug(`${toolName} 完成: ${result}`);
        if (shouldSendDingtalkBlockComplete('tool_use', toolName, displayConfig)) {
          await effectiveSendStatus(`${toolName} 执行完成`);
        }
      },

      // /compact v2：压缩过程黑箱化——钉钉端只收到状态提示与完成确认，不收摘要正文
      async onCompactionStart() {
        await effectiveSendStatus('正在压缩上下文...');
      },

      async onCompactionEnd(data) {
        const text = data?.skipped
          ? (data.note ?? '当前会话历史很短，无需压缩。')
          : `✅ 上下文已压缩：${data?.coveredEventCount ?? 0} 条较早历史已被摘要替代，最近对话原文保留。`;
        if (card) {
          if (needsBlockSeparator && aiCardAccumulated) {
            aiCardAccumulated += '\n\n';
            needsBlockSeparator = false;
          }
          aiCardAccumulated += text;
          await cardService.stream(card, 'content', cleanMediaForDisplay(aiCardAccumulated));
        } else {
          hasSentText = true;
          await sendMessage(text, 'markdown');
        }
      },

      async onError(error) {
        if (card) {
          try {
            await cardService.fail(card, `处理出错: ${error}`);
          } catch {
            // ignore secondary error
          }
        }
        await deliveryService.sendMessage({
          sessionWebhook: prepared.source.sessionWebhook,
          content: `处理消息时出错: ${error}`,
          msgType: 'text',
        });
      },

      async onFinally() {
        if (!card || !aiCardAccumulated) {
          return;
        }
        const displayContent = cleanMediaForDisplay(aiCardAccumulated);
        await cardService.stream(card, 'content', displayContent);
      },
    };

    const consumer = createEventConsumer();
    const result = await consumer.consume(events, handler);

    return {
      sessionId: result.sessionId,
      finalText: result.finalText,
      aiCardAccumulated,
      hasSentText,
    };
  }
}
