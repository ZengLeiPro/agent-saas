/**
 * Token Usage — 从 transcript jsonl 回填 token_usage_daily
 *
 * 触发场景：
 *   - 服务首次启动（rebuild_state 表无记录）→ 全量扫描清表后重建
 *   - 后续启动 → 跳过（实时路径已经在写入）
 *   - 调用 resetRebuildState(db) → 下次启动触发全量重建
 *
 * 已知限制（写入 dashboard 时需标注）：
 *   1. 历史回填 cost 由本地 pricing.ts 按 4 类 token × 单价计算（与实时路径口径一致）。
 *      未知 model 会被静默归 0 + 一次性 warn；新模型上线时需在 pricing.ts 补单价
 *   2. 历史回填优先使用 usage.api_request_count；旧 transcript 缺失时才按 assistant usage 行数近似
 *   3. channel 推断：读同名 .meta.json 的 channel 字段；缺失时默认 'web'；
 *      subagent 文件位于 {sessionId}/subagents/ 子目录，沿父 session 的 channel
 *   4. subagent token 被独立累加（确保总量正确，与主 agent 一起算到同一用户头上）
 */

import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  createTokenUsageStore,
  formatBeijingMinute,
  type UsageDailyRowDelta,
} from './store.js';
import { computeCostMicro } from './pricing.js';
import { readSessionMeta } from '../transcripts/meta.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT, CLAUDE_PROJECTS_ROOT } from '../transcripts/projectKey.js';
import { LEGACY_TENANT_ID } from '../tenants/types.js';

export interface RebuildOptions {
  /** Agent 全局 cwd，用于反推 projectKey 前缀（如 /Users/admin/workspace） */
  agentCwd: string;
  /** 新 Agent SaaS transcript 根目录，默认 ~/.agent-saas/legacy-transcripts */
  projectsRoot?: string;
  /** 旧 Claude transcript 根目录，默认 ~/.claude/projects；设为 null 可关闭旧布局扫描 */
  legacyProjectsRoot?: string | null;
  /** 日志函数（可选） */
  log?: (msg: string) => void;
  /** 强制重建（即使 rebuild_state 已存在） */
  force?: boolean;
}

export interface RebuildStats {
  performed: boolean;
  filesScanned: number;
  linesProcessed: number;
  rowsWritten: number;
  maxMtimeMs: number;
  durationMs: number;
}

/**
 * 把 agentCwd 转成对应的 projectKey 前缀。
 * 例：'/Users/admin/workspace' → '-Users-admin-workspace-'
 */
function buildProjectKeyPrefix(agentCwd: string): string {
  const transformed = agentCwd.replace(/[^a-zA-Z0-9]/g, '-');
  return transformed.endsWith('-') ? transformed : transformed + '-';
}

/**
 * 从 projectKey 反推 username。返回 null 表示这不是用户 workspace 目录。
 * 当前仅支持字母数字 + 下划线的 username（实际 KY Agent 内的 username 都符合此规则）。
 */
export function parseUsernameFromProjectKey(
  projectKey: string,
  prefix: string,
): string | null {
  if (!projectKey.startsWith(prefix)) return null;
  const tail = projectKey.slice(prefix.length);
  return /^[A-Za-z0-9_]+$/.test(tail) ? tail : null;
}

interface AccBucket {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turnDelta: number;
}

function emptyBucket(): AccBucket {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    turnDelta: 0,
  };
}

type UserAcc = Map<string, { channel: string; bucket: AccBucket; occurredAtMs: number }>;

/**
 * 扫描单个 jsonl 文件，累加到内存 user-level map。
 */
async function processJsonl(
  filePath: string,
  channel: string,
  userAcc: UserAcc,
): Promise<{ lines: number; mtimeMs: number }> {
  let mtimeMs = 0;
  try {
    const s = await stat(filePath);
    mtimeMs = Math.floor(s.mtimeMs);
  } catch {
    return { lines: 0, mtimeMs: 0 };
  }

  let lines = 0;
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      lines++;
      if (!line) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.type !== 'assistant') continue;
      const message = parsed.message as Record<string, unknown> | undefined;
      if (!message) continue;
      const usage = message.usage as Record<string, unknown> | undefined;
      const model = typeof message.model === 'string' ? message.model : null;
      const ts = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN;
      if (!usage || !model || !Number.isFinite(ts)) continue;

      const minute = formatBeijingMinute(ts);
      const key = `${minute}|${model}|${channel}`;
      const entry = userAcc.get(key) ?? { channel, bucket: emptyBucket(), occurredAtMs: ts };
      const b = entry.bucket;
      b.inputTokens += Number(usage.input_tokens ?? 0) || 0;
      b.outputTokens += Number(usage.output_tokens ?? 0) || 0;
      b.cacheReadTokens += Number(usage.cache_read_input_tokens ?? 0) || 0;
      b.cacheCreationTokens += Number(usage.cache_creation_input_tokens ?? 0) || 0;
      b.turnDelta += Math.max(1, Math.floor(Number(usage.api_request_count ?? 1) || 1));
      if (ts < entry.occurredAtMs) entry.occurredAtMs = ts;
      userAcc.set(key, entry);
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { lines, mtimeMs };
}

