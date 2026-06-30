import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { getTranscriptPath } from '../data/transcripts/store.js';
import { readSessionMeta, type SessionMeta } from '../data/transcripts/meta.js';
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
    return this.options.artifactStore.create({
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
    opts: { baseUrl: string; expiresInSeconds?: number },
  ): Promise<ArtifactReadUrl> {
    const record = await this.getForUser(artifactId, user);
    const ttlSeconds = opts.expiresInSeconds ?? this.defaultReadUrlTtlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    if (record.uri.startsWith('oss://')) {
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
      await this.options.blobStore.delete(record.uri).catch(() => undefined);
      await this.options.artifactStore.delete(record.artifactId);
      deleted += 1;
    }
    return { scanned: records.length, deleted };
  }

  private async assertCanAccessSession(sessionId: string, user?: RuntimeArtifactUser): Promise<void> {
    // 修 P1 BUG #3 延伸（2026-06-21）：原 user.role === 'admin' 让组织 admin 跳过
    // session ACL 校验，意味着任意客户组织 admin 可读其他组织的 artifact 内容
    // （截图、patch、log 都是会话产生的临时文件，跨组织读同样泄漏）。收紧到
    // platform admin。组织 admin 看自己 tenant 内的 artifact 走正常 session 校验。
    if (!user) return;
    if (user.role === 'admin' && user.tenantId === DEFAULT_TENANT_ID) return;
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
    if (!meta || meta.userId !== user.sub || isMemoryPollSessionMeta(meta)) {
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

function isMemoryPollSessionMeta(meta: SessionMeta | null | undefined): boolean {
  const jobName = meta?.cronJobName;
  return Boolean(jobName && (jobName.endsWith('记忆轮询') || jobName.endsWith('心跳轮询')));
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
