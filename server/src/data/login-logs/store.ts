/**
 * 操作日志 JSONL 存储
 *
 * 复用 cron/run-log.ts 的 append-only JSONL 模式。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { LoginLogEntry, LoginLogQuery, LoginLogResponse } from './types.js';
import { authLogger } from '../../utils/logger.js';

const logger = authLogger.child('LoginLog');

const DEFAULT_MAX_BYTES = 2_000_000; // 2MB
const DEFAULT_KEEP_LINES = 5000;

// ---- Write ----

export async function appendLoginLog(
  entry: LoginLogEntry,
  filePath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
  await pruneIfNeeded(filePath);
}

// ---- Read ----

export async function queryLoginLogs(
  query: LoginLogQuery,
  filePath: string,
): Promise<LoginLogResponse> {
  const all = await readAll(filePath);

  // 事件类别分组
  const CATEGORY_MAP: Record<string, string[]> = {
    login: ['login_success', 'login_fail'],
    activity: ['app_foreground', 'app_background', 'page_viewed'],
    session: ['chat_message_sent', 'session_opened', 'session_soft_deleted', 'session_restored', 'session_permanently_deleted', 'session_renamed', 'session_forked'],
    group: ['group_created', 'group_updated', 'group_deleted', 'group_sessions_added', 'group_sessions_removed'],
    cron: ['cron_job_created', 'cron_job_updated', 'cron_job_deleted', 'cron_job_toggled', 'cron_job_triggered'],
    user: ['user_created', 'user_updated', 'user_deleted', 'user_avatar_updated', 'user_disabled', 'user_enabled', 'user_password_changed'],
    file: ['file_previewed', 'file_downloaded', 'file_deleted'],
    agent: ['agent_profile_viewed', 'agent_profile_updated', 'agent_persona_viewed', 'agent_persona_updated', 'agent_memory_viewed', 'agent_memory_updated', 'agent_avatar_uploaded', 'agent_avatar_reset'],
    skill: ['skill_visibility_updated', 'skill_promoted', 'skill_custom_deleted', 'skill_tenant_selections_updated', 'skill_user_selections_updated', 'skill_document_updated'],
    mcp: ['mcp_server_updated', 'mcp_server_deleted', 'mcp_user_selections_updated', 'mcp_admin_user_selections_updated', 'mcp_secret_bound', 'mcp_secret_rotated', 'mcp_secret_deleted', 'mcp_oauth_connected', 'mcp_oauth_revoked'],
    tenant: ['tenant_created', 'tenant_updated', 'tenant_disabled', 'tenant_enabled', 'tenant_deleted'],
  };

  let filtered = all;
  if (query.username) {
    if (Array.isArray(query.username)) {
      const set = new Set(query.username);
      filtered = filtered.filter(e => set.has(e.username));
    } else {
      filtered = filtered.filter(e => e.username === query.username);
    }
  }
  if (query.event) {
    filtered = filtered.filter(e => e.event === query.event);
  }
  if (query.category && CATEGORY_MAP[query.category]) {
    const events = CATEGORY_MAP[query.category];
    filtered = filtered.filter(e => events.includes(e.event));
  }
  if (query.channel) {
    filtered = filtered.filter(e => e.channel === query.channel);
  }
  if (query.startTime) {
    filtered = filtered.filter(e => e.timestamp >= query.startTime!);
  }
  if (query.endTime) {
    filtered = filtered.filter(e => e.timestamp <= query.endTime!);
  }

  // newest first
  filtered.reverse();

  const limit = Math.max(1, Math.min(200, query.limit ?? 50));
  const offset = Math.max(0, query.offset ?? 0);

  return {
    entries: filtered.slice(offset, offset + limit),
    total: filtered.length,
  };
}

// ---- Clear by username ----

export async function clearLogsByUsername(
  filePath: string,
  username: string,
): Promise<{ deleted: number }> {
  const all = await readAll(filePath);
  if (all.length === 0) return { deleted: 0 };
  const kept = all.filter(e => e.username !== username);
  const deleted = all.length - kept.length;
  await fs.writeFile(
    filePath,
    kept.length ? `${kept.map(e => JSON.stringify(e)).join('\n')}\n` : '',
    'utf-8',
  );
  return { deleted };
}

// ---- Clear ----

export async function clearLoginLogs(
  filePath: string,
  options?: { beforeDate?: string; excludeUsername?: string },
): Promise<{ deleted: number }> {
  const all = await readAll(filePath);
  if (all.length === 0) return { deleted: 0 };

  if (options?.beforeDate || options?.excludeUsername) {
    const kept = all.filter(e => {
      if (options.excludeUsername && e.username === options.excludeUsername) return true;
      if (options.beforeDate && e.timestamp >= options.beforeDate) return true;
      if (!options.beforeDate) return false;
      return false;
    });
    const deleted = all.length - kept.length;
    await fs.writeFile(
      filePath,
      kept.length ? `${kept.map(e => JSON.stringify(e)).join('\n')}\n` : '',
      'utf-8',
    );
    return { deleted };
  }

  // 无条件清空
  await fs.writeFile(filePath, '', 'utf-8');
  return { deleted: all.length };
}

// ---- Last Active Per User ----

/** 非活跃事件（仅排除失败和被动事件，其余均视为用户主动操作） */
const INACTIVE_EVENTS = new Set(['login_fail', 'app_background']);

export interface UserActiveInfo {
  lastActive: string;
  mobileLastActive?: string;
}

/**
 * 返回每个用户最后一次活跃时间（username → { lastActive, mobileLastActive }）。
 * 只统计"真实活跃"事件，忽略 login_fail / 管理员操作等。
 */
export async function getLastActivePerUser(
  filePath: string,
): Promise<Map<string, UserActiveInfo>> {
  const all = await readAll(filePath);
  const map = new Map<string, UserActiveInfo>();
  for (const entry of all) {
    if (INACTIVE_EVENTS.has(entry.event)) continue;
    const prev = map.get(entry.username);
    const ts = entry.timestamp;
    if (!prev) {
      map.set(entry.username, {
        lastActive: ts,
        mobileLastActive: entry.channel === 'mobile' ? ts : undefined,
      });
    } else {
      if (ts > prev.lastActive) prev.lastActive = ts;
      if (entry.channel === 'mobile' && (!prev.mobileLastActive || ts > prev.mobileLastActive)) {
        prev.mobileLastActive = ts;
      }
    }
  }
  return map;
}

// ---- Internal ----

async function readAll(filePath: string): Promise<LoginLogEntry[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    const entries: LoginLogEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as LoginLogEntry);
      } catch {
        // skip malformed line
      }
    }
    return entries;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

async function pruneIfNeeded(
  filePath: string,
  maxBytes = DEFAULT_MAX_BYTES,
  keepLines = DEFAULT_KEEP_LINES,
): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size <= maxBytes) return;

    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    if (lines.length <= keepLines) return;

    const kept = lines.slice(-keepLines);
    await fs.writeFile(filePath, `${kept.join('\n')}\n`, 'utf-8');
    logger.info(`Pruned login log: ${lines.length} -> ${kept.length} lines`);
  } catch {
    // ignore
  }
}
