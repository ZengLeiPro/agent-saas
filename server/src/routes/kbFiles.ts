/**
 * 租户共享知识库文件与 PDF 单页预览服务。
 *
 * tenantId 只取 JWT；所有源文件和预览都先按源 PDF 做相同的租户、路径与符号链接校验。
 */
import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { auditLog } from '../data/login-logs/index.js';
import {
  KB_PREVIEW_SCHEMA_VERSION,
  type KbPreviewManifest,
  normalizeKbRelativePath,
  previewContentDir,
  previewManifestPath,
  previewPagePath,
} from '../kb/previewGenerator.js';
import { isPathWithinDirectory } from '../security/extraDirs.js';

const KB_ALLOWED_EXTS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.md', '.txt']);
const KB_MIME_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export interface KbFilesRouterOptions {
  kbRootDir: string;
}

interface AuthorizedFile {
  tenantRoot: string;
  absolutePath: string;
  relativePath: string;
  stats: Stats;
  ext: string;
}

function readStringQuery(req: Request, name: string): string | null {
  const value = req.query[name];
  return typeof value === 'string' ? value : null;
}

async function assertNoSymlinkComponents(tenantRoot: string, absolutePath: string): Promise<void> {
  const components = relative(tenantRoot, absolutePath).split(sep).filter(Boolean);
  let current = tenantRoot;
  for (const component of components) {
    current = resolve(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw Object.assign(new Error('Symbolic links are not allowed'), { code: 'EACCES' });
  }
}

async function authorizeFile(kbRootDir: string, req: Request, allowedExts = KB_ALLOWED_EXTS): Promise<AuthorizedFile> {
  const tenantId = req.user?.tenantId;
  if (!tenantId) throw Object.assign(new Error('Authentication required'), { status: 401 });
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(tenantId)) throw Object.assign(new Error('Access denied'), { status: 403 });
  const filePath = readStringQuery(req, 'path');
  if (!filePath) throw Object.assign(new Error('Missing path parameter'), { status: 400 });
  if (
    filePath.length > 2_048
    || filePath.startsWith('/')
    || filePath.includes('\0')
    || filePath.includes('\\')
    || filePath.split('/').includes('.previews')
  ) {
    throw Object.assign(new Error('Access denied'), { status: 403 });
  }
  const ext = extname(filePath).toLowerCase();
  if (!allowedExts.has(ext)) throw Object.assign(new Error('该文件类型不支持访问'), { status: 403 });

  const tenantRoot = resolve(kbRootDir, tenantId);
  const absolutePath = resolve(tenantRoot, filePath);
  if (!isPathWithinDirectory(absolutePath, tenantRoot)) throw Object.assign(new Error('Access denied'), { status: 403 });
  await assertNoSymlinkComponents(tenantRoot, absolutePath);
  const [realTenantRoot, realFilePath, stats] = await Promise.all([realpath(tenantRoot), realpath(absolutePath), stat(absolutePath)]);
  if (!isPathWithinDirectory(realFilePath, realTenantRoot)) throw Object.assign(new Error('Access denied'), { status: 403 });
  if (!stats.isFile()) throw Object.assign(new Error('Not a file'), { status: 400 });
  return {
    tenantRoot,
    absolutePath,
    relativePath: normalizeKbRelativePath(relative(tenantRoot, absolutePath)),
    stats,
    ext,
  };
}

