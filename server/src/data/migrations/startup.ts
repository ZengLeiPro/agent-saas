/**
 * 启动时数据迁移
 *
 * BUG 2: 修复 anonymous cron 分组归属（cron 分组 userId=anonymous → 正确 owner）
 * BUG 3: 补写 cron 会话 meta（无 meta 的 cron session 补写 userId/username/channel/createdAt）
 * BUG 4: 旧 UUID 工作目录产生的 transcript 文件迁移到 username 目录对应的 projectKey
 * BUG 5: 补写所有用户缺失 meta 的会话（解决 admin 查看他人会话无用户名 + 文件预览 404）
 * BUG 6 (PR 7 P1-6): 多组织改造前的扁平 <cwd>/<username>/ transcript 迁移到
 *        当前 resolveUserCwd 路径对应的 projectKey，否则升级后用户会话"消失"
 */
import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import { ALLOWED_ROOT, deriveProjectKey, isValidSessionId } from '../transcripts/projectKey.js';
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
  await migrateUuidTranscripts(deps);  // BUG 4
  await migrateFlatToTenantTranscripts(deps);  // BUG 6 (PR 7 P1-6)
  await fixAnonymousCronGroups(deps);  // BUG 2
  await backfillCronSessionMeta(deps); // BUG 3
  await backfillAllSessionMeta(deps);  // BUG 5
  await cleanupOldAgentTranscripts();  // housekeeping: warmup/subagent transcripts
}

// ============================================================
// BUG 6 (PR 7 P1-6): 扁平 <cwd>/<username> → 当前 resolveUserCwd projectKey 迁移
// ============================================================

/**
 * PR 4 把 workspace 路径从 `<cwd>/<username>/` 改为 tenant 隔离路径；
 * 后续又把物理末段从 username 固定为 userId。
 * ~/.claude/projects 下的 projectKey 是从 cwd 派生的（替换 / 为 -），所以路径变更
 * 导致同一用户的 transcript projectKey 完全不同。如果不迁移，老用户升级后会感觉
 * "会话全部消失"（实际上还在旧 projectKey 下，只是新路径找不到）。
 *
 * 做法：扫所有用户，按"假设旧扁平路径"派生 oldProjectKey，与新路径派生的
 * newProjectKey 不同时把 .jsonl + .meta.json 全部 rename 过去（文件粒度幂等）。
 */
