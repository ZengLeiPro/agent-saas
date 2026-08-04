import { openDB, type IDBPDatabase } from 'idb';
import type { MessageItem } from "@/components/types";
import { MESSAGE_CACHE_TTL_MS } from '@agent/shared';

const DB_NAME = 'agentChatDB';
const DB_VERSION = 1;
const STORE_NAME = 'messages';

const MAX_CACHED_MESSAGES = 500;

const LS_CACHE_KEY_PREFIX = "agentChat.msgCache.";
const LS_MIGRATED_FLAG = "agentChat.idbMigrated";

interface CachedEntry {
  sessionId: string;
  messages: MessageItem[];
  timestamp: number;
  /** 是否已加载到 transcript 起点。 */
  historyComplete?: boolean;
  /** 当前缓存尾部对应的服务端最新 block 游标。 */
  tailCursor?: string;
  /** 当前缓存最早消息对应的 block 游标。 */
  oldestCursor?: string;
  /** v2 兼容字段。 */
  complete?: boolean;
  /** v2 兼容字段。 */
  cursor?: string;
}

export interface SessionMessageSnapshot {
  messages: MessageItem[];
  historyComplete: boolean;
  tailCursor?: string;
  oldestCursor?: string;
}

interface SaveSessionMessagesOptions {
  historyComplete: boolean;
  tailCursor?: string;
  oldestCursor?: string;
}

/** 构造与当前可变消息数组解耦的缓存快照，并剥离由服务端状态派生的提示。 */
export function prepareMessagesForCache(messages: MessageItem[]): MessageItem[] {
  return messages
    .filter((message) => message.type !== "system-error")
    .map((message) => (
      "streaming" in message && message.streaming
        ? { ...message, streaming: false }
        : { ...message }
    ));
}

/**
 * 缓存快照读回时的规范化。
 *
 * 1. 遗留 pending 用户消息转 failed（上次发送未完成就关掉了页面）。
 * 2. 按 id 去重：2026-08-04 前 sessionMerge 的 preserveTail 自我复制缺陷会把同 id
 *    消息写进缓存，源头修复不清理已落盘的脏快照，这里让存量在下次读取时自愈。
 *    保留首次出现的位置；正常快照 id 唯一，去重是 no-op。
 */
export function restoreCachedMessages(cached: MessageItem[]): MessageItem[] {
  const seenIds = new Set<string>();
  const restored: MessageItem[] = [];
  for (const message of cached) {
    if (seenIds.has(message.id)) continue;
    seenIds.add(message.id);
    restored.push(
      message.type === "user" && message.status === "pending"
        ? { ...message, status: "failed" as const }
        : message,
    );
  }
  return restored;
}

const cacheMetadata = new Map<string, SaveSessionMessagesOptions>();

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' });
          store.createIndex('timestamp', 'timestamp');
        }
      },
    });
  }
  return dbPromise;
}

/** 一次性 localStorage → IndexedDB 迁移 */
async function migrateFromLocalStorage(): Promise<void> {
  try {
    if (localStorage.getItem(LS_MIGRATED_FLAG)) return;

    const db = await getDB();
    const keysToRemove: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(LS_CACHE_KEY_PREFIX)) continue;

      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const data = JSON.parse(raw) as { messages: MessageItem[]; timestamp: number };
        const sessionId = key.slice(LS_CACHE_KEY_PREFIX.length);

        await db.put(STORE_NAME, {
          sessionId,
          messages: data.messages,
          timestamp: data.timestamp,
        } satisfies CachedEntry);

        keysToRemove.push(key);
      } catch {
        keysToRemove.push(key);
      }
    }

    // 清理 localStorage 旧条目
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
    localStorage.setItem(LS_MIGRATED_FLAG, '1');
  } catch {
    // IndexedDB 不可用 — 静默跳过迁移
  }
}

// 模块加载时立即执行迁移（fire-and-forget）
void migrateFromLocalStorage();

