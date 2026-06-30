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
}

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
): void {
  void (async () => {
    try {
      const db = await getDB();
      const trimmed = messages.slice(-MAX_CACHED_MESSAGES).map((m) =>
        "streaming" in m && m.streaming ? { ...m, streaming: false } : m,
      );
      await db.put(STORE_NAME, {
        sessionId,
        messages: trimmed,
        timestamp: Date.now(),
      } satisfies CachedEntry);

      if (++saveCounter % EVICT_CHECK_INTERVAL === 0) {
        await evictExpiredEntries(db);
      }
    } catch {
      // IndexedDB 不可用 — 静默失败
    }
  })();
}

/** 读取缓存的 session 消息，过期返回 null */
export async function loadSessionMessages(
  sessionId: string,
): Promise<MessageItem[] | null> {
  try {
    const db = await getDB();
    const entry: CachedEntry | undefined = await db.get(STORE_NAME, sessionId);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > MESSAGE_CACHE_TTL_MS) {
      await db.delete(STORE_NAME, sessionId);
      return null;
    }
    // 从缓存加载时，将遗留的 pending 状态转为 failed（上次发送未完成就关闭了页面）
    return entry.messages.map(m =>
      m.type === 'user' && m.status === 'pending' ? { ...m, status: 'failed' as const } : m
    );
  } catch {
    return null;
  }
}

/** 删除指定 session 的消息缓存 */
export async function clearSessionMessages(sessionId: string): Promise<void> {
  try {
    const db = await getDB();
    await db.delete(STORE_NAME, sessionId);
  } catch {
    // silent
  }
}

/** 清除所有消息缓存（登出时调用） */
export async function clearAllMessageCache(): Promise<void> {
  try {
    const db = await getDB();
    await db.clear(STORE_NAME);
  } catch {
    // silent
  }
}