function fileEtag(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`;
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const normalize = (value: string) => value.trim().replace(/^W\//, '');
  return header.split(',').some((candidate) => candidate.trim() === '*' || normalize(candidate) === normalize(etag));
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value;
}

function isNotModified(req: Request, etag: string, mtime: Date): boolean {
  const ifNoneMatch = singleHeader(req.headers['if-none-match']);
  if (ifNoneMatch) return etagMatches(ifNoneMatch, etag);
  const ifModifiedSince = singleHeader(req.headers['if-modified-since']);
  if (!ifModifiedSince) return false;
  const timestamp = Date.parse(ifModifiedSince);
  return Number.isFinite(timestamp) && Math.floor(mtime.getTime() / 1_000) <= Math.floor(timestamp / 1_000);
}

function rangeAllowedByIfRange(req: Request, etag: string, mtime: Date): boolean {
  const ifRange = singleHeader(req.headers['if-range']);
  if (!ifRange) return true;
  if (ifRange.includes('"')) return etagMatches(ifRange, etag);
  const timestamp = Date.parse(ifRange);
  return Number.isFinite(timestamp) && Math.floor(mtime.getTime() / 1_000) <= Math.floor(timestamp / 1_000);
}

function setCommonFileHeaders(res: Response, options: {
  contentType: string;
  contentDisposition?: string;
  cacheControl: string;
  etag: string;
  mtime: Date;
}): void {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', options.contentType);
  if (options.contentDisposition) res.setHeader('Content-Disposition', options.contentDisposition);
  res.setHeader('Cache-Control', options.cacheControl);
  res.setHeader('ETag', options.etag);
  res.setHeader('Last-Modified', options.mtime.toUTCString());
}

function disposition(filename: string, mode: 'inline' | 'attachment'): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function sendFile(req: Request, res: Response, options: {
  absolutePath: string;
  stats: AuthorizedFile['stats'];
  contentType: string;
  contentDisposition?: string;
  cacheControl: string;
  etag?: string;
}): Promise<void> {
  const etag = options.etag ?? fileEtag(options.stats.size, options.stats.mtimeMs);
  setCommonFileHeaders(res, { ...options, etag, mtime: options.stats.mtime });
  if (isNotModified(req, etag, options.stats.mtime)) {
    res.status(304).end();
    return;
  }

  const parsedRange = req.headers.range && rangeAllowedByIfRange(req, etag, options.stats.mtime)
    ? parseByteRange(req.headers.range, options.stats.size)
    : null;
  if (parsedRange?.kind === 'unsatisfiable') {
    res.status(416).setHeader('Content-Range', `bytes */${options.stats.size}`).end();
    return;
  }
  if (parsedRange?.kind === 'range') {
    const { start, end } = parsedRange;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${options.stats.size}`);
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await pipeFile(res, options.absolutePath, { start, end });
    return;
  }
  res.setHeader('Content-Length', options.stats.size);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeFile(res, options.absolutePath);
}

function pipeFile(res: Response, absolutePath: string, range?: { start: number; end: number }): Promise<void> {
  return new Promise((resolvePromise) => {
    const stream = createReadStream(absolutePath, range);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Failed to read file' });
      else res.destroy();
      resolvePromise();
    });
    stream.on('end', resolvePromise);
    stream.pipe(res);
  });
}

function isManifest(value: unknown): value is KbPreviewManifest {
  const manifest = value as Partial<KbPreviewManifest> | null;
  return !!manifest
    && manifest.schemaVersion === KB_PREVIEW_SCHEMA_VERSION
    && typeof manifest.sourcePath === 'string'
    && /^[a-f0-9]{64}$/.test(manifest.sourceSha256 ?? '')
    && Number.isFinite(manifest.sourceSize)
    && Number.isFinite(manifest.sourceMtimeMs)
    && Number.isInteger(manifest.pageCount)
    && (manifest.pageCount ?? 0) > 0
    && manifest.format === 'webp';
}

