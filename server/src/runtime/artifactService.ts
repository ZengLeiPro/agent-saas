import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { getTranscriptPath } from '../data/transcripts/store.js';
import { readSessionMeta } from '../data/transcripts/meta.js';
import { hidesMemoryPollFrom } from '../data/sessions/access.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import type {
  ArtifactBlobStore,
  ArtifactKind,
  ArtifactRecord,
  ArtifactStore,
} from './artifactStore.js';

export interface RuntimeArtifactUser {
  sub: string;
  username: string;
  role: 'admin' | 'user';
  /** Tenant 归属（多组织改造 PR 2 起必选） */
  tenantId: string;
}

export interface CreateArtifactFromBytesInput {
  sessionId: string;
  workspaceId?: string;
  producingHandId?: string;
  kind?: ArtifactKind;
  data: string | Buffer | Uint8Array;
  fileName?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateArtifactFromWorkspaceFileInput {
  sessionId: string;
  workspaceRoot: string;
  filePath: string;
  workspaceId?: string;
  producingHandId?: string;
  kind?: ArtifactKind;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactReadUrl {
  url: string;
  expiresAt: string;
  direct: boolean;
}

export interface ArtifactContent {
  record: ArtifactRecord;
  data: Buffer;
}

export interface ArtifactServiceOptions {
  artifactStore: ArtifactStore;
  blobStore: ArtifactBlobStore;
  agentCwd: string;
  signingSecret?: string;
  defaultReadUrlTtlSeconds?: number;
  maxBlobBytes?: number;
  resolveSessionTenantId?: (sessionId: string) => Promise<string | undefined>;
  authorizeContentAccess?: (input: {
    tenantId: string;
    subjectUserId: string;
    targetType: 'session';
    targetId: string;
    scope: 'session_export';
  }) => Promise<boolean>;
  auditContentAccess?: (input: {
    tenantId: string;
    subjectUserId: string;
    sessionId: string;
    scope: 'session_export';
  }) => Promise<void>;
  /** Active public shares pin immutable artifacts until revoke/expiry. */
  isArtifactPinned?: (artifactId: string) => Promise<boolean>;
  /** Serializes share creation with the GC check/delete critical section. */
  withArtifactLock?: <T>(artifactId: string, operation: () => Promise<T>) => Promise<T>;
}

const DEFAULT_READ_URL_TTL_SECONDS = 15 * 60;
const DEFAULT_MAX_BLOB_BYTES = 100 * 1024 * 1024;

export class ArtifactService {
  private readonly signingSecret: string;
  private readonly defaultReadUrlTtlSeconds: number;
  private readonly maxBlobBytes: number;

  constructor(private readonly options: ArtifactServiceOptions) {
    this.signingSecret = options.signingSecret || randomBytes(32).toString('hex');
    this.defaultReadUrlTtlSeconds = options.defaultReadUrlTtlSeconds ?? DEFAULT_READ_URL_TTL_SECONDS;
    this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  }

  async listForSession(sessionId: string, user?: RuntimeArtifactUser): Promise<ArtifactRecord[]> {
    await this.ensureCanAccessSession(sessionId, user);
    return this.options.artifactStore.listForSession(sessionId);
  }

  async getForUser(artifactId: string, user?: RuntimeArtifactUser): Promise<ArtifactRecord> {
    const record = await this.options.artifactStore.get(artifactId);
    if (!record) throw new ArtifactServiceError(404, 'Artifact not found');
    await this.ensureCanAccessSession(record.sessionId, user);
    return record;
  }

  /** Owner-self check for creating or managing a public share; admin grants never substitute ownership. */
  async getForOwner(artifactId: string, user?: RuntimeArtifactUser): Promise<ArtifactRecord> {
    if (!user) throw new ArtifactServiceError(401, 'Authentication required');
    const record = await this.options.artifactStore.get(artifactId);
    if (!record) throw new ArtifactServiceError(404, 'Artifact not found');
    await this.assertSessionOwner(record.sessionId, user);
    return record;
  }

  async markDelivered(artifactId: string): Promise<ArtifactRecord> {
    const update = async (): Promise<ArtifactRecord> => {
      const record = await this.options.artifactStore.markDelivered(artifactId, new Date().toISOString());
      if (!record) throw new ArtifactServiceError(404, 'Artifact not found');
      return record;
    };
    return this.options.withArtifactLock
      ? this.options.withArtifactLock(artifactId, update)
      : update();
  }

  /** Internal share path. Callers must validate the public share token first. */
  async getRecordForShare(artifactId: string): Promise<ArtifactRecord> {
    const record = await this.options.artifactStore.get(artifactId);
    if (!record) throw new ArtifactServiceError(404, 'Artifact not found');
    return record;
  }

  /** Internal share path. Never returns a storage URL. */
  async readContentForShare(artifactId: string): Promise<ArtifactContent> {
    const record = await this.getRecordForShare(artifactId);
    return { record, data: await this.options.blobStore.get(record.uri) };
  }

  async ensureCanAccessSession(sessionId: string, user?: RuntimeArtifactUser): Promise<void> {
    await this.assertCanAccessSession(sessionId, user);
  }

  async createFromBytes(input: CreateArtifactFromBytesInput): Promise<ArtifactRecord> {
    const buffer = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);
    this.assertSizeAllowed(buffer.byteLength);
    const blob = await this.options.blobStore.put({
      data: buffer,
      contentType: input.mimeType,
      extension: input.fileName ? extname(input.fileName) : undefined,
    });
    try {
      return await this.options.artifactStore.create({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        producingHandId: input.producingHandId,
        kind: input.kind ?? inferKind(input.fileName),
        uri: blob.uri,
        mimeType: input.mimeType ?? blob.contentType,
        sizeBytes: blob.sizeBytes,
        sha256: blob.sha256,
        metadata: {
          ...(input.metadata ?? {}),
          ...(input.fileName ? { fileName: basename(input.fileName) } : {}),
        },
      });
    } catch (error) {
      // Blob 已写入但 metadata 落库失败时立即补偿，避免每次失败都留下唯一对象。
      await this.options.blobStore.delete(blob.uri).catch(() => undefined);
      throw error;
    }
  }

  async createFromWorkspaceFile(input: CreateArtifactFromWorkspaceFileInput): Promise<ArtifactRecord> {
    const fullPath = resolveInsideWorkspace(input.workspaceRoot, input.filePath);
    const st = await stat(fullPath);
    if (!st.isFile()) throw new ArtifactServiceError(400, 'Artifact source must be a file');
    this.assertSizeAllowed(st.size);
    const data = await readFile(fullPath);
    return this.createFromBytes({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      producingHandId: input.producingHandId,
      kind: input.kind ?? inferKind(fullPath),
      data,
      fileName: basename(fullPath),
      mimeType: input.mimeType,
      metadata: {
        source: 'workspace_file',
        sourcePath: relative(input.workspaceRoot, fullPath).split(sep).join('/'),
        ...(input.metadata ?? {}),
      },
    });
  }

  async createReadUrlForUser(
    artifactId: string,
    user: RuntimeArtifactUser | undefined,
    opts: { baseUrl: string; expiresInSeconds?: number; forceProxy?: boolean },
  ): Promise<ArtifactReadUrl> {
    const record = await this.getForUser(artifactId, user);
    const ttlSeconds = opts.expiresInSeconds ?? this.defaultReadUrlTtlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    if (record.uri.startsWith('oss://') && !opts.forceProxy) {
      return {
        url: await this.options.blobStore.createReadUrl(record.uri, { expiresInSeconds: ttlSeconds }),
        expiresAt,
        direct: true,
      };
    }
    const token = this.signReadToken(artifactId, expiresAt);
    const base = opts.baseUrl.replace(/\/$/, '');
    return {
      url: `${base}/api/artifacts/${encodeURIComponent(artifactId)}/content?token=${encodeURIComponent(token)}`,
      expiresAt,
      direct: false,
    };
  }

  async getContentBySignedToken(artifactId: string, token: string): Promise<ArtifactContent> {
    this.verifyReadToken(artifactId, token);
    const record = await this.options.artifactStore.get(artifactId);
    if (!record) throw new ArtifactServiceError(404, 'Artifact not found');
    return {
      record,
      data: await this.options.blobStore.get(record.uri),
    };
  }

  async pruneExpiredArtifacts(retentionDays: number, limit = 100): Promise<{ scanned: number; deleted: number }> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const records = await this.options.artifactStore.listOlderThan(cutoff, limit);
    let deleted = 0;
    for (const record of records) {
      const cleanup = async (): Promise<boolean> => {
        // listOlderThan 只是候选快照；deliver 可能随后写入 deliveredAt。锁内必须
        // 重读，不能用旧 record 删除刚完成交付的 Artifact。
        const current = await this.options.artifactStore.get(record.artifactId);
        if (!current || current.deliveredAt) return false;
        if (await this.options.isArtifactPinned?.(record.artifactId)) return false;
        await this.deleteRecordAndUnreferencedBlob(current);
        return true;
      };
      const didDelete = this.options.withArtifactLock
        ? await this.options.withArtifactLock(record.artifactId, cleanup)
        : await cleanup();
      if (didDelete) deleted += 1;
    }
    return { scanned: records.length, deleted };
  }