/**
 * 递归列出目录下所有 .jsonl 文件路径。不跟随符号链接。
 */
async function listJsonlFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf-8' });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = await listJsonlFilesRecursive(full);
      out.push(...sub);
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 推断 jsonl 文件的 channel。
 *
 * - 主会话：同目录 .meta.json 的 channel 字段
 * - subagent：路径形如 .../{parentSessionId}/subagents/agent-xxx.jsonl
 *             向上找父 session 的 meta（{parentSessionId}.meta.json 与该子目录同级）
 * - 缺失：默认 'web'
 */
async function inferChannel(jsonlPath: string): Promise<string> {
  const direct = await readSessionMeta(jsonlPath).catch(() => null);
  if (direct?.channel) return direct.channel;

  // subagent 路径检测：.../<parent>/subagents/agent-xxx.jsonl
  const dir = dirname(jsonlPath);
  if (dir.endsWith('/subagents') || dir.endsWith('\\subagents')) {
    const parentDir = dirname(dir);              // .../<parent>
    const parentSessionId = parentDir.split(/[/\\]/).pop() ?? '';
    if (parentSessionId) {
      const parentJsonl = join(dirname(parentDir), `${parentSessionId}.jsonl`);
      const parentMeta = await readSessionMeta(parentJsonl).catch(() => null);
      if (parentMeta?.channel) return parentMeta.channel;
    }
  }

  return 'web';
}

/**
 * 主入口：根据 rebuild_state 决定是否执行全量重建。
 */
