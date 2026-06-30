const STORAGE_KEY_PREFIX = "agentChat.unreadAiReplies.v1";

export function getUnreadAiRepliesStorageKey(userId: string | undefined): string {
  return `${STORAGE_KEY_PREFIX}:${userId ?? "no-auth"}`;
}

export function loadUnreadAiReplySessionIds(storageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((v): v is string => typeof v === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

export function saveUnreadAiReplySessionIds(storageKey: string, ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...ids]));
  } catch {
    // ignore quota/private-mode failures
  }
}

export function clearUnreadAiReplyCache(): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(`${STORAGE_KEY_PREFIX}:`)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  } catch {
    // silent
  }
}