  async deleteArtifactsForSessions(sessionIds: string[]): Promise<{ scanned: number; deleted: number }> {
    const ids = Array.from(new Set(sessionIds.filter(Boolean)));
    if (ids.length === 0) return { scanned: 0, deleted: 0 };
    const records = this.options.artifactStore.listForSessions
      ? await this.options.artifactStore.listForSessions(ids)
      : (await Promise.all(ids.map(id => this.options.artifactStore.listForSession(id)))).flat();
    let deleted = 0;
    for (const record of records) {
      await this.deleteRecordAndUnreferencedBlob(record);
      deleted += 1;
    }
    return { scanned: records.length, deleted };
  }

  private async deleteRecordAndUnreferencedBlob(record: ArtifactRecord): Promise<void> {
    const referenceCount = await this.options.artifactStore.countByUri(record.uri);
    // 新对象 URI 唯一；历史内容寻址对象可能仍被多条记录共享。最后一条引用删除时
    // 先确认 Blob 已清理，再删 metadata，避免吞掉存储失败后留下无法追踪的敏感孤儿。
    if (referenceCount <= 1) await this.options.blobStore.delete(record.uri);
    await this.options.artifactStore.delete(record.artifactId);
  }

  private async assertSessionOwner(sessionId: string, user: RuntimeArtifactUser): Promise<void> {
    const userCwd = resolveUserCwd(this.options.agentCwd, {
      id: user.sub,
      username: user.username,
      role: 'user',
      tenantId: user.tenantId,
    });
    const transcriptPath = getTranscriptPath(userCwd, sessionId, { tenantId: user.tenantId, userId: user.sub });
    let meta = await readSessionMeta(transcriptPath);
    if (!meta) meta = await readSessionMeta(getTranscriptPath(userCwd, sessionId));
    if (
      !meta
      || meta.userId !== user.sub
      || (meta.tenantId !== undefined && meta.tenantId !== user.tenantId)
      || meta.deletedAt
      || hidesMemoryPollFrom({ role: user.role, tenantId: user.tenantId }, meta)
    ) {
      throw new ArtifactServiceError(404, 'Artifact not found');
    }
  }

