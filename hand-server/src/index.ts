import { createServer } from 'node:http';

import { loadConfigFromEnv } from './config.js';
import {
  backendToTarget,
  createProvider,
  buildHealthResponse,
  buildToolsResponse,
  handleCancelInvocation,
  handleGetInvocationResult,
  handleExecute,
  handleExecuteStream,
  handleProvision,
  handleWorkspaceLifecycle,
  type HandlerDeps,
  type Logger,
} from './handlers.js';
import { FileHandInvocationStore, type HandInvocationStore } from './invocationStore.js';
import { WorkspaceResolver } from './workspaceResolver.js';

const config = loadConfigFromEnv();
const workspaceResolver = new WorkspaceResolver(config.sandboxRoot, config.workspace);
const provider = createProvider(config);
const internalExecutionTarget = backendToTarget(config.backend);

const logger: Logger = {
  info: (msg) => console.log(`[hand-server] ${msg}`),
  warn: (msg) => console.warn(`[hand-server] ${msg}`),
  error: (msg) => console.error(`[hand-server] ${msg}`),
};

/**
 * Durable Tool Invocation（TASK-316）：invocation journal 初始化。
 * - 启动对账：上一进程遗留的 running 记录转成 interrupted/indeterminate 终态，
 *   Hand 重启后 Brain 仍能对账结果，而不是拿到 404。
 * - 显式配置目录（HAND_INVOCATION_STORE_DIR）init 失败时拒绝启动；
 *   默认目录失败则大声记 error 并退化内存模式（保持既有可用性，health 可见）。
 */
async function initInvocationStore(): Promise<HandInvocationStore | undefined> {
  if (config.invocationStore.mode === 'memory') {
    logger.info('invocation journal disabled (HAND_INVOCATION_STORE_DIR=memory)');
    return undefined;
  }
  const store = new FileHandInvocationStore(config.invocationStore.dir, {
    retentionMs: config.invocationStore.retentionMs,
  });
  try {
    await store.ensureDir();
    const reconciled = await store.reconcileStartup();
    const swept = await store.sweep();
    logger.info(
      `invocation journal ready dir=${config.invocationStore.dir} retentionMs=${config.invocationStore.retentionMs}` +
        ` loaded=${reconciled.loaded} interrupted=${reconciled.interrupted} swept=${swept.deleted}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (config.invocationStore.explicit) {
      throw new Error(`HAND_INVOCATION_STORE_DIR 初始化失败，拒绝启动: ${message}`);
    }
    logger.error(
      `invocation journal init failed; falling back to memory-only invocations: ${message}`,
    );
    return undefined;
  }
  const sweepIntervalMs = Math.min(config.invocationStore.retentionMs, 30 * 60_000);
  const sweepTimer = setInterval(() => {
    void store.sweep().catch((sweepErr) => {
      logger.error(
        `invocation journal sweep failed: ${sweepErr instanceof Error ? sweepErr.message : String(sweepErr)}`,
      );
    });
  }, sweepIntervalMs);
  sweepTimer.unref?.();
  return store;
}

const invocationStore = await initInvocationStore();
const activeInvocations = new Set<string>();

const handlerDeps: HandlerDeps = {
  config,
  invocations: new Map<string, AbortController>(),
  invocationResults: new Map(),
  ...(invocationStore ? { invocationStore } : {}),
  activeInvocations,
  workspaceResolver,
  provider,
  internalExecutionTarget,
  logger,
};

const server = createServer((req, res) => {
  // GET /health：无鉴权（让 brain 探活不需要带 token）
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(buildHealthResponse(handlerDeps)));
    return;
  }

  // GET /tools：工具发现，同样无鉴权；只返回 schema-free descriptor，避免 zod schema 序列化。
  if (req.method === 'GET' && req.url === '/tools') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(buildToolsResponse(handlerDeps)));
    return;
  }

  // POST /provision：幂等准备 workspace（供 brain/registry 重建 hand 时调用）
  if (req.url === '/provision') {
    void handleProvision(req, res, handlerDeps);
    return;
  }

  // POST /execute-stream：SSE streaming 入口
  if (req.url === '/execute-stream') {
    void handleExecuteStream(req, res, handlerDeps);
    return;
  }

  const invocationMatch = req.url?.match(/^\/invocations\/([^/?#]+)$/);
  if (invocationMatch) {
    const invocationId = decodeURIComponent(invocationMatch[1]!);
    if (req.method === 'GET') {
      void handleGetInvocationResult(req, res, handlerDeps, invocationId);
    } else {
      void handleCancelInvocation(req, res, handlerDeps, invocationId);
    }
    return;
  }

  const workspaceLifecycleMatch = req.url?.match(/^\/workspaces\/([^/?#]+)\/(archive|reset)$/);
  if (workspaceLifecycleMatch) {
    void handleWorkspaceLifecycle(
      req,
      res,
      handlerDeps,
      decodeURIComponent(workspaceLifecycleMatch[1]!),
      workspaceLifecycleMatch[2] as 'archive' | 'reset',
    );
    return;
  }

  // POST /execute：主入口
  if (req.url === '/execute') {
    void handleExecute(req, res, handlerDeps);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'error', error: 'not found' }));
});

// 默认仅监听 127.0.0.1；Docker bridge / 组织 ECS hand 可用 HAND_SERVER_HOST=0.0.0.0
// 对容器内网开放。公网部署仍应由前置 proxy 处理 TLS + 来源 ACL。
server.listen(config.port, config.host, () => {
  logger.info(`listening on ${config.host}:${config.port}`);
  logger.info(`sandbox root: ${config.sandboxRoot}`);
  logger.info(`backend: ${config.backend} (internal executionTarget=${internalExecutionTarget})`);
  logger.info(
    `invocations: ${invocationStore ? 'durable journal' : 'memory-only'}; drain timeout: ${config.drainTimeoutMs}ms`,
  );
});

/**
 * SIGTERM/SIGINT drain（TASK-316）：不再 5 秒强退。
 * - 停止接新流量；draining 期间新 invocation 返回 503（brain 侧按连接类失败安全退避重试）。
 * - 等待在途 invocation 完整收尾（activeInvocations 从请求被接受一直跟踪到
 *   结果落盘 + 响应写出），最长 HAND_DRAIN_TIMEOUT_MS。
 * - 退出条件统一由 drain poll 决定：server.close 完成（所有连接收尾，含
 *   provision 等非 invocation 端点）且 activeInvocations 清空才 exit(0)；
 *   close 回调本身不再直接退出，避免绕过在途状态。
 * - 超时仍有在途 invocation 时以非零码退出，把"副作用可能未收尾"暴露给 systemd 日志。
 */
let shutdownStarted = false;
const shutdown = (sig: NodeJS.Signals) => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  handlerDeps.draining = true;
  logger.info(
    `received ${sig}, draining (in-flight invocations=${activeInvocations.size}, timeout=${config.drainTimeoutMs}ms)`,
  );
  let serverClosed = false;
  server.close(() => {
    serverClosed = true;
    logger.info('server closed; all connections finished');
  });
  const drainPoll = setInterval(() => {
    if (serverClosed && activeInvocations.size === 0) {
      clearInterval(drainPoll);
      logger.info('drain complete; exiting');
      process.exit(0);
    }
  }, 100);
  drainPoll.unref?.();
  setTimeout(() => {
    logger.warn(
      `drain timeout after ${config.drainTimeoutMs}ms with ${activeInvocations.size} invocations still in flight; exiting`,
    );
    process.exit(1);
  }, config.drainTimeoutMs).unref?.();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
