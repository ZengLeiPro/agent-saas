import * as fs from "node:fs/promises";
import * as path from "node:path";

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
  attachmentId?: string;
  savedPath?: string;
  relativePath?: string;
  size?: number;
  mimeType?: string;
  isImage?: boolean;
}> {
  if (!Array.isArray(value)) return [];
  return (value as Array<Record<string, unknown>>).flatMap((attachment) => (
    typeof attachment?.originalName === 'string' ? [{
      name: attachment.originalName,
      ...(typeof attachment.attachmentId === 'string' ? { attachmentId: attachment.attachmentId } : {}),
      ...(typeof attachment.savedPath === 'string' ? { savedPath: attachment.savedPath } : {}),
      ...(typeof attachment.relativePath === 'string' ? { relativePath: attachment.relativePath } : {}),
      ...(typeof attachment.size === 'number' ? { size: attachment.size } : {}),
      ...(typeof attachment.mimeType === 'string' ? { mimeType: attachment.mimeType } : {}),
      ...(typeof attachment.isImage === 'boolean' ? { isImage: attachment.isImage } : {}),
    }] : []
  ));
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
