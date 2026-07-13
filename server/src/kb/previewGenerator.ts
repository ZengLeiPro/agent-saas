import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

export const KB_PREVIEW_SCHEMA_VERSION = 1 as const;
export const KB_PREVIEW_WIDTH = 1600;
export const KB_PREVIEW_QUALITY = 80;
export const KB_PREVIEW_MAX_SOURCE_BYTES = 200 * 1024 * 1024;
export const KB_PREVIEW_MAX_PAGES = 1_000;

export interface KbPreviewManifest {
  schemaVersion: typeof KB_PREVIEW_SCHEMA_VERSION;
  sourcePath: string;
  sourceSha256: string;
  sourceSize: number;
  sourceMtimeMs: number;
  pageCount: number;
  width: number;
  format: 'webp';
  quality: number;
  generatedAt: string;
}

export interface PreviewGenerationResult {
  tenantId: string;
  sourcePath: string;
  status: 'generated' | 'skipped' | 'failed';
  sourceSha256?: string;
  pageCount?: number;
  generatedPages?: number;
  error?: string;
}

export interface PreviewGenerationReport {
  startedAt: string;
  finishedAt: string;
  generated: number;
  skipped: number;
  failed: number;
  results: PreviewGenerationResult[];
}

export type PdfPreviewRenderer = (options: {
  sourcePath: string;
  outputDir: string;
  width: number;
  quality: number;
  existingPages: Set<number>;
  pageTimeoutMs: number;
}) => Promise<{ pageCount: number; generatedPages: number }>;

export function normalizeKbRelativePath(value: string): string {
  return value.split(sep).join('/');
}

export function previewManifestPath(tenantRoot: string, sourceRelativePath: string): string {
  const key = createHash('sha256').update(normalizeKbRelativePath(sourceRelativePath)).digest('hex');
  return join(tenantRoot, '.previews', 'index', `${key}.json`);
}

export function previewContentDir(tenantRoot: string, sourceSha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error('Invalid preview version');
  return join(tenantRoot, '.previews', 'content', sourceSha256);
}

export function previewPagePath(contentDir: string, page: number): string {
  if (!Number.isInteger(page) || page < 1) throw new Error('Invalid preview page');
  return join(contentDir, `page-${String(page).padStart(4, '0')}.webp`);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

async function atomicWrite(filePath: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, data);
  await rename(temporaryPath, filePath);
}

