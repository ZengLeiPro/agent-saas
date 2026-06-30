/**
 * 用户删除后的软清理：将关联资源重命名为 *-deleted-{timestamp} 形式。
 * 保留数据可恢复，避免 rm -rf 造成不可逆损失。
 */

import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { authLogger } from '../../utils/logger.js';
import { resolveUserCwd } from '../../workspace/resolver.js';
import { getProjectDir } from '../transcripts/projectKey.js';

export interface CleanupContext {
  userId: string;
  username: string;
  /** PR 6 P1-5：用户所属 tenant slug，用于 resolveUserCwd 落正确路径 */
  tenantId?: string;
  agentCwd: string;
  avatarsDir: string;
}

/**
 * 对已删除用户的关联资源执行软删除（重命名加后缀）。
 * 全部操作 best-effort，单项失败不影响其余项。
 */
export function softDeleteUserResources(ctx: CleanupContext): void {
  const suffix = `-deleted-${Date.now()}`;

  softDeleteWorkspace(ctx, suffix);
  softDeleteTranscripts(ctx, suffix);
  softDeleteAvatars(ctx, suffix);
}

// ---- internals ----

function softDeleteWorkspace(ctx: CleanupContext, suffix: string): void {
  const userCwd = resolveUserCwd(ctx.agentCwd, {
    id: ctx.userId,
    username: ctx.username,
    role: 'user', // role doesn't matter for path resolution
    tenantId: ctx.tenantId,
  });

  if (!existsSync(userCwd)) return;

  const dest = `${userCwd}${suffix}`;
  try {
    renameSync(userCwd, dest);
    authLogger.info(`Soft-deleted workspace: ${userCwd} → ${dest}`);
  } catch (err) {
    authLogger.warn(`Failed to soft-delete workspace ${userCwd}: ${err}`);
  }
}

function softDeleteTranscripts(ctx: CleanupContext, suffix: string): void {
  const userCwd = resolveUserCwd(ctx.agentCwd, {
    id: ctx.userId,
    username: ctx.username,
    role: 'user',
    tenantId: ctx.tenantId,
  });

  const projectDir = getProjectDir(userCwd);
  if (!existsSync(projectDir)) return;

  const dest = `${projectDir}${suffix}`;
  try {
    renameSync(projectDir, dest);
    authLogger.info(`Soft-deleted transcripts: ${projectDir} → ${dest}`);
  } catch (err) {
    authLogger.warn(`Failed to soft-delete transcripts ${projectDir}: ${err}`);
  }
}

function softDeleteAvatars(ctx: CleanupContext, suffix: string): void {
  if (!existsSync(ctx.avatarsDir)) return;

  try {
    const files = readdirSync(ctx.avatarsDir);
    for (const f of files) {
      if (!f.startsWith(ctx.userId)) continue;

      const ext = extname(f);
      const base = basename(f, ext);
      const dest = join(ctx.avatarsDir, `${base}${suffix}${ext}`);

      try {
        renameSync(join(ctx.avatarsDir, f), dest);
        authLogger.info(`Soft-deleted avatar: ${f} → ${basename(dest)}`);
      } catch (err) {
        authLogger.warn(`Failed to soft-delete avatar ${f}: ${err}`);
      }
    }
  } catch (err) {
    authLogger.warn(`Failed to read avatars dir for cleanup: ${err}`);
  }
}
