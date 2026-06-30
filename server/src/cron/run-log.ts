/**
 * Cron 运行日志模块
 *
 * 使用 JSONL 格式存储，每行一条记录，便于追加和查询。
 */
import * as fs from "fs/promises";
import * as path from "path";
import type { CronRunLogEntry } from "./types.js";
import { cronLogger } from "../utils/logger.js";

const DEFAULT_MAX_BYTES = 2_000_000; // 2MB
const DEFAULT_KEEP_LINES = 2000;

export interface RunLogOptions {
  runsDir: string; // runs 目录路径
}

export function getRunLogPath(jobId: string, opts: RunLogOptions): string {
  return path.join(opts.runsDir, `${jobId}.jsonl`);
}

export async function appendRunLog(
  entry: CronRunLogEntry,
  opts: RunLogOptions
): Promise<void> {
  const filePath = getRunLogPath(entry.jobId, opts);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
  await pruneIfNeeded(filePath);
}

export async function readRunLog(
  jobId: string,
  opts: RunLogOptions & { limit?: number }
): Promise<CronRunLogEntry[]> {
  const filePath = getRunLogPath(jobId, opts);
  const limit = Math.max(1, Math.min(5000, opts.limit ?? 200));

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());

    const entries: CronRunLogEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      try {
        entries.push(JSON.parse(lines[i]) as CronRunLogEntry);
      } catch {
        // ignore
      }
    }

    return entries;
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

export async function findRunLogEntryByRunId(
  runId: string,
  opts: RunLogOptions
): Promise<CronRunLogEntry | null> {
  const id = String(runId || "").trim();
  if (!id) return null;

  const dirEntries = await fs.readdir(opts.runsDir, { withFileTypes: true }).catch(() => []);
  for (const ent of dirEntries) {
    if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
    const filePath = path.join(opts.runsDir, ent.name);
    const content = await fs.readFile(filePath, "utf-8").catch(() => "");
    if (!content) continue;
    const lines = content.split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as CronRunLogEntry;
        if (entry?.runId === id) return entry;
      } catch {
        // ignore
      }
    }
  }

  return null;
}

async function pruneIfNeeded(
  filePath: string,
  maxBytes = DEFAULT_MAX_BYTES,
  keepLines = DEFAULT_KEEP_LINES
): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size <= maxBytes) return;

    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());
    if (lines.length <= keepLines) return;

    const kept = lines.slice(-keepLines);
    await fs.writeFile(filePath, `${kept.join("\n")}\n`, "utf-8");
    cronLogger.info(
      `Pruned log file: ${filePath} (${lines.length} -> ${kept.length} lines)`
    );
  } catch {
    // ignore
  }
}

export async function deleteRunLog(
  jobId: string,
  opts: RunLogOptions
): Promise<void> {
  const filePath = getRunLogPath(jobId, opts);
  try {
    await fs.unlink(filePath);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
}
