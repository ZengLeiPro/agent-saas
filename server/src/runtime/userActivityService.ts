/**
 * UserActivityService（2026-07-14 记忆轮询批次）
 *
 * 按 tenantId+userId 聚合最近时间窗内的「用户主动消息」，跨会话读取：
 *   session projection（按 userId+updatedFrom 列会话）
 *     → 逐 session 从 runtime event store 拉 user_message + run_started
 *     → 按 run_started.channel 只保留 web/dingtalk 发起的 run（cron 自动
 *       prompt 不算用户活动；用户在 cron 会话里的 web 续聊仍会被保留，
 *       因为续聊 run 的 channel 是 web）。
 *
 * 安全边界：本服务不做身份鉴权——调用方（UserActivityList 工具 / cron
 * executor 预检）必须只用 context 解析出的身份调用，绝不接受模型入参里的
 * userId/tenantId。
 *
 * 数据源要求 PG 后端（sessionProjection + PgEventStore）。文件后端没有
 * 跨会话列表能力，构造时传 null 即降级为 unavailable。
 */

import { isMemoryPollSessionMeta } from '../data/sessions/access.js';
import type {
  RuntimeSessionListQuery,
  RuntimeSessionListResult,
} from './sessionProjectionStore.js';
import type { EventStore, PlatformEvent } from './types.js';

export interface SessionProjectionLike {
  list(query: RuntimeSessionListQuery): Promise<RuntimeSessionListResult>;
}

export interface UserActivityQuery {
  tenantId: string;
  userId: string;
  /** 时间窗下界（ISO 8601，含） */
  sinceIso: string;
  /** 时间窗上界（ISO 8601，含；缺省 = 现在） */
  untilIso?: string;
  /** 最多扫描的会话数（按 updated_at 倒序取最近的） */
  maxSessions?: number;
  /** 每个会话最多保留的用户消息条数 */
  maxMessagesPerSession?: number;
  /** 单条消息最大字符数（超出截断） */
  maxCharsPerMessage?: number;
  /** 全量输出字符预算（超出停止收集并标记 truncated） */
  maxTotalChars?: number;
}

export interface UserActivityMessage {
  timestamp: string;
  channel: string;
  content: string;
}

export interface UserActivitySession {
  sessionId: string;
  title?: string;
  updatedAt: string;
  messages: UserActivityMessage[];
}

export interface UserActivityResult {
  available: boolean;
  sinceIso: string;
  untilIso: string;
  sessions: UserActivitySession[];
  /** 命中时间窗的会话总数（含因预算被丢弃的） */
  scannedSessions: number;
  truncated: boolean;
}

const DEFAULT_MAX_SESSIONS = 30;
const DEFAULT_MAX_MESSAGES_PER_SESSION = 50;
const DEFAULT_MAX_CHARS_PER_MESSAGE = 2_000;
const DEFAULT_MAX_TOTAL_CHARS = 60_000;
const USER_INITIATED_CHANNELS = new Set(['web', 'dingtalk']);
const EVENT_PAGE_LIMIT = 200;

export class UserActivityService {
  constructor(
    private readonly options: {
      sessionProjection: SessionProjectionLike | null;
      eventStore: EventStore | null;
      logger?: { warn: (message: string) => void };
    },
  ) {}

  get available(): boolean {
    return !!this.options.sessionProjection && !!this.options.eventStore;
  }

  /**
   * 便捷预检：时间窗内是否存在任何用户主动消息。
   * cron executor 的「48h 无活动跳过」用它，避免为空跑付模型成本。
   * 数据源不可用时返回 null（调用方自行决定 fail-open/closed）。
   */
  async hasActivity(query: Pick<UserActivityQuery, 'tenantId' | 'userId' | 'sinceIso' | 'untilIso'>): Promise<boolean | null> {
    if (!this.available) return null;
    const result = await this.listActivity({
      ...query,
      maxSessions: DEFAULT_MAX_SESSIONS,
      maxMessagesPerSession: 1,
      maxTotalChars: 4_000,
    });
    if (!result.available) return null;
    return result.sessions.some((session) => session.messages.length > 0);
  }

