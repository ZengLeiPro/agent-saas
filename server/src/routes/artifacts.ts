import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

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
  expiresInSeconds: z.coerce.number().int().positive().max(7 * 24 * 60 * 60).optional(),
  proxy: z.enum(['true', 'false']).optional(),
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
        },
      );
      res.json(result);
    } catch (err) {
      sendArtifactError(res, err);
    }
  });

  router.get('/artifacts/:artifactId/content', async (req: Request, res: Response) => {
    if (typeof req.query.token !== 'string') {
      res.status(401).json({ error: 'artifact token required' });
      return;
    }
    try {
      const { record, data } = await artifactService.getContentBySignedToken(req.params.artifactId, req.query.token);
      const mimeType = record.mimeType || 'application/octet-stream';
      const activeContent = isActiveContentType(mimeType);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', String(data.byteLength));
      const fileName = typeof record.metadata.fileName === 'string' ? record.metadata.fileName : `${record.artifactId}.bin`;
      res.setHeader('Content-Disposition', buildContentDisposition(activeContent ? 'attachment' : 'inline', fileName));
      if (activeContent) res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.send(data);
    } catch (err) {
      sendArtifactError(res, err);
    }
  });

  const servePublicContent = async (req: Request, res: Response): Promise<void> => {
    if (!options.artifactShareService) {
      res.status(404).json({ error: 'Artifact share not found' });
      return;
    }
    try {
      const { share, record, data } = await options.artifactShareService.getPublicContent(req.params.token);
      setPublicContentHeaders(res, share, record, data.byteLength);
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

function setPublicContentHeaders(
  res: Response,
  share: Pick<ArtifactShareRecord, 'allowDownload'>,
  record: ArtifactRecord,
  contentLength?: number,
): void {
  const mimeType = record.mimeType || 'application/octet-stream';
  const dangerous = isActiveContentType(mimeType);
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
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : 'Artifact request failed' });
}

function isActiveContentType(value: string): boolean {
  const mimeType = value.split(';', 1)[0]!.trim().toLowerCase();
  return mimeType === 'text/html'
    || mimeType === 'application/xhtml+xml'
    || mimeType === 'image/svg+xml'
    || mimeType === 'application/xml'
    || mimeType === 'text/xml';
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
