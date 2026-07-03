import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyRuntimeConfigPatch,
  loadConfigFromEnv,
  parseRuntimeConfigPatch,
  runtimeConfigSnapshot,
} from './config.js';
import { AcsExecutor } from './executor.js';
import { Kubectl } from './kubectl.js';
import {
  MAX_BODY_BYTES,
  buildToolsResponse,
  parseProvisionRecipe,
  parseWireRequest,
} from './protocol.js';
import { Provisioner } from './provision.js';
import { SandboxManager } from './sandboxManager.js';
import { ActiveSandboxRegistry } from './activeSandboxRegistry.js';

const config = loadConfigFromEnv();

const logger = {
  info: (msg: string) => console.log(`[acs-orchestrator] ${msg}`),
  warn: (msg: string) => console.warn(`[acs-orchestrator] ${msg}`),
  error: (msg: string) => console.error(`[acs-orchestrator] ${msg}`),
};

const kubectl = new Kubectl(config);
const activeRegistry = new ActiveSandboxRegistry();
const sandboxManager = new SandboxManager(config, kubectl, logger, activeRegistry);
const executor = new AcsExecutor(config, kubectl, sandboxManager, logger, activeRegistry);
const provisioner = new Provisioner(config, kubectl, sandboxManager, () => executor.busySandboxNames(), activeRegistry);
let lifecycleTimer: ReturnType<typeof setInterval> | null = null;
const lastAlertAtByEvent = new Map<string, number>();

// ─── Graceful drain (SIGUSR2) ────────────────────────────────────
// 用于零停机 deploy: `kill -USR2` -> 停接新的长运行请求 (/provision, /execute,
// /execute-stream, /invocations/*) -> 等 inflight=0 -> exit(0)。/health 期间
// 报告 draining + inflight 供 CI 脚本轮询。SIGTERM 沿用原短路径 (5s 硬退)。
let inflightRequests = 0;
let draining = false;
const DRAIN_DEADLINE_MS = 120_000; // 与 CI 脚本超时对齐,给它留 20s buffer

