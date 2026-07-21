import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  MAX_UPLOAD_FILE_SIZE,
  MAX_UPLOAD_FILES_PER_REQUEST as SHARED_MAX_UPLOAD_FILES_PER_REQUEST,
} from '../../../shared/src/lib/constants.js';

import type { UploadedFileInfo } from '../types/index.js';
import { repairWorkspacePath } from '../workspace/permissions.js';
import { uploadLogger } from '../utils/logger.js';

export const MAX_UPLOAD_FILE_BYTES = MAX_UPLOAD_FILE_SIZE;
export const MAX_UPLOAD_FILES_PER_REQUEST = SHARED_MAX_UPLOAD_FILES_PER_REQUEST;
export const DEFAULT_STAGED_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type UploadRequestOutcome = 'success' | 'failed' | 'aborted';

export interface AttachmentState {
  version: 1;
  attachmentId: string;
  filename: string;
  originalName: string;
  relativePath: string;
  size: number;
  mimeType: string;
  status: 'staged' | 'referenced';
  createdAt: string;
  referencedAt?: string;
  sessionIds?: string[];
  clientMessageIds?: string[];
}

export interface UploadFinalizeFile {
  attachmentId: string;
  filename: string;
  partialPath: string;
  originalName: string;
  size: number;
  mimeType: string;
  isImage: boolean;
  isVoiceUpload: boolean;
}

export interface FinalizedUpload {
  info: UploadedFileInfo;
  absolutePath: string;
}

export interface UploadMetricsSnapshot {
  activeUploads: number;
  completedRequests: number;
  failedRequests: number;
  abortedRequests: number;
  uploadedBytes: number;
  cleanupRuns: number;
  cleanedPartialRequests: number;
  cleanedStagedFiles: number;
  cleanedBytes: number;
  lastUploadDurationMs?: number;
  lastCompletedAt?: string;
  lastCleanupAt?: string;
}

export interface UploadUsageSnapshot {
  totalBytes: number;
  totalFiles: number;
  stagedBytes: number;
  stagedFiles: number;
  referencedBytes: number;
  referencedFiles: number;
  legacyBytes: number;
  legacyFiles: number;
  partialBytes: number;
  partialFiles: number;
  stagedRetentionHours: number;
  measuredAt: string;
}

export interface UploadCleanupResult {
  deletedFiles: number;
  deletedBytes: number;
}

interface ActiveUploadRequest {
  userCwd: string;
  partialDir: string;
  startedAtMs: number;
}

export class UploadDrainingError extends Error {
  constructor() {
    super('Server is draining');
    this.name = 'UploadDrainingError';
  }
}

export interface UploadManagerOptions {
  agentCwd: string;
  stagedRetentionMs?: number;
  cleanupIntervalMs?: number;
  now?: () => number;
}

/**
 * 管理用户附件从上传临时区到正式文件的生命周期。
 *
 * `.partial` 与最终 `uploads/` 位于同一 NAS 文件系统，完成时使用 rename 原子提交；
 * `.state` 只记录新上传附件，历史无 sidecar 文件永不参与自动删除。
 */
export class UploadManager {
  private readonly activeRequests = new Map<string, ActiveUploadRequest>();
  private readonly knownUserCwds = new Set<string>();
  private readonly userMutationTails = new Map<string, Promise<void>>();
  private readonly stagedRetentionMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly now: () => number;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private draining = false;
  private metrics: Omit<UploadMetricsSnapshot, 'activeUploads'> = {
    completedRequests: 0,
    failedRequests: 0,
    abortedRequests: 0,
    uploadedBytes: 0,
    cleanupRuns: 0,
    cleanedPartialRequests: 0,
    cleanedStagedFiles: 0,
    cleanedBytes: 0,
  };

