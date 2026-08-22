import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { basename } from 'node:path';

import type { ArtifactRecord } from './artifactStore.js';
import { ArtifactService, ArtifactServiceError, type RuntimeArtifactUser } from './artifactService.js';
import type { ArtifactShareRecord, ArtifactShareStore } from './artifactShareStore.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 7 * DAY_MS;
const MAX_TTL_MS = 30 * DAY_MS;

export interface ArtifactShareServiceOptions {
  store: ArtifactShareStore;
  artifactService: ArtifactService;
  signingSecret: string;
  now?: () => Date;
}

export interface UpsertArtifactShareRequest {
  expiresAt?: string;
  allowDownload?: boolean;
}

export interface OwnerArtifactShare {
  shareId: string;
  artifactId: string;
  token: string;
  publicPath: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  allowDownload: boolean;
  accessCount: number;
  lastAccessedAt?: string;
}

export interface PublicArtifactShareMetadata {
  share: {
    createdAt: string;
    expiresAt: string;
    allowDownload: boolean;
    accessCount: number;
    lastAccessedAt?: string;
  };
  artifact: {
    kind: ArtifactRecord['kind'];
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
    sha256?: string;
  };
}

export class ArtifactShareService {
  private readonly signingSecret: string;
  private readonly now: () => Date;

  constructor(private readonly options: ArtifactShareServiceOptions) {
    if (!options.signingSecret || options.signingSecret.length < 16) {
      throw new Error('ArtifactShareService requires a persistent signingSecret of at least 16 characters');
    }
    this.signingSecret = options.signingSecret;
    this.now = options.now ?? (() => new Date());
  }

  async getCurrent(artifactId: string, user?: RuntimeArtifactUser): Promise<OwnerArtifactShare | null> {
    const record = await this.options.artifactService.getForOwner(artifactId, user);
    const share = await this.options.store.getCurrent(artifactId, user!.sub);
    return share ? this.toOwnerShare(share, record.artifactId) : null;
  }