async function withInflight<T>(fn: () => Promise<T>): Promise<T> {
  inflightRequests++;
  try {
    return await fn();
  } finally {
    inflightRequests--;
  }
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    void handleHealth(res);
    return;
  }

  if (req.method === 'GET' && req.url === '/tools') {
    return sendJson(res, 200, buildToolsResponse());
  }

  if (req.url === '/runtime-config') {
    void handleRuntimeConfig(req, res);
    return;
  }

  if (req.url === '/lifecycle/cleanup') {
    void handleLifecycleCleanup(req, res);
    return;
  }

  if (req.url === '/network-policy/probe') {
    void handleNetworkPolicyProbe(req, res);
    return;
  }

  if (req.url === '/snat') {
    void handleSnatStatus(req, res);
    return;
  }

  if (req.url === '/snat/cleanup-orphans') {
    void handleSnatCleanup(req, res);
    return;
  }

  // Drain 期间对新的长运行请求返回 503; 已在跑的请求正常继续
  if (draining && (req.url === '/provision' || req.url === '/execute' || req.url === '/execute-stream')) {
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
    res.end(JSON.stringify({ status: 'error', error: 'orchestrator draining, retry shortly' }));
    return;
  }

  if (req.url === '/provision') {
    void withInflight(() => handleProvision(req, res));
    return;
  }

  if (req.url === '/execute') {
    void withInflight(() => handleExecute(req, res));
    return;
  }

  if (req.url === '/execute-stream') {
    void withInflight(() => handleExecuteStream(req, res));
    return;
  }

  const cancelMatch = req.url?.match(/^\/invocations\/([^/?#]+)$/);
  if (cancelMatch) {
    // cancel 请求即使 drain 也放行(它本身是清理动作,加速 inflight 下降)
    void handleCancel(req, res, decodeURIComponent(cancelMatch[1]!));
    return;
  }

  const workspaceLifecycleMatch = req.url?.match(/^\/workspaces\/([^/?#]+)\/(archive|reset)$/);
  if (workspaceLifecycleMatch) {
    void handleWorkspaceLifecycle(
      req,
      res,
      decodeURIComponent(workspaceLifecycleMatch[1]!),
      workspaceLifecycleMatch[2] as 'archive' | 'reset',
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'error', error: 'not found' }));
});

async function handleHealth(res: ServerResponse): Promise<void> {
  const checks: Record<string, unknown> = {};
  let ok = true;
  const crd = await kubectl.run(['get', 'crd', config.sandboxCrdName, '-o', 'name'], { timeoutMs: 5_000 });
  checks.crd = crd.exitCode === 0 ? 'ok' : 'error';
  if (crd.exitCode !== 0) ok = false;
  const trafficPolicyCrd = await kubectl.run(['get', 'crd', config.trafficPolicyCrdName, '-o', 'name'], { timeoutMs: 5_000 });
  checks.trafficPolicyCrd = trafficPolicyCrd.exitCode === 0 ? 'ok' : 'error';
  if (trafficPolicyCrd.exitCode !== 0) ok = false;
  const trafficPolicyAccess = await kubectl.run([
    'auth',
    'can-i',
    'create',
    config.trafficPolicyCrdName,
  ], { timeoutMs: 5_000 });
  checks.trafficPolicyRbac = trafficPolicyAccess.stdout.trim() === 'yes' ? 'ok' : 'error';
  if (trafficPolicyAccess.stdout.trim() !== 'yes') ok = false;
  const ns = await kubectl.run(['get', 'namespace', config.namespace, '-o', 'name'], { timeoutMs: 5_000 });
  checks.namespace = ns.exitCode === 0 ? 'ok' : 'error';
  if (ns.exitCode !== 0) ok = false;
  let sandboxes: unknown;
  let snat: unknown;
  try {
    sandboxes = await sandboxManager.inventorySummary();
    snat = await sandboxManager.snatStatus();
  } catch (err) {
    ok = false;
    checks.sandboxes = err instanceof Error ? err.message : String(err);
  }
  return sendJson(res, ok ? 200 : 503, {
    status: ok ? 'ok' : 'unhealthy',
    // drain 期间 CI 脚本轮询 inflight,为 0 时才 SIGTERM
    draining,
    inflight: inflightRequests,
    backend: 'acs-agent-sandbox',
    namespace: config.namespace,
    sandboxKind: config.sandboxKind,
    image: config.sandboxImage,
    checks,
    workspace: {
      mountPath: config.workspaceMountPath,
      pvc: config.pvcName ?? null,
      hostWorkspaceRootConfigured: Boolean(config.hostWorkspaceRoot),
    },
    contextSemantics: {
      workspacePersistence: config.pvcName ? 'nas-pvc' : config.hostWorkspaceRoot ? 'host-workspace' : 'ephemeral',
      memoryInjection: 'session-start',
      memoryHotReload: false,
      folderAutoContext: false,
      note: 'Workspace files are persistent and tool-accessible; they are not automatically loaded into model context.',
    },
    lifecycle: {
      enabled: config.lifecycleEnabled,
      cleanupIntervalMs: config.sandboxCleanupIntervalMs,
      idlePauseMs: config.sandboxIdlePauseMs,
      ttlMs: config.sandboxTtlMs,
      orphanGraceMs: config.sandboxOrphanGraceMs,
      maxRunningSandboxes: config.maxRunningSandboxes,
      warnRunningSandboxes: config.warnRunningSandboxes,
      alertWebhookConfigured: Boolean(config.alertWebhookUrl),
    },
    runtimeConfig: runtimeConfigSnapshot(config),
    runtimeContract: runtimeContractSnapshot(),
    capabilities: {
      browser: {
        available: config.capabilities.browser,
        reason: config.capabilities.browser
          ? 'Chromium/Playwright browser automation is available in the production Agent hand'
          : 'browser automation is disabled for this runtime',
      },
      media: {
        available: config.capabilities.media,
        reason: config.capabilities.media
          ? 'ffmpeg/ffprobe media processing is available in the production Agent hand'
          : 'media processing is disabled for this runtime',
      },
      officeDocuments: {
        available: config.capabilities.officeDocuments,
        reason: config.capabilities.officeDocuments
          ? 'LibreOffice/Poppler/QPDF/Tesseract document tools are available in the production Agent hand'
          : 'office document packages disabled for this runtime',
      },
      pythonBasePackages: {
        available: config.capabilities.pythonBasePackages,
        reason: config.capabilities.pythonBasePackages
          ? 'workspace runtime venv installs acs-orchestrator/requirements/base.txt'
          : 'base Python package installation disabled for this runtime',
      },
    },
    networkPolicy: sandboxManager.networkPolicyStatus(),
    snat,
    sandboxes,
    tools: buildToolsResponse().tools,
  });
}

function runtimeContractSnapshot(): Record<string, unknown> {
  const requirementsPath = process.env.ACS_BASE_REQUIREMENTS_PATH?.trim()
    || join(dirname(fileURLToPath(import.meta.url)), '..', 'requirements', 'base.txt');
  const wheelhousePath = process.env.ACS_PYTHON_WHEELHOUSE?.trim() || '/opt/ky-agent/python-wheels';
  return {
    python: {
      venvPath: `${config.workspaceMountPath}/.ky-agent/runtime/venv`,
      pipCacheDir: `${config.workspaceMountPath}/.ky-agent/runtime/cache/pip`,
      manifestPath: `${config.workspaceMountPath}/.ky-agent/runtime/venv/.ky-runtime.json`,
      archivePath: `${config.workspaceMountPath}/.ky-agent/runtime/venv-archive`,
      maxArchives: readPositiveIntegerEnv('ACS_MAX_VENV_ARCHIVES', 2),
      includeSystemSitePackages: false,
      baseRequirementsPath: requirementsPath,
      baseRequirementsHash: hashFileIfExists(requirementsPath),
      wheelhousePath,
      wheelhouseScope: 'sandbox-image',
      packageInstallMode: 'prefer-local-wheelhouse',
      rebuildTriggers: [
        'missing-or-invalid-manifest',
        'python-major-minor-changed',
        'base-requirements-hash-changed',
        'sandbox-image-ref-changed',
        'non-isolated-venv',
      ],
    },
    npm: {
      globalPrefix: '/home/agent/.npm-global',
    },
    downloads: {
      directory: `${config.workspaceMountPath}/downloads`,
    },
  };
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function hashFileIfExists(path: string): string {
  if (!existsSync(path)) return 'missing';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function handleRuntimeConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  if (req.method === 'GET') {
    return sendJson(res, 200, { status: 'ok', runtimeConfig: runtimeConfigSnapshot(config) });
  }
  if (req.method !== 'PATCH') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use GET or PATCH' });
  const body = await readJson(req, res);
  if (!body.ok) return;
  try {
    const patch = parseRuntimeConfigPatch(body.value);
    const runtimeConfig = applyRuntimeConfigPatch(config, patch);
    logger.warn(
      `runtime_config_updated maxRunningSandboxes=${runtimeConfig.maxRunningSandboxes} `
      + `warnRunningSandboxes=${runtimeConfig.warnRunningSandboxes} persisted=${runtimeConfig.persisted}`,
    );
    return sendJson(res, 200, { status: 'ok', runtimeConfig });
  } catch (err) {
    return sendJson(res, 400, { status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleLifecycleCleanup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
  if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  try {
    const report = await sandboxManager.cleanupSandboxes({ busySandboxNames: activeBusySandboxNames() });
    logger.warn(
      `sandbox_lifecycle_manual_cleanup checked=${report.checked} paused=${report.paused.length} `
      + `deleted=${report.deleted.length} skippedBusy=${report.skippedBusy.length}`,
    );
    return sendJson(res, 200, { status: 'ok', report });
  } catch (err) {
    return sendJson(res, 500, { status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleNetworkPolicyProbe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
  if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  try {
    const result = await sandboxManager.probeNetworkPolicy();
    logger.warn(
      `network_policy_probe enforcement=${result.effectivePolicy.enforcement} `
      + `public=${result.effectivePolicy.publicEgressReachable} `
      + `privateBlocked=${result.effectivePolicy.privateEgressBlocked} `
      + `metadataBlocked=${result.effectivePolicy.metadataBlocked}`,
    );
    return sendJson(res, 200, { status: 'ok', networkPolicy: result });
  } catch (err) {
    return sendJson(res, 500, { status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleSnatStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use GET' });
  if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  try {
    const snat = await sandboxManager.snatStatus();
    return sendJson(res, 200, { status: 'ok', snat });
  } catch (err) {
    return sendJson(res, 500, { status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleSnatCleanup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
  if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  try {
    const report = await sandboxManager.cleanupOrphanSnat();
    logger.warn(
      `snat_manual_cleanup checked=${report.checked} deleted=${report.deleted.length} `
      + `unexpected=${report.unexpected.length}`,
    );
    return sendJson(res, 200, { status: 'ok', report });
  } catch (err) {
    return sendJson(res, 500, { status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleProvision(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
  if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  const body = await readJson(req, res);
  if (!body.ok) return;
  const parsed = parseProvisionRecipe(body.value);
  if (!parsed.ok) return sendJson(res, 400, { status: 'error', error: parsed.error });
  try {
    const result = await provisioner.provision(parsed.value);
    return sendJson(res, 200, {
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
      workspaceId: parsed.value.workspaceId,
      sessionId: parsed.value.sessionId,
      backend: 'acs-agent-sandbox',
      internalExecutionTarget: 'server-local',
      metadata: result.metadata,
      logs: result.logs,
    });
  } catch (err) {
    return sendJson(res, 500, { status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleExecute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
  if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  const body = await readJson(req, res);
  if (!body.ok) return;
  const parsed = parseWireRequest(body.value);
  if (!parsed.ok) return sendJson(res, 400, { status: 'error', error: parsed.error });
  try {
    const response = await executor.execute(parsed.value);
    return sendJson(res, 200, response);
  } catch (err) {
    return sendJson(res, 500, { status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleExecuteStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
  if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  const body = await readJson(req, res);
  if (!body.ok) return;
  const parsed = parseWireRequest(body.value);
  if (!parsed.ok) return sendJson(res, 400, { status: 'error', error: parsed.error });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  let sawCompleted = false;
  const writeChunk = (chunk: unknown) => {
    if (chunk && typeof chunk === 'object' && (chunk as { type?: unknown }).type === 'completed') sawCompleted = true;
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };
  try {
    for await (const chunk of executor.executeStream(parsed.value, { stream: true })) {
      writeChunk(chunk);
      if (sawCompleted) break;
    }
  } catch (err) {
    writeChunk({ type: 'completed', response: { status: 'error', error: err instanceof Error ? err.message : String(err) } });
  } finally {
    if (!sawCompleted) writeChunk({ type: 'completed', response: { status: 'error', error: 'ACS stream ended without completed chunk' } });
    res.end();
  }
}

async function handleCancel(req: IncomingMessage, res: ServerResponse, invocationId: string): Promise<void> {
  if (req.method !== 'DELETE') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use DELETE' });
  if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  const cancelled = executor.cancel(invocationId);
  return sendJson(res, 200, {
    status: 'ok',
    invocationId,
    cancelled,
    ...(cancelled ? {} : { alreadyFinishedOrUnknown: true }),
  });
}

async function handleWorkspaceLifecycle(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
  action: 'archive' | 'reset',
): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
  if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  let reason: string = action;
  try {
    const raw = await readBody(req, MAX_BODY_BYTES);
    if (raw.trim()) {
      const body = JSON.parse(raw) as { reason?: unknown };
      if (typeof body.reason === 'string' && body.reason.trim()) reason = body.reason.trim();
    }
  } catch (err) {
    return sendJson(res, 400, { status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
  try {
    const deleted = await sandboxManager.deleteByWorkspaceId(workspaceId, { busySandboxNames: activeBusySandboxNames() });
    if (deleted.skippedBusy.length) {
      return sendJson(res, 409, {
        status: 'error',
        error: 'workspace has active sandbox invocations; retry after they finish',
        workspaceId,
        skippedBusySandboxes: deleted.skippedBusy,
        deletedSandboxes: deleted.names,
      });
    }
    const archived = await sandboxManager.archiveWorkspace(workspaceId, `${action}-${reason}`);
    return sendJson(res, 200, {
      status: 'ok',
      action,
      workspaceId: archived.workspaceId,
      archived: archived.archived,
      missing: archived.missing === true,
      deletedSandboxes: deleted.names,
      skippedBusySandboxes: deleted.skippedBusy,
      ...(archived.archiveId ? { archiveId: archived.archiveId } : {}),
      note: archived.archived
        ? 'workspace archived; no files were deleted'
        : 'workspace archive skipped because ACS_HOST_WORKSPACE_ROOT is not configured or workspace is missing',
    });
  } catch (err) {
    return sendJson(res, 400, { status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

function activeBusySandboxNames(): Set<string> {
  return new Set([...executor.busySandboxNames(), ...activeRegistry.busyNames()]);
}

function authorize(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return !!match && match[1] === config.authToken;
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const raw = await readBody(req, MAX_BODY_BYTES);
    return { ok: true, value: raw.trim() ? JSON.parse(raw) : {} };
  } catch (err) {
    sendJson(res, 400, { status: 'error', error: err instanceof Error ? err.message : String(err) });
    return { ok: false };
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) throw new Error(`body 超过 ${maxBytes} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

server.listen(config.port, config.host, () => {
  logger.info(`listening on ${config.host}:${config.port}`);
  logger.info(`namespace=${config.namespace} image=${config.sandboxImage}`);
  startLifecycleLoop();
});

const shutdown = (sig: NodeJS.Signals) => {
  logger.info(`received ${sig}, shutting down`);
  if (lifecycleTimer) clearInterval(lifecycleTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// SIGUSR2: 优雅 drain。deploy 时 CI 先 `kill -USR2` -> 轮询 /health.inflight=0
// -> `systemctl restart` (SIGTERM)。已在跑的 /execute-stream SSE 不会被打断。
process.on('SIGUSR2', () => {
  if (draining) return;
  draining = true;
  logger.info(`SIGUSR2 received — entering drain mode (inflight=${inflightRequests})`);
  if (lifecycleTimer) clearInterval(lifecycleTimer);
  // 停接新连接; 已建立连接 keep-alive 上的新请求会拿到 draining=true 状态或
  // 长运行路径的 503。已在跑的 handler 通过 withInflight 计数,进度不受影响。
  server.close(() => {
    logger.info('server.close callback fired (all connections closed)');
  });
  const startedAt = Date.now();
  const poll = setInterval(() => {
    if (inflightRequests === 0) {
      clearInterval(poll);
      logger.info('drain complete, exiting cleanly');
      process.exit(0);
    }
    if (Date.now() - startedAt >= DRAIN_DEADLINE_MS) {
      clearInterval(poll);
      logger.warn(`drain deadline reached (${DRAIN_DEADLINE_MS}ms), forcing exit (inflight=${inflightRequests})`);
      process.exit(1);
    }
    logger.info(`draining... inflight=${inflightRequests}`);
  }, 2_000);
  poll.unref();
});

function startLifecycleLoop(): void {
  if (!config.lifecycleEnabled) {
    logger.info('sandbox lifecycle loop disabled');
    return;
  }
  void runLifecycleOnce('startup');
  lifecycleTimer = setInterval(() => {
    void runLifecycleOnce('interval');
  }, config.sandboxCleanupIntervalMs);
  lifecycleTimer.unref?.();
  logger.info(`sandbox lifecycle loop enabled intervalMs=${config.sandboxCleanupIntervalMs}`);
}

async function runLifecycleOnce(reason: string): Promise<void> {
  try {
    const report = await sandboxManager.cleanupSandboxes({ busySandboxNames: executor.busySandboxNames() });
    if (report.paused.length || report.deleted.length || report.skippedBusy.length) {
      logger.warn(
        `sandbox_lifecycle_actions reason=${reason} checked=${report.checked} paused=${report.paused.length} `
        + `deleted=${report.deleted.length} skippedBusy=${report.skippedBusy.length} snatDeleted=${report.snatDeleted.length}`,
      );
      await emitAlert({
        event: 'sandbox_lifecycle_actions',
        severity: report.deleted.length ? 'warning' : 'info',
        message: 'ACS Sandbox lifecycle guard took action',
        metadata: report,
      });
    }
    if (report.snatDeleted.length || report.snatUnexpected > 0) {
      await emitAlert({
        event: report.snatUnexpected > 0 ? 'snat_unexpected_entries' : 'snat_orphan_cleanup',
        severity: report.snatUnexpected > 0 ? 'warning' : 'info',
        message: report.snatUnexpected > 0
          ? `ACS SNAT table has ${report.snatUnexpected} unexpected entry${report.snatUnexpected === 1 ? '' : 'ies'}`
          : `ACS SNAT orphan cleanup deleted ${report.snatDeleted.length} entr${report.snatDeleted.length === 1 ? 'y' : 'ies'}`,
        metadata: {
          snatDeleted: report.snatDeleted,
          snatUnexpected: report.snatUnexpected,
        },
      });
    }
    if (config.warnRunningSandboxes > 0 && report.runningCount >= config.warnRunningSandboxes) {
      await emitAlert({
        event: 'sandbox_running_near_quota',
        severity: report.runningCount >= config.maxRunningSandboxes && config.maxRunningSandboxes > 0 ? 'error' : 'warning',
        message: `ACS Sandbox running count is ${report.runningCount}`,
        metadata: {
          runningCount: report.runningCount,
          totalCount: report.totalCount,
          maxRunningSandboxes: config.maxRunningSandboxes,
          warnRunningSandboxes: config.warnRunningSandboxes,
        },
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`sandbox_lifecycle_failed reason=${reason}: ${message}`);
    await emitAlert({
      event: 'sandbox_lifecycle_failed',
      severity: 'error',
      message,
      metadata: { reason },
    });
  }
}

async function emitAlert(input: {
  event: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  metadata?: unknown;
}): Promise<void> {
  const log = input.severity === 'error' ? logger.error : input.severity === 'warning' ? logger.warn : logger.info;
  log(`alert event=${input.event} severity=${input.severity} message=${input.message}`);
  if (!config.alertWebhookUrl) return;
  const now = Date.now();
  const lastAt = lastAlertAtByEvent.get(input.event) ?? 0;
  if (config.alertMinIntervalMs > 0 && now - lastAt < config.alertMinIntervalMs) return;
  lastAlertAtByEvent.set(input.event, now);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  timer.unref?.();
  try {
    const response = await fetch(config.alertWebhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.alertWebhookBearerToken ? { authorization: `Bearer ${config.alertWebhookBearerToken}` } : {}),
      },
      body: JSON.stringify({
        source: 'agent-saas-acs-orchestrator',
        namespace: config.namespace,
        event: input.event,
        severity: input.severity,
        message: input.message,
        metadata: input.metadata ?? {},
        occurredAt: new Date().toISOString(),
      }),
      signal: controller.signal,
    });
    if (!response.ok) logger.warn(`alert webhook HTTP ${response.status}`);
  } catch (err) {
    logger.warn(`alert webhook failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}
