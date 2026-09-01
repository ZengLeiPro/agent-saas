import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EventStore, PlatformEvent } from "../runtime/types.js";
import { isValidAttachmentId } from '@agent/shared';

/** Build an agent session id -> DingTalk sender nickname index. */
export async function buildDingtalkSessionIndex(
  basePath: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const filePath = path.join(basePath, "dingtalk-sessions.json");
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const store = JSON.parse(raw) as Record<
      string,
      { agentSessionId?: string; senderNick?: string }
    >;
    for (const info of Object.values(store)) {
      if (info.agentSessionId && info.senderNick) {
        map.set(info.agentSessionId, info.senderNick);
      }
    }
  } catch {
    // file missing or parse error – ignore
  }
  return map;
}

export interface CronSessionInfo {
  jobId: string;
  jobName: string;
  model?: string;
}

/** Build a session id -> cron run metadata index from JSONL logs. */
export async function buildCronSessionIndex(
  runsDir: string,
): Promise<Map<string, CronSessionInfo>> {
  const map = new Map<string, CronSessionInfo>();
  let files: string[];
  try {
    files = (await fs.readdir(runsDir)).filter((file) => file.endsWith(".jsonl"));
  } catch {
    return map;
  }
  for (const file of files) {
    const jobId = file.replace(".jsonl", "");
    try {
      const content = await fs.readFile(path.join(runsDir, file), "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as {
            sessionId?: string;
            jobName?: string;
            model?: string;
          };
          if (entry.sessionId && entry.jobName) {
            map.set(entry.sessionId, {
              jobId,
              jobName: entry.jobName,
              model: entry.model,
            });
          }
        } catch {
          // skip malformed line
        }
      }
    } catch {
      // skip unreadable file
    }
  }
  return map;
}

export function projectQueuedMessageAttachments(value: unknown): Array<{
  name: string;
  attachmentId: string;
  size?: number;
  mimeType?: string;
  isImage?: boolean;
}> {
  if (!Array.isArray(value)) return [];
  return (value as Array<Record<string, unknown>>).flatMap((attachment) => {
    const attachmentId = attachment?.attachmentId;
    if (!isValidAttachmentId(attachmentId)) return [];
    const display = attachment.display && typeof attachment.display === 'object' && !Array.isArray(attachment.display)
      ? attachment.display as Record<string, unknown>
      : attachment;
    const originalName = typeof display.originalName === 'string'
      ? display.originalName
      : typeof attachment.originalName === 'string'
        ? attachment.originalName
        : undefined;
    if (!originalName) return [];
    return [{
      name: originalName,
      attachmentId,
      ...(typeof display.size === 'number' ? { size: display.size } : {}),
      ...(typeof display.mimeType === 'string' ? { mimeType: display.mimeType } : {}),
      ...(typeof display.isImage === 'boolean' ? { isImage: display.isImage } : {}),
    }];
  });
}

/** Strip common markdown syntax while retaining readable text. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]{3,}\s*$/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n{2,}/g, " ")
    .trim();
}

/**
 * Return queued source run ids whose durable user_message projection already exists.
 * Steering messages are projected under their target run, so both source and target are checked.
 */
export async function listDurablyProjectedQueuedRunIds(
  eventStore: EventStore,
  tenantId: string,
  sessionId: string,
  pending: Array<{ runId?: string; sourceRunId?: string; targetRunId?: string; metadata?: Record<string, unknown> }>,
  blocks: Array<{ interjectionSourceRunId?: string }> = [],
): Promise<string[]> {
  if (pending.length === 0) return [];
  const wanted = new Set(pending.map((input) => input.runId ?? input.sourceRunId!));
  const projected = new Set<string>();
  for (const block of blocks) if (block.interjectionSourceRunId) projected.add(block.interjectionSourceRunId);
  const collect = (events: PlatformEvent[]) => {
    for (const event of events) {
      if (event.type !== "user_message") continue;
      if (event.runId && wanted.has(event.runId)) projected.add(event.runId);
      if (event.interjectionSourceRunId && wanted.has(event.interjectionSourceRunId)) projected.add(event.interjectionSourceRunId);
    }
  };
  if (eventStore.listByRun) {
    for (const input of pending) {
      const sourceRunId = input.runId ?? input.sourceRunId!;
      collect(await eventStore.listByRun(tenantId, sessionId, sourceRunId));
      const targetRunId = input.targetRunId ?? (typeof input.metadata?.steeringTargetRunId === "string" ? input.metadata.steeringTargetRunId : undefined);
      if (targetRunId && targetRunId !== sourceRunId) collect(await eventStore.listByRun(tenantId, sessionId, targetRunId));
    }
  } else {
    collect(await eventStore.list(tenantId, sessionId, { includeTypes: ["user_message"] }));
  }
  return [...projected];
}

export interface CanonicalSessionListCursor {
  v: 1;
  updatedAtMs: number;
  sessionId: string;
}

/** Canonical list order shared with clients: updatedAt DESC, sessionId DESC. */
export function compareCanonicalSessionKeys(
  left: { updatedAtMs: number; sessionId: string },
  right: { updatedAtMs: number; sessionId: string },
): number {
  return right.updatedAtMs - left.updatedAtMs || right.sessionId.localeCompare(left.sessionId);
}

export function encodeSessionListCursor(value: Omit<CanonicalSessionListCursor, 'v'>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...value } satisfies CanonicalSessionListCursor), 'utf8').toString('base64url');
}

export function decodeSessionListCursor(value: string): CanonicalSessionListCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid session list cursor');
  }
  const cursor = parsed as Partial<CanonicalSessionListCursor>;
  if (cursor.v !== 1 || !Number.isFinite(cursor.updatedAtMs) || typeof cursor.sessionId !== 'string' || cursor.sessionId.length === 0) {
    throw new Error('Invalid session list cursor');
  }
  return cursor as CanonicalSessionListCursor;
}

export function isSessionAfterCursor(
  session: { updatedAtMs: number; sessionId: string },
  cursor: CanonicalSessionListCursor,
): boolean {
  return session.updatedAtMs < cursor.updatedAtMs
    || (session.updatedAtMs === cursor.updatedAtMs && session.sessionId.localeCompare(cursor.sessionId) < 0);
}