  async upsert(
    artifactId: string,
    user: RuntimeArtifactUser | undefined,
    request: UpsertArtifactShareRequest,
  ): Promise<OwnerArtifactShare> {
    const candidate = await this.options.artifactService.getForOwner(artifactId, user);
    return this.options.store.withArtifactSessionLock(artifactId, candidate.sessionId, async () => {
      // 会话锁内重跑 owner/tombstone 校验；软删除若先提交，这里必须失败而不是复活分享。
      const record = await this.options.artifactService.getForOwner(artifactId, user);
      const current = await this.options.store.getCurrent(artifactId, user!.sub);
      const nowMs = this.now().getTime();
      const expiresAt = request.expiresAt
        ? new Date(request.expiresAt)
        : current
          ? new Date(current.expiresAt)
          : new Date(nowMs + DEFAULT_TTL_MS);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= nowMs) {
        throw new ArtifactShareServiceError(400, 'expiresAt must be in the future');
      }
      if (expiresAt.getTime() > nowMs + MAX_TTL_MS) {
        throw new ArtifactShareServiceError(400, 'Artifact shares may not exceed 30 days');
      }

      const shareId = current?.shareId ?? randomUUID();
      const token = this.deriveToken(shareId);
      const share = await this.options.store.upsertCurrent({
        shareId,
        artifactId,
        sessionId: record.sessionId,
        tenantId: user!.tenantId,
        ownerUserId: user!.sub,
        createdByUserId: user!.sub,
        tokenHash: hashToken(token),
        expiresAt: expiresAt.toISOString(),
        // 这是 UI 呈现偏好而非 DRM：关闭只隐藏下载入口，无法阻止访问者保存已加载内容。
        allowDownload: request.allowDownload ?? current?.allowDownload ?? true,
      });
      return this.toOwnerShare(share, artifactId);
    });
  }

  async revoke(artifactId: string, user?: RuntimeArtifactUser): Promise<boolean> {
    const candidate = await this.options.artifactService.getForOwner(artifactId, user);
    return this.options.store.withArtifactSessionLock(artifactId, candidate.sessionId, async () => {
      await this.options.artifactService.getForOwner(artifactId, user);
      return this.options.store.revoke(artifactId, user!.sub);
    });
  }

  async getPublicMetadata(token: string): Promise<PublicArtifactShareMetadata> {
    const share = await this.resolvePublicShare(token);
    const record = await this.options.artifactService.getRecordForShare(share.artifactId);
    const accessed = await this.options.store.markAccessed(share.shareId);
    if (!accessed) throw new ArtifactShareServiceError(410, 'Artifact share no longer active');
    return {
      share: {
        createdAt: accessed.createdAt,
        expiresAt: accessed.expiresAt,
        allowDownload: accessed.allowDownload,
        accessCount: accessed.accessCount,
        ...(accessed.lastAccessedAt ? { lastAccessedAt: accessed.lastAccessedAt } : {}),
      },
      artifact: publicArtifactMetadata(record),
    };
  }

  async getPublicContentMetadata(token: string): Promise<{ share: ArtifactShareRecord; record: ArtifactRecord }> {
    const share = await this.resolvePublicShare(token);
    const record = await this.options.artifactService.getRecordForShare(share.artifactId);
    return { share, record };
  }

  async getPublicContent(token: string): Promise<{ share: ArtifactShareRecord; record: ArtifactRecord; data: Buffer }> {
    const { share, record } = await this.getPublicContentMetadata(token);
    return { share, record, data: await this.options.artifactService.readBlobForShare(record) };
  }

  async resolvePublicShare(token: string): Promise<ArtifactShareRecord> {
    const shareId = parseAndVerifyToken(token, this.signingSecret);
    if (!shareId) throw new ArtifactShareServiceError(404, 'Artifact share not found');
    const record = await this.options.store.getByTokenHash(hashToken(token));
    if (!record || record.shareId !== shareId) {
      throw new ArtifactShareServiceError(404, 'Artifact share not found');
    }
    if (record.revokedAt) throw new ArtifactShareServiceError(410, 'Artifact share revoked');
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      throw new ArtifactShareServiceError(410, 'Artifact share expired');
    }
    return record;
  }

  deriveToken(shareId: string): string {
    const signature = createHmac('sha256', this.signingSecret).update(`artifact-share:${shareId}`).digest('base64url');
    return `${shareId}.${signature}`;
  }

  private toOwnerShare(record: ArtifactShareRecord, artifactId: string): OwnerArtifactShare {
    const token = this.deriveToken(record.shareId);
    return {
      shareId: record.shareId,
      artifactId,
      token,
      publicPath: `/public/artifacts/${encodeURIComponent(token)}`,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
      allowDownload: record.allowDownload,
      accessCount: record.accessCount,
      ...(record.lastAccessedAt ? { lastAccessedAt: record.lastAccessedAt } : {}),
    };
  }
}

export class ArtifactShareServiceError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function parseAndVerifyToken(token: string, signingSecret: string): string | null {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i.exec(token);
  if (!match) return null;
  const expected = createHmac('sha256', signingSecret).update(`artifact-share:${match[1]}`).digest('base64url');
  return safeEqual(match[2]!, expected) ? match[1]! : null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicArtifactMetadata(record: ArtifactRecord): PublicArtifactShareMetadata['artifact'] {
  const rawName = typeof record.metadata.fileName === 'string' ? record.metadata.fileName : `${record.artifactId}.bin`;
  return {
    kind: record.kind,
    fileName: basename(rawName),
    ...(record.mimeType ? { mimeType: record.mimeType } : {}),
    ...(record.sizeBytes !== undefined ? { sizeBytes: record.sizeBytes } : {}),
    ...(record.sha256 ? { sha256: record.sha256 } : {}),
  };
}

export function asArtifactShareError(err: unknown): ArtifactShareServiceError | ArtifactServiceError | null {
  if (err instanceof ArtifactShareServiceError || err instanceof ArtifactServiceError) return err;
  return null;
}
