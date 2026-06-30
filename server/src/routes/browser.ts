/**
 * Browser CDP lifecycle API
 *
 * 供沙箱内的 agent 通过 curl localhost 按需启动/关闭 headless Chrome。
 * POST /internal/browser/ensure — 确保指定用户的 CDP Chrome 实例在运行
 * POST /internal/browser/stop   — 停止指定用户的 CDP Chrome 实例
 * GET  /internal/browser/health  — 简单健康检查
 */

import { Router, type Request, type Response } from 'express';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { resolve as pathResolve } from 'path';
import { execSync, spawn } from 'child_process';
import http from 'http';
import { serverLogger } from '../utils/logger.js';
import type { UserStore } from '../data/users/store.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { agentPath } from '../workspace/namespace.js';
import { ensureWorkspaceRuntimeLayout } from '../workspace/permissions.js';

export interface BrowserRouterOptions {
  serverRoot: string;
  workspaceRoot: string;
  userStore?: UserStore;
}

interface PortsConfig {
  ports: Record<string, number>;
}

let portsCache: PortsConfig | null = null;
let portsCacheMtime = 0;

function loadPorts(portsFile: string): PortsConfig | null {
  try {
    if (!existsSync(portsFile)) return null;
    const mtime = statSync(portsFile).mtimeMs;
    if (portsCache && mtime === portsCacheMtime) return portsCache;
    portsCache = JSON.parse(readFileSync(portsFile, 'utf-8'));
    portsCacheMtime = mtime;
    return portsCache;
  } catch (err) {
    serverLogger.warn(`[browser] Failed to load ports config: ${err}`);
    return null;
  }
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((done) => {
    const req = http.get(`http://localhost:${port}/json/version`, { timeout: 2000 }, (res) => {
      res.resume();
      done(res.statusCode === 200);
    });
    req.on('error', () => done(false));
    req.on('timeout', () => { req.destroy(); done(false); });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function loadJsonObject(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function configureChromeDownloadDirectory(profile: string, downloadDir: string): void {
  mkdirSync(downloadDir, { recursive: true });
  const defaultProfile = pathResolve(profile, 'Default');
  mkdirSync(defaultProfile, { recursive: true });
  const preferencesPath = pathResolve(defaultProfile, 'Preferences');
  const preferences = loadJsonObject(preferencesPath);
  const downloadPreferences = isRecord(preferences.download) ? preferences.download : {};
  preferences.download = {
    ...downloadPreferences,
    default_directory: downloadDir,
    directory_upgrade: true,
    prompt_for_download: false,
  };
  writeFileSync(preferencesPath, JSON.stringify(preferences), 'utf-8');
}

export function createBrowserRouter(opts: BrowserRouterOptions): Router {
  const router = Router();
  const portsFile = pathResolve(opts.serverRoot, 'data/browser-ports.json');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  // GET /health — 简单健康检查（验证路由注册成功）
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // POST /ensure — 启动 Chrome（如果未运行）
  router.post('/ensure', async (req: Request, res: Response) => {
    try {
      const username = req.body?.username;
      if (!username || typeof username !== 'string') {
        res.status(400).json({ error: 'username required' });
        return;
      }
      const ports = loadPorts(portsFile);
      if (!ports) {
        res.status(500).json({ error: 'Failed to load ports config' });
        return;
      }

      const port = ports.ports[username];
      if (!port) {
        res.status(404).json({ error: `no port mapping for ${username}` });
        return;
      }

      // 已在运行
      if (await checkPort(port)) {
        res.json({ ok: true, port, status: 'already_running' });
        return;
      }

      // 启动 Chrome
      const headed = req.body?.headed === true;
      const user = opts.userStore?.findByUsername(username);
      const userCwd = user
        ? resolveUserCwd(opts.workspaceRoot, { id: user.id, username: user.username, role: user.role, tenantId: user.tenantId })
        : pathResolve(opts.workspaceRoot, username);
      ensureWorkspaceRuntimeLayout(userCwd);
      const profile = agentPath(userCwd, 'runtime', 'browser-profile');
      const downloads = pathResolve(userCwd, 'downloads');
      configureChromeDownloadDirectory(profile, downloads);

      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
      ];
      if (!headed) args.unshift('--headless=new');

      const child = spawn(chrome, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      // 等待就绪（最多 10 秒）
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (await checkPort(port)) {
          serverLogger.info(`[browser] Chrome started: user=${username} port=${port}`);
          res.json({ ok: true, port, status: 'started' });
          return;
        }
      }

      serverLogger.warn(`[browser] Chrome start timeout: user=${username} port=${port}`);
      res.status(504).json({ error: 'Chrome start timeout' });
    } catch (err) {
      serverLogger.error(`[browser] ensure error: ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /stop — 停止 Chrome
  router.post('/stop', async (req: Request, res: Response) => {
    try {
      const username = req.body?.username;
      if (!username || typeof username !== 'string') {
        res.status(400).json({ error: 'username required' });
        return;
      }

      const ports = loadPorts(portsFile);
      if (!ports) {
        res.status(500).json({ error: 'Failed to load ports config' });
        return;
      }

      const port = ports.ports[username];
      if (!port) {
        res.status(404).json({ error: `no port mapping for ${username}` });
        return;
      }

      const pids = execSync(
        `ps aux | grep 'remote-debugging-port=${port}' | grep -v grep | awk '{print $2}'`,
        { encoding: 'utf-8' },
      ).trim();

      if (pids) {
        for (const pid of pids.split('\n')) {
          try { process.kill(parseInt(pid)); } catch {}
        }
        serverLogger.info(`[browser] Chrome stopped: user=${username} port=${port}`);
        res.json({ ok: true, port, status: 'stopped' });
      } else {
        res.json({ ok: true, port, status: 'not_running' });
      }
    } catch (err) {
      serverLogger.error(`[browser] stop error: ${err}`);
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
