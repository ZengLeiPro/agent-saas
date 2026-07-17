import express from 'express';
import cors from 'cors';
import fs from 'fs';
import type { Server } from 'http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createRuntime } from './app/runtime.js';
import { registerRoutes } from './app/routes.js';
import { createBrowserRouter } from './routes/browser.js';
import type { AppRuntime } from './app/runtime.js';
import type { CronService } from './cron/service.js';
import { verifyAzerothTokenMetadata } from './integrations/azeroth/tokens.js';
import { startKbPreviewScheduler, type KbPreviewScheduler } from './kb/previewScheduler.js';
import { serverLogger, cronLogger } from './utils/logger.js';

type ProcessRole = 'all' | 'ws-only' | 'scheduler-only';

let runtime: AppRuntime | undefined;
let cronService: CronService | null | undefined;
let httpServer: Server | undefined;
let kbPreviewScheduler: KbPreviewScheduler | undefined;

const eventLoopDelayMonitor = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelayMonitor.enable();

function resolveProcessRole(): ProcessRole {
  const raw = (process.env.AGENT_SAAS_PROCESS_ROLE || process.env.RUNTIME_PROCESS_ROLE || 'all').trim();
  if (raw === 'all' || raw === 'ws-only' || raw === 'scheduler-only') return raw;
  throw new Error(`Invalid process role "${raw}". Expected one of: all, ws-only, scheduler-only`);
}

