import { createServer } from 'node:http';

import { loadConfigFromEnv } from './config.js';
import {
  backendToTarget,
  createProvider,
  buildHealthResponse,
  buildToolsResponse,
  handleCancelInvocation,
  handleExecute,
  handleExecuteStream,
  handleProvision,
  handleWorkspaceLifecycle,
  type Logger,
} from './handlers.js';
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

const handlerDeps = {
  config,
  invocations: new Map<string, AbortController>(),
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

  const cancelMatch = req.url?.match(/^\/invocations\/([^/?#]+)$/);
  if (cancelMatch) {
    void handleCancelInvocation(req, res, handlerDeps, decodeURIComponent(cancelMatch[1]!));
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
});

const shutdown = (sig: NodeJS.Signals) => {
  logger.info(`received ${sig}, shutting down`);
  server.close(() => process.exit(0));
  // 兜底：5 秒强退
  setTimeout(() => process.exit(1), 5_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
