import { openDB, type IDBPDatabase } from "idb";
import type { UploadedFile } from "@/components/types";
import { INPUT_DRAFT_KEY } from "@/lib/constants";
import type { BoundaryIdentity } from "@agent/shared";
import { identityScope } from "@agent/shared";

const TEXT_DRAFT_KEY_PREFIX = "agentChat.inputDraft.v2.";
const DB_NAME = "agentChatComposerDB";
const DB_VERSION = 1;
const STORE_NAME = "attachments";

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

function textDraftKey(scope: string): string {
  return `${TEXT_DRAFT_KEY_PREFIX}${scope}`;
}

function withoutPreviewUrls(files: UploadedFile[]): UploadedFile[] {
  return files.map(({ previewUrl: _previewUrl, ...file }) => file);
}

export function getComposerDraftScope(
  identity: BoundaryIdentity | null,
  sessionId: string | null,
): string {
  const account = identity ? identityScope(identity) : "unauthenticated";
  const session = sessionId ? encodeURIComponent(sessionId) : "new";
  return `${account}.${session}`;
}

export function loadComposerText(scope: string, migrateLegacy = false): string {
  try {
    const scopedValue = localStorage.getItem(textDraftKey(scope));
    if (scopedValue !== null) return scopedValue;

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
      localStorage.setItem(textDraftKey(scope), value);
    } else {
      localStorage.removeItem(textDraftKey(scope));
    }
  } catch {
    // QuotaExceededError 或浏览器禁用本地存储时静默退化
  }
}

export async function loadComposerAttachments(scope: string): Promise<UploadedFile[]> {
  try {
    const db = await getDB();
    const entry = await db.get(STORE_NAME, scope) as AttachmentDraftEntry | undefined;
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
    const db = await getDB();
    if (files.length === 0) {
      await db.delete(STORE_NAME, scope);
      return;
    }
    await db.put(STORE_NAME, {
      scope,
      files: withoutPreviewUrls(files),
      updatedAt: Date.now(),
    } satisfies AttachmentDraftEntry);
  } catch {
    // IndexedDB 不可用或配额不足时退化为当前页面内存状态
  }
}
