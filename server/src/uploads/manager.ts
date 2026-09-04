import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import {
  MAX_UPLOAD_FILE_SIZE,
  MAX_UPLOAD_FILES_PER_REQUEST as SHARED_MAX_UPLOAD_FILES_PER_REQUEST,
} from '../../../shared/src/lib/constants.js';

import type { UploadedFileInfo } from '../types/index.js';
import type { TaskBoardAttachment, TaskBoardUploadAttachment } from '../../../shared/src/types/taskboard.js';
import { uploadLogger } from '../utils/logger.js';
import { mimeTypeForAsset, validateAssetPath, validateAttachmentStatePath } from './assetReference.js';
import { inspectUploadedFile } from './uploadSecurity.js';
import {
  ATTACHMENT_ID_RE,
  AttachmentUnavailableError,
  isSafeTaskScopeSegment,
  resolveAttachmentReferences,
  resolveLegacyAttachmentReferences,
  taskAttachmentFilename,
  trustedRelative,
  validateTaskAttachmentPath,
} from './attachmentValidation.js';
import {
  readAttachmentStates,
  readCompletedUploadRequest,
  writeAttachmentState,
  writeCompletedUploadRequest,
} from './uploadLedger.js';
import {
  atomicWriteTrustedFile,
  openTrustedDirectory,
  openTrustedFile,
  readTrustedFile,
  relativeToTrustedRoot,
  removeTrustedPath,
  type TrustedFile,
  UnsafeFilePathError,
  writeTrustedFile,
} from '../security/trustedFile.js';

export const MAX_UPLOAD_FILE_BYTES = MAX_UPLOAD_FILE_SIZE;
export const MAX_UPLOAD_FILES_PER_REQUEST = SHARED_MAX_UPLOAD_FILES_PER_REQUEST;
export const DEFAULT_STAGED_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export type UploadRequestOutcome = 'success' | 'failed' | 'aborted';

export type AttachmentUnavailableCode = 'ATTACHMENT_NOT_FOUND' | 'ATTACHMENT_EXPIRED' | 'ATTACHMENT_DELETED';

export { AttachmentUnavailableError } from './attachmentValidation.js';

export interface AttachmentState {
  version: 1;
  attachmentId: string;
  filename: string;
  originalName: string;
  relativePath: string;
  size: number;
  mimeType: string;
  source?: 'upload' | 'asset';
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

export interface UploadReference {
  sessionId?: string;
  clientMessageId?: string;
}


export interface AttachmentContent {
  attachmentId: string;
  absolutePath: string;
  originalName: string;
  size: number;
  mimeType: string;
  isImage: boolean;
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
  /** Descriptor-bound paths; callers write through partialDir while these handles stay open. */
  uploadsHandle: FileHandle;
  uploadsDir: string;
  partialHandle: FileHandle;
  partialDir: string;
  partialFdPath: string;
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

  /**
   * drain 截止兜底：把开始时间早于 maxAgeMs 的挂死上传请求判定为 failed 并
   * 释放计数（2026-08-17 生产 blue 色 drain 死锁修复）。客户端连接已物理消失
   * 但计数未清时，进程会因「uploads are never force-interrupted」永不退出，
   * 蓝绿部署无法覆盖 idle 色；超过宽限阈值的请求不再无限等待。
   * 返回清理的请求数。
   */
  failStaleUploads(maxAgeMs: number): number {
    const nowMs = this.now();
    let failed = 0;
    for (const [requestId, active] of this.activeRequests) {
      if (nowMs - active.startedAtMs <= maxAgeMs) continue;
      failed += 1;
      void this.finishFailedRequest(requestId, 'failed').catch(() => undefined);
    }
    return failed;
  }

  getMetricsSnapshot(): UploadMetricsSnapshot {
    return { activeUploads: this.activeRequests.size, ...this.metrics };
  }

