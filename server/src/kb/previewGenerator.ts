import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  atomicWriteTrustedFile,
  openTrustedDirectory,
  openTrustedFile,
  relativeToTrustedRoot,
  removeTrustedPath,
  writeTrustedFile,
  type TrustedFile,
} from '../security/trustedFile.js';

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
  /** Descriptor-bound source path; safe if an ancestor is renamed after validation. */
  sourcePath: string;
  /** Descriptor-bound output directory. */
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

async function sha256File(file: TrustedFile): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = file.handle.createReadStream({ autoClose: false, start: 0 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

/** outputDir is a descriptor-bound /proc path opened by generateDocumentPreview. */
async function atomicWrite(filePath: string, data: string | Uint8Array): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, data, { flag: 'wx' });
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function existingPreviewPages(outputDirFdPath: string): Promise<Set<number>> {
  const pages = new Set<number>();
  for (const entry of await readdir(outputDirFdPath, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const match = /^page-(\d{4})\.webp$/.exec(entry.name);
    if (match) pages.add(Number(match[1]));
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

async function readManifest(tenantRoot: string, manifestRelativePath: string): Promise<KbPreviewManifest | null> {
  try {
    const manifest = await openTrustedFile(tenantRoot, manifestRelativePath);
    try {
      const parsed = JSON.parse(await manifest.handle.readFile({ encoding: 'utf8' })) as KbPreviewManifest;
      return parsed.schemaVersion === KB_PREVIEW_SCHEMA_VERSION ? parsed : null;
    } finally {
      await manifest.handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function listPdfFiles(tenantRoot: string, directoryRelativePath = ''): Promise<string[]> {
  const directory = await openTrustedDirectory(tenantRoot, directoryRelativePath);
  let entries;
  try {
    entries = await readdir(directory.fdPath, { withFileTypes: true });
  } finally {
    await directory.handle.close();
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.previews' || entry.isSymbolicLink()) continue;
    const entryRelativePath = join(directoryRelativePath, entry.name);
    if (entry.isDirectory()) files.push(...await listPdfFiles(tenantRoot, entryRelativePath));
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) files.push(entryRelativePath);
  }
  return files;
}

async function openPreviewOutputDirectory(tenantRoot: string, relativePath: string) {
  const marker = join(relativePath, `.init-${randomUUID()}`);
  await writeTrustedFile(tenantRoot, marker, '', { createParents: true, exclusive: true });
  try {
    return await openTrustedDirectory(tenantRoot, relativePath);
  } finally {
    await removeTrustedPath(tenantRoot, marker).catch(() => undefined);
  }
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
  let sourcePath = normalizeKbRelativePath(relative(tenantRoot, sourceAbsolutePath));
  let source: TrustedFile | undefined;
  let outputDirectory: Awaited<ReturnType<typeof openTrustedDirectory>> | undefined;
  try {
    sourcePath = normalizeKbRelativePath(relativeToTrustedRoot(tenantRoot, sourceAbsolutePath));
    source = await openTrustedFile(tenantRoot, sourcePath);
    const before = source.stats;
    if (before.size > KB_PREVIEW_MAX_SOURCE_BYTES) {
      throw new Error(`PDF size ${before.size} exceeds limit ${KB_PREVIEW_MAX_SOURCE_BYTES}`);
    }
    const sourceSha256 = await sha256File(source);
    const manifestRelativePath = relativeToTrustedRoot(
      tenantRoot,
      previewManifestPath(tenantRoot, sourcePath),
    );
    const currentManifest = await readManifest(tenantRoot, manifestRelativePath);
    const outputRelativeDir = relativeToTrustedRoot(tenantRoot, previewContentDir(tenantRoot, sourceSha256));
    outputDirectory = await openPreviewOutputDirectory(tenantRoot, outputRelativeDir);
    const existingPages = await existingPreviewPages(outputDirectory.fdPath);
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
      sourcePath: source.fdPath,
      outputDir: outputDirectory.fdPath,
      width: KB_PREVIEW_WIDTH,
      quality: KB_PREVIEW_QUALITY,
      existingPages,
      pageTimeoutMs: options.pageTimeoutMs ?? 90_000,
    });
    const after = await source.handle.stat();
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
    await atomicWriteTrustedFile(tenantRoot, manifestRelativePath, `${JSON.stringify(manifest, null, 2)}\n`, {
      createParents: true,
    });
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
  } finally {
    await outputDirectory?.handle.close().catch(() => undefined);
    await source?.handle.close().catch(() => undefined);
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
  let rootDirectory: Awaited<ReturnType<typeof openTrustedDirectory>> | undefined;
  let tenantEntries: Dirent[];
  try {
    rootDirectory = await openTrustedDirectory(root);
    tenantEntries = await readdir(rootDirectory.fdPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') tenantEntries = [];
    else throw error;
  } finally {
    await rootDirectory?.handle.close().catch(() => undefined);
  }
  const tenants = tenantEntries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((tenantId) => !options.tenantId || tenantId === options.tenantId)
    .sort();
  const results: PreviewGenerationResult[] = [];
  for (const tenantId of tenants) {
    const tenantRoot = join(root, tenantId);
    for (const sourceRelativePath of (await listPdfFiles(tenantRoot)).sort()) {
      results.push(await generateDocumentPreview({
        tenantId,
        tenantRoot,
        sourceAbsolutePath: join(tenantRoot, sourceRelativePath),
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