/** TTL 过期清理（不再限制数量上限） */
async function evictExpiredEntries(db: IDBPDatabase): Promise<void> {
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(tx.objectStoreNames[0]);
    const index = store.index('timestamp');
    const all = await index.getAll();
    const now = Date.now();

    for (const entry of all) {
      if (now - entry.timestamp > MESSAGE_CACHE_TTL_MS) {
        await store.delete(entry.sessionId);
      }
    }

    await tx.done;
  } catch {
    // silent
  }
}

let saveCounter = 0;
const EVICT_CHECK_INTERVAL = 20;

/** 保存 session 消息快照到 IndexedDB */
export function saveSessionMessages(
  sessionId: string,
  messages: MessageItem[],
  options?: SaveSessionMessagesOptions,
): void {
  if (options) cacheMetadata.set(sessionId, options);
  const knownMetadata = options ?? cacheMetadata.get(sessionId);
  // 入队前同步截取快照：messages 是可变数组，不能等 IndexedDB ready 后再读取。
  // system-error 由服务端 lastRunState 派生，也不能作为会话正文缓存。
  const cacheableMessages = prepareMessagesForCache(messages);
  const trimmed = cacheableMessages.slice(-MAX_CACHED_MESSAGES);
  const wasTrimmed = trimmed.length < cacheableMessages.length;
  const historyComplete = knownMetadata?.historyComplete === true && !wasTrimmed;
  const oldestCursor = wasTrimmed
    ? trimmed[0]?.id
    : knownMetadata?.oldestCursor ?? trimmed[0]?.id;
  void (async () => {
    try {
      const db = await getDB();
      await db.put(STORE_NAME, {
        sessionId,
        messages: trimmed,
        timestamp: Date.now(),
        historyComplete,
        ...(knownMetadata?.tailCursor ? { tailCursor: knownMetadata.tailCursor } : {}),
        ...(oldestCursor ? { oldestCursor } : {}),
      } satisfies CachedEntry);

      if (++saveCounter % EVICT_CHECK_INTERVAL === 0) {
        await evictExpiredEntries(db);
      }
    } catch {
      // IndexedDB 不可用 — 静默失败
    }
  })();
}

/** 读取缓存快照；尾部 cursor 与历史是否完整相互独立。 */
export async function loadSessionMessageSnapshot(
  sessionId: string,
): Promise<SessionMessageSnapshot | null> {
  try {
    const db = await getDB();
    const entry: CachedEntry | undefined = await db.get(STORE_NAME, sessionId);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > MESSAGE_CACHE_TTL_MS) {
      await db.delete(STORE_NAME, sessionId);
      return null;
    }
    const messages = restoreCachedMessages(entry.messages);
    const historyComplete = entry.historyComplete ?? entry.complete === true;
    const tailCursor = entry.tailCursor ?? (entry.complete ? entry.cursor : undefined);
    const oldestCursor = entry.oldestCursor ?? messages[0]?.id;
    const snapshot: SessionMessageSnapshot = {
      messages,
      historyComplete,
      ...(tailCursor ? { tailCursor } : {}),
      ...(oldestCursor ? { oldestCursor } : {}),
    };
    cacheMetadata.set(sessionId, {
      historyComplete: snapshot.historyComplete,
      ...(snapshot.tailCursor ? { tailCursor: snapshot.tailCursor } : {}),
      ...(snapshot.oldestCursor ? { oldestCursor: snapshot.oldestCursor } : {}),
    });
    return snapshot;
  } catch {
    return null;
  }
}

/** 兼容现有调用方：只读取消息数组。 */
export async function loadSessionMessages(
  sessionId: string,
): Promise<MessageItem[] | null> {
  return (await loadSessionMessageSnapshot(sessionId))?.messages ?? null;
}

/** 删除指定 session 的消息缓存 */
export async function clearSessionMessages(sessionId: string): Promise<void> {
  cacheMetadata.delete(sessionId);
  try {
    const db = await getDB();
    await db.delete(STORE_NAME, sessionId);
  } catch {
    // silent
  }
}

/** 清除所有消息缓存（登出时调用） */
export async function clearAllMessageCache(): Promise<void> {
  cacheMetadata.clear();
  try {
    const db = await getDB();
    await db.clear(STORE_NAME);
  } catch {
    // silent
  }
}
