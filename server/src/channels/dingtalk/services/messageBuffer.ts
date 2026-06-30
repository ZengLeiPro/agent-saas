/**
 * 钉钉消息聚合缓冲
 *
 * 解决钉钉无法同时发送文件和文字的问题：
 * 收到媒体消息后短暂等待后续文字消息，合并为一条再派发给 Agent。
 *
 * 缓冲维度：conversationId + senderId（同会话同用户）
 */

import { dingtalkLogger } from '../../../utils/logger.js';
import type { DingtalkMessageContext } from '../types.js';

const MEDIA_MSG_TYPES = ['picture', 'file', 'audio', 'video'];

interface BufferedEntry {
  mediaContexts: DingtalkMessageContext[];
  robotId?: string;
  timer: ReturnType<typeof setTimeout>;
}

type FlushHandler = (ctx: DingtalkMessageContext, robotId?: string) => Promise<void>;

function bufferKey(ctx: DingtalkMessageContext): string {
  return `${ctx.conversationId}:${ctx.senderId || ''}`;
}

function isMediaMessage(ctx: DingtalkMessageContext): boolean {
  return !!ctx.msgtype && MEDIA_MSG_TYPES.includes(ctx.msgtype);
}

export class MessageBuffer {
  private readonly pending = new Map<string, BufferedEntry>();

  constructor(
    private readonly timeoutMs: number,
    private readonly onFlush: FlushHandler,
  ) {}

  /**
   * 接收一条消息，决定是否缓冲。
   * @returns true — 消息已被缓冲或合并 flush，调用方不需要再处理
   * @returns false — 缓冲不适用，调用方应正常处理
   */
  receive(ctx: DingtalkMessageContext, robotId?: string): boolean {
    const key = bufferKey(ctx);

    if (isMediaMessage(ctx)) {
      this.addMedia(key, ctx, robotId);
      return true;
    }

    // 文字消息：检查是否有待合并的媒体缓冲
    const entry = this.pending.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(key);

      const merged: DingtalkMessageContext = {
        ...ctx, // 文字消息作为主体（content、sessionWebhook 等取最新）
        _bufferedMedia: entry.mediaContexts,
      };

      const rid = robotId || entry.robotId;
      dingtalkLogger.info(
        `[Buffer] 合并 ${entry.mediaContexts.length} 条媒体消息 + 文字，key=${key}`,
      );

      this.onFlush(merged, rid).catch((err) => {
        dingtalkLogger.error(`[Buffer] flush 异常: ${err.message}`);
      });
      return true;
    }

    // 无缓冲，透传
    return false;
  }

  private addMedia(key: string, ctx: DingtalkMessageContext, robotId?: string): void {
    const existing = this.pending.get(key);

    if (existing) {
      // 追加到已有缓冲，重置定时器
      clearTimeout(existing.timer);
      existing.mediaContexts.push(ctx);
      existing.robotId = robotId || existing.robotId;
      existing.timer = this.createTimer(key);
      dingtalkLogger.debug(
        `[Buffer] 追加媒体消息 (${existing.mediaContexts.length} 条), key=${key}`,
      );
    } else {
      // 新建缓冲
      this.pending.set(key, {
        mediaContexts: [ctx],
        robotId,
        timer: this.createTimer(key),
      });
      dingtalkLogger.info(
        `[Buffer] 缓冲媒体消息，等待 ${this.timeoutMs}ms 后续文字, key=${key}`,
      );
    }
  }

  private createTimer(key: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const entry = this.pending.get(key);
      if (!entry) return;
      this.pending.delete(key);

      // 超时：媒体消息原样派发
      const [first, ...rest] = entry.mediaContexts;
      const ctx: DingtalkMessageContext = {
        ...first,
        _bufferedMedia: rest.length > 0 ? rest : undefined,
      };

      dingtalkLogger.info(
        `[Buffer] 超时，派发 ${entry.mediaContexts.length} 条媒体消息, key=${key}`,
      );

      this.onFlush(ctx, entry.robotId).catch((err) => {
        dingtalkLogger.error(`[Buffer] flush 异常: ${err.message}`);
      });
    }, this.timeoutMs);
  }

  dispose(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
  }
}