  private async assertCanAccessSession(sessionId: string, user?: RuntimeArtifactUser): Promise<void> {
    // 修 P1 BUG #3 延伸（2026-06-21）：原 user.role === 'admin' 让组织 admin 跳过
    // session ACL 校验，意味着任意客户组织 admin 可读其他组织的 artifact 内容
    // （截图、patch、log 都是会话产生的临时文件，跨组织读同样泄漏）。收紧到
    // platform admin。组织 admin 看自己 tenant 内的 artifact 走正常 session 校验。
    if (!user) return;
    if (user.role === 'admin' && user.tenantId === DEFAULT_TENANT_ID) {
      const targetTenantId = await this.options.resolveSessionTenantId?.(sessionId);
      const allowed = targetTenantId && this.options.authorizeContentAccess
        ? await this.options.authorizeContentAccess({
            tenantId: targetTenantId,
            subjectUserId: user.sub,
            targetType: 'session',
            targetId: sessionId,
            scope: 'session_export',
          })
        : false;
      if (!allowed || !targetTenantId || !this.options.auditContentAccess) {
        throw new ArtifactServiceError(404, 'Artifact not found');
      }
      await this.options.auditContentAccess({
        tenantId: targetTenantId,
        subjectUserId: user.sub,
        sessionId,
        scope: 'session_export',
      });
      return;
    }
    // PR 7 P1-7：传 tenantId 让 resolveUserCwd 落对路径
    const userCwd = resolveUserCwd(this.options.agentCwd, {
      id: user.sub,
      username: user.username,
      role: 'user',
      tenantId: user.tenantId,
    });
    const transcriptPath = getTranscriptPath(userCwd, sessionId, { tenantId: user.tenantId, userId: user.sub });
    let meta = await readSessionMeta(transcriptPath);
    if (!meta) {
      meta = await readSessionMeta(getTranscriptPath(userCwd, sessionId));
    }
    if (!meta || meta.userId !== user.sub || hidesMemoryPollFrom({ role: user.role, tenantId: user.tenantId }, meta)) {
      throw new ArtifactServiceError(404, 'Artifact not found');
    }
  }

