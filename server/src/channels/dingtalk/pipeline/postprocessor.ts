import { dingtalkLogger } from '../../../utils/logger.js';
import type { ChannelContext } from '../../../types/index.js';
import { getTranscriptPath } from '../../../data/transcripts/store.js';
import { readSessionMeta, writeSessionMeta, type SessionMeta } from '../../../data/transcripts/meta.js';
import { resolveUserCwd } from '../../../workspace/resolver.js';
import {
  DingtalkVoiceService,
  DingtalkCardService,
} from '../services/index.js';
import type { DingtalkSessionService } from '../services/index.js';
import {
  processLocalImages,
  processVideoMarkers,
  processAudioMarkers,
  processFileMarkers,
} from './mediaPostprocess.js';
import type { DingtalkPostprocessInput } from './types.js';

export class DingtalkPostprocessor {
  constructor(
    private readonly sessionService: DingtalkSessionService,
    private readonly voiceService: DingtalkVoiceService,
    private readonly cardService: DingtalkCardService,
    private readonly agentCwd?: string,
  ) {}

  async process(input: DingtalkPostprocessInput): Promise<void> {
    const { prepared, consumed } = input;
    this.persistSession(prepared.source, consumed.sessionId, prepared.context);

    const rawText = consumed.finalText || consumed.aiCardAccumulated || '';
    const processedText = await this.postProcessText(rawText, input);
    await this.deliverFinal(prepared, consumed.hasSentText, processedText);
  }

  private persistSession(
    source: DingtalkPostprocessInput['prepared']['source'],
    sessionId: string | undefined,
    context: ChannelContext,
  ): void {
    if (!sessionId) {
      return;
    }

    this.sessionService.saveAgentSession({
      conversationId: source.conversationId,
      agentSessionId: sessionId,
      sessionWebhook: source.sessionWebhook,
      senderNick: source.senderNick || '',
      senderId: source.senderId || '',
      conversationType: source.conversationType || '',
    });

    if (context.user && this.agentCwd) {
      const effectiveCwd = resolveUserCwd(this.agentCwd, { id: context.user.id, username: context.user.username, role: context.user.role as 'admin' | 'user', tenantId: context.user.tenantId });
      const transcriptPath = getTranscriptPath(effectiveCwd, sessionId, { tenantId: context.user.tenantId, userId: context.user.id });
      readSessionMeta(transcriptPath).then((existing) => {
        const meta: SessionMeta = {
          userId: context.user!.id,
          username: context.user!.username,
          tenantId: context.user!.tenantId,
          channel: 'dingtalk',
          createdAt: new Date().toISOString(),
          ...(existing?.customTitle ? { customTitle: existing.customTitle } : {}),
        };
        return writeSessionMeta(transcriptPath, meta);
      }).catch(() => {});
    }
  }

  private async postProcessText(
    rawText: string,
    input: DingtalkPostprocessInput,
  ): Promise<string> {
    const { prepared } = input;
    let processedText = rawText;

    // 语音标记在两个互斥路径中处理：
    // - 有 AI Card 时：在此处处理（因为最终内容通过 cardService.finish 投递，不经过 sendDingtalkMessage）
    // - 无 AI Card 时：在 sendDingtalkMessage 中自动处理（该函数内部会解析和发送语音标记）
    if (prepared.card && processedText) {
      processedText = await this.voiceService.processVoiceMarkers({
        content: processedText,
        context: prepared.source,
        robotConfig: prepared.robotConfig,
      });
    }

    if (prepared.robotCredentials && processedText.trim()) {
      processedText = await processLocalImages(processedText, prepared.robotCredentials);
      processedText = await processVideoMarkers(
        processedText,
        prepared.robotCredentials,
        prepared.source.sessionWebhook,
        prepared.mediaTarget,
      );
      processedText = await processAudioMarkers(
        processedText,
        prepared.robotCredentials,
        prepared.source.sessionWebhook,
        prepared.mediaTarget,
      );
      processedText = await processFileMarkers(
        processedText,
        prepared.robotCredentials,
        prepared.source.sessionWebhook,
        prepared.mediaTarget,
      );
    }

    return processedText;
  }

  private async deliverFinal(
    prepared: DingtalkPostprocessInput['prepared'],
    hasSentText: boolean,
    processedText: string,
  ): Promise<void> {
    if (prepared.card) {
      const finalContent = processedText.trim() || '(无回复)';
      // 取首行非空文本作为卡片摘要（去掉 markdown 标题符号，截断到 100 字符）
      const firstLine = finalContent
        .split('\n')
        .map((l) => l.replace(/^#+\s+/, '').trim())
        .find((l) => l.length > 0);
      const lastMessage = firstLine ? firstLine.slice(0, 100) : '';
      await this.cardService.finish(prepared.card, finalContent, lastMessage);
      dingtalkLogger.info(`[AICard] 已完成，内容长度: ${finalContent.length}`);
      return;
    }

    if (!hasSentText && processedText.trim()) {
      await prepared.messageHelpers.sendMessage(processedText, 'markdown');
    }
  }
}
