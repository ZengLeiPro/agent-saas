import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
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
});