  async getCompletedRequest(
    userCwd: string,
    requestId: string,
    sessionId?: string,
  ): Promise<UploadedFileInfo[] | undefined> {
    return readCompletedUploadRequest(userCwd, requestId, sessionId);
  }

  async beginRequest(userCwd: string, requestId: string): Promise<string> {
    if (this.draining) throw new UploadDrainingError();
    if (this.activeRequests.has(requestId)) throw new Error(`Duplicate upload request: ${requestId}`);

    if (!isSafeTaskScopeSegment(requestId)) throw new Error('Invalid upload request id');
    const initRelative = `uploads/.partial/${requestId}/.upload-init-${randomUUID()}`;
    await writeTrustedFile(userCwd, initRelative, '', { createParents: true, exclusive: true, mode: 0o600 });
    await removeTrustedPath(userCwd, initRelative);

    const uploads = await openTrustedDirectory(userCwd, 'uploads');
    let partial;
    try {
      partial = await openTrustedDirectory(userCwd, `uploads/.partial/${requestId}`);
    } catch (error) {
      await uploads.handle.close().catch(() => undefined);
      throw error;
    }
    this.knownUserCwds.add(userCwd);
    this.activeRequests.set(requestId, {
      userCwd,
      uploadsHandle: uploads.handle,
      uploadsDir: uploads.fdPath,
      partialHandle: partial.handle,
      partialDir: join(userCwd, 'uploads', '.partial', requestId),
      partialFdPath: partial.fdPath,
      startedAtMs: this.now(),
    });
    return join(userCwd, 'uploads', '.partial', requestId);
  }

  async completeRequest(
    requestId: string,
    files: UploadFinalizeFile[],
    refs: UploadReference = {},
  ): Promise<FinalizedUpload[]> {
    const active = this.activeRequests.get(requestId);
    if (!active) throw new Error(`Upload request is no longer active: ${requestId}`);

    return this.withUserMutation(active.userCwd, async () => this.completeRequestLocked(requestId, active, files, refs));
  }
  async registerAssetReferences(
    userCwd: string,
    paths: readonly string[],
    refs: UploadReference = {},
  ): Promise<UploadedFileInfo[]> {
    this.knownUserCwds.add(userCwd);
    return this.withUserMutation(userCwd, async () => {
      const createdStateIds: string[] = [];
      try {
        const referenced: UploadedFileInfo[] = [];
        for (const requestedPath of paths) {
          const relativePath = validateAssetPath(userCwd, requestedPath);
          const source = await openTrustedFile(userCwd, relativePath);
          const size = source.stats.size;
          await source.handle.close();
          if (size > MAX_UPLOAD_FILE_BYTES) {
            throw Object.assign(new Error('单文件不能超过 2 GiB'), { statusCode: 413 });
          }
          const attachmentId = randomUUID();
          const originalName = basename(relativePath);
          const declaredMimeType = mimeTypeForAsset(originalName);
          const security = await inspectUploadedFile({
            path: resolve(userCwd, relativePath),
            originalName,
            size,
            mimetype: declaredMimeType,
          });
          const mimeType = security.mimeType;
          const state: AttachmentState = {
            version: 1,
            attachmentId,
            filename: originalName,
            originalName,
            relativePath,
            size,
            mimeType,
            source: 'asset',
            status: 'staged',
            createdAt: new Date(this.now()).toISOString(),
            ...(refs.sessionId ? { sessionIds: [refs.sessionId] } : {}),
            ...(refs.clientMessageId ? { clientMessageIds: [refs.clientMessageId] } : {}),
          };
          await writeAttachmentState(userCwd, state, 'uploads/.state');
          createdStateIds.push(attachmentId);
          referenced.push({
            attachmentId,
            originalName,
            relativePath,
            size,
            mimeType,
            isImage: security.isImage,
          });
        }
        return referenced;
      } catch (error) {
        await Promise.allSettled(createdStateIds.map((attachmentId) => (
          removeTrustedPath(userCwd, `uploads/.state/${attachmentId}.json`)
        )));
        throw error;
      }
    });
  }