  private assertSizeAllowed(sizeBytes: number): void {
    if (sizeBytes > this.maxBlobBytes) {
      throw new ArtifactServiceError(413, `Artifact exceeds max size ${this.maxBlobBytes} bytes`);
    }
  }

  private signReadToken(artifactId: string, expiresAt: string): string {
    const payload = Buffer.from(JSON.stringify({ artifactId, exp: expiresAt })).toString('base64url');
    const sig = createHmac('sha256', this.signingSecret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  private verifyReadToken(artifactId: string, token: string): void {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) throw new ArtifactServiceError(401, 'Invalid artifact token');
    const expected = createHmac('sha256', this.signingSecret).update(payload).digest('base64url');
    if (!safeEqual(sig, expected)) throw new ArtifactServiceError(401, 'Invalid artifact token');
    let parsed: { artifactId?: string; exp?: string };
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { artifactId?: string; exp?: string };
    } catch {
      throw new ArtifactServiceError(401, 'Invalid artifact token');
    }
    if (parsed.artifactId !== artifactId || !parsed.exp || Date.parse(parsed.exp) <= Date.now()) {
      throw new ArtifactServiceError(401, 'Expired artifact token');
    }
  }
}

export class ArtifactServiceError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function resolveInsideWorkspace(cwd: string, inputPath: string): string {
  const fullPath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  const rel = relative(cwd, fullPath);
  if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))) {
    return fullPath;
  }
  throw new ArtifactServiceError(403, `Artifact source outside workspace: ${inputPath}`);
}

function inferKind(fileName?: string): ArtifactKind {
  const ext = extname(fileName ?? '').toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'screenshot';
  if (['.patch', '.diff'].includes(ext)) return 'patch';
  if (['.log', '.txt', '.md'].includes(ext)) return 'log';
  return 'file';
}

// 记忆/心跳轮询会话可见性统一走 data/sessions/access.ts 的 hidesMemoryPollFrom
// （2026-07-14 B 方案批次移除本地重复实现）。

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
