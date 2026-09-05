/**
 * 托管前端生产构建产物（§5.1：HTML 入口与重定向终点都由本服务发响应头）。
 *
 * SPA 兜底：任何未命中静态文件、也不属于契约 / 业务前缀的 GET 都返回 `index.html`，
 * 保证深链（`/orders/123`）刷新后仍然带着正确的 CSP。
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

import type { MiddlewareHandler } from 'hono';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** 不走静态托管的前缀（契约端点与业务 API）。 */
const RESERVED = ['/ky/', '/ky-local/', '/api/', '/internal/'];

function safeJoin(root: string, pathname: string): string | null {
  // 一次解码 + 规范化后必须仍在 root 之内，防目录穿越。
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const target = normalize(join(root, decoded));
  return target === root || target.startsWith(root + sep) ? target : null;
}

export function serveWebDist(rootDir: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const pathname = new URL(c.req.url).pathname;
    if (RESERVED.some((prefix) => pathname.startsWith(prefix))) return next();

    const direct = pathname === '/' ? null : safeJoin(rootDir, pathname);
    if (direct !== null) {
      const info = await stat(direct).catch(() => null);
      if (info !== null && info.isFile()) {
        const type = CONTENT_TYPES[extname(direct)] ?? 'application/octet-stream';
        return c.body(await readFile(direct), 200, { 'content-type': type });
      }
    }

    const index = join(rootDir, 'index.html');
    const info = await stat(index).catch(() => null);
    if (info === null) {
      return c.text('前端产物尚未构建，请先执行 pnpm build', 503);
    }
    return c.body(await readFile(index), 200, { 'content-type': CONTENT_TYPES['.html'] });
  };
}
