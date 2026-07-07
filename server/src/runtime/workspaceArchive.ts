import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { WorkspaceUsageRecord, WorkspaceUsageStatus } from './systemMetricsStore.js';

const ARCHIVABLE_STATUSES: ReadonlySet<WorkspaceUsageStatus> = new Set([
  'soft_deleted',
  'orphan_tenant',
  'orphan_user',
]);

export interface ArchiveWorkspaceInput {
  agentCwd: string;
  path: string;
  confirm: string;
  usage: WorkspaceUsageRecord;
  now?: Date;
}

export interface ArchiveWorkspaceResult {
  sourcePath: string;
  targetPath: string;
  relativeArchivePath: string;
}

export function canArchiveWorkspaceStatus(status: WorkspaceUsageStatus): boolean {
  return ARCHIVABLE_STATUSES.has(status);
}

export async function archiveWorkspace(input: ArchiveWorkspaceInput): Promise<ArchiveWorkspaceResult> {
  const safe = resolveWorkspacePath(input.agentCwd, input.path);
  if (input.usage.path !== input.path) {
    throw new Error('Workspace usage record does not match requested path');
  }
  if (!canArchiveWorkspaceStatus(input.usage.status)) {
    throw new Error('Only soft-deleted or orphan workspaces can be archived');
  }
  const lastSegment = basename(safe.absolutePath);
  if (input.confirm !== lastSegment) {
    throw new Error('Confirmation does not match workspace directory name');
  }
  if (!existsSync(safe.absolutePath)) {
    throw new Error('Workspace directory no longer exists');
  }
  const day = formatDay(input.now ?? new Date());
  const archiveRoot = resolve(dirname(input.agentCwd), 'runtime', 'archive', day);
  await mkdir(archiveRoot, { recursive: true });
  const targetName = `${input.usage.tenantId}__${lastSegment}`;
  const targetPath = join(archiveRoot, targetName);
  if (existsSync(targetPath)) {
    throw new Error('Archive target already exists');
  }
  await rename(safe.absolutePath, targetPath);
  return {
    sourcePath: safe.absolutePath,
    targetPath,
    relativeArchivePath: relative(dirname(input.agentCwd), targetPath),
  };
}

export function resolveWorkspacePath(agentCwd: string, path: string): { absolutePath: string; relativePath: string } {
  if (!path || isAbsolute(path) || path.includes('\0')) {
    throw new Error('Invalid workspace path');
  }
  const root = resolve(agentCwd);
  const absolutePath = resolve(root, path);
  const rel = relative(root, absolutePath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Workspace path is outside agent cwd');
  }
  return { absolutePath, relativePath: rel };
}

export function isWorkspaceScanFresh(scannedAt: string, now = new Date(), maxAgeMs = 24 * 60 * 60_000): boolean {
  const ts = Date.parse(scannedAt);
  return Number.isFinite(ts) && now.getTime() - ts <= maxAgeMs;
}

function formatDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}
