/**
 * WP4 Phase C E2E 的对端与壳站托管（Playwright `webServer` 拉起）。
 *
 * 与 `web/demo/screenshot.mjs` 同一套路，但端口错开（4190/4191），
 * 两者可以同时跑而不打架。
 *
 * **不跑 `pnpm dev`、不起后端、不碰 staging**：这里只有 `vite build` 出来的
 * 静态产物和两个 node http 服务器。
 *
 * 壳挂 `127.0.0.1`、mock 定制项目挂 `localhost` —— 同机不同 host，浏览器视为
 * **真跨源**，所以 §5.3 的 `event.origin` / `event.source` 校验与 §5.1 的
 * sandbox 都在真实条件下执行。壳站再开一个 SPA fallback，`/apps/<iid>/<path>`
 * 才能直接 F5 打开（§5.2 深链）。
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const demoDir = join(repoRoot, 'web/demo');
const distDir = join(demoDir, 'dist');

export const SHELL_PORT = 4190;
export const APP_PORT = 4191;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

function build() {
  const result = spawnSync(
    process.execPath,
    [
      join(repoRoot, 'node_modules/vite/bin/vite.js'),
      'build',
      '--config',
      join(demoDir, 'vite.config.ts'),
    ],
    { stdio: 'inherit', cwd: demoDir },
  );
  if (result.status !== 0) throw new Error('演示态构建失败，E2E 无法开跑');
}

/** 静态服务器；`fallback` 用于 SPA 深链与 mock 子端的任意应用内路径。 */
function serve(port, host, root, fallback) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    // 目录穿越兜底：测试服务器也不该能读出 dist 之外的文件
    const rel = relative(root, file);
    const escaped = rel.startsWith('..') || rel.startsWith(`..${sep}`);
    if (escaped || !existsSync(file) || url.pathname.endsWith('/')) file = join(root, fallback);
    readFile(file)
      .then((body) => {
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404).end('not found');
      });
  });
  return new Promise((resolve_) => server.listen(port, host, () => resolve_(server)));
}

build();
await serve(SHELL_PORT, '127.0.0.1', distDir, 'index.html');
await serve(APP_PORT, 'localhost', distDir, 'mock-app.html');
console.log(
  `ky-app-shell E2E servers: shell=http://127.0.0.1:${SHELL_PORT} app=http://localhost:${APP_PORT}`,
);