  async listActivity(query: UserActivityQuery): Promise<UserActivityResult> {
    const untilIso = query.untilIso ?? new Date().toISOString();
    const base: UserActivityResult = {
      available: this.available,
      sinceIso: query.sinceIso,
      untilIso,
      sessions: [],
      scannedSessions: 0,
      truncated: false,
    };
    const projection = this.options.sessionProjection;
    const eventStore = this.options.eventStore;
    if (!projection || !eventStore) return base;
    if (!query.tenantId || !query.userId) return base;

    const maxSessions = clampPositive(query.maxSessions, DEFAULT_MAX_SESSIONS, 100);
    const maxMessagesPerSession = clampPositive(query.maxMessagesPerSession, DEFAULT_MAX_MESSAGES_PER_SESSION, 200);
    const maxCharsPerMessage = clampPositive(query.maxCharsPerMessage, DEFAULT_MAX_CHARS_PER_MESSAGE, 8_000);
    const maxTotalChars = clampPositive(query.maxTotalChars, DEFAULT_MAX_TOTAL_CHARS, 200_000);

    // 1) 列出时间窗内更新过的用户会话（kind=user 排除子 agent；不含已删除）
    const candidates: Array<{ sessionId: string; title?: string; updatedAt: string }> = [];
    let cursor: { updatedAt: string; sessionId: string } | undefined;
    while (candidates.length < maxSessions) {
      const page = await projection.list({
        tenantId: query.tenantId,
        userId: query.userId,
        kind: 'user',
        updatedFrom: query.sinceIso,
        updatedTo: untilIso,
        includeDeleted: false,
        limit: Math.min(100, maxSessions - candidates.length),
        ...(cursor ? { cursor } : {}),
      });
      for (const record of page.items) {
        base.scannedSessions++;
        // 记忆/心跳轮询等内部会话不算用户活动（否则轮询会互相喂养产生噪音）
        if (isMemoryPollSessionMeta(record.metaJson)) continue;
        candidates.push({
          sessionId: record.sessionId,
          ...(record.title ? { title: record.title } : {}),
          updatedAt: record.updatedAt,
        });
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    // 2) 逐会话拉 run_started + user_message，按 run channel 过滤
    const sinceMs = Date.parse(query.sinceIso);
    const untilMs = Date.parse(untilIso);
    let totalChars = 0;
    for (const candidate of candidates) {
      if (totalChars >= maxTotalChars) {
        base.truncated = true;
        break;
      }
      let runChannels: Map<string, string>;
      let userMessages: PlatformEvent[];
      try {
        [runChannels, userMessages] = await Promise.all([
          this.collectRunChannels(eventStore, candidate.sessionId),
          this.collectEvents(eventStore, candidate.sessionId, 'user_message'),
        ]);
      } catch (err) {
        this.options.logger?.warn(
          `[user-activity] read session events failed: session=${candidate.sessionId} error=${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      const messages: UserActivityMessage[] = [];
      for (const event of userMessages) {
        if (event.type !== 'user_message') continue;
        const channel = runChannels.get(event.runId);
        if (!channel || !USER_INITIATED_CHANNELS.has(channel)) continue;
        const eventMs = Date.parse(event.timestamp);
        if (Number.isFinite(sinceMs) && Number.isFinite(eventMs) && eventMs < sinceMs) continue;
        if (Number.isFinite(untilMs) && Number.isFinite(eventMs) && eventMs > untilMs) continue;
        const content = (event.content ?? '').trim();
        if (!content) continue;
        const clipped = content.length > maxCharsPerMessage
          ? `${content.slice(0, maxCharsPerMessage)}...[截断]`
          : content;
        messages.push({ timestamp: event.timestamp, channel, content: clipped });
        totalChars += clipped.length;
        if (messages.length >= maxMessagesPerSession) {
          base.truncated = true;
          break;
        }
        if (totalChars >= maxTotalChars) {
          base.truncated = true;
          break;
        }
      }
      if (messages.length > 0) {
        base.sessions.push({
          sessionId: candidate.sessionId,
          ...(candidate.title ? { title: candidate.title } : {}),
          updatedAt: candidate.updatedAt,
          messages,
        });
      }
    }
    if (candidates.length >= maxSessions && base.scannedSessions > candidates.length) {
      base.truncated = true;
    }
    return base;
  }

  private async collectRunChannels(eventStore: EventStore, sessionId: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const event of await this.collectEvents(eventStore, sessionId, 'run_started')) {
      if (event.type === 'run_started') map.set(event.runId, event.channel);
    }
    return map;
  }

  private async collectEvents(
    eventStore: EventStore,
    sessionId: string,
    type: PlatformEvent['type'],
  ): Promise<PlatformEvent[]> {
    // 优先 listPage（PG 后端服务端按 event_type 过滤，避免全量事件搬运）
    if (eventStore.listPage) {
      const events: PlatformEvent[] = [];
      let afterCursor: string | undefined;
      // 一个会话的 run_started/user_message 数量有限；防御性给个页数上限
      for (let page = 0; page < 50; page++) {
        const result = await eventStore.listPage(sessionId, {
          type,
          limit: EVENT_PAGE_LIMIT,
          ...(afterCursor ? { afterCursor } : {}),
        });
        events.push(...result.events);
        if (!result.hasMore || !result.nextCursor) break;
        afterCursor = result.nextCursor;
      }
      return events;
    }
    const all = await eventStore.list(sessionId);
    return all.filter((event) => event.type === type);
  }
}

function clampPositive(value: number | undefined, fallback: number, max: number): number {
  if (!value || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}