  private async completeRequestLocked(
    requestId: string,
    active: ActiveUploadRequest,
    files: UploadFinalizeFile[],
    refs: UploadReference,
  ): Promise<FinalizedUpload[]> {
    const completed: Array<{ filename: string; attachmentId: string }> = [];
    const finalized: FinalizedUpload[] = [];
    try {
      for (const file of files) {
        if (!ATTACHMENT_ID_RE.test(file.attachmentId) || basename(file.filename) !== file.filename) {
          throw new Error('Invalid generated upload filename');
        }
        if (file.partialPath !== join(active.partialDir, file.filename)) {
          throw new Error('Upload partial path escaped request directory');
        }

        const finalFdPath = join(active.uploadsDir, file.filename);
        const finalPath = join(active.userCwd, 'uploads', file.filename);
        const relativePath = `uploads/${file.filename}`;
        await rename(join(active.partialFdPath, file.filename), finalFdPath);

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
          ...(refs.sessionId ? { sessionIds: [refs.sessionId] } : {}),
          ...(refs.clientMessageId ? { clientMessageIds: [refs.clientMessageId] } : {}),
        };
        completed.push({ filename: file.filename, attachmentId: file.attachmentId });
        await writeAttachmentState(active.userCwd, state, 'uploads/.state');
        finalized.push({
          absolutePath: finalPath,
          info: {
            attachmentId: file.attachmentId,
            originalName: file.originalName,
            relativePath,
            size: file.size,
            mimeType: file.mimeType,
            isImage: file.isImage,
          },
        });
      }

      await writeCompletedUploadRequest(
        active.userCwd,
        requestId,
        finalized.map(({ info }) => info),
        new Date(this.now()).toISOString(),
        refs.sessionId,
      );
      await this.closeActiveRequest(requestId, active, true);
      this.metrics.completedRequests += 1;
      this.metrics.uploadedBytes += files.reduce((sum, file) => sum + file.size, 0);
      this.metrics.lastUploadDurationMs = Math.max(0, this.now() - active.startedAtMs);
      this.metrics.lastCompletedAt = new Date(this.now()).toISOString();
      return finalized;
    } catch (error) {
      await Promise.allSettled(completed.flatMap((entry) => [
        removePinnedPath(active.uploadsDir, entry.filename),
        removeTrustedPath(active.userCwd, `uploads/.state/${entry.attachmentId}.json`),
      ]));
      await this.finishFailedRequest(requestId, 'failed');
      throw error;
    }
  }

  async cancelRequest(userCwd: string, requestId: string): Promise<'cancelled' | 'not_found' | 'uploaded'> {
    if (await this.getCompletedRequest(userCwd, requestId)) return 'uploaded';
    const active = this.activeRequests.get(requestId);
    if (!active || active.userCwd !== userCwd) return 'not_found';
    await this.finishFailedRequest(requestId, 'aborted');
    return 'cancelled';
  }

  async finishFailedRequest(requestId: string, outcome: Exclude<UploadRequestOutcome, 'success'>): Promise<void> {
    const active = this.activeRequests.get(requestId);
    if (!active) return;
    if (outcome === 'aborted') this.metrics.abortedRequests += 1;
    else this.metrics.failedRequests += 1;
    await this.closeActiveRequest(requestId, active, true).catch(() => undefined);
  }

