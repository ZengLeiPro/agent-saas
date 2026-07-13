/**
 * KB 文件路由测试（/api/kb/file，计划用例 14-15）
 *
 * 14. 同租户 pdf：200 + inline + Accept-Ranges；Range 请求 → 206 分片
 * 15. 路径安全四道闸：路径穿越 / 绝对路径 / 符号链接 / 白名单外扩展名 → 403；
 *     跨租户文件不可达（tenantId 取自 JWT，非参数）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';

import { createKbFilesRouter } from '../routes/kbFiles.js';
import { previewContentDir, previewManifestPath, previewPagePath } from '../kb/previewGenerator.js';

const PDF_BYTES = Buffer.from('%PDF-1.4 fake-pdf-content-0123456789');

interface TestUser {
  sub: string;
  username: string;
  role: 'admin' | 'user';
  tenantId: string;
}

async function startServer(kbRootDir: string, user: TestUser): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser }).user = user;
    next();
  });
  app.use('/api/kb', createKbFilesRouter({ kbRootDir }));
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server: s, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function seedPreview(kbRootDir: string, sourcePath = 'docs/manual.pdf', pageCount = 2): Promise<{ version: string; pageBytes: Buffer }> {
  const tenantRoot = join(kbRootDir, 'tenant-a');
  const source = join(tenantRoot, sourcePath);
  const sourceStats = await stat(source);
  const version = createHash('sha256').update(PDF_BYTES).digest('hex');
  const contentDir = previewContentDir(tenantRoot, version);
  await mkdir(contentDir, { recursive: true });
  const pageBytes = Buffer.from('fake-webp-page-1');
  await writeFile(previewPagePath(contentDir, 1), pageBytes);
  const manifestPath = previewManifestPath(tenantRoot, sourcePath);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    sourcePath,
    sourceSha256: version,
    sourceSize: sourceStats.size,
    sourceMtimeMs: sourceStats.mtimeMs,
    pageCount,
    width: 1600,
    format: 'webp',
    quality: 80,
    generatedAt: new Date().toISOString(),
  }));
  return { version, pageBytes };
}

function stopServer(s: Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

describe('/api/kb/file routes', () => {
  let kbRoot: string;
  let server: Server | null = null;
  let baseUrl = '';

  const userA: TestUser = { sub: 'u-a', username: 'alice', role: 'user', tenantId: 'tenant-a' };

  beforeEach(async () => {
    kbRoot = await mkdtemp(join(tmpdir(), 'kb-routes-test-'));
    await mkdir(join(kbRoot, 'tenant-a', 'docs'), { recursive: true });
    await mkdir(join(kbRoot, 'tenant-b'), { recursive: true });
    await writeFile(join(kbRoot, 'tenant-a', 'docs', 'manual.pdf'), PDF_BYTES);
    await writeFile(join(kbRoot, 'tenant-a', 'evil.exe'), 'MZ');
    await writeFile(join(kbRoot, 'tenant-b', 'secret.pdf'), PDF_BYTES);
    // 符号链接指向租户 b 的文件（即使在白名单扩展名内也必须拒绝）
    await symlink(join(kbRoot, 'tenant-b', 'secret.pdf'), join(kbRoot, 'tenant-a', 'link.pdf'));
  });

  afterEach(async () => {
    if (server) {
      await stopServer(server);
      server = null;
    }
    await rm(kbRoot, { recursive: true, force: true });
  });

  it('用例14: 同租户 pdf 200 + inline + Accept-Ranges；Range → 206', async () => {
    ({ server, baseUrl } = await startServer(kbRoot, userA));

    const res = await fetch(`${baseUrl}/api/kb/file?path=${encodeURIComponent('docs/manual.pdf')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('inline');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PDF_BYTES)).toBe(true);

    // HEAD 预检：带 Content-Length 无 body
    const head = await fetch(`${baseUrl}/api/kb/file?path=${encodeURIComponent('docs/manual.pdf')}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get('content-length'))).toBe(PDF_BYTES.length);
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    // Range 分片
    const ranged = await fetch(`${baseUrl}/api/kb/file?path=${encodeURIComponent('docs/manual.pdf')}`, {
      headers: { Range: 'bytes=0-9' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-9/${PDF_BYTES.length}`);
    const slice = Buffer.from(await ranged.arrayBuffer());
    expect(slice.equals(PDF_BYTES.subarray(0, 10))).toBe(true);

    // 越界 Range → 416
    const outOfRange = await fetch(`${baseUrl}/api/kb/file?path=${encodeURIComponent('docs/manual.pdf')}`, {
      headers: { Range: `bytes=${PDF_BYTES.length + 100}-` },
    });
    expect(outOfRange.status).toBe(416);
  });

  it('F4: suffix Range（bytes=-N）→ 206 取末 N 字节；N 超文件大小时取全文件', async () => {
    ({ server, baseUrl } = await startServer(kbRoot, userA));
    const url = `${baseUrl}/api/kb/file?path=${encodeURIComponent('docs/manual.pdf')}`;

    // N > size：start clamp 到 0，等价整个文件的 206
    const bigSuffix = await fetch(url, { headers: { Range: 'bytes=-500' } });
    expect(bigSuffix.status).toBe(206);
    expect(bigSuffix.headers.get('content-range')).toBe(`bytes 0-${PDF_BYTES.length - 1}/${PDF_BYTES.length}`);
    const bigBody = Buffer.from(await bigSuffix.arrayBuffer());
    expect(bigBody.length).toBe(PDF_BYTES.length);
    expect(bigBody.equals(PDF_BYTES)).toBe(true);

    // 常规 suffix：末 10 字节
    const tail = await fetch(url, { headers: { Range: 'bytes=-10' } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get('content-range')).toBe(`bytes ${PDF_BYTES.length - 10}-${PDF_BYTES.length - 1}/${PDF_BYTES.length}`);
    expect(Buffer.from(await tail.arrayBuffer()).equals(PDF_BYTES.subarray(-10))).toBe(true);
  });

  it('F4: malformed Range（bytes=abc-def）→ 416，绝不意外回退全量 200', async () => {
    ({ server, baseUrl } = await startServer(kbRoot, userA));
    const res = await fetch(`${baseUrl}/api/kb/file?path=${encodeURIComponent('docs/manual.pdf')}`, {
      headers: { Range: 'bytes=abc-def' },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${PDF_BYTES.length}`);
  });

  it('F4: end 越界（bytes=0-999999999）→ 206 clamp 到 size-1', async () => {
    ({ server, baseUrl } = await startServer(kbRoot, userA));
    const res = await fetch(`${baseUrl}/api/kb/file?path=${encodeURIComponent('docs/manual.pdf')}`, {
      headers: { Range: 'bytes=0-999999999' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-${PDF_BYTES.length - 1}/${PDF_BYTES.length}`);
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF_BYTES)).toBe(true);
  });

  it('用例15: 路径穿越/绝对路径/符号链接/白名单外扩展名 → 403；跨租户不可达', async () => {
    ({ server, baseUrl } = await startServer(kbRoot, userA));

    // 路径穿越（../ 逃逸到租户 b）
    const traversal = await fetch(`${baseUrl}/api/kb/file?path=${encodeURIComponent('../tenant-b/secret.pdf')}`);
    expect(traversal.status).toBe(403);

    // 绝对路径
    const absolute = await fetch(`${baseUrl}/api/kb/file?path=${encodeURIComponent(join(kbRoot, 'tenant-b', 'secret.pdf'))}`);
    expect(absolute.status).toBe(403);

    // 符号链接（白名单扩展名 .pdf，但 lstat 拒绝）
    const link = await fetch(`${baseUrl}/api/kb/file?path=${encodeURIComponent('link.pdf')}`);
    expect(link.status).toBe(403);

    // 白名单外扩展名
    const exe = await fetch(`${baseUrl}/api/kb/file?path=${encodeURIComponent('evil.exe')}`);
    expect(exe.status).toBe(403);

    // 跨租户：路径参数没有任何写法能读到 tenant-b 的文件（正向相对路径也只解析到 tenant-a 根下）
    const crossTenant = await fetch(`${baseUrl}/api/kb/file?path=${encodeURIComponent('tenant-b/secret.pdf')}`);
    expect(crossTenant.status).toBe(404); // resolve 到 tenant-a/tenant-b/secret.pdf → 不存在

    // 存在性探测口径：本租户内不存在的文件 → 404
    const missing = await fetch(`${baseUrl}/api/kb/file?path=${encodeURIComponent('docs/nope.pdf')}`);
    expect(missing.status).toBe(404);
  });

  it('返回 ETag/Last-Modified/私有缓存，并正确处理两个条件请求', async () => {
    ({ server, baseUrl } = await startServer(kbRoot, userA));
    const url = `${baseUrl}/api/kb/file?path=${encodeURIComponent('docs/manual.pdf')}`;
    const initial = await fetch(url);
    const etag = initial.headers.get('etag');
    const lastModified = initial.headers.get('last-modified');
    expect(etag).toBeTruthy();
    expect(lastModified).toBeTruthy();
    expect(initial.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect((await fetch(url, { headers: { 'If-None-Match': etag! } })).status).toBe(304);
    expect((await fetch(url, { headers: { 'If-Modified-Since': lastModified! } })).status).toBe(304);
  });

  it('单页预览按 1-based 页码返回轻量 WebP；越界、缺页和旧版本均明确拒绝', async () => {
    const { version, pageBytes } = await seedPreview(kbRoot);
    ({ server, baseUrl } = await startServer(kbRoot, userA));
    const manifestUrl = `${baseUrl}/api/kb/preview-manifest?path=${encodeURIComponent('docs/manual.pdf')}`;
    const manifestRes = await fetch(manifestUrl);
    expect(manifestRes.status).toBe(200);
    expect((await manifestRes.json()).pageCount).toBe(2);

    const pageUrl = `${baseUrl}/api/kb/preview?path=${encodeURIComponent('docs/manual.pdf')}&page=1&version=${version}`;
    const pageRes = await fetch(pageUrl);
    expect(pageRes.status).toBe(200);
    expect(pageRes.headers.get('content-type')).toBe('image/webp');
    expect(pageRes.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(Buffer.from(await pageRes.arrayBuffer()).equals(pageBytes)).toBe(true);

    expect((await fetch(pageUrl.replace('page=1', 'page=0'))).status).toBe(400);
    expect((await fetch(pageUrl.replace('page=1', 'page=3'))).status).toBe(416);
    expect((await fetch(pageUrl.replace('page=1', 'page=2'))).status).toBe(404);
    expect((await fetch(pageUrl.replace(version, 'a'.repeat(64)))).status).toBe(409);
  });

  it('预览清单缺失时返回 404，不静默回退原始 PDF', async () => {
    ({ server, baseUrl } = await startServer(kbRoot, userA));
    const res = await fetch(`${baseUrl}/api/kb/preview-manifest?path=${encodeURIComponent('docs/manual.pdf')}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: '该文档预览暂未生成' });
  });

  it('admin 仍受 tenant scope 约束，不能读取其他租户原件或预览', async () => {
    const adminA: TestUser = { ...userA, role: 'admin' };
    ({ server, baseUrl } = await startServer(kbRoot, adminA));
    expect((await fetch(`${baseUrl}/api/kb/file?path=${encodeURIComponent('../tenant-b/secret.pdf')}`)).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/kb/preview-manifest?path=${encodeURIComponent('../tenant-b/secret.pdf')}`)).status).toBe(403);
  });
});