  constructor(private readonly options: UploadManagerOptions) {
    this.stagedRetentionMs = options.stagedRetentionMs ?? DEFAULT_STAGED_RETENTION_MS;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.cleanupTimer) return;
    // 不在新色启动瞬间清理：蓝绿切流前旧色仍可能把刚发送的附件从 staged
    // 标为 referenced。首轮延后到正常周期，旧色收到 drain 时也会停掉清理器。
    this.cleanupTimer = setInterval(() => {
      void this.runMaintenance().catch((error) => {
        uploadLogger.warn(`Attachment maintenance scan failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  setDraining(draining: boolean): void {
    this.draining = draining;
    if (draining) this.stop();
  }

  isDraining(): boolean {
    return this.draining;
  }

  getActiveUploadCount(): number {
    return this.activeRequests.size;
  }

  getMetricsSnapshot(): UploadMetricsSnapshot {
    return { activeUploads: this.activeRequests.size, ...this.metrics };
  }

  async beginRequest(userCwd: string, requestId: string): Promise<string> {
    if (this.draining) throw new UploadDrainingError();
    if (this.activeRequests.has(requestId)) throw new Error(`Duplicate upload request: ${requestId}`);

    const uploadsDir = join(userCwd, 'uploads');
    const partialDir = join(uploadsDir, '.partial', requestId);
    await mkdir(partialDir, { recursive: true });
    await mkdir(join(uploadsDir, '.state'), { recursive: true });
    repairWorkspacePath(partialDir, 0o775);
    repairWorkspacePath(join(uploadsDir, '.state'), 0o775);
    this.knownUserCwds.add(userCwd);
    this.activeRequests.set(requestId, { userCwd, partialDir, startedAtMs: this.now() });
    return partialDir;
  }

  async completeRequest(requestId: string, files: UploadFinalizeFile[]): Promise<FinalizedUpload[]> {
    const active = this.activeRequests.get(requestId);
    if (!active) throw new Error(`Upload request is no longer active: ${requestId}`);

    return this.withUserMutation(active.userCwd, async () => this.completeRequestLocked(requestId, active, files));
  }

  private async completeRequestLocked(
    requestId: string,
    active: ActiveUploadRequest,
    files: UploadFinalizeFile[],
  ): Promise<FinalizedUpload[]> {
    const uploadsDir = join(active.userCwd, 'uploads');
    const completed: Array<{ path: string; statePath: string }> = [];
    const finalized: FinalizedUpload[] = [];
    try {
      for (const file of files) {
        if (!ATTACHMENT_ID_RE.test(file.attachmentId) || basename(file.filename) !== file.filename) {
          throw new Error('Invalid generated upload filename');
        }
        if (!isWithin(file.partialPath, active.partialDir)) {
          throw new Error('Upload partial path escaped request directory');
        }

        const finalPath = join(uploadsDir, file.filename);
        const relativePath = relative(active.userCwd, finalPath).split(sep).join('/');
        await rename(file.partialPath, finalPath);
        repairWorkspacePath(finalPath, 0o664);

        const state: AttachmentState = {
          version: 1,
          attachmentId: file.attachmentId,
          filename: file.filename,
          originalName: file.originalName,
          relativePath,
          size: file.size,
          mimeType: file.mimeType,
          status: 'staged',
          createdAt: new Date(this.now()).toISOString(),
        };
        const statePath = this.statePath(active.userCwd, file.attachmentId);
        completed.push({ path: finalPath, statePath });
        await this.writeState(statePath, state);
        finalized.push({
          absolutePath: finalPath,
          info: {
            attachmentId: file.attachmentId,
            originalName: file.originalName,
            ...(file.isVoiceUpload ? { savedPath: finalPath } : {}),
            relativePath,
            size: file.size,
            mimeType: file.mimeType,
            isImage: file.isImage,
          },
        });
      }

      await rm(active.partialDir, { recursive: true, force: true });
      this.activeRequests.delete(requestId);
      this.metrics.completedRequests += 1;
      this.metrics.uploadedBytes += files.reduce((sum, file) => sum + file.size, 0);
      this.metrics.lastUploadDurationMs = Math.max(0, this.now() - active.startedAtMs);
      this.metrics.lastCompletedAt = new Date(this.now()).toISOString();
      return finalized;
    } catch (error) {
      await Promise.allSettled(completed.flatMap((entry) => [unlink(entry.path), unlink(entry.statePath)]));
      await this.finishFailedRequest(requestId, 'failed');
      throw error;
    }
  }

  async finishFailedRequest(requestId: string, outcome: Exclude<UploadRequestOutcome, 'success'>): Promise<void> {
    const active = this.activeRequests.get(requestId);
    if (!active) return;
    this.activeRequests.delete(requestId);
    await rm(active.partialDir, { recursive: true, force: true }).catch(() => undefined);
    if (outcome === 'aborted') this.metrics.abortedRequests += 1;
    else this.metrics.failedRequests += 1;
  }

  async markReferenced(
    userCwd: string,
    attachments: readonly UploadedFileInfo[],
    refs: { sessionId?: string; clientMessageId?: string },
  ): Promise<void> {
    this.knownUserCwds.add(userCwd);
    await this.withUserMutation(userCwd, async () => {
      for (const attachment of attachments) {
        const attachmentId = attachment.attachmentId;
        if (!attachmentId || !ATTACHMENT_ID_RE.test(attachmentId)) continue;
        const statePath = this.statePath(userCwd, attachmentId);
        let state: AttachmentState;
        try {
          state = JSON.parse(await readFile(statePath, 'utf8')) as AttachmentState;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (state.attachmentId !== attachmentId || basename(state.filename) !== state.filename) {
          throw new Error(`Invalid attachment state: ${attachmentId}`);
        }
        await stat(join(userCwd, state.relativePath));
        state.status = 'referenced';
        state.referencedAt ??= new Date(this.now()).toISOString();
        if (refs.sessionId) state.sessionIds = appendUnique(state.sessionIds, refs.sessionId);
        if (refs.clientMessageId) state.clientMessageIds = appendUnique(state.clientMessageIds, refs.clientMessageId);
        await this.writeState(statePath, state);
      }
    });
  }

  async getUsage(userCwd: string): Promise<UploadUsageSnapshot> {
    this.knownUserCwds.add(userCwd);
    const uploadsDir = join(userCwd, 'uploads');
    const states = await this.readStates(userCwd);
    const statusByFilename = new Map(states.map((state) => [state.filename, state.status]));
    const regularFiles = await listFilesRecursive(uploadsDir, new Set(['.partial', '.state']));
    const partialFiles = await listFilesRecursive(join(uploadsDir, '.partial'));

    let stagedBytes = 0;
    let stagedFiles = 0;
    let referencedBytes = 0;
    let referencedFiles = 0;
    let legacyBytes = 0;
    let legacyFiles = 0;
    for (const file of regularFiles) {
      const status = statusByFilename.get(basename(file.path));
      if (status === 'staged') {
        stagedFiles += 1;
        stagedBytes += file.size;
      } else if (status === 'referenced') {
        referencedFiles += 1;
        referencedBytes += file.size;
      } else {
        legacyFiles += 1;
        legacyBytes += file.size;
      }
    }

    return {
      totalBytes: regularFiles.reduce((sum, file) => sum + file.size, 0),
      totalFiles: regularFiles.length,
      stagedBytes,
      stagedFiles,
      referencedBytes,
      referencedFiles,
      legacyBytes,
      legacyFiles,
      partialBytes: partialFiles.reduce((sum, file) => sum + file.size, 0),
      partialFiles: partialFiles.length,
      stagedRetentionHours: Math.round(this.stagedRetentionMs / 3_600_000),
      measuredAt: new Date(this.now()).toISOString(),
    };
  }

  async cleanupUserStaged(userCwd: string, olderThanMs = 0): Promise<UploadCleanupResult> {
    this.knownUserCwds.add(userCwd);
    return this.withUserMutation(userCwd, async () => this.cleanupUserStagedLocked(userCwd, olderThanMs));
  }

  private async cleanupUserStagedLocked(userCwd: string, olderThanMs: number): Promise<UploadCleanupResult> {
    const cutoff = this.now() - olderThanMs;
    const states = await this.readStates(userCwd);
    let deletedFiles = 0;
    let deletedBytes = 0;

    for (const state of states) {
      if (state.status !== 'staged') continue;
      const createdAt = Date.parse(state.createdAt);
      if (!Number.isFinite(createdAt) || createdAt > cutoff) continue;
      if (!ATTACHMENT_ID_RE.test(state.attachmentId) || basename(state.filename) !== state.filename) continue;

      const filePath = join(userCwd, 'uploads', state.filename);
      if (!isWithin(filePath, join(userCwd, 'uploads'))) continue;
      let size = state.size;
      try {
        size = (await stat(filePath)).size;
        await unlink(filePath);
        deletedFiles += 1;
        deletedBytes += size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await unlink(this.statePath(userCwd, state.attachmentId)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }

    return { deletedFiles, deletedBytes };
  }

  async runMaintenance(): Promise<void> {
    await this.discoverUserWorkspaces();
    let cleanedStagedFiles = 0;
    let cleanedBytes = 0;
    let cleanedPartialRequests = 0;
    for (const userCwd of this.knownUserCwds) {
      const staged = await this.cleanupUserStaged(userCwd, this.stagedRetentionMs);
      cleanedStagedFiles += staged.deletedFiles;
      cleanedBytes += staged.deletedBytes;
      const partial = await this.cleanupStalePartialRequests(userCwd);
      cleanedPartialRequests += partial.deletedRequests;
      cleanedBytes += partial.deletedBytes;
    }
    this.metrics.cleanupRuns += 1;
    this.metrics.cleanedStagedFiles += cleanedStagedFiles;
    this.metrics.cleanedPartialRequests += cleanedPartialRequests;
    this.metrics.cleanedBytes += cleanedBytes;
    this.metrics.lastCleanupAt = new Date(this.now()).toISOString();
    if (cleanedStagedFiles > 0 || cleanedPartialRequests > 0) {
      uploadLogger.info(`Attachment cleanup: staged=${cleanedStagedFiles}, partialRequests=${cleanedPartialRequests}, bytes=${cleanedBytes}`);
    }
  }

  private async cleanupStalePartialRequests(userCwd: string): Promise<{ deletedRequests: number; deletedBytes: number }> {
    const partialRoot = join(userCwd, 'uploads', '.partial');
    let entries;
    try {
      entries = await readdir(partialRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { deletedRequests: 0, deletedBytes: 0 };
      throw error;
    }
    const cutoff = this.now() - this.stagedRetentionMs;
    let deletedRequests = 0;
    let deletedBytes = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || this.activeRequests.has(entry.name)) continue;
      const requestDir = join(partialRoot, entry.name);
      const requestStat = await lstat(requestDir);
      if (requestStat.mtimeMs > cutoff) continue;
      const files = await listFilesRecursive(requestDir);
      if (files.some((file) => file.mtimeMs > cutoff)) continue;
      deletedBytes += files.reduce((sum, file) => sum + file.size, 0);
      await rm(requestDir, { recursive: true, force: true });
      deletedRequests += 1;
    }
    return { deletedRequests, deletedBytes };
  }

  private async discoverUserWorkspaces(): Promise<void> {
    const rootUploads = join(this.options.agentCwd, 'uploads');
    if (await isDirectory(rootUploads)) this.knownUserCwds.add(this.options.agentCwd);
    let tenants;
    try {
      tenants = await readdir(this.options.agentCwd, { withFileTypes: true });
    } catch {
      return;
    }
    for (const tenant of tenants) {
      if (!tenant.isDirectory() || tenant.name.startsWith('.')) continue;
      const tenantDir = join(this.options.agentCwd, tenant.name);
      let users;
      try {
        users = await readdir(tenantDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const user of users) {
        if (!user.isDirectory() || user.name.startsWith('.')) continue;
        const userCwd = join(tenantDir, user.name);
        if (await isDirectory(join(userCwd, 'uploads'))) this.knownUserCwds.add(userCwd);
      }
    }
  }

  private statePath(userCwd: string, attachmentId: string): string {
    return join(userCwd, 'uploads', '.state', `${attachmentId}.json`);
  }

  private async writeState(statePath: string, state: AttachmentState): Promise<void> {
    await mkdir(dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o664 });
    await rename(tempPath, statePath);
    repairWorkspacePath(statePath, 0o664);
  }

  private async readStates(userCwd: string): Promise<AttachmentState[]> {
    const stateDir = join(userCwd, 'uploads', '.state');
    let entries;
    try {
      entries = await readdir(stateDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const states: AttachmentState[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await readFile(join(stateDir, entry.name), 'utf8')) as AttachmentState;
        if (parsed.version === 1 && ATTACHMENT_ID_RE.test(parsed.attachmentId)) states.push(parsed);
      } catch (error) {
        uploadLogger.warn(`Skip invalid attachment state ${join(stateDir, entry.name)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return states;
  }

  private async withUserMutation<T>(userCwd: string, task: () => Promise<T>): Promise<T> {
    const previous = this.userMutationTails.get(userCwd) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.userMutationTails.set(userCwd, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.userMutationTails.get(userCwd) === tail) this.userMutationTails.delete(userCwd);
    }
  }
}

function appendUnique(values: string[] | undefined, value: string): string[] {
  return values?.includes(value) ? values : [...(values ?? []), value];
}

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function listFilesRecursive(
  root: string,
  skipNames = new Set<string>(),
): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (skipNames.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursive(path, skipNames));
    else if (entry.isFile()) {
      const fileStat = await stat(path);
      files.push({ path, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
    }
  }
  return files;
}