  private async closeActiveRequest(requestId: string, active: ActiveUploadRequest, removePartial: boolean): Promise<void> {
    this.activeRequests.delete(requestId);
    try {
      await active.partialHandle.close().catch(() => undefined);
      if (removePartial) {
        await removePinnedPath(active.uploadsDir, `.partial/${requestId}`).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
    } finally {
      await Promise.allSettled([
        active.partialHandle.close(),
        active.uploadsHandle.close(),
      ]);
    }
  }

  /** Resolve V1 IDs against the authenticated user's upload state. */
  async resolveAttachments(
    userCwd: string,
    attachmentIds: readonly string[],
    refs: Pick<UploadReference, 'sessionId'> = {},
  ): Promise<UploadedFileInfo[]> {
    this.knownUserCwds.add(userCwd);
    return this.withUserMutation(userCwd, () => resolveAttachmentReferences(
      userCwd, attachmentIds, refs, this.now, this.stagedRetentionMs,
    ));
  }

  async getAttachmentContent(userCwd: string, attachmentId: string): Promise<AttachmentContent> {
    const [resolved] = await this.resolveAttachments(userCwd, [attachmentId]);
    if (!resolved) throw new AttachmentUnavailableError('ATTACHMENT_NOT_FOUND', 'Attachment not found');
    return {
      attachmentId,
      absolutePath: resolve(userCwd, resolved.relativePath),
      originalName: resolved.originalName,
      size: resolved.size,
      mimeType: resolved.mimeType,
      isImage: resolved.isImage,
    };
  }

  /** N-1 adapter: legacy paths are lookup hints; server state remains authoritative. */
  async resolveLegacyAttachments(
    userCwd: string,
    attachments: readonly UploadedFileInfo[],
  ): Promise<UploadedFileInfo[]> {
    this.knownUserCwds.add(userCwd);
    return this.withUserMutation(userCwd, async () => (
      resolveLegacyAttachmentReferences(userCwd, attachments, await readAttachmentStates(userCwd))
    ));
  }

  async materializeTaskAttachments(
    sourceCwd: string,
    targetCwd: string,
    taskId: string,
    attachments: readonly TaskBoardUploadAttachment[],
  ): Promise<TaskBoardUploadAttachment[]> {
    if (!isSafeTaskScopeSegment(taskId)) throw new Error('Invalid task attachment scope');
    if (attachments.length === 0) return [];
    this.knownUserCwds.add(sourceCwd);
    this.knownUserCwds.add(targetCwd);
    return this.withUserMutation(sourceCwd, async () => {
      const targetDirectoryRelative = `taskboard/attachments/${taskId}`;
      const initRelative = `${targetDirectoryRelative}/.init-${randomUUID()}`;
      await writeTrustedFile(targetCwd, initRelative, '', { createParents: true, exclusive: true, mode: 0o600 });
      await removeTrustedPath(targetCwd, initRelative);
      const targetDirectory = await openTrustedDirectory(targetCwd, targetDirectoryRelative);
      const created: string[] = [];
      try {
        const materialized: TaskBoardUploadAttachment[] = [];
        for (const attachment of attachments) {
          if (!ATTACHMENT_ID_RE.test(attachment.attachmentId)) {
            throw new Error(`Invalid attachment id: ${attachment.attachmentId}`);
          }
          const sourceRelative = trustedRelative(sourceCwd, attachment.relativePath);
          const source = await openTrustedFile(sourceCwd, sourceRelative);
          try {
            if (source.stats.size !== attachment.size) {
              throw new Error(`Attachment source changed: ${attachment.attachmentId}`);
            }
            let targetName = taskAttachmentFilename(attachment);
            for (;;) {
              try {
                await copyOpenedFile(source, targetDirectory.fdPath, targetName);
                break;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                targetName = `${attachment.attachmentId}-${randomUUID()}-${taskAttachmentFilename(attachment).slice(attachment.attachmentId.length + 1)}`;
              }
            }
            created.push(targetName);
            materialized.push({ ...attachment, relativePath: `${targetDirectoryRelative}/${targetName}` });
          } finally {
            await source.handle.close();
          }
        }
        return materialized;
      } catch (error) {
        await Promise.allSettled(created.map((name) => removePinnedPath(targetDirectory.fdPath, name)));
        throw error;
      } finally {
        await targetDirectory.handle.close();
      }
    });
  }

  async cleanupTaskAttachments(
    targetCwd: string,
    taskId: string,
    attachments: readonly Pick<TaskBoardAttachment, 'attachmentId' | 'relativePath'>[],
  ): Promise<void> {
    if (!isSafeTaskScopeSegment(taskId) || attachments.length === 0) return;
    this.knownUserCwds.add(targetCwd);
    await this.withUserMutation(targetCwd, async () => {
      for (const attachment of attachments) {
        const relativePath = validateTaskAttachmentPath(taskId, attachment);
        try {
          await removeTrustedPath(targetCwd, relativePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    });
  }

  async resolveTaskAttachment(
    userCwd: string,
    taskId: string,
    attachment: Pick<TaskBoardAttachment, 'attachmentId' | 'relativePath'>,
  ): Promise<TrustedFile> {
    return openTrustedFile(userCwd, validateTaskAttachmentPath(taskId, attachment));
  }

  async markReferenced(
    userCwd: string,
    attachments: readonly UploadedFileInfo[],
    refs: { sessionId?: string; clientMessageId?: string },
  ): Promise<void> {
    this.knownUserCwds.add(userCwd);
    await this.withUserMutation(userCwd, async () => {
      const updates: AttachmentState[] = [];
      for (const attachment of attachments) {
        const attachmentId = attachment.attachmentId;
        if (!attachmentId || !ATTACHMENT_ID_RE.test(attachmentId)) continue;
        let state: AttachmentState;
        try {
          state = JSON.parse(await readTrustedFile(userCwd, `uploads/.state/${attachmentId}.json`, 'utf8') as string) as AttachmentState;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (state.attachmentId !== attachmentId || basename(state.filename) !== state.filename) {
          throw new Error(`Invalid attachment state: ${attachmentId}`);
        }
        validateAttachmentStatePath(userCwd, state);
        if (refs.sessionId && state.sessionIds?.some((sessionId) => sessionId !== refs.sessionId)) {
          throw new Error(`Attachment is already bound to another session: ${attachmentId}`);
        }
        const opened = await openTrustedFile(userCwd, state.relativePath);
        await opened.handle.close();
        state.status = 'referenced';
        state.referencedAt ??= new Date(this.now()).toISOString();
        if (refs.sessionId) state.sessionIds = appendUnique(state.sessionIds, refs.sessionId);
        if (refs.clientMessageId) state.clientMessageIds = appendUnique(state.clientMessageIds, refs.clientMessageId);
        updates.push(state);
      }
      for (const state of updates) await writeAttachmentState(userCwd, state, 'uploads/.state');
    });
  }

  async releaseReference(userCwd:string,attachments:ReadonlyArray<Pick<UploadedFileInfo,'attachmentId'>>,refs:{sessionId:string;clientMessageId:string}):Promise<void>{
    this.knownUserCwds.add(userCwd);await this.withUserMutation(userCwd,async()=>{for(const attachment of attachments){const attachmentId=attachment.attachmentId;if(!attachmentId||!ATTACHMENT_ID_RE.test(attachmentId))continue;let state:AttachmentState;
      try{state=JSON.parse(await readTrustedFile(userCwd,`uploads/.state/${attachmentId}.json`,'utf8') as string) as AttachmentState;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      validateAttachmentStatePath(userCwd,state);if(!state.sessionIds?.includes(refs.sessionId)||!state.clientMessageIds?.includes(refs.clientMessageId))continue;state.clientMessageIds=state.clientMessageIds.filter(id=>id!==refs.clientMessageId);
      if(state.clientMessageIds.length===0){state.sessionIds=state.sessionIds.filter(id=>id!==refs.sessionId);state.status='staged';delete state.referencedAt;}await writeAttachmentState(userCwd,state,'uploads/.state');}});
  }
  async getUsage(userCwd: string): Promise<UploadUsageSnapshot> {
    this.knownUserCwds.add(userCwd);
    const states = await readAttachmentStates(userCwd);
    const statusByFilename = new Map(
      states.filter((state) => state.source !== 'asset').map((state) => [state.filename, state.status]),
    );
    const regularFiles = await listFilesRecursive(userCwd, 'uploads', new Set(['.partial', '.state', '.requests', '.tombstones']));
    const partialFiles = await listFilesRecursive(userCwd, 'uploads/.partial');

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
    const states = await readAttachmentStates(userCwd);
    let deletedFiles = 0;
    let deletedBytes = 0;

    for (const state of states) {
      if (state.status !== 'staged') continue;
      const createdAt = Date.parse(state.createdAt);
      if (!Number.isFinite(createdAt) || createdAt > cutoff) continue;
      if (!ATTACHMENT_ID_RE.test(state.attachmentId) || basename(state.filename) !== state.filename) continue;

      try {
        validateAttachmentStatePath(userCwd, state);
      } catch {
        continue;
      }
      if (state.source !== 'asset') {
        let size = state.size;
        try {
          const opened = await openTrustedFile(userCwd, state.relativePath);
          size = opened.stats.size;
          await opened.handle.close();
          await removeTrustedPath(userCwd, state.relativePath);
          deletedFiles += 1;
          deletedBytes += size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await atomicWriteTrustedFile(
        userCwd,
        `uploads/.tombstones/${state.attachmentId}.json`,
        `${JSON.stringify({ version: 1, attachmentId: state.attachmentId, code: olderThanMs >= this.stagedRetentionMs ? 'ATTACHMENT_EXPIRED' : 'ATTACHMENT_DELETED', at: new Date(this.now()).toISOString() })}\n`,
        { encoding: 'utf8', createParents: true, mode: 0o600 },
      );
      await removeTrustedPath(userCwd, `uploads/.state/${state.attachmentId}.json`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }

    return { deletedFiles, deletedBytes };
  }

  /**
   * 清空该用户 uploads/ 下的全部附件（未发送 + 已发送 + 历史文件）与状态记录。
   * 不触碰 .partial：其中可能有正在传输的请求，交由请求生命周期与超龄清理负责；
   * 与 completeRequest/markReferenced 共用同一把用户写锁，不会删到 finalize 到一半的文件。
   */
  async purgeUserUploads(userCwd: string): Promise<UploadCleanupResult> {
    this.knownUserCwds.add(userCwd);
    return this.withUserMutation(userCwd, async () => {
      const states = await readAttachmentStates(userCwd);
      const files = await listFilesRecursive(userCwd, 'uploads', new Set(['.partial', '.state', '.requests', '.tombstones']));
      let deletedFiles = 0;
      let deletedBytes = 0;
      for (const file of files) {
        try {
          await removeTrustedPath(userCwd, file.path);
          deletedFiles += 1;
          deletedBytes += file.size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await removeTrustedPath(userCwd, 'uploads/.state').catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      await removeTrustedPath(userCwd, 'uploads/.requests').catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      for (const state of states) {
        await atomicWriteTrustedFile(
          userCwd,
          `uploads/.tombstones/${state.attachmentId}.json`,
          `${JSON.stringify({ version: 1, attachmentId: state.attachmentId, code: 'ATTACHMENT_DELETED', at: new Date(this.now()).toISOString() })}\n`,
          { encoding: 'utf8', createParents: true, mode: 0o600 },
        );
      }
      return { deletedFiles, deletedBytes };
    });
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
    let partialRoot: Awaited<ReturnType<typeof openTrustedDirectory>>;
    try {
      partialRoot = await openTrustedDirectory(userCwd, 'uploads/.partial');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { deletedRequests: 0, deletedBytes: 0 };
      throw error;
    }
    try {
      const entries = await readdir(partialRoot.fdPath, { withFileTypes: true });
      const cutoff = this.now() - this.stagedRetentionMs;
      let deletedRequests = 0;
      let deletedBytes = 0;
      for (const entry of entries) {
        if (!entry.isDirectory() || this.activeRequests.has(entry.name)) continue;
        let requestDirectory: FileHandle;
        try {
          requestDirectory = await open(
            join(partialRoot.fdPath, entry.name),
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        let requestStats;
        let files;
        try {
          requestStats = await requestDirectory.stat();
          files = await listFilesRecursive(userCwd, `uploads/.partial/${entry.name}`);
        } finally {
          await requestDirectory.close();
        }
        if (requestStats.mtimeMs > cutoff || files.some((file) => file.mtimeMs > cutoff)) continue;
        deletedBytes += files.reduce((sum, file) => sum + file.size, 0);
        await removeTrustedPath(userCwd, `uploads/.partial/${entry.name}`);
        deletedRequests += 1;
      }
      return { deletedRequests, deletedBytes };
    } finally {
      await partialRoot.handle.close();
    }
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

async function isDirectory(path: string): Promise<boolean> {
  try {
    const opened = await openTrustedDirectory(path);
    await opened.handle.close();
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursive(
  root: string,
  relativePath = '',
  skipNames = new Set<string>(),
): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  let directory: Awaited<ReturnType<typeof openTrustedDirectory>>;
  try {
    directory = await openTrustedDirectory(root, relativePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const entries = await readdir(directory.fdPath, { withFileTypes: true });
    const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (skipNames.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        files.push(...await listFilesRecursive(root, path, skipNames));
      } else if (entry.isFile()) {
        const file = await openTrustedFile(root, path);
        files.push({ path, size: file.stats.size, mtimeMs: file.stats.mtimeMs });
        await file.handle.close();
      }
    }
    return files;
  } finally {
    await directory.handle.close();
  }
}

async function readPinnedFile(
  directoryFdPath: string,
  leaf: string,
  encoding?: BufferEncoding,
): Promise<Buffer | string> {
  const handle = await open(join(directoryFdPath, leaf), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw Object.assign(new Error('Not a file'), { code: 'EISDIR' });
    return encoding ? await handle.readFile({ encoding }) : await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function copyOpenedFile(source: TrustedFile, destinationDirectoryFdPath: string, leaf: string): Promise<void> {
  const destination = await open(
    join(destinationDirectoryFdPath, leaf),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o664,
  );
  try {
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, source.stats.size)));
    let position = 0;
    while (position < source.stats.size) {
      const { bytesRead } = await source.handle.read(buffer, 0, Math.min(buffer.length, source.stats.size - position), position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
  } finally {
    await destination.close();
  }
}

async function removePinnedPath(directoryFdPath: string, relativePath: string): Promise<void> {
  const components = relativePath.split('/').filter(Boolean);
  if (components.length === 0 || components.some((component) => component === '.' || component === '..')) {
    throw new UnsafeFilePathError();
  }
  const parents: FileHandle[] = [];
  let currentPath = directoryFdPath;
  try {
    for (const component of components.slice(0, -1)) {
      const parent = await open(
        join(currentPath, component),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      parents.push(parent);
      currentPath = `/proc/self/fd/${parent.fd}`;
    }
    await removePinnedEntry(currentPath, components.at(-1)!);
  } finally {
    await Promise.allSettled(parents.map((handle) => handle.close()));
  }
}

async function removePinnedEntry(directoryFdPath: string, leaf: string): Promise<void> {
  const path = join(directoryFdPath, leaf);
  let child: FileHandle | undefined;
  try {
    child = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stats = await file.stat();
      await file.close();
      if (!stats.isFile()) throw new UnsafeFilePathError();
      await unlink(path);
      return;
    }
    throw error;
  }
  const childFdPath = `/proc/self/fd/${child.fd}`;
  try {
    for (const entry of await readdir(childFdPath)) {
      await removePinnedEntry(childFdPath, entry);
    }
  } finally {
    await child.close();
  }
  await rmdir(path);
}
