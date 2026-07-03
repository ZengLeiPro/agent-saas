import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import type { Server } from 'http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createRuntime } from './app/runtime.js';
import { registerRoutes } from './app/routes.js';
import { createBrowserRouter } from './routes/browser.js';
import type { AppRuntime } from './app/runtime.js';
import type { CronService } from './cron/service.js';
import { serverLogger, cronLogger } from './utils/logger.js';

type ProcessRole = 'all' | 'ws-only' | 'scheduler-only';

let runtime: AppRuntime | undefined;
let cronService: CronService | null | undefined;
let httpServer: Server | undefined;

const eventLoopDelayMonitor = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelayMonitor.enable();

function resolveProcessRole(): ProcessRole {
  const raw = (process.env.AGENT_SAAS_PROCESS_ROLE || process.env.RUNTIME_PROCESS_ROLE || 'all').trim();
  if (raw === 'all' || raw === 'ws-only' || raw === 'scheduler-only') return raw;
  throw new Error(`Invalid process role "${raw}". Expected one of: all, ws-only, scheduler-only`);
}

async function startServer(): Promise<void> {
  const processRole = resolveProcessRole();
  runtime = await createRuntime({ processCwd: process.cwd(), processRole });
  serverLogger.info(`Process role: ${processRole}`);
  if (processRole === 'scheduler-only') {
    serverLogger.info('Scheduler-only process started; HTTP/WebSocket listeners are disabled');
    return;
  }
  const { config, agentCwd, uploadsDir, channelManager, cronRuntime } = runtime;
  const { enabled: cronEnabled, cronStorePath } = cronRuntime;
  cronService = cronRuntime.service;

  const app = express();
  const corsOrigins = config.server?.corsOrigins;
  app.use(cors(corsOrigins?.length
    ? { origin: corsOrigins, exposedHeaders: ['X-Refresh-Token'] }
    : { exposedHeaders: ['X-Refresh-Token'] },
  ));
  // 全局 JSON parser，但跳过 /api/azeroth/* —— 透明反向代理路由需要原始 body stream
  // 才能 fetch 透传给 azeroth，提前解析会消费 stream 导致透传失败。
  const jsonParser = express.json();
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/azeroth/')) return next();
    jsonParser(req, res, next);
  });

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const eventLoopLagMs = Number(eventLoopDelayMonitor.mean / 1e6);
      if (durationMs >= 1500 || eventLoopLagMs >= 200) {
        serverLogger.warn(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} in ${durationMs}ms (eventLoopMean=${eventLoopLagMs.toFixed(1)}ms)`);
      }
    });
    next();
  });

  // Browser CDP API: localhost only（沙箱内 agent 通过 curl localhost 调用）
  app.use('/internal/browser', (req, res, next) => {
    const ip = req.socket.remoteAddress;
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
      next();
    } else {
      res.status(403).json({ error: 'Internal API: localhost only' });
    }
  }, createBrowserRouter({
    serverRoot: runtime.processCwd,
    workspaceRoot: agentCwd,
    userStore: runtime.userStore,
  }));

  if (runtime.authMiddleware) {
    app.use('/api', runtime.authMiddleware);
  }

  registerRoutes(app, runtime);

  // Ensure channel routes/listeners are registered before accepting traffic.
  await channelManager.startAll(app);

  // 托管前端构建产物（生产模式下 web/dist 存在时启用）
  const webDistDir = path.resolve(import.meta.dirname, '../../web/dist');
  const noCacheHeaders = 'no-cache, no-store, must-revalidate';
  if (fs.existsSync(path.join(webDistDir, 'index.html'))) {
    // 带 hash 的静态资源（JS/CSS）：长期缓存，文件名变则 URL 变
    app.use('/assets', express.static(path.join(webDistDir, 'assets'), {
      maxAge: '1y',
      immutable: true,
    }));
    // 旧 release assets fallback：SW update-on-navigation 策略下，未刷新的旧页面
    // 会继续懒加载旧 hash chunk；当前 release 的 dist 没有时，回扫历史 release 目录。
    // 部署结构 releases/<sha>/web/dist（ci.yml），本地开发无此结构时自动禁用。
    const releasesRoot = path.resolve(webDistDir, '../../..');
    if (path.basename(releasesRoot) === 'releases' && fs.existsSync(releasesRoot)) {
      const MAX_FALLBACK_RELEASES = 10;
      app.use('/assets', (req, res, next) => {
        const fileName = req.path.replace(/^\/+/, '');
        // 仅允许单层安全文件名（vite hash 产物），拒绝子路径与穿越
        if (!/^[A-Za-z0-9_.-]+$/.test(fileName) || fileName.includes('..')) return next();
        void (async () => {
          try {
            const entries = await fs.promises.readdir(releasesRoot);
            const dirs = (await Promise.all(entries.map(async (name) => {
              const dir = path.join(releasesRoot, name);
              try {
                const st = await fs.promises.stat(dir);
                return st.isDirectory() ? { dir, mtime: st.mtimeMs } : null;
              } catch { return null; }
            })))
              .filter((d): d is { dir: string; mtime: number } => d !== null)
              .sort((a, b) => b.mtime - a.mtime)
              .slice(0, MAX_FALLBACK_RELEASES);
            for (const { dir } of dirs) {
              const assetsDir = path.join(dir, 'web/dist/assets');
              if (assetsDir === path.join(webDistDir, 'assets')) continue; // 当前 release 已由上方 static 处理
              const candidate = path.join(assetsDir, fileName);
              if (fs.existsSync(candidate)) {
                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                res.sendFile(candidate);
                return;
              }
            }
            next();
          } catch {
            next();
          }
        })();
      });
    }
    // Service Worker & Workbox 文件：禁止缓存，确保浏览器总是检查更新
    app.get(/^\/(sw|workbox-.*?)\.js$/, (_req, res, next) => {
      res.setHeader('Cache-Control', noCacheHeaders);
      next();
    });
    // 其余静态文件（favicon, manifest 等）：短期缓存；HTML 禁止缓存
    app.use(express.static(webDistDir, {
      maxAge: '1h',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', noCacheHeaders);
        }
      },
    }));
    // SPA fallback：非 API 路由全部返回 index.html（禁止缓存）
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', noCacheHeaders);
      res.sendFile(path.join(webDistDir, 'index.html'));
    });
    serverLogger.info(`Serving frontend from ${webDistDir}`);
  }

  if (processRole === 'all' && cronService) {
    cronService.start().catch((err) => {
      cronLogger.error('Failed to start:', err);
    });
  } else if (processRole === 'ws-only' && cronService) {
    cronLogger.info('未启动：processRole=ws-only');
  }

  const PORT = parseInt(process.env.PORT || '', 10) || config.server.port || 3001;
  httpServer = app.listen(PORT, "0.0.0.0", () => {
    // Node.js 22 defaults requestTimeout to 300s (5 min), which kills large
    // video uploads through the nginx→WireGuard proxy chain. Set a generous
    // upper bound (2h) instead of disabling entirely, to retain Slowloris
    // protection. Per-route req.setTimeout() handles idle timeout separately.
    httpServer!.requestTimeout = 2 * 60 * 60 * 1000; // 2 hours
    httpServer!.headersTimeout = 0; // nginx handles header timeout upstream
    serverLogger.info(`Server running on http://localhost:${PORT}`);
    serverLogger.info(`Agent cwd: ${agentCwd}`);
    serverLogger.info(`Uploads dir: ${uploadsDir}`);
    serverLogger.info(`Permission mode: ${config.agent.permissionMode}`);
    serverLogger.info(`Settings source: ${config.agent.settingSources?.join(', ') || '(none)'}`);
    if (processRole === 'all' && cronEnabled) {
      cronLogger.info(`已启用 (store: ${cronStorePath})`);
    }
  });

  setInterval(() => {
    const meanMs = Number(eventLoopDelayMonitor.mean / 1e6);
    const p95Ms = Number(eventLoopDelayMonitor.percentile(95) / 1e6);
    const maxMs = Number(eventLoopDelayMonitor.max / 1e6);
    if (meanMs >= 100 || p95Ms >= 250 || maxMs >= 500) {
      serverLogger.warn(`[Perf] event loop lag mean=${meanMs.toFixed(1)}ms p95=${p95Ms.toFixed(1)}ms max=${maxMs.toFixed(1)}ms`);
    }
    eventLoopDelayMonitor.reset();
  }, 60_000).unref();

  // Attach WebSocket server to HTTP server for /ws upgrade handling
  const webChannel = channelManager.getChannel<import('./channels/web/channel.js').WebChannel>('web');
  if (webChannel) {
    webChannel.attachToServer(httpServer);
  }
  runtime.clientDaemonGateway?.attach(httpServer);
}