export async function rebuildTokenUsageFromJsonl(
  db: DatabaseSync,
  options: RebuildOptions,
): Promise<RebuildStats> {
  const log = options.log ?? (() => {});
  const projectsRoot = options.projectsRoot ?? AGENT_LEGACY_TRANSCRIPTS_ROOT;
  const legacyProjectsRoot = options.legacyProjectsRoot === null
    ? null
    : (options.legacyProjectsRoot ?? CLAUDE_PROJECTS_ROOT);
  const startedAt = Date.now();
  const store = createTokenUsageStore(db);

  // 短路：非首次启动且未强制
  const existing = store.getRebuildState();
  if (existing && !options.force) {
    log(`[token-usage] rebuild skipped (state exists, last_rebuild_at=${new Date(existing.lastRebuildAtMs).toISOString()})`);
    return {
      performed: false,
      filesScanned: 0,
      linesProcessed: 0,
      rowsWritten: 0,
      maxMtimeMs: existing.jsonlMaxMtimeMs,
      durationMs: 0,
    };
  }

  const prefix = buildProjectKeyPrefix(options.agentCwd);
  log(`[token-usage] rebuild starting (agentRoot='${projectsRoot}', legacyProjectKey prefix='${prefix}')`);

  // 内存累加：username → (date|model|channel) → { channel, bucket }
  const acc = new Map<string, UserAcc>();
  // PR 10：username → tenantId 映射（从 jsonl 路径或 meta 解析）。upsertRaw 时回填 tenant_id 列。
  const userTenant = new Map<string, string>();
  let filesScanned = 0;
  let linesProcessed = 0;
  let maxMtimeMs = 0;

  // 新布局：~/.agent-saas/legacy-transcripts/<tenantId>/<userId>/**/*.jsonl
  // PR 10：从 parts[0] 解析 tenantId（之前这里只解析 parts[1] 当 userId，整个 tenant 维度丢失）
  const newLayoutFiles = await listJsonlFilesRecursive(projectsRoot);
  for (const file of newLayoutFiles) {
    const rel = relative(projectsRoot, file);
    const parts = rel.split(/[/\\]/);
    const tenantIdFromPath = parts[0];
    const fallbackUsername = parts[1]; // <tenantId>/<userId>/... — meta 缺失时以 userId 兜底
    if (!fallbackUsername || !tenantIdFromPath) continue;
    const meta = await readSessionMeta(file).catch(() => null);
    const username = meta?.username || fallbackUsername;
    const tenantId = meta?.tenantId || tenantIdFromPath;
    let userMap = acc.get(username);
    if (!userMap) {
      userMap = new Map();
      acc.set(username, userMap);
    }
    // username 的 tenantId 记忆：首次出现时绑定。username 全局唯一，理论上不会跨 tenant 出现，
    // 若出现冲突（脏数据）保留首次并 warn。
    const existing = userTenant.get(username);
    if (!existing) {
      userTenant.set(username, tenantId);
    } else if (existing !== tenantId) {
      log(`[token-usage] WARN username ${username} appears under multiple tenants: ${existing} vs ${tenantId} (keeping ${existing})`);
    }
    filesScanned++;
    const channel = meta?.channel || await inferChannel(file);
    const r = await processJsonl(file, channel, userMap);
    linesProcessed += r.lines;
    if (r.mtimeMs > maxMtimeMs) maxMtimeMs = r.mtimeMs;
  }

  // 旧布局：~/.claude/projects/<cwd-derived-projectKey>/**/*.jsonl（迁移期 fallback）
  if (legacyProjectsRoot) {
    let projectKeys: string[] = [];
    try {
      const entries = await readdir(legacyProjectsRoot, { withFileTypes: true });
      projectKeys = entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch (err) {
      log(`[token-usage] legacy projects root unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }

    for (const projectKey of projectKeys) {
      const username = parseUsernameFromProjectKey(projectKey, prefix);
      if (!username) continue;

      const projectDir = join(legacyProjectsRoot, projectKey);
      const jsonlFiles = await listJsonlFilesRecursive(projectDir);

      let userMap = acc.get(username);
      if (!userMap) {
        userMap = new Map();
        acc.set(username, userMap);
      }
      // 旧布局 ~/.claude/projects/ 路径里没有 tenantId 信息，兜底 LEGACY_TENANT_ID。
      // 注意：若新布局已经为同名 username 设过 tenantId，不覆盖。
      if (!userTenant.has(username)) userTenant.set(username, LEGACY_TENANT_ID);

      for (const file of jsonlFiles) {
        filesScanned++;
        const channel = await inferChannel(file);
        const r = await processJsonl(file, channel, userMap);
        linesProcessed += r.lines;
        if (r.mtimeMs > maxMtimeMs) maxMtimeMs = r.mtimeMs;
      }
    }
  }

  // 写入：清表 + 批量 UPSERT 全程包在事务内
  db.exec('BEGIN');
  try {
    store.clearAll();
    let rowsWritten = 0;
    for (const [username, userMap] of acc) {
      for (const [key, entry] of userMap) {
        const [minute, model] = key.split('|');
        if (!minute || !model) continue;
        const date = minute.slice(0, 10);
        const tokens = {
          inputTokens: entry.bucket.inputTokens,
          outputTokens: entry.bucket.outputTokens,
          cacheReadTokens: entry.bucket.cacheReadTokens,
          cacheCreationTokens: entry.bucket.cacheCreationTokens,
        };
        const delta: UsageDailyRowDelta = {
          date,
          username,
          // PR 10：从 userTenant 映射回填 tenantId；理论上 acc 中 username 一定也在 userTenant
          // 里（同一文件循环里 set 的），但旧路径在 userMap 创建后才 set，所以这里兜底 legacy。
          tenantId: userTenant.get(username) ?? LEGACY_TENANT_ID,
          model,
          channel: entry.channel,
          ...tokens,
          // 按本地 pricing.ts 计算（未知 model → 0 并 warn 一次）
          costUsdMicro: computeCostMicro(model, tokens, log),
          turnDelta: entry.bucket.turnDelta,
          occurredAtMs: entry.occurredAtMs,
        };
        store.upsertRaw(delta);
        rowsWritten++;
      }
    }
    store.setRebuildState({
      lastRebuildAtMs: Date.now(),
      lastFullScanMs: Date.now(),
      jsonlMaxMtimeMs: maxMtimeMs,
      totalFilesScanned: filesScanned,
      totalRowsBuilt: rowsWritten,
    });
    db.exec('COMMIT');

    const durationMs = Date.now() - startedAt;
    log(`[token-usage] rebuild done: files=${filesScanned}, lines=${linesProcessed}, rows=${rowsWritten}, took=${durationMs}ms`);
    return {
      performed: true,
      filesScanned,
      linesProcessed,
      rowsWritten,
      maxMtimeMs,
      durationMs,
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    log(`[token-usage] rebuild failed during write: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/** 测试/管理脚本：清空 rebuild_state 强制下次启动重建 */
export function resetRebuildState(db: DatabaseSync): void {
  db.exec('DELETE FROM token_usage_rebuild_state');
}
