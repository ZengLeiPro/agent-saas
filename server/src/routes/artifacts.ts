import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ARTIFACT_VIEW_POLICY_VERSION, evaluateArtifactPolicy } from '@agent/shared';

import type { ArtifactKind, ArtifactRecord } from '../runtime/artifactStore.js';
import type { ArtifactShareRecord } from '../runtime/artifactShareStore.js';
import {
  ArtifactService,
  ArtifactServiceError,
  type RuntimeArtifactUser,
} from '../runtime/artifactService.js';
import {
  ArtifactShareService,
  ArtifactShareServiceError,
} from '../runtime/artifactShareService.js';
import { isValidSessionId } from '../data/transcripts/index.js';

export interface ArtifactsRouterOptions {
  artifactService: ArtifactService;
  artifactShareService?: ArtifactShareService;
  defaultReadUrlTtlSeconds?: number;
}

const createArtifactSchema = z.object({
  kind: z.enum(['file', 'screenshot', 'patch', 'log', 'blob']).optional(),
  content: z.string().optional(),
  contentBase64: z.string().optional(),
  fileName: z.string().min(1).max(255).optional(),
  mimeType: z.string().min(1).max(200).optional(),
  workspaceId: z.string().min(1).max(200).optional(),
  producingHandId: z.string().min(1).max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const readUrlQuerySchema = z.object({
  expiresInSeconds: z.coerce.number().int().positive().max(5 * 60).optional(),
  proxy: z.enum(['true', 'false']).optional(),
  download: z.enum(['true', 'false']).optional(),
  viewPolicyVersion: z.coerce.number().int().min(1).max(ARTIFACT_VIEW_POLICY_VERSION).optional(),
});

const upsertShareSchema = z.object({
  confirmPublicArtifact: z.literal(true),
  expiresAt: z.string().refine(value => Number.isFinite(Date.parse(value)), 'Invalid expiresAt').optional(),
  allowDownload: z.boolean().optional(),
}).strict();

export function createArtifactsRouter(options: ArtifactsRouterOptions): Router {
  const router = Router();
  const { artifactService } = options;

  router.get('/sessions/:sessionId/artifacts', async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    if (!isValidSessionId(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId' });
      return;
    }
    try {
      const artifacts = await artifactService.listForSession(sessionId, req.user as RuntimeArtifactUser | undefined);
      res.json({ sessionId, artifacts });
    } catch (err) {
      sendArtifactError(res, err);
    }
  });

  router.post('/sessions/:sessionId/artifacts', async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    if (!isValidSessionId(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId' });
      return;
    }
    const parsed = createArtifactSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
      return;
    }
    const content = parsed.data.contentBase64
      ? Buffer.from(parsed.data.contentBase64, 'base64')
      : parsed.data.content;
    if (content === undefined) {
      res.status(400).json({ error: 'content or contentBase64 required' });
      return;
    }
    try {
      await artifactService.ensureCanAccessSession(sessionId, req.user as RuntimeArtifactUser | undefined);
      const artifact = await artifactService.createFromBytes({
        sessionId,
        workspaceId: parsed.data.workspaceId,
        producingHandId: parsed.data.producingHandId,
        kind: parsed.data.kind as ArtifactKind | undefined,
        data: content,
        fileName: parsed.data.fileName,
        mimeType: parsed.data.mimeType,
        metadata: parsed.data.metadata,
      });
      res.status(201).json({ artifact });
    } catch (err) {
      sendArtifactError(res, err);
    }
  });

  router.get('/artifacts/:artifactId', async (req: Request, res: Response) => {
    try {
      const artifact = await artifactService.getForUser(req.params.artifactId, req.user as RuntimeArtifactUser | undefined);
      res.json({ artifact });
    } catch (err) {
      sendArtifactError(res, err);
    }
  });

  router.get('/artifacts/:artifactId/share', async (req: Request, res: Response) => {
    if (!options.artifactShareService) {
      res.status(503).json({ error: 'Artifact sharing unavailable' });
      return;
    }
    try {
      const share = await options.artifactShareService.getCurrent(
        req.params.artifactId,
        req.user as RuntimeArtifactUser | undefined,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json({ share });
    } catch (err) {
      sendArtifactError(res, err);
    }
  });

  router.post('/artifacts/:artifactId/share', async (req: Request, res: Response) => {
    if (!options.artifactShareService) {
      res.status(503).json({ error: 'Artifact sharing unavailable' });
      return;
    }
    const parsed = upsertShareSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Explicit public sharing confirmation required', issues: parsed.error.issues });
      return;
    }
    try {
      const share = await options.artifactShareService.upsert(
        req.params.artifactId,
        req.user as RuntimeArtifactUser | undefined,
        parsed.data,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json({ share });
    } catch (err) {
      sendArtifactError(res, err);
    }
  });

  router.delete('/artifacts/:artifactId/share', async (req: Request, res: Response) => {
    if (!options.artifactShareService) {
      res.status(503).json({ error: 'Artifact sharing unavailable' });
      return;
    }
    try {
      const revoked = await options.artifactShareService.revoke(
        req.params.artifactId,
        req.user as RuntimeArtifactUser | undefined,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, revoked });
    } catch (err) {
      sendArtifactError(res, err);
    }
  });

  router.get('/artifacts/:artifactId/read-url', async (req: Request, res: Response) => {
    const parsed = readUrlQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
      return;
    }
    try {
      const result = await artifactService.createReadUrlForUser(
        req.params.artifactId,
        req.user as RuntimeArtifactUser | undefined,
        {
          baseUrl: requestBaseUrl(req),
          expiresInSeconds: parsed.data.expiresInSeconds ?? options.defaultReadUrlTtlSeconds,
          forceProxy: parsed.data.proxy === 'true',
          forceDownload: parsed.data.download === 'true',
          viewPolicyVersion: parsed.data.viewPolicyVersion,
        },
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    } catch (err) {
      sendArtifactError(res, err);
    }
  });

  const serveSignedContent = async (req: Request, res: Response): Promise<void> => {
    if (typeof req.query.token !== 'string') {
      res.status(401).json({ error: 'artifact token required', code: 'authentication_required' });
      return;
    }
    try {
      const content = await artifactService.getContentBySignedToken(
        req.params.artifactId,
        req.query.token,
        req.user as RuntimeArtifactUser | undefined,
      );
      sendSignedArtifactContent(req, res, content);
    } catch (err) {
      sendArtifactError(res, err);
    }
  };

  // HEAD is explicit: Express otherwise aliases GET and would skip per-request verification semantics.
  router.head('/artifacts/:artifactId/content', (req: Request, res: Response) => {
    void serveSignedContent(req, res);
  });
  router.get('/artifacts/:artifactId/content', (req: Request, res: Response) => {
    void serveSignedContent(req, res);
  });

  const servePublicContent = async (req: Request, res: Response): Promise<void> => {
    if (!options.artifactShareService) {
      res.status(404).json({ error: 'Artifact share not found' });
      return;
    }
    try {
      const { share, record, data } = await options.artifactShareService.getPublicContent(req.params.token);
      setPublicContentHeaders(res, share, record, data.byteLength, data);
      res.send(data);
    } catch (err) {
      sendArtifactError(res, err);
    }
  };

  // Register HEAD before GET because Express otherwise treats GET as an implicit HEAD handler.
  router.head('/share/artifacts/:token/content', async (req: Request, res: Response) => {
    if (!options.artifactShareService) {
      res.status(404).json({ error: 'Artifact share not found' });
      return;
    }
    try {
      const { share, record } = await options.artifactShareService.getPublicContentMetadata(req.params.token);
      setPublicContentHeaders(res, share, record, record.sizeBytes);
      res.end();
    } catch (err) {
      sendArtifactError(res, err);
    }
  });
  router.get('/share/artifacts/:token/content', (req: Request, res: Response) => {
    void servePublicContent(req, res);
  });

  router.get('/share/artifacts/:token', async (req: Request, res: Response) => {
    if (!options.artifactShareService) {
      res.status(404).json({ error: 'Artifact share not found' });
      return;
    }
    try {
      const metadata = await options.artifactShareService.getPublicMetadata(req.params.token);
      res.setHeader('Cache-Control', 'no-store');
      res.json(metadata);
    } catch (err) {
      sendArtifactError(res, err);
    }
  });

  return router;
}

function sendSignedArtifactContent(
  req: Request,
  res: Response,
  content: Awaited<ReturnType<ArtifactService['getContentBySignedToken']>>,
): void {
  const { data, descriptor, disposition } = content;
  const etag = `"sha256-${descriptor.digest}"`;
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'self'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('ETag', etag);
  res.setHeader('Content-Type', descriptor.safeMime || 'application/octet-stream');
  res.setHeader('Content-Disposition', buildContentDisposition(disposition, descriptor.name));

  const rangeAllowed = ['audio', 'video', 'pdf', 'markdown', 'text', 'source'].includes(descriptor.viewKind);
  if (rangeAllowed) res.setHeader('Accept-Ranges', 'bytes');
  if (!req.headers.range && req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }

  const range = req.headers.range;
  if (range) {
    if (!rangeAllowed) {
      res.setHeader('Content-Range', `bytes */${data.byteLength}`);
      res.status(416).end();
      return;
    }
    const parsed = parseSingleByteRange(range, data.byteLength);
    if (!parsed) {
      res.setHeader('Content-Range', `bytes */${data.byteLength}`);
      res.status(416).end();
      return;
    }
    const { start, end } = parsed;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${data.byteLength}`);
    res.setHeader('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') res.end();
    else res.send(data.subarray(start, end + 1));
    return;
  }

  res.setHeader('Content-Length', String(data.byteLength));
  if (req.method === 'HEAD') res.end();
  else res.send(data);
}

function parseSingleByteRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size <= 0) return null;
  const rawStart = match[1];
  const rawEnd = match[2];
  if (!rawStart && !rawEnd) return null;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

function setPublicContentHeaders(
  res: Response,
  share: Pick<ArtifactShareRecord, 'allowDownload'>,
  record: ArtifactRecord,
  contentLength?: number,
  data?: Buffer,
): void {
  const policy = data ? evaluateArtifactPolicy({
    artifactId: record.artifactId,
    name: typeof record.metadata.fileName === 'string' ? record.metadata.fileName : undefined,
    declaredMime: record.mimeType,
    size: record.sizeBytes ?? data.byteLength,
    digest: record.sha256,
    bytes: data,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    correlationId: 'public-share',
  }) : undefined;
  const mimeType = policy?.safeMime || 'application/octet-stream';
  const dangerous = !policy || policy.activeContent || policy.disposition === 'attachment';
  const rawFileName = typeof record.metadata.fileName === 'string' ? record.metadata.fileName : `${record.artifactId}.bin`;
  const fileName = rawFileName.split(/[\\/]/).pop() || `${record.artifactId}.bin`;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', mimeType);
  if (contentLength !== undefined) res.setHeader('Content-Length', String(contentLength));
  res.setHeader('Content-Disposition', buildContentDisposition(dangerous || share.allowDownload ? 'attachment' : 'inline', fileName));
  if (dangerous) res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
}

function sendArtifactError(res: Response, err: unknown): void {
  if (err instanceof ArtifactServiceError || err instanceof ArtifactShareServiceError) {
    const code = err.statusCode === 401 ? 'authentication_required'
      : err.statusCode === 403 ? 'access_denied'
      : err.statusCode === 404 ? 'artifact_not_found'
      : err.statusCode === 410 ? 'artifact_deleted'
      : err.statusCode === 423 ? 'artifact_quarantined'
      : 'artifact_unavailable';
    res.status(err.statusCode).json({ error: err.message, code });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : 'Artifact request failed' });
}

function requestBaseUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || req.protocol;
  return `${proto}://${req.get('host')}`;
}

function buildContentDisposition(disposition: 'inline' | 'attachment', fileName: string): string {
  const fallback = asciiFileNameFallback(fileName);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987Value(fileName)}`;
}

function asciiFileNameFallback(fileName: string): string {
  const fallback = fileName
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\r\n\\;]/g, '_')
    .slice(0, 255);
  return fallback || 'artifact.bin';
}

function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
