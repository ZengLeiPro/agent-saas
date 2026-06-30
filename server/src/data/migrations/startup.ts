/**
 * 启动时数据迁移
 *
 * BUG 2: 修复 anonymous cron 分组归属（cron 分组 userId=anonymous → 正确 owner）
 * BUG 3: 补写 cron 会话 meta（无 meta 的 cron session 补写 userId/username/channel/createdAt）
 * BUG 5: 补写所有用户缺失 meta 的会话（解决 admin 查看他人会话无用户名 + 文件预览 404）
 */
import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import { ALLOWED_ROOT, getAgentTranscriptDir, isValidSessionId } from '../transcripts/projectKey.js';
import { getTranscriptPath } from '../transcripts/store.js';
import { readSessionMeta, writeSessionMeta } from '../transcripts/meta.js';
import { resolveUserCwd } from '../../workspace/resolver.js';
import type { GroupStore } from '../groups/store.js';
import type { UserStore } from '../users/store.js';
import type { CronService } from '../../cron/service.js';
import { dataLogger } from '../../utils/logger.js';

export interface StartupMigrationDeps {
  globalAgentCwd: string;
  userStore: UserStore;
  groupStore: GroupStore;
  cronService: CronService | null;
}

export async function runStartupMigrations(deps: StartupMigrationDeps): Promise<void> {
  await fixAnonymousCronGroups(deps);  // BUG 2
  await backfillCronSessionMeta(deps); // BUG 3
  await backfillAllSessionMeta(deps);  // BUG 5
  await cleanupOldAgentTranscripts();  // housekeeping: warmup/subagent transcripts
}

// ============================================================
// Housekeeping: 清理陈旧的 sidechain / subagent transcript
// ============================================================

const AGENT_TRANSCRIPT_RETENTION_DAYS = 5;
const AGENT_META_PATTERN = /^agent-[0-9a-f]+\.meta\.json$/i;

async function cleanupOldAgentTranscripts(): Promise<void> {
  const cutoffMs = Date.now() - AGENT_TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  let removedTopLevel = 0;
  let removedSubagent = 0;
  let removedDirs = 0;

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      const fullPath = path.join(dir, name);

      let stat: Stats;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (isValidSessionId(name)) {
          await cleanupSessionSidecar(fullPath);
        } else {
          await walk(fullPath);
        }
        continue;
      }

      if (/^agent-[0-9a-f]+\.jsonl$/i.test(name) || AGENT_META_PATTERN.test(name)) {
        try {
          if (!stat.isFile() || stat.mtimeMs >= cutoffMs) continue;
          await fs.unlink(fullPath);
          removedTopLevel++;
        } catch {
          // ignore per-file failure
        }
        continue;
      }
    }
  }

  async function cleanupSessionSidecar(sessionDir: string): Promise<void> {
    const subagentsDir = path.join(sessionDir, 'subagents');
    let subEntries: string[];
    try {
      const stat = await fs.stat(subagentsDir);
      if (!stat.isDirectory()) return;
      subEntries = await fs.readdir(subagentsDir);
    } catch {
      return;
    }

    for (const subName of subEntries) {
      if (!/^agent-[0-9a-f]+(?:\.(?:jsonl|meta\.json))?$/i.test(subName)) continue;
      const subPath = path.join(subagentsDir, subName);
      try {
        const stat = await fs.stat(subPath);
        if (!stat.isFile() || stat.mtimeMs >= cutoffMs) continue;
        await fs.unlink(subPath);
        removedSubagent++;
      } catch {
        // ignore per-file failure
      }
    }

    try {
      const remaining = await fs.readdir(subagentsDir);
      if (remaining.length === 0) {
        await fs.rmdir(subagentsDir);
        removedDirs++;
      }
    } catch {
      // ignore empty-dir cleanup failure
    }
  }

  await walk(ALLOWED_ROOT);

  if (removedTopLevel > 0 || removedSubagent > 0 || removedDirs > 0) {
    dataLogger.info(
      `[startup] housekeeping: removed ${removedTopLevel} top-level agent transcript file(s), `
      + `${removedSubagent} subagent transcript file(s), ${removedDirs} empty subagents dir(s) `
      + `(older than ${AGENT_TRANSCRIPT_RETENTION_DAYS} days)`,
    );
  }
}

// ============================================================
// BUG 2: 修复 anonymous cron 分组归属
// ============================================================

async function fixAnonymousCronGroups(deps: StartupMigrationDeps): Promise<void> {
  const { groupStore, cronService } = deps;

  if (!cronService) return;

  // 找出所有 kind=cron && userId=anonymous 的分组
  const anonymousGroups = groupStore.listAll().filter(
    g => g.kind === 'cron' && g.userId === 'anonymous' && g.cronJobId,
  );

  if (anonymousGroups.length === 0) return;

  // 从 CronService 获取 job → owner 映射
  let jobs: Awaited<ReturnType<CronService['list']>> = [];
  try {
    jobs = await cronService.list({ includeDisabled: true });
  } catch (err) {
    dataLogger.warn(`[startup] BUG2: Failed to list cron jobs: ${err}`);
    return;
  }

  const jobOwnerMap = new Map<string, string>();
  for (const job of jobs) {
    if (job.owner) {
      jobOwnerMap.set(job.id, job.owner);
    }
  }

  let fixedCount = 0;
  for (const group of anonymousGroups) {
    const owner = jobOwnerMap.get(group.cronJobId!);
    if (!owner) continue; // 无法确定归属，保持 anonymous

    await groupStore.updateInternal(group.id, { userId: owner });
    fixedCount++;
  }

  if (fixedCount > 0) {
    dataLogger.info(`[startup] BUG2: Fixed ${fixedCount} anonymous cron group(s) with correct owner`);
  }
}

