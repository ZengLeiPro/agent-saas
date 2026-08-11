import { lstat, mkdir, readdir, rename } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import type { UserInfo } from '../data/users/types.js';
import { resolveUserCwd } from '../workspace/resolver.js';

const RETENTION_ROOT = '.governance-retention';
const SYSTEM_FILES = new Set(['.workspace-meta.json']);

export interface PersonalWorkspaceInventory {
  personalMemoryIds: string[];
  personalFileIds: string[];
  organizationFileIds: string[];
}

async function listWorkspaceEntries(root: string): Promise<string[]> {
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
  } catch {
    return [];
  }
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (directory === root && entry.name === RETENTION_ROOT) continue;
      const absolutePath = join(directory, entry.name);
      const rel = relative(root, absolutePath).split(sep).join('/');
      if (SYSTEM_FILES.has(rel)) continue;
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(absolutePath);
      else files.push(rel);
    }
  };
  await walk(root);
  return files.sort();
}

function isMemoryPath(path: string): boolean {
  return path === 'MEMORY.md' || (path.startsWith('memory/') && path.endsWith('.md'));
}

export async function inventoryPersonalWorkspace(
  agentCwd: string,
  user: UserInfo,
): Promise<PersonalWorkspaceInventory> {
  const files = await listWorkspaceEntries(resolveUserCwd(agentCwd, user));
  return {
    personalMemoryIds: files.filter(isMemoryPath),
    personalFileIds: files.filter(path => !isMemoryPath(path)),
    // 当前文件系统没有组织 owner 元数据；不得从目录位置推导组织 ownership。
    organizationFileIds: [],
  };
}

export async function archivePersonalWorkspace(
  agentCwd: string,
  user: UserInfo,
  jobId: string,
  manifestPaths?: readonly string[],
): Promise<{ affectedCount: number; completedCount: number }> {
  const sourceRoot = resolveUserCwd(agentCwd, user);
  const inventory = manifestPaths ? undefined : await inventoryPersonalWorkspace(agentCwd, user);
  const paths = [...new Set(manifestPaths ?? [
    ...(inventory?.personalMemoryIds ?? []),
    ...(inventory?.personalFileIds ?? []),
  ])].sort();
  if (paths.some(path => !path || path.startsWith('/') || path.split('/').includes('..'))) {
    throw new Error('OFFBOARDING_RETENTION_MANIFEST_INVALID');
  }
  const retentionRoot = join(agentCwd, RETENTION_ROOT, user.tenantId, user.id, jobId);
  let completedCount = 0;
  for (const rel of paths) {
    const source = join(sourceRoot, rel);
    const destination = join(retentionRoot, rel);
    try {
      await lstat(source);
      await mkdir(dirname(destination), { recursive: true });
      await rename(source, destination);
      completedCount += 1;
    } catch (error) {
      try {
        await lstat(destination);
        // A prior attempt already moved this exact manifest item.
        completedCount += 1;
      } catch {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return { affectedCount: paths.length, completedCount };
}