async function existingPreviewPages(outputDir: string): Promise<Set<number>> {
  const pages = new Set<number>();
  try {
    for (const entry of await readdir(outputDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = /^page-(\d{4})\.webp$/.exec(entry.name);
      if (match) pages.add(Number(match[1]));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return pages;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`PDF preview page rendering timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const renderPdfToWebp: PdfPreviewRenderer = async ({
  sourcePath,
  outputDir,
  width,
  quality,
  existingPages,
  pageTimeoutMs,
}) => {
  const data = new Uint8Array(await readFile(sourcePath));
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true });
  const document = await loadingTask.promise;
  try {
    if (document.numPages > KB_PREVIEW_MAX_PAGES) {
      throw new Error(`PDF page count ${document.numPages} exceeds limit ${KB_PREVIEW_MAX_PAGES}`);
    }
    await mkdir(outputDir, { recursive: true });
    let generatedPages = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      if (existingPages.has(pageNumber)) continue;
      const page = await document.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = width / baseViewport.width;
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      try {
        const renderTask = page.render({
          canvasContext: canvas.getContext('2d') as never,
          viewport,
        });
        await withTimeout(renderTask.promise, pageTimeoutMs, () => renderTask.cancel());
        const encoded = await canvas.encode('webp', quality);
        await atomicWrite(previewPagePath(outputDir, pageNumber), encoded);
        generatedPages += 1;
      } finally {
        page.cleanup();
        canvas.width = 1;
        canvas.height = 1;
      }
    }
    return { pageCount: document.numPages, generatedPages };
  } finally {
    await document.destroy();
  }
};

async function readManifest(manifestPath: string): Promise<KbPreviewManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as KbPreviewManifest;
    return parsed.schemaVersion === KB_PREVIEW_SCHEMA_VERSION ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function listPdfFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.previews' || entry.isSymbolicLink()) continue;
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listPdfFiles(entryPath));
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.pdf') files.push(entryPath);
  }
  return files;
}

export async function generateDocumentPreview(options: {
  tenantId: string;
  tenantRoot: string;
  sourceAbsolutePath: string;
  renderer?: PdfPreviewRenderer;
  pageTimeoutMs?: number;
}): Promise<PreviewGenerationResult> {
  const { tenantId, tenantRoot, sourceAbsolutePath } = options;
  const renderer = options.renderer ?? renderPdfToWebp;
  const sourcePath = normalizeKbRelativePath(relative(tenantRoot, sourceAbsolutePath));
  try {
    const before = await stat(sourceAbsolutePath);
    if (!before.isFile()) throw new Error('Source is not a file');
    if (before.size > KB_PREVIEW_MAX_SOURCE_BYTES) {
      throw new Error(`PDF size ${before.size} exceeds limit ${KB_PREVIEW_MAX_SOURCE_BYTES}`);
    }
    const sourceSha256 = await sha256File(sourceAbsolutePath);
    const manifestPath = previewManifestPath(tenantRoot, sourcePath);
    const currentManifest = await readManifest(manifestPath);
    const outputDir = previewContentDir(tenantRoot, sourceSha256);
    const existingPages = await existingPreviewPages(outputDir);
    if (
      currentManifest?.sourceSha256 === sourceSha256
      && currentManifest.sourceSize === before.size
      && currentManifest.sourceMtimeMs === before.mtimeMs
      && currentManifest.pageCount > 0
      && existingPages.size >= currentManifest.pageCount
    ) {
      return { tenantId, sourcePath, status: 'skipped', sourceSha256, pageCount: currentManifest.pageCount, generatedPages: 0 };
    }

    const rendered = await renderer({
      sourcePath: sourceAbsolutePath,
      outputDir,
      width: KB_PREVIEW_WIDTH,
      quality: KB_PREVIEW_QUALITY,
      existingPages,
      pageTimeoutMs: options.pageTimeoutMs ?? 90_000,
    });
    const after = await stat(sourceAbsolutePath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('PDF changed while preview was being generated; retry required');
    }
    const manifest: KbPreviewManifest = {
      schemaVersion: KB_PREVIEW_SCHEMA_VERSION,
      sourcePath,
      sourceSha256,
      sourceSize: after.size,
      sourceMtimeMs: after.mtimeMs,
      pageCount: rendered.pageCount,
      width: KB_PREVIEW_WIDTH,
      format: 'webp',
      quality: KB_PREVIEW_QUALITY,
      generatedAt: new Date().toISOString(),
    };
    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return {
      tenantId,
      sourcePath,
      status: 'generated',
      sourceSha256,
      pageCount: rendered.pageCount,
      generatedPages: rendered.generatedPages,
    };
  } catch (error) {
    return { tenantId, sourcePath, status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

export async function generateKbPreviews(options: {
  kbRootDir: string;
  tenantId?: string;
  renderer?: PdfPreviewRenderer;
  pageTimeoutMs?: number;
}): Promise<PreviewGenerationReport> {
  const startedAt = new Date().toISOString();
  const root = resolve(options.kbRootDir);
  const tenantEntries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const tenants = tenantEntries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((tenantId) => !options.tenantId || tenantId === options.tenantId)
    .sort();
  const results: PreviewGenerationResult[] = [];
  for (const tenantId of tenants) {
    const tenantRoot = join(root, tenantId);
    for (const sourceAbsolutePath of (await listPdfFiles(tenantRoot)).sort()) {
      results.push(await generateDocumentPreview({
        tenantId,
        tenantRoot,
        sourceAbsolutePath,
        renderer: options.renderer,
        pageTimeoutMs: options.pageTimeoutMs,
      }));
    }
  }
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    generated: results.filter((result) => result.status === 'generated').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    failed: results.filter((result) => result.status === 'failed').length,
    results,
  };
}
