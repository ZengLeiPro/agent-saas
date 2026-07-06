/**
 * DingTalk Session Storage
 *
 * 钉钉会话持久化：conversationId -> Agent sessionId 映射。
 * 存储在 JSON 文件中，供 DingtalkChannel 和 Cron 通知使用。
 *
 * 内存缓存 + 串行写入队列，消除并发读写竞态。
 */

import { existsSync, readFileSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";
import type { DingtalkSessionStore, SaveSessionOptions } from './types.js';
import { dingtalkLogger } from '../../utils/logger.js';

// ============================================
// File Path
// ============================================

function getDingtalkSessionsFile(basePath: string): string {
  return join(basePath, "dingtalk-sessions.json");
}

// ============================================
// Helpers
// ============================================

function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

// ============================================
// In-memory cache + serial write queue
// ============================================

const cacheMap = new Map<string, DingtalkSessionStore>();
const writeChainMap = new Map<string, Promise<void>>();

function getCache(basePath: string): DingtalkSessionStore {
  let cache = cacheMap.get(basePath);
  if (cache) return cache;

  const filePath = getDingtalkSessionsFile(basePath);
  if (existsSync(filePath)) {
    try {
      cache = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      cache = {};
    }
  } else {
    cache = {};
  }
  cacheMap.set(basePath, cache!);
  return cache!;
}

function queueWrite(basePath: string): void {
  const filePath = getDingtalkSessionsFile(basePath);
  const data = JSON.stringify(getCache(basePath), null, 2);
  const prev = writeChainMap.get(basePath) ?? Promise.resolve();
  const next = prev.then(() => writeFile(filePath, data).catch((err) => {
    dingtalkLogger.error(`会话文件写入失败: ${err}`);
  }));
  writeChainMap.set(basePath, next);
}

// ============================================
// CRUD
// ============================================

export function loadDingtalkSessions(basePath: string): DingtalkSessionStore {
  return getCache(basePath);
}

export function saveDingtalkSessions(sessions: DingtalkSessionStore, basePath: string): void {
  cacheMap.set(basePath, sessions);
  queueWrite(basePath);
}

export function getAgentSession(conversationId: string, basePath: string): string | undefined {
  return getCache(basePath)[conversationId]?.agentSessionId;
}

export function saveAgentSession(opts: SaveSessionOptions, basePath: string): void {
  const { conversationId, agentSessionId, sessionWebhook, senderNick, senderId, conversationType, tenantId, userId } = opts;
  const sessions = getCache(basePath);
  const now = Date.now();
  const existing = sessions[conversationId];

  sessions[conversationId] = {
    agentSessionId,
    sessionWebhook: sessionWebhook || existing?.sessionWebhook,
    senderNick,
    senderId,
    conversationType,
    lastUpdated: now,
    lastUpdatedAt: formatDateTime(now),
    createdAt: existing?.createdAt || formatDateTime(now),
    messageCount: (existing?.messageCount || 0) + 1,
    tenantId: tenantId || existing?.tenantId,
    userId: userId || existing?.userId,
  };
  queueWrite(basePath);
}

export function clearDingtalkSession(conversationId: string, basePath: string): void {
  const sessions = getCache(basePath);
  delete sessions[conversationId];
  queueWrite(basePath);
}

export function getModelRef(conversationId: string, basePath: string): string | undefined {
  return getCache(basePath)[conversationId]?.modelRef;
}

export function saveModelRef(conversationId: string, modelRef: string | undefined, basePath: string): void {
  const sessions = getCache(basePath);
  const existing = sessions[conversationId];
  if (!existing) return;

  const now = Date.now();
  if (modelRef === undefined) {
    delete existing.modelRef;
  } else {
    existing.modelRef = modelRef;
  }
  existing.lastUpdated = now;
  existing.lastUpdatedAt = formatDateTime(now);
  queueWrite(basePath);
}