// SDK AbortError 判定（unhandledRejection 和 uncaughtException 共用）
function isSdkAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message === 'Operation aborted' &&
    (err.stack?.includes('ProcessTransport') ?? false)
  );
}

// MCP transport 并发连接冲突判定（SDK 0.2.x 多 dispatch 共用 in-process MCP server 实例时触发）
function isMcpTransportError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Already connected to a transport');
}

// 瞬态网络错误判定：网络波动不应终结进程
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT',
  'EAI_AGAIN', 'EPIPE', 'ERR_NETWORK', 'ECONNABORTED',
  'EHOSTUNREACH', 'ENETUNREACH', 'ESOCKETTIMEDOUT',
]);

function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  // axios 网络错误
  if (e.isAxiosError && typeof e.code === 'string' && TRANSIENT_NETWORK_CODES.has(e.code)) return true;
  // 原生 Node.js 网络错误
  if (err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string') {
    return TRANSIENT_NETWORK_CODES.has((err as NodeJS.ErrnoException).code!);
  }
  return false;
}

// SDK bug 安全网：SDK 内部 Query.handleControlRequest 的 catch 块在
// transport.write 失败时会再次调用 transport.write，而 readMessages 调用
// handleControlRequest 时没有 await/.catch()，导致 unhandled rejection。
// 此 handler 拦截 SDK 的 AbortError 防止进程崩溃，其余 rejection 仍按默认行为处理。
process.on('unhandledRejection', (reason) => {
  if (isSdkAbortError(reason)) {
    console.error('[Server] Suppressed SDK AbortError (unhandled rejection):', (reason as Error).message);
    return;
  }
  if (isTransientNetworkError(reason)) {
    serverLogger.warn('[Server] Suppressed transient network error (unhandled rejection):', (reason as Error).message);
    return;
  }
  if (isMcpTransportError(reason)) {
    serverLogger.warn('[Server] Suppressed MCP transport conflict (unhandled rejection):', (reason as Error).message);
    return;
  }
  console.error('[Server] Unhandled rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  if (isSdkAbortError(err)) {
    console.error('[Server] Suppressed SDK AbortError (uncaught exception):', err.message);
    return;
  }
  if (isTransientNetworkError(err)) {
    serverLogger.warn('[Server] Suppressed transient network error (uncaught exception):', err.message);
    return;
  }
  if (isMcpTransportError(err)) {
    serverLogger.warn('[Server] Suppressed MCP transport conflict (uncaught exception):', err.message);
    return;
  }
  console.error('[Server] Uncaught exception:', err);
  process.exit(1);
});

