import { openDB, type IDBPDatabase } from "idb";
import type { UploadedFile } from "@/components/types";
import { INPUT_DRAFT_KEY } from "@/lib/constants";
import type { BoundaryIdentity } from "@agent/shared";
import { CacheKeyBuilder, cacheKeyForIdentity, canonicalSerialize, identityScope, parseCacheJson } from "@agent/shared";

const DB_NAME = "agentChatComposerDB";
const DB_VERSION = 1;
const STORE_NAME = "attachments"; // local draft references only; uploaded authority is never retained
const LEGACY_TEXT_DRAFT_KEY_PREFIX = "agentChat.inputDraft.v2.";
const legacyScopeByV2 = new Map<string, string>();

interface AttachmentDraftEntry {
  scope: string;
  files: UploadedFile[];
  updatedAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "scope" });
        }
      },
    });
  }
  return dbPromise;
}

function scopedResourceKey(scope: string, resource: string): string | null {
  if (!scope) return null;
  try {
    const parsed = CacheKeyBuilder.parse(scope);
    return CacheKeyBuilder.build(parsed, resource, parsed.resourceId);
  } catch { return null; }
}

function textDraftKey(scope: string): string | null { return scopedResourceKey(scope, "draft-text"); }
function attachmentDraftKey(scope: string): string | null { return scopedResourceKey(scope, "draft-attachments"); }

export function prepareComposerAttachmentDrafts(files: UploadedFile[]): UploadedFile[] {
  return files
    .filter((file) => !file.attachmentId && !file.savedPath && !/^(?:[A-Za-z]:[\\/]|\/|\\\\|file:\/\/)/u.test(file.relativePath))
    .map(({ previewUrl: _previewUrl, attachmentId: _attachmentId, savedPath: _savedPath, ...file }) => file);
}

export function getComposerDraftScope(
  identity: BoundaryIdentity | null,
  sessionId: string | null,
): string {
  const resourceId = sessionId ?? "new";
  try {
    const scope = cacheKeyForIdentity(identity, "draft-metadata", resourceId) ?? "";
    if (scope && identity) legacyScopeByV2.set(scope, `${identityScope(identity)}.${sessionId ? encodeURIComponent(sessionId) : "new"}`);
    return scope;
  } catch { return ""; }
}

export function loadComposerText(scope: string, migrateLegacy = false): string {
  try {
    const key = textDraftKey(scope);
    if (!key) return "";
    const scopedValue = localStorage.getItem(key);
    if (scopedValue !== null) {
      const parsed = parseCacheJson(scopedValue) as { text?: unknown };
      return typeof parsed.text === "string" ? parsed.text : "";
    }

    const legacyScope = legacyScopeByV2.get(scope);
    const legacyKey = legacyScope ? `${LEGACY_TEXT_DRAFT_KEY_PREFIX}${legacyScope}` : null;
    const legacyValue = legacyKey ? localStorage.getItem(legacyKey) : null;
    if (legacyKey) localStorage.removeItem(legacyKey);
    if (legacyValue !== null) {
      localStorage.setItem(key, canonicalSerialize({ text: legacyValue }));
      return legacyValue;
    }
    if (migrateLegacy) {
      // Ownerless N-1 draft cannot prove account/tenant ownership.
      localStorage.removeItem(INPUT_DRAFT_KEY);
    }
  } catch {
    // 浏览器禁用本地存储时退化为仅内存草稿
  }
  return "";
}

export function saveComposerText(scope: string, value: string): void {
  try {
    if (value) {
      const key = textDraftKey(scope);
      if (key) localStorage.setItem(key, canonicalSerialize({ text: value }));
    } else {
      const key = textDraftKey(scope);
      if (key) localStorage.removeItem(key);
    }
  } catch {
    // QuotaExceededError 或浏览器禁用本地存储时静默退化
  }
}

export async function loadComposerAttachments(scope: string): Promise<UploadedFile[]> {
  try {
    const db = await getDB();
    const key = attachmentDraftKey(scope);
    if (!key) return [];
    let entry = await db.get(STORE_NAME, key) as AttachmentDraftEntry | undefined;
    if (!entry) {
      const legacyScope = legacyScopeByV2.get(scope);
      const legacy = legacyScope ? await db.get(STORE_NAME, legacyScope) as AttachmentDraftEntry | undefined : undefined;
      if (legacyScope && legacy) {
        const files = prepareComposerAttachmentDrafts(legacy.files);
        const tx = db.transaction(STORE_NAME, "readwrite");
        if (files.length) {
          entry = { scope: key, files, updatedAt: legacy.updatedAt };
          await tx.store.put(entry);
        }
        await tx.store.delete(legacyScope);
        await tx.done;
      }
    }
    return entry?.files ?? [];
  } catch {
    return [];
  }
}

export async function saveComposerAttachments(
  scope: string,
  files: UploadedFile[],
): Promise<void> {
  try {
    const key = attachmentDraftKey(scope);
    if (!key) return;
    const db = await getDB();
    const drafts = prepareComposerAttachmentDrafts(files);
    if (drafts.length === 0) {
      await db.delete(STORE_NAME, key);
      return;
    }
    await db.put(STORE_NAME, {
      scope: key,
      files: drafts,
      updatedAt: Date.now(),
    } satisfies AttachmentDraftEntry);
  } catch {
    // IndexedDB 不可用或配额不足时退化为当前页面内存状态
  }
}

/** Logout/owner switch clears v2 attachment draft references, including journal recovery. */
export async function clearAllComposerAttachmentDrafts(): Promise<void> {
  try {
    const db = await getDB();
    await db.clear(STORE_NAME);
  } catch {
    // IndexedDB unavailable already means no durable attachment drafts can be read.
  }
}
