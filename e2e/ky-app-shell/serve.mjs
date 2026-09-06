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
/**
 * 真 SDK 子端（`sdk-app.html`）单独一个 origin。
 *
 * 为什么不跟 `APP_PORT` 合用：壳是拿安装实例的 `origin` 拼 iframe 的 `src` 的，
 * 路径由 §5.2 的应用内路径决定，测试没法让壳去指定某个 HTML 文件。
 * 所以「哪个页面当子端」只能由服务器的 SPA fallback 决定 —— 一个 origin 一个 fallback。
 */
export const SDK_APP_PORT = 4192;

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

/**
 * 真 SDK 子端那一侧的「定制项目后端」桩（只挂在 `SDK_APP_PORT` 上）。
 *
 * 只有三类端点，全部按 `key` 分桶，所以用例之间不共享状态、可以任意顺序跑：
 * - `GET /ky/v1/attest?nonce=` —— §4.6，SDK 握手第一步会真的去拉。
 * - `GET /api/probe`、`POST /api/write` —— 每个 `key` 的**第一次**请求回 401，
 *   之后回 200。安全读会被 SDK 续期后重放一次从而拿到 200；写请求不该被重放，
 *   于是它在服务端只会留下一条记录。
 * - `GET /__calls?key=` —— 把该 key 收到的请求流水交出去（含 `Authorization`），
 *   测试靠它数「重放了几次」「重放用的是不是新令牌」。由 Playwright 的 `request`
 *   夹具在 node 侧取，不经浏览器，所以不需要 CORS。
 */
const buckets = new Map();

function bucket(key) {
  let found = buckets.get(key);
  if (found === undefined) {
    found = [];
    buckets.set(key, found);
  }
  return found;
}

/** 命中返回 true（已应答），未命中返回 false（交给静态服务器）。 */
function apiRoutes(req, res, url) {
  const sendJson = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/ky/v1/attest') {
    const nonce = url.searchParams.get('nonce') ?? '';
    sendJson(200, { attestation: `demo.attest.${nonce}` });
    return true;
  }

  if (url.pathname === '/__calls') {
    sendJson(200, { calls: bucket(url.searchParams.get('key') ?? '') });
    return true;
  }

  if (url.pathname === '/api/probe' || url.pathname === '/api/write') {
    const key = url.searchParams.get('key') ?? '';
    const calls = bucket(key);
    calls.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      auth: req.headers.authorization ?? null,
      at: Date.now(),
    });
    // 每个 key 的第一次一律 401，逼出「续期 → 重放」；第二次才放行。
    if (calls.length === 1) {
      sendJson(401, { error: { code: 'unauthorized', message: 'SAT 已失效' } });
      return true;
    }
    sendJson(200, { ok: true, seen: calls.length });
    return true;
  }

  return false;
}

/** 静态服务器；`fallback` 用于 SPA 深链与 mock 子端的任意应用内路径。 */
function serve(port, host, root, fallback, routes) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (routes !== undefined && routes(req, res, url)) return;
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
await serve(SDK_APP_PORT, 'localhost', distDir, 'sdk-app.html', apiRoutes);
console.log(
  `ky-app-shell E2E servers: shell=http://127.0.0.1:${SHELL_PORT} app=http://localhost:${APP_PORT} sdk=http://localhost:${SDK_APP_PORT}`,
);