startServer().catch((err) => {
  console.error('[Server] Startup failed:', err);
  process.exit(1);
});

async function gracefulShutdown(signal: string): Promise<void> {
  serverLogger.info(`${signal} received, shutting down...`);
  const forceTimer = setTimeout(() => {
    serverLogger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 30_000);
  forceTimer.unref();

  try {
    httpServer?.close();
    cronService?.stop();
    await runtime?.channelManager.stopAll();
    await runtime?.memoryIndexShutdown?.();
    // MCP shutdown 必须在 pkill -TERM 之前调用，让 client.close() 走协议级
    // disconnect；pkill 是兜底，防止某些 transport 没正确收 close。
    await runtime?.mcpClientShutdown?.();
    await runtime?.auditProjectionShutdown?.();
    await runtime?.artifactShutdown?.();
    await runtime?.runtimeEventStoreShutdown?.();
  } catch (err) {
    serverLogger.error('Error during shutdown:', err);
  }

  // 清理可能残留的 SDK 孤儿子进程
  // 注意：不能用 process.kill(-process.pid) 杀进程组，那会给自身也发 SIGTERM 导致递归。
  // pkill -P 按父进程 ID 精确匹配，只杀直接子进程，不影响自身。
  try {
    const { execSync } = await import('child_process');
    execSync(`pkill -TERM -P ${process.pid} 2>/dev/null || true`, { stdio: 'ignore' });
  } catch {
    // 无子进程或 pkill 不可用，忽略
  }

  // 等待 stdout/stderr flush，避免日志丢失
  await new Promise<void>((resolve) => {
    if (process.stdout.writableEnded) { resolve(); return; }
    process.stdout.write('', () => resolve());
    setTimeout(resolve, 500); // 兜底
  });

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── SIGUSR2: Drain 模式（部署时排空活跃流后退出）──────────────────
let isDraining = false;

process.on('SIGUSR2', () => {
  if (isDraining) return;
  isDraining = true;
  serverLogger.info('SIGUSR2 received — entering drain mode');

  if (runtime) runtime.channelManager.draining = true;

  // 停止接受新 HTTP 连接
  httpServer?.close();
  // 停止调度新 cron 任务
  cronService?.stop();

  // 轮询等待活跃流清空
  const drainPoll = setInterval(() => {
    const active = runtime?.channelManager.getActiveStreamCount() ?? 0;
    serverLogger.info(`Drain: ${active} active stream(s) remaining`);
    if (active === 0) {
      clearInterval(drainPoll);
      serverLogger.info('Drain complete, exiting');
      process.exit(0);
    }
  }, 2000);
  drainPoll.unref();

  // 硬性截止：100 秒（deploy.sh DRAIN_TIMEOUT=120s 减去 20s 安全余量，
  // 确保进程在 deploy 脚本超时前自行退出）
  const drainDeadline = setTimeout(() => {
    clearInterval(drainPoll);
    const remaining = runtime?.channelManager.getActiveStreamCount() ?? 0;
    serverLogger.warn(`Drain timeout: ${remaining} stream(s) still active, forcing exit`);
    process.exit(1);
  }, 100_000);
  drainDeadline.unref();
});