// ============================================================
// BUG 3: 补写 cron 会话 meta
// ============================================================

async function backfillCronSessionMeta(deps: StartupMigrationDeps): Promise<void> {
  const { globalAgentCwd, groupStore, userStore } = deps;

  // 取所有 cron 分组（BUG 2 修复后 userId 已正确）
  const cronGroups = groupStore.listAll().filter(
    g => g.kind === 'cron' && g.userId !== 'anonymous',
  );

  if (cronGroups.length === 0) return;

  let writtenCount = 0;

  for (const group of cronGroups) {
    // 找到归属用户
    const user = userStore.findById(group.userId);
    if (!user) continue;

    // 确定该用户的 cwd（cron session 可能在 per-user 或全局 ownerless 目录）
    const userCwd = resolveUserCwd(globalAgentCwd, { id: user.id, username: user.username, role: user.role, tenantId: user.tenantId });
    const transcriptCandidatesFor = (sessionId: string) => {
      const paths = user.tenantId
        ? [getTranscriptPath(userCwd, sessionId, { tenantId: user.tenantId, userId: user.id })]
        : [];
      if (userCwd !== globalAgentCwd) paths.push(getTranscriptPath(userCwd, sessionId));
      paths.push(getTranscriptPath(globalAgentCwd, sessionId));
      return paths;
    };

    for (const sessionId of group.sessionIds) {
      // 在新 owner layout 和 ownerless fallback 中查找 transcript
      let foundTranscriptPath: string | null = null;
      for (const candidate of transcriptCandidatesFor(sessionId)) {
        try {
          await fs.access(candidate);
          foundTranscriptPath = candidate;
          break;
        } catch {
          // 继续下一个
        }
      }

      if (!foundTranscriptPath) continue;

      // 已有 meta 则跳过（幂等）
      const existing = await readSessionMeta(foundTranscriptPath);
      if (existing) continue;

      // 从 transcript 中读取创建时间（取第一行的 timestamp）
      let createdAt: string;
      try {
        const content = await fs.readFile(foundTranscriptPath, 'utf-8');
        const firstLine = content.split('\n').find(l => l.trim());
        const parsed = firstLine ? JSON.parse(firstLine) as { timestamp?: string } : null;
        createdAt = parsed?.timestamp ?? new Date().toISOString();
      } catch {
        createdAt = new Date().toISOString();
      }

      try {
        await writeSessionMeta(foundTranscriptPath, {
          userId: user.id,
          username: user.username,
          channel: 'cron',
          createdAt,
        });
        writtenCount++;
      } catch (err) {
        dataLogger.warn(`[startup] BUG3: Failed to write meta for session ${sessionId}: ${err}`);
      }
    }
  }

  if (writtenCount > 0) {
    dataLogger.info(`[startup] BUG3: Backfilled meta for ${writtenCount} cron session(s)`);
  }
}

// ============================================================
// BUG 5: 补写所有用户缺失 meta 的会话
// ============================================================

async function backfillAllSessionMeta(deps: StartupMigrationDeps): Promise<void> {
  const { userStore } = deps;
  const allUsers = userStore.listAll();
  let writtenCount = 0;

  for (const user of allUsers) {
    if (!user.tenantId) continue;
    const projectDir = getAgentTranscriptDir({ tenantId: user.tenantId, userId: user.id });

    let entries: string[];
    try {
      entries = await fs.readdir(projectDir);
    } catch {
      continue;
    }

    const jsonlFiles = entries.filter(f => f.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) continue;

    const metaSet = new Set(entries.filter(f => f.endsWith('.meta.json')));

    for (const file of jsonlFiles) {
      const sessionId = file.replace(/\.jsonl$/, '');
      if (!isValidSessionId(sessionId)) continue;
      if (metaSet.has(`${sessionId}.meta.json`)) continue;

      const transcriptPath = path.join(projectDir, file);

      let createdAt: string;
      try {
        const fd = await fs.open(transcriptPath, 'r');
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await fd.read(buf, 0, 4096, 0);
        await fd.close();
        const firstLine = buf.subarray(0, bytesRead).toString('utf-8').split('\n').find(l => l.trim());
        const parsed = firstLine ? JSON.parse(firstLine) as { timestamp?: string } : null;
        createdAt = parsed?.timestamp ?? new Date().toISOString();
      } catch {
        createdAt = new Date().toISOString();
      }

      try {
        await writeSessionMeta(transcriptPath, {
          userId: user.id,
          username: user.username,
          channel: 'web',
          createdAt,
        });
        writtenCount++;
      } catch (err) {
        dataLogger.warn(`[startup] BUG5: Failed to write meta for ${user.username}/${sessionId}: ${err}`);
      }
    }
  }

  if (writtenCount > 0) {
    dataLogger.info(`[startup] BUG5: Backfilled meta for ${writtenCount} session(s) across all users`);
  }
}