async function migrateFlatToTenantTranscripts(deps: StartupMigrationDeps): Promise<void> {
  const { globalAgentCwd, userStore } = deps;
  const allUsers = userStore.listAll();
  let migratedCount = 0;

  for (const user of allUsers) {
    // 旧扁平 cwd（PR 4 前）：<globalAgentCwd>/<username>
    const oldCwd = path.join(globalAgentCwd, user.username);
    // 当前用户 cwd：由 resolveUserCwd 统一决定。
    const newCwd = resolveUserCwd(globalAgentCwd, { id: user.id, username: user.username, role: user.role, tenantId: user.tenantId });

    if (oldCwd === newCwd) continue;

    const oldProjectKey = deriveProjectKey(oldCwd);
    const newProjectKey = deriveProjectKey(newCwd);
    if (oldProjectKey === newProjectKey) continue;

    const oldProjectDir = path.join(ALLOWED_ROOT, oldProjectKey);
    const newProjectDir = path.join(ALLOWED_ROOT, newProjectKey);

    let entries: string[];
    try {
      entries = await fs.readdir(oldProjectDir);
    } catch {
      continue; // 旧 projectKey 目录不存在，跳过
    }

    const files = entries.filter(f => f.endsWith('.jsonl') || f.endsWith('.meta.json'));
    if (files.length === 0) continue;

    try {
      await fs.mkdir(newProjectDir, { recursive: true });
    } catch {
      // ignore
    }

    for (const file of files) {
      const src = path.join(oldProjectDir, file);
      const dst = path.join(newProjectDir, file);
      // 跳过目标已存在（幂等）
      try {
        await fs.access(dst);
        continue;
      } catch {
        // 目标不存在，继续
      }
      try {
        await fs.rename(src, dst);
        migratedCount++;
      } catch {
        // 跨设备 rename 失败，copy + delete
        try {
          await fs.copyFile(src, dst);
          await fs.unlink(src);
          migratedCount++;
        } catch (err) {
          dataLogger.warn(`[startup] BUG6: Failed to migrate ${src} → ${dst}: ${err}`);
        }
      }
    }
  }

  if (migratedCount > 0) {
    dataLogger.info(`[startup] BUG6: Migrated ${migratedCount} transcript file(s) to tenant-aware projectKey`);
  }
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

  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(ALLOWED_ROOT);
  } catch {
    return;
  }

  for (const projectKey of projectDirs) {
    const projectDir = path.join(ALLOWED_ROOT, projectKey);

    let projectStat: Stats | undefined;
    try {
      projectStat = await fs.stat(projectDir);
    } catch {
      continue;
    }
    if (!projectStat.isDirectory()) continue;

    let entries: string[];
    try {
      entries = await fs.readdir(projectDir);
    } catch {
      continue;
    }

    for (const name of entries) {
      const fullPath = path.join(projectDir, name);

      if (/^agent-[0-9a-f]+\.jsonl$/i.test(name) || AGENT_META_PATTERN.test(name)) {
        try {
          const stat = await fs.stat(fullPath);
          if (!stat.isFile() || stat.mtimeMs >= cutoffMs) continue;
          await fs.unlink(fullPath);
          removedTopLevel++;
        } catch {
          // ignore per-file failure
        }
        continue;
      }

      if (!isValidSessionId(name)) continue;

      const subagentsDir = path.join(fullPath, 'subagents');
      let subEntries: string[];
      try {
        const stat = await fs.stat(subagentsDir);
        if (!stat.isDirectory()) continue;
        subEntries = await fs.readdir(subagentsDir);
      } catch {
        continue;
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
  }

  if (removedTopLevel > 0 || removedSubagent > 0 || removedDirs > 0) {
    dataLogger.info(
      `[startup] housekeeping: removed ${removedTopLevel} top-level agent transcript file(s), `
      + `${removedSubagent} subagent transcript file(s), ${removedDirs} empty subagents dir(s) `
      + `(older than ${AGENT_TRANSCRIPT_RETENTION_DAYS} days)`,
    );
  }
}

// ============================================================
// BUG 4: 旧 UUID transcript 目录迁移到 username projectKey 目录
// ============================================================

async function migrateUuidTranscripts(deps: StartupMigrationDeps): Promise<void> {
  const { globalAgentCwd, userStore } = deps;
  const allUsers = userStore.listAll();
  let migratedCount = 0;

  for (const user of allUsers) {
    // 旧 UUID cwd：workspace/{userId}
    const oldCwd = path.join(globalAgentCwd, user.id);
    // 新 username cwd：workspace/{username}
    const newCwd = resolveUserCwd(globalAgentCwd, { id: user.id, username: user.username, role: user.role, tenantId: user.tenantId });

    if (oldCwd === newCwd) continue; // id 与 username 相同则跳过

    const oldProjectKey = deriveProjectKey(oldCwd);
    const newProjectKey = deriveProjectKey(newCwd);

    if (oldProjectKey === newProjectKey) continue;

    const oldProjectDir = path.join(ALLOWED_ROOT, oldProjectKey);
    const newProjectDir = path.join(ALLOWED_ROOT, newProjectKey);

    let entries: string[];
    try {
      entries = await fs.readdir(oldProjectDir);
    } catch {
      continue; // 旧目录不存在，跳过
    }

    // 只处理 .jsonl 和 .meta.json 文件
    const files = entries.filter(f => f.endsWith('.jsonl') || f.endsWith('.meta.json'));
    if (files.length === 0) continue;

    // 确保新目录存在
    try {
      await fs.mkdir(newProjectDir, { recursive: true });
    } catch {
      // ignore
    }

    for (const file of files) {
      const src = path.join(oldProjectDir, file);
      const dst = path.join(newProjectDir, file);

      // 跳过目标已存在的文件（幂等）
      try {
        await fs.access(dst);
        continue; // 目标已存在，跳过
      } catch {
        // 目标不存在，继续移动
      }

      try {
        await fs.rename(src, dst);
        migratedCount++;
      } catch {
        // 跨设备移动时 rename 失败，尝试 copy + delete
        try {
          await fs.copyFile(src, dst);
          await fs.unlink(src);
          migratedCount++;
        } catch (err) {
          dataLogger.warn(`[startup] BUG4: Failed to migrate ${src} → ${dst}: ${err}`);
        }
      }
    }
  }

  if (migratedCount > 0) {
    dataLogger.info(`[startup] BUG4: Migrated ${migratedCount} transcript file(s) from UUID dirs to username dirs`);
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

    // 确定该用户的 cwd（cron session 可能在 per-user 或全局目录）
    const userCwd = resolveUserCwd(globalAgentCwd, { id: user.id, username: user.username, role: user.role, tenantId: user.tenantId });
    const cwdsToTry = userCwd !== globalAgentCwd
      ? [userCwd, globalAgentCwd]
      : [globalAgentCwd];

    for (const sessionId of group.sessionIds) {
      // 在可能的 cwd 中查找 transcript
      let foundTranscriptPath: string | null = null;
      for (const cwd of cwdsToTry) {
        const candidate = getTranscriptPath(cwd, sessionId);
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
  const { globalAgentCwd, userStore } = deps;
  const allUsers = userStore.listAll();
  let writtenCount = 0;

  // 构建 projectKey → user 映射（per-user + 全局 workspace 根）
  const keyUserMap = new Map<string, { id: string; username: string }>();
  for (const user of allUsers) {
    const userCwd = resolveUserCwd(globalAgentCwd, { id: user.id, username: user.username, role: user.role, tenantId: user.tenantId });
    keyUserMap.set(deriveProjectKey(userCwd), { id: user.id, username: user.username });
  }
  // 全局 workspace 根目录（兜底，归属 admin 或 unknown）
  const globalKey = deriveProjectKey(globalAgentCwd);
  if (!keyUserMap.has(globalKey)) {
    const admin = allUsers.find(u => u.role === 'admin');
    keyUserMap.set(globalKey, admin ? { id: admin.id, username: admin.username } : { id: 'unknown', username: 'unknown' });
  }

  for (const [projectKey, owner] of keyUserMap) {
    const projectDir = path.join(ALLOWED_ROOT, projectKey);

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
          userId: owner.id,
          username: owner.username,
          channel: 'web',
          createdAt,
        });
        writtenCount++;
      } catch (err) {
        dataLogger.warn(`[startup] BUG5: Failed to write meta for ${owner.username}/${sessionId}: ${err}`);
      }
    }
  }

  if (writtenCount > 0) {
    dataLogger.info(`[startup] BUG5: Backfilled meta for ${writtenCount} session(s) across all users`);
  }
}
