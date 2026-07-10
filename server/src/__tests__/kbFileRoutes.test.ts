/**
 * KB 文件路由测试（/api/kb/file，计划用例 14-15）
 *
 * 14. 同租户 pdf：200 + inline + Accept-Ranges；Range 请求 → 206 分片
 * 15. 路径安全四道闸：路径穿越 / 绝对路径 / 符号链接 / 白名单外扩展名 → 403；
 *     跨租户文件不可达（tenantId 取自 JWT，非参数）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';

import { createKbFilesRouter } from '../routes/kbFiles.js';

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
});
