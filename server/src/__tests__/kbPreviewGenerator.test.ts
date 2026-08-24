import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateDocumentPreview,
  generateKbPreviews,
  previewManifestPath,
  previewPagePath,
  type PdfPreviewRenderer,
} from '../kb/previewGenerator.js';

describe('KB PDF 预览生成器', () => {
  let root: string;
  let source: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-preview-generator-'));
    source = join(root, 'tenant-a', 'docs', 'manual.pdf');
    await mkdir(join(root, 'tenant-a', 'docs'), { recursive: true });
    await writeFile(source, 'pdf-version-1');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function fakeRenderer(): PdfPreviewRenderer {
    return vi.fn(async ({ outputDir, existingPages }) => {
      await mkdir(outputDir, { recursive: true });
      let generatedPages = 0;
      for (let page = 1; page <= 2; page += 1) {
        if (existingPages.has(page)) continue;
        await writeFile(previewPagePath(outputDir, page), `page-${page}`);
        generatedPages += 1;
      }
      return { pageCount: 2, generatedPages };
    });
  }

  it('可重复执行且幂等，第二次不重新渲染', async () => {
    const renderer = fakeRenderer();
    const first = await generateKbPreviews({ kbRootDir: root, renderer });
    const second = await generateKbPreviews({ kbRootDir: root, renderer });
    expect(first).toMatchObject({ generated: 1, skipped: 0, failed: 0 });
    expect(second).toMatchObject({ generated: 0, skipped: 1, failed: 0 });
    expect(renderer).toHaveBeenCalledTimes(1);
  });

  it('PDF 更新后生成新内容版本，并原子切换路径索引', async () => {
    const renderer = fakeRenderer();
    await generateKbPreviews({ kbRootDir: root, renderer });
    const manifestPath = previewManifestPath(join(root, 'tenant-a'), 'docs/manual.pdf');
    const first = JSON.parse(await readFile(manifestPath, 'utf8')) as { sourceSha256: string };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    await writeFile(source, 'pdf-version-2-with-different-content');
    const secondReport = await generateKbPreviews({ kbRootDir: root, renderer });
    const second = JSON.parse(await readFile(manifestPath, 'utf8')) as { sourceSha256: string; sourceSize: number };
    expect(secondReport).toMatchObject({ generated: 1, failed: 0 });
    expect(second.sourceSha256).not.toBe(first.sourceSha256);
    expect(second.sourceSha256).toBe(createHash('sha256').update('pdf-version-2-with-different-content').digest('hex'));
    expect(second.sourceSize).toBe((await stat(source)).size);
    expect(renderer).toHaveBeenCalledTimes(2);
  });

  it('扫描与 manifest 输出拒绝 ancestor symlink', async () => {
    const tenantRoot = join(root, 'tenant-a');
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.pdf'), 'outside');
    await symlink(outside, join(tenantRoot, 'linked-docs'), 'dir');
    await rm(source);

    const renderer = fakeRenderer();
    const scan = await generateKbPreviews({ kbRootDir: root, tenantId: 'tenant-a', renderer });
    expect(scan).toMatchObject({ generated: 0, skipped: 0, failed: 0, results: [] });
    expect(renderer).not.toHaveBeenCalled();

    await writeFile(source, 'pdf-version-1');
    await mkdir(join(tenantRoot, '.previews'));
    await symlink(outside, join(tenantRoot, '.previews', 'index'), 'dir');
    const manifestRace = await generateKbPreviews({ kbRootDir: root, tenantId: 'tenant-a', renderer });
    expect(manifestRace).toMatchObject({ generated: 0, failed: 1 });
    expect(renderer).not.toHaveBeenCalled();
  });

  it('检查后替换源目录时 hash 与 render 仍绑定同一受信 inode', async () => {
    const tenantRoot = join(root, 'tenant-a');
    const original = 'pdf-version-1';
    const replacement = 'attacker-replacement';
    const renderer: PdfPreviewRenderer = vi.fn(async ({ sourcePath, outputDir }) => {
      await rename(join(tenantRoot, 'docs'), join(tenantRoot, 'docs-original'));
      await mkdir(join(tenantRoot, 'docs'));
      await writeFile(join(tenantRoot, 'docs', 'manual.pdf'), replacement);
      const rendered = await readFile(sourcePath, 'utf8');
      await writeFile(previewPagePath(outputDir, 1), rendered);
      return { pageCount: 1, generatedPages: 1 };
    });

    const result = await generateDocumentPreview({
      tenantId: 'tenant-a',
      tenantRoot,
      sourceAbsolutePath: source,
      renderer,
    });
    expect(result).toMatchObject({
      status: 'generated',
      sourceSha256: createHash('sha256').update(original).digest('hex'),
    });
    expect(await readFile(join(tenantRoot, 'docs', 'manual.pdf'), 'utf8')).toBe(replacement);
    expect(renderer).toHaveBeenCalledTimes(1);
  });
});