// 蓝绿部署（2026-07-15）：AGENT_SAAS_PIDFILE 由 systemd 每色 env 文件指定
// （如 /run/agent-saas-server-blue.pid），部署脚本据此精确投递 SIGUSR2。
function writePidFile(): void {
  const pidFile = process.env.AGENT_SAAS_PIDFILE;
  if (!pidFile) return;
  try {
    fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf-8');
  } catch (err) {
    serverLogger.warn(`Failed to write pidfile ${pidFile}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function removePidFile(): void {
  const pidFile = process.env.AGENT_SAAS_PIDFILE;
  if (!pidFile) return;
  try {
    fs.unlinkSync(pidFile);
  } catch { /* 不存在或不可删，忽略 */ }
}

async function startServer(): Promise<void> {
  const processRole = resolveProcessRole();
  // 蓝绿部署（2026-07-15）：把真实 node PID 写入 pidfile，部署脚本用
  // `kill -USR2 $(cat pidfile)` 精确送 drain 信号。不能用 systemctl kill
  // 的 cgroup 广播——SIGUSR2 对无 handler 的 SDK 子进程默认动作是终止。
  writePidFile();
  runtime = await createRuntime({ processCwd: process.cwd(), processRole });
  serverLogger.info(`Process role: ${processRole}`);
  if (processRole === 'scheduler-only') {
    serverLogger.info('Scheduler-only process started; HTTP/WebSocket listeners are disabled');
    void runtime.runDeferredStartupTasks();
    return;
  }
  const { config, agentCwd, uploadsDir, channelManager, cronRuntime } = runtime;
  const { enabled: cronEnabled, cronStorePath } = cronRuntime;
  cronService = cronRuntime.service;

  const app = express();
  // 生产在 nginx 反代后：信任第一层代理的 X-Forwarded-For，否则 req.ip 恒为
  // 代理地址，signup 等 per-IP 限流会退化成"所有用户共享一个桶"。
  // 直连部署（无代理）下无 XFF header，req.ip 仍取 socket 地址，无副作用。
  app.set('trust proxy', 1);
  const corsOrigins = config.server?.corsOrigins;
  app.use(cors(corsOrigins?.length
    ? { origin: corsOrigins, exposedHeaders: ['X-Refresh-Token'], maxAge: 600 }
    : { exposedHeaders: ['X-Refresh-Token'], maxAge: 600 },
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

  if (processRole === 'all' && cronService) {
    // 经 cron leadership 协调器启动（PG advisory lock 选主，防蓝绿并存双跑）；
    // 非 leader 实例挂起等待，旧实例 drain 释放锁后 ≤15s 接管。
    runtime.startCronCoordinator();
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
    if (process.env.AZEROTH_TOKEN_METADATA_VERIFY !== 'false') {
      void verifyAzerothTokenMetadata().catch((err) => {
        serverLogger.error('ky-azeroth PAT metadata 校验异常', err);
      });
    }
    if (processRole === 'all') kbPreviewScheduler = startKbPreviewScheduler(runtime!.processCwd);
    // 后台启动任务（skills warmup 等）：listen 之后执行，不阻塞 ready。
    // 进度经 /api/healthz/ready 的 warmup 字段暴露，部署门禁等 done 再切流。
    void runtime!.runDeferredStartupTasks();
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

// ── 关停与 drain（2026-07-15 零停机部署批次重构）───────────────────
// 两条退出路径共用 shutdownCleanup：
// - gracefulShutdown（SIGTERM/SIGINT）：≤30s 尽力清理后退出；systemd
//   TimeoutStopSec=35 兜底 SIGKILL。
// - SIGUSR2 drain（蓝绿部署旧色排空）：拒新流量 → runtime 侧按序 quiesce
//   （cron 结清 → 释放 leadership → scheduler 结清）→ 等 WS 活跃流清空 →
//   清理退出。所有 drain 出口 exit(0)：unit Restart=on-failure 不得复活已
//   排空的旧色；被打断的 in-flight run 由新实例经 lease 过期 autoWake 续跑。

let shuttingDown = false;

async function shutdownCleanup(): Promise<void> {
  try {
    httpServer?.close();
    cronService?.stop();
    runtime?.dwsAuthKeepaliveShutdown?.();
    kbPreviewScheduler?.stop();
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

  removePidFile();

  // 等待 stdout/stderr flush，避免日志丢失
  await new Promise<void>((resolve) => {
    if (process.stdout.writableEnded) { resolve(); return; }
    process.stdout.write('', () => resolve());
    setTimeout(resolve, 500); // 兜底
  });
}

async function gracefulShutdown(signal: string): Promise<void> {
  // drain 进行中收到 SIGTERM（部署脚本的 systemctl stop 兜底）：跳过继续等待，
  // 直接进入清理退出；已在收尾的重复信号忽略。
  if (shuttingDown) return;
  shuttingDown = true;
  serverLogger.info(`${signal} received, shutting down...`);
  const forceTimer = setTimeout(() => {
    serverLogger.error('Graceful shutdown timed out, forcing exit');
    // drain 中的强杀也走 0：避免 Restart=on-failure 复活已排空实例；
    // systemctl stop/restart 语义不受退出码影响
    process.exit(isDraining ? 0 : 1);
  }, 30_000);
  forceTimer.unref();
  await shutdownCleanup();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── SIGUSR2: Drain 模式（蓝绿部署旧色排空后自退）──────────────────
let isDraining = false;

process.on('SIGUSR2', () => {
  if (isDraining || shuttingDown) return;
  isDraining = true;
  serverLogger.info('SIGUSR2 received — entering drain mode');

  if (runtime) runtime.channelManager.draining = true;

  // 停止接受新 HTTP 连接（已建立的 WS/流不受影响，继续跑完）
  httpServer?.close();
  runtime?.dwsAuthKeepaliveShutdown?.();
  kbPreviewScheduler?.stop();

  // runtime 侧按序 quiesce：停 cron 触发 → 等 in-flight cron 结清 →
  // 释放 cron leadership（新实例接管）→ 停 scheduler 并等 in-flight run 结清
  let runtimeQuiesced = false;
  const runtimeDrain = runtime?.beginRuntimeDrain().catch((err) => {
    serverLogger.error('Drain: beginRuntimeDrain failed:', err);
  }) ?? Promise.resolve();
  void runtimeDrain.then(() => { runtimeQuiesced = true; });

  const finishDrain = (why: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    serverLogger.info(`Drain ${why}; cleaning up and exiting`);
    const forceTimer = setTimeout(() => process.exit(0), 30_000);
    forceTimer.unref();
    void shutdownCleanup().finally(() => process.exit(0));
  };

  // 轮询等待活跃流清空 + runtime quiesce 完成
  const drainPoll = setInterval(() => {
    const active = runtime?.channelManager.getActiveStreamCount() ?? 0;
    serverLogger.info(`Drain: ${active} active stream(s) remaining, runtimeQuiesced=${runtimeQuiesced}`);
    if (active === 0 && runtimeQuiesced) {
      clearInterval(drainPoll);
      clearTimeout(drainDeadline);
      finishDrain('complete');
    }
  }, 2000);
  drainPoll.unref();

  // 硬性截止（默认 15min，AGENT_SAAS_DRAIN_DEADLINE_MS 可调）：蓝绿模式下
  // 旧色在后台排空、不阻塞部署，可以给长 run 充足余量；到点仍未清空则
  // 放弃等待——被打断的 run 由新实例 lease 恢复续跑。
  const deadlineMs = parseInt(process.env.AGENT_SAAS_DRAIN_DEADLINE_MS || '', 10) || 900_000;
  const drainDeadline = setTimeout(() => {
    clearInterval(drainPoll);
    const remaining = runtime?.channelManager.getActiveStreamCount() ?? 0;
    serverLogger.warn(`Drain deadline after ${deadlineMs}ms: ${remaining} stream(s) still active, forcing exit (interrupted runs recover via lease on the new instance)`);
    finishDrain('deadline reached');
  }, deadlineMs);
  drainDeadline.unref();
});