async function loadCurrentManifest(file: AuthorizedFile): Promise<KbPreviewManifest | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(previewManifestPath(file.tenantRoot, file.relativePath), 'utf8'));
    if (!isManifest(parsed)) return null;
    if (
      parsed.sourcePath !== file.relativePath
      || parsed.sourceSize !== file.stats.size
      || parsed.sourceMtimeMs !== file.stats.mtimeMs
    ) return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function handleRouteError(res: Response, error: unknown): void {
  const candidate = error as NodeJS.ErrnoException & { status?: number };
  if (candidate.status) {
    res.status(candidate.status).json({ error: candidate.message });
    return;
  }
  if (candidate.code === 'ENOENT') {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  if (candidate.code === 'EACCES') {
    res.status(403).json({ error: 'Access denied: symbolic links not allowed' });
    return;
  }
  res.status(500).json({ error: 'Failed to read file' });
}

export function createKbFilesRouter(options: KbFilesRouterOptions): Router {
  const kbRootDir = resolve(options.kbRootDir);
  const router = Router();

  const fileHandler = async (req: Request, res: Response) => {
    try {
      const file = await authorizeFile(kbRootDir, req);
      const contentType = KB_MIME_MAP[file.ext] ?? 'application/octet-stream';
      const mode = contentType.startsWith('image/') || contentType === 'application/pdf' ? 'inline' : 'attachment';
      if (req.method === 'GET' && req.headers.authorization) {
        auditLog(req, 'kb_file_read', `${file.relativePath} (${file.ext})`);
      }
      await sendFile(req, res, {
        absolutePath: file.absolutePath,
        stats: file.stats,
        contentType,
        contentDisposition: disposition(basename(file.absolutePath), mode),
        cacheControl: 'private, max-age=0, must-revalidate',
      });
    } catch (error) {
      handleRouteError(res, error);
    }
  };
  router.route('/file').get(fileHandler).head(fileHandler);

  const manifestHandler = async (req: Request, res: Response) => {
    try {
      const file = await authorizeFile(kbRootDir, req, new Set(['.pdf']));
      const manifest = await loadCurrentManifest(file);
      if (!manifest) {
        res.status(404).json({ error: '该文档预览暂未生成' });
        return;
      }
      const body = Buffer.from(JSON.stringify(manifest));
      const etag = `"${manifest.sourceSha256}-manifest"`;
      setCommonFileHeaders(res, {
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'private, max-age=0, must-revalidate',
        etag,
        mtime: file.stats.mtime,
      });
      if (isNotModified(req, etag, file.stats.mtime)) {
        res.status(304).end();
        return;
      }
      res.setHeader('Content-Length', body.length);
      if (req.method === 'HEAD') res.end();
      else res.send(body);
    } catch (error) {
      handleRouteError(res, error);
    }
  };
  router.route('/preview-manifest').get(manifestHandler).head(manifestHandler);

  const previewHandler = async (req: Request, res: Response) => {
    try {
      const file = await authorizeFile(kbRootDir, req, new Set(['.pdf']));
      const manifest = await loadCurrentManifest(file);
      if (!manifest) {
        res.status(404).json({ error: '该页预览暂未生成' });
        return;
      }
      const version = readStringQuery(req, 'version');
      if (!version || version !== manifest.sourceSha256) {
        res.status(409).json({ error: '文档版本已更新，请重新打开引用' });
        return;
      }
      const rawPage = readStringQuery(req, 'page');
      const page = rawPage && /^\d+$/.test(rawPage) ? Number(rawPage) : NaN;
      if (!Number.isSafeInteger(page) || page < 1) {
        res.status(400).json({ error: '页码必须是正整数' });
        return;
      }
      if (page > manifest.pageCount) {
        res.status(416).json({ error: `页码超出范围，共 ${manifest.pageCount} 页` });
        return;
      }
      const absolutePath = previewPagePath(previewContentDir(file.tenantRoot, version), page);
      const previewStats = await stat(absolutePath);
      if (!previewStats.isFile()) {
        res.status(404).json({ error: '该页预览暂未生成' });
        return;
      }
      await sendFile(req, res, {
        absolutePath,
        stats: previewStats,
        contentType: 'image/webp',
        cacheControl: 'private, max-age=31536000, immutable',
        etag: `"${version}-p${page}-${previewStats.size.toString(16)}"`,
      });
    } catch (error) {
      handleRouteError(res, error);
    }
  };
  router.route('/preview').get(previewHandler).head(previewHandler);
  return router;
}

export type ParsedByteRange =
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' }
  | null;

/** 仅支持单段 byte range；任何格式错误、多段或越界均返回 416，不回退全量 200。 */
export function parseByteRange(header: string, size: number): ParsedByteRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return { kind: 'unsatisfiable' };
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || requestedEnd < start || start >= size) {
    return { kind: 'unsatisfiable' };
  }
  return { kind: 'range', start, end: Math.min(requestedEnd, size - 1) };
}
