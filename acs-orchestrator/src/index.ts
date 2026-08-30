import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyRuntimeConfigPatch,
  loadConfigFromEnv,
  parseRuntimeConfigPatch,
  releaseIdentityHealth,
  runtimeConfigSnapshot,
} from './config.js';
import { AcsExecutor } from './executor.js';
import { Kubectl } from './kubectl.js';
import { KubeApi } from './kubeApi.js';
import {
  MAX_BODY_BYTES,
  buildToolsResponse,
  parseProvisionRecipe,
  parseWarmupRequest,
  parseWireRequest,
} from './protocol.js';
import { Provisioner, sandboxResourceOverride } from './provision.js';
import {
  SandboxCapacityError,
  SandboxManager,
  brokenSandboxStateReason,
} from './sandboxManager.js';
import { ActiveSandboxRegistry } from './activeSandboxRegistry.js';
import { SnatSharedCidrCoverageError } from './snatManager.js';
import { SnatOperations } from './snatOperations.js';
import {
  allowsExecutionMaintenanceBypass,
  decodeSandboxName,
  matchSandboxRoute,
  sendCapacityError,
  sendExecutionMaintenance,
  sendSandboxError,
  type SandboxRoute,
} from './sandboxHttp.js';
import { AlertDispatcher, type AcsAlert } from './alerts.js';
import { SandboxLifecycleController } from './lifecycleController.js';
import { handleSandboxLifecycleRoute, matchSandboxLifecycleRoute } from './sandboxLifecycleRoutes.js';
const config = loadConfigFromEnv();

const logger = {
  info: (msg: string) => console.log(`[acs-orchestrator] ${msg}`),
  warn: (msg: string) => console.warn(`[acs-orchestrator] ${msg}`),
  error: (msg: string) => console.error(`[acs-orchestrator] ${msg}`),
};

const kubectl = new Kubectl(config);
const kubeApi = KubeApi.tryCreate(config, logger);
const activeRegistry = new ActiveSandboxRegistry();
const sandboxManager = new SandboxManager(config, kubectl, logger, activeRegistry, kubeApi);
const executor = new AcsExecutor(config, kubectl, sandboxManager, logger, activeRegistry);
const provisioner = new Provisioner(
  config,
  kubectl,
  sandboxManager,
  () => executor.busySandboxNames(),
  activeRegistry,
);
const alerts = new AlertDispatcher(config, logger);
const emitAlert = (input: AcsAlert) => alerts.emit(input);
let lifecycleController: SandboxLifecycleController;
const STREAM_HEARTBEAT_MS = 25_000;
// 用于零停机 deploy: `kill -USR2` -> 停接新的长运行请求 (/provision, /execute,
// /execute-stream, /invocations/*) -> 等 inflight=0 -> exit(0)。/health 期间
// 报告 draining + inflight 供 CI 脚本轮询。SIGTERM 沿用原短路径 (5s 硬退)。
let inflightRequests = 0;
let draining = false;
async function withInflight<T>(fn: () => Promise<T>): Promise<T> {
  inflightRequests++;
  try {
    return await fn();
  } finally {
    inflightRequests--;
  }
}
const snatOperations = new SnatOperations({
  sandboxManager,
  authorize,
  sendJson,
  emitAlert,
  logger,
  drainDeadlineMs: config.drainDeadlineMs,
  inflightRequests: () => inflightRequests,
  lifecycleRunning: () => lifecycleController.isLifecycleRunning(),
  backgroundMutationRunning: () => lifecycleController.isBackgroundMutationRunning(),
  ...(config.runtimeConfigPath
    ? { stateFile: `${config.runtimeConfigPath}.snat-operation-state.json` }
    : {}),
});
lifecycleController = new SandboxLifecycleController(
  config,
  provisioner,
  executor,
  sandboxManager,
  alerts,
  logger,
  activeBusySandboxNames,
  () => snatOperations.isMaintenanceActive(),
);
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    void handleHealth(res);
    return;
  }
  if (snatOperations.blocks(req)) {
    return sendJson(res, 503, {
      status: 'error',
      error: 'SNAT rollback maintenance is active; new workspace mutations are paused',
    });
  }
  if (req.method === 'GET' && req.url === '/tools') {
    return sendJson(res, 200, buildToolsResponse());
  }
  if (req.url === '/runtime-config') {
    void handleRuntimeConfig(req, res);
    return;
  }
  if (req.url === '/lifecycle/cleanup') {
    void withInflight(() => handleLifecycleCleanup(req, res));
    return;
  }

  if (req.url === '/network-policy/probe') {
    void withInflight(() => snatOperations.handleNetworkPolicyProbe(req, res));
    return;
  }

  if (req.url === '/snat') {
    void snatOperations.handleStatus(req, res);
    return;
  }

  if (req.url === '/snat/cleanup-orphans') {
    void withInflight(() => snatOperations.handleCleanup(req, res));
    return;
  }

  if (req.url === '/snat/migrate-shared') {
    if (draining)
      return sendJson(res, 503, { status: 'error', error: 'orchestrator draining, retry shortly' });
    void withInflight(() => snatOperations.handleMigration(req, res));
    return;
  }

  if (req.url === '/snat/restore-per-pod') {
    if (draining)
      return sendJson(res, 503, { status: 'error', error: 'orchestrator draining, retry shortly' });
    void withInflight(() => snatOperations.handleRestore(req, res));
    return;
  }

  if (req.url === '/snat/restore-per-pod/cancel') {
    if (draining)
      return sendJson(res, 503, { status: 'error', error: 'orchestrator draining, retry shortly' });
    void withInflight(() => snatOperations.handleRestoreCancel(req, res));
    return;
  }

  const sandboxLifecycleRoute = matchSandboxLifecycleRoute(req.url);
  if (sandboxLifecycleRoute) {
    void withInflight(() => handleSandboxLifecycleRoute(req, res, sandboxLifecycleRoute, {
      sandboxManager,
      authorize,
      busySandboxNames: activeBusySandboxNames,
    }));
    return;
  }

  const sandboxRoute = matchSandboxRoute(req.url);
  if (sandboxRoute) {
    void withInflight(() => handleSandboxRoute(req, res, sandboxRoute));
    return;
  }

  // Drain 期间对新的长运行请求返回 503; 已在跑的请求正常继续
  if (
    draining &&
    (req.url === '/provision' || req.url === '/execute' || req.url === '/execute-stream')
  ) {
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
    res.end(JSON.stringify({ status: 'error', error: 'orchestrator draining, retry shortly' }));
    return;
  }
  if (req.url === '/warmup') {
    void withInflight(() => handleWarmup(req, res));
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
    void withInflight(() =>
      handleWorkspaceLifecycle(
        req,
        res,
        decodeURIComponent(workspaceLifecycleMatch[1]!),
        workspaceLifecycleMatch[2] as 'archive' | 'reset',
      ),
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'error', error: 'not found' }));
});

/**
 * 2026-08-03 CPU 治理 P0a：/health 深度检查缓存。
 *
 * 生产实测：HandHealthScanner 串行扫 900+ 条同 endpoint 的 hands，把 /health
 * 打成 ~1 QPS；旧实现每次串行 fork ~7 个 kubectl/aliyun 子进程（单次 1.1s+），
 * 持续吃掉约 0.86 核。现在深检结果缓存 `healthDeepCacheMs`（默认 15s）并做
 * in-flight 合流；缓存期内 /health 为纯内存响应。
 *
 * 不缓存的字段（CI 零停机部署门禁依赖，必须实时）：
 * - `draining` / `inflight`：deploy 脚本轮询 inflight=0 才发 SIGTERM；
 * - `image` / runtimeConfig 等来自 config 内存的字段本来就是实时值。
 */
interface DeepHealthSnapshot {
  at: number;
  ok: boolean;
  checks: Record<string, unknown>;
  sandboxes: unknown;
  snat: unknown;
}

let deepHealthLast: DeepHealthSnapshot | null = null;
let deepHealthInFlight: Promise<DeepHealthSnapshot> | null = null;

async function checkCrdExists(crdName: string): Promise<boolean> {
  const viaApi = await kubeApi?.crdExists(crdName);
  if (typeof viaApi === 'boolean') return viaApi;
  const result = await kubectl.run(['get', 'crd', crdName, '-o', 'name'], { timeoutMs: 5_000 });
  return result.exitCode === 0;
}

async function checkNamespaceExists(namespace: string): Promise<boolean> {
  const viaApi = await kubeApi?.namespaceExists(namespace);
  if (typeof viaApi === 'boolean') return viaApi;
  const result = await kubectl.run(['get', 'namespace', namespace, '-o', 'name'], {
    timeoutMs: 5_000,
  });
  return result.exitCode === 0;
}

async function checkCanCreate(crdName: string): Promise<boolean> {
  const viaApi = await kubeApi?.canCreate(crdName);
  if (typeof viaApi === 'boolean') return viaApi;
  const result = await kubectl.run(['auth', 'can-i', 'create', crdName], { timeoutMs: 5_000 });
  return result.stdout.trim() === 'yes';
}

async function computeDeepHealth(): Promise<DeepHealthSnapshot> {
  const checks: Record<string, unknown> = {};
  let ok = true;
  // 各检查相互独立，并行执行（旧实现串行导致单次 /health 1.1s+）。
  const [crdOk, trafficPolicyCrdOk, trafficPolicyRbacOk, namespaceOk, inventoryOutcome] =
    await Promise.all([
      checkCrdExists(config.sandboxCrdName),
      checkCrdExists(config.trafficPolicyCrdName),
      checkCanCreate(config.trafficPolicyCrdName),
      checkNamespaceExists(config.namespace),
      (async () => {
        try {
          const sandboxes = await sandboxManager.inventorySummary();
          const snat = await sandboxManager.snatStatus();
          return { sandboxes, snat, error: undefined as string | undefined };
        } catch (err) {
          return {
            sandboxes: undefined,
            snat: undefined,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      })(),
    ]);
  checks.crd = crdOk ? 'ok' : 'error';
  checks.trafficPolicyCrd = trafficPolicyCrdOk ? 'ok' : 'error';
  checks.trafficPolicyRbac = trafficPolicyRbacOk ? 'ok' : 'error';
  checks.namespace = namespaceOk ? 'ok' : 'error';
  if (!crdOk || !trafficPolicyCrdOk || !trafficPolicyRbacOk || !namespaceOk) ok = false;
  if (inventoryOutcome.error !== undefined) {
    ok = false;
    checks.sandboxes = inventoryOutcome.error;
  }
  if (inventoryOutcome.sandboxes) {
    checks.executionCapacity = inventoryOutcome.sandboxes.executionReady ? 'ok' : 'exhausted';
    if (!inventoryOutcome.sandboxes.executionReady) ok = false;
  }
  const snat = inventoryOutcome.snat;
  if (snat?.enabled) {
    const sharedCidrsReady =
      snat.mode !== 'shared-cidr' ||
      snat.sharedCidrAvailableCount === (snat.sharedCidrs?.length ?? 0);
    const podCoverageOk = snat.uncoveredPodCidrs.length === 0;
    const snatOk = snat.configured && !snat.error && sharedCidrsReady && podCoverageOk;
    checks.snat = snatOk
      ? 'ok'
      : (snat.error ??
        (podCoverageOk
          ? 'shared CIDRs are not all Available'
          : `uncovered Pod CIDRs: ${snat.uncoveredPodCidrs.join(',')}`));
    if (!snatOk) ok = false;
  }
  return { at: Date.now(), ok, checks, sandboxes: inventoryOutcome.sandboxes, snat };
}

async function getDeepHealth(): Promise<DeepHealthSnapshot> {
  const ttl = config.healthDeepCacheMs;
  if (deepHealthLast && ttl > 0 && Date.now() - deepHealthLast.at < ttl) return deepHealthLast;
  if (!deepHealthInFlight) {
    deepHealthInFlight = computeDeepHealth().finally(() => {
      deepHealthInFlight = null;
    });
  }
  const snapshot = await deepHealthInFlight;
  deepHealthLast = snapshot;
  return snapshot;
}

async function handleHealth(res: ServerResponse): Promise<void> {
  const { ok, checks, sandboxes, snat } = await getDeepHealth();
  return sendJson(res, ok ? 200 : 503, {
    status: ok ? 'ok' : 'unhealthy',
    // drain 期间 CI 脚本轮询 inflight,为 0 时才 SIGTERM
    draining,
    inflight: inflightRequests,
    ...snatOperations.healthState(),
    backend: 'acs-agent-sandbox',
    ...releaseIdentityHealth(config.releaseIdentity),
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
      workspacePersistence: config.pvcName
        ? 'nas-pvc'
        : config.hostWorkspaceRoot
          ? 'host-workspace'
          : 'ephemeral',
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
      drainDeadlineMs: config.drainDeadlineMs,
      maxRunningSandboxes: config.maxRunningSandboxes,
      warnRunningSandboxes: config.warnRunningSandboxes,
      maxAllocatedCpuMillicores: config.maxAllocatedCpuMillicores,
      warnAllocatedCpuMillicores: config.warnAllocatedCpuMillicores,
      maxAllocatedMemoryMib: config.maxAllocatedMemoryMib,
      warnAllocatedMemoryMib: config.warnAllocatedMemoryMib,
      executionMaintenance: config.executionMaintenance,
      executionMaintenanceReason: config.executionMaintenanceReason ?? null,
      brokenRecycleGraceMs: config.sandboxBrokenRecycleGraceMs,
      alertWebhookConfigured: config.alertWebhookUrls.length > 0,
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
  const requirementsPath =
    process.env.ACS_BASE_REQUIREMENTS_PATH?.trim() ||
    join(dirname(fileURLToPath(import.meta.url)), '..', 'requirements', 'base.txt');
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
      contractVersion: 2,
      manifestImageRefScope: 'diagnostic-only',
      rebuildTriggers: [
        'missing-or-invalid-manifest',
        'runtime-contract-version-changed',
        'python-major-minor-changed',
        'base-requirements-hash-changed',
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
  if (req.method !== 'PATCH')
    return sendJson(res, 405, { status: 'error', error: 'method not allowed; use GET or PATCH' });
  const body = await readJson(req, res);
  if (!body.ok) return;
  try {
    const patch = parseRuntimeConfigPatch(body.value);
    const runtimeConfig = applyRuntimeConfigPatch(config, patch);
    logger.warn(
      `runtime_config_updated maxRunningSandboxes=${runtimeConfig.maxRunningSandboxes} ` +
        `warnRunningSandboxes=${runtimeConfig.warnRunningSandboxes} ` +
        `drainDeadlineMs=${runtimeConfig.drainDeadlineMs} persisted=${runtimeConfig.persisted}`,
    );
    return sendJson(res, 200, { status: 'ok', runtimeConfig });
  } catch (err) {
    return sendJson(res, 400, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleLifecycleCleanup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST')
    return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
  if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  try {
    const report = await sandboxManager.cleanupSandboxes({
      busySandboxNames: activeBusySandboxNames(),
    });
    logger.warn(
      `sandbox_lifecycle_manual_cleanup checked=${report.checked} paused=${report.paused.length} ` +
        `deleted=${report.deleted.length} skippedBusy=${report.skippedBusy.length}`,
    );
    return sendJson(res, 200, { status: 'ok', report });
  } catch (err) {
    return sendJson(res, 500, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleSandboxRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: SandboxRoute,
): Promise<void> {
  if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  if (
    config.executionMaintenance &&
    !allowsExecutionMaintenanceBypass(req) &&
    route.kind === 'name' &&
    route.action === 'resume'
  ) {
    return sendExecutionMaintenance(res, config.executionMaintenanceReason);
  }
  if (route.kind === 'list') {
    if (req.method !== 'GET')
      return sendJson(res, 405, { status: 'error', error: 'method not allowed; use GET' });
    try {
      const sandboxes = await sandboxManager.listSandboxInventory({
        busySandboxNames: activeBusySandboxNames(),
      });
      return sendJson(res, 200, { status: 'ok', sandboxes });
    } catch (err) {
      return sendJson(res, 500, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const name = decodeSandboxName(route.rawName);
  if (!name) return sendJson(res, 400, { status: 'error', error: 'invalid sandbox name' });

  try {
    if (route.action === 'pause') {
      if (req.method !== 'POST')
        return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
      await sandboxManager.pauseByName(name, { busySandboxNames: activeBusySandboxNames() });
      return sendJson(res, 200, { status: 'ok', name, paused: true });
    }
    if (route.action === 'resume') {
      if (req.method !== 'POST')
        return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
      const ref = await sandboxManager.resumeByName(name, {
        busySandboxNames: activeBusySandboxNames(),
      });
      return sendJson(res, 200, { status: 'ok', name, resumed: true, ref });
    }
    if (req.method === 'GET') {
      const sandbox = await sandboxManager.getStatus(name);
      if (!sandbox) return sendJson(res, 404, { status: 'error', error: 'sandbox not found' });
      return sendJson(res, 200, {
        status: 'ok',
        name,
        phase: sandbox.phase ?? null,
        brokenReason: brokenSandboxStateReason(sandbox) ?? null,
        sandbox: sandbox.raw,
      });
    }
    if (req.method === 'DELETE') {
      await sandboxManager.deleteByName(name, { busySandboxNames: activeBusySandboxNames() });
      return sendJson(res, 200, { status: 'ok', name, deleted: true });
    }
    return sendJson(res, 405, { status: 'error', error: 'method not allowed; use GET or DELETE' });
  } catch (err) {
    return sendSandboxError(res, err);
  }
}

/**
 * POST /warmup（2026-07-31 冷启动治理批次）。
 *
 * server 在用户打开会话页时 fire-and-forget 调用，提前把 Sandbox 带到 Running，
 * 让 30s+ 冷启动与用户打字/LLM 首轮思考并行。立即返回 202，ensureRunning 在
 * 后台完成（同名并发由 SandboxManager.ensureInFlight 合流；与真实 execute 的
 * ensure 也会合流）。失败仅记日志——warmup 是纯优化路径，不影响正式链路。
 * warmup 全程计入 withInflight，确保 drain 与 SNAT 回滚维护屏障不会漏掉已接受的创建。
 */
async function handleWarmup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST')
    return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
  if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  if (config.executionMaintenance && !allowsExecutionMaintenanceBypass(req)) {
    return sendExecutionMaintenance(res, config.executionMaintenanceReason);
  }
  if (draining) {
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
    res.end(JSON.stringify({ status: 'error', error: 'orchestrator draining' }));
    return;
  }
  const body = await readJson(req, res);
  if (!body.ok) return;
  const parsed = parseWarmupRequest(body.value);
  if (!parsed.ok) return sendJson(res, 400, { status: 'error', error: parsed.error });
  const { workspaceId, sessionId, sandboxScopeId, mountSubPath, workload } = parsed.value;
  const resourceOverride = parsed.value.resources
    ? sandboxResourceOverride({ workspaceId, resources: parsed.value.resources }, config)
    : undefined;
  const ensureInput = {
    workspaceId,
    sessionId,
    sandboxScopeId,
    mountSubPath,
    ...(resourceOverride ? { resources: resourceOverride } : {}),
    ...(workload ? { workload } : {}),
  };
  let ref: ReturnType<typeof sandboxManager.ref>;
  try {
    ref = sandboxManager.ref(ensureInput);
  } catch (err) {
    return sendJson(res, 400, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  sendJson(res, 202, { status: 'accepted', sandbox: ref.name });
  const activeKey = `warmup:${ref.name}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
  const releaseActive = activeRegistry.acquire(ref.name, activeKey);
  const startedAt = Date.now();
  try {
    await sandboxManager.ensureRunning(
      ensureInput,
      { busySandboxNames: executor.busySandboxNames(), activeKey },
    );
    logger.info(`sandbox_warmup_ok sandbox=${ref.name} totalMs=${Date.now() - startedAt}`);
  } catch (err) {
    logger.warn(
      `sandbox_warmup_failed sandbox=${ref.name} totalMs=${Date.now() - startedAt} err=${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    releaseActive();
  }
}

async function handleProvision(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST')
    return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
  if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  if (config.executionMaintenance && !allowsExecutionMaintenanceBypass(req)) {
    return sendExecutionMaintenance(res, config.executionMaintenanceReason);
  }
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
    if (err instanceof SandboxCapacityError) return sendCapacityError(res, err);
    const message = err instanceof Error ? err.message : String(err);
    if (
      err instanceof SnatSharedCidrCoverageError ||
      /ACS SNAT|CreateSnatEntry\(shared\)/.test(message)
    ) {
      await emitAlert({
        event:
          err instanceof SnatSharedCidrCoverageError
            ? 'snat_shared_cidr_coverage_gap'
            : 'snat_provision_failed',
        severity: 'error',
        message,
        metadata:
          err instanceof SnatSharedCidrCoverageError
            ? { podIp: err.podIp, sharedCidrs: err.sharedCidrs }
            : undefined,
      });
    }
    return sendJson(res, 500, { status: 'error', error: message });
  }
}

async function handleExecute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST')
    return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
  if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  if (config.executionMaintenance && !allowsExecutionMaintenanceBypass(req)) {
    return sendExecutionMaintenance(res, config.executionMaintenanceReason);
  }
  const body = await readJson(req, res);
  if (!body.ok) return;
  const parsed = parseWireRequest(body.value);
  if (!parsed.ok) return sendJson(res, 400, { status: 'error', error: parsed.error });
  try {
    const response = await executor.execute(parsed.value);
    return sendJson(res, 200, response);
  } catch (err) {
    return sendSandboxError(res, err);
  }
}

async function handleExecuteStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST')
    return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
  if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  if (config.executionMaintenance && !allowsExecutionMaintenanceBypass(req)) {
    return sendExecutionMaintenance(res, config.executionMaintenanceReason);
  }
  const body = await readJson(req, res);
  if (!body.ok) return;
  const parsed = parseWireRequest(body.value);
  if (!parsed.ok) return sendJson(res, 400, { status: 'error', error: parsed.error });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  let sawCompleted = false;
  const disconnectController = new AbortController();
  const cancelDisconnectedInvocation = () => {
    if (sawCompleted || disconnectController.signal.aborted) return;
    disconnectController.abort();
    const invocationId = parsed.value.context.invocationId;
    if (invocationId) executor.cancel(invocationId);
  };
  req.once('aborted', cancelDisconnectedInvocation);
  res.once('close', cancelDisconnectedInvocation);
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n');
  }, STREAM_HEARTBEAT_MS);
  heartbeat.unref?.();
  const writeChunk = (chunk: unknown) => {
    if (chunk && typeof chunk === 'object' && (chunk as { type?: unknown }).type === 'completed')
      sawCompleted = true;
    if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };
  try {
    for await (const chunk of executor.executeStream(parsed.value, {
      stream: true,
      signal: disconnectController.signal,
    })) {
      writeChunk(chunk);
      if (sawCompleted) break;
    }
  } catch (err) {
    writeChunk({
      type: 'completed',
      response: { status: 'error', error: err instanceof Error ? err.message : String(err) },
    });
  } finally {
    clearInterval(heartbeat);
    req.removeListener('aborted', cancelDisconnectedInvocation);
    res.removeListener('close', cancelDisconnectedInvocation);
    if (!sawCompleted)
      writeChunk({
        type: 'completed',
        response: { status: 'error', error: 'ACS stream ended without completed chunk' },
      });
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

async function handleCancel(
  req: IncomingMessage,
  res: ServerResponse,
  invocationId: string,
): Promise<void> {
  if (req.method !== 'DELETE')
    return sendJson(res, 405, { status: 'error', error: 'method not allowed; use DELETE' });
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
  if (req.method !== 'POST')
    return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
  if (!authorize(req)) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  let reason: string = action;
  try {
    const raw = await readBody(req, MAX_BODY_BYTES);
    if (raw.trim()) {
      const body = JSON.parse(raw) as { reason?: unknown };
      if (typeof body.reason === 'string' && body.reason.trim()) reason = body.reason.trim();
    }
  } catch (err) {
    return sendJson(res, 400, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    const deleted = await sandboxManager.deleteByWorkspaceId(workspaceId, {
      busySandboxNames: activeBusySandboxNames(),
    });
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
    return sendJson(res, 400, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
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

async function readJson(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const raw = await readBody(req, MAX_BODY_BYTES);
    return { ok: true, value: raw.trim() ? JSON.parse(raw) : {} };
  } catch (err) {
    sendJson(res, 400, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
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
  // 2026-07-15 零停机部署批次：把真实 node PID 写入 pidfile，部署脚本据此
  // `kill -USR2 $(cat pidfile)` 精确投递 drain 信号。ExecStart 经 pnpm wrapper
  // 启动时 systemd MainPID 是 wrapper 的 node 进程——它不转发 SIGUSR2 且收到
  // 即被默认动作终止，drain 会静默失效，必须直送本进程。
  const pidFile = process.env.ACS_ORCH_PIDFILE;
  if (pidFile) {
    try {
      writeFileSync(pidFile, `${process.pid}\n`, 'utf-8');
      logger.info(`pidfile written: ${pidFile} (pid=${process.pid})`);
    } catch (err) {
      logger.warn(
        `failed to write pidfile ${pidFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  lifecycleController.start();
});

const shutdown = (sig: NodeJS.Signals) => {
  logger.info(`received ${sig}, shutting down`);
  lifecycleController.stop();
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
  lifecycleController.stop();
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
    if (Date.now() - startedAt >= config.drainDeadlineMs) {
      clearInterval(poll);
      logger.warn(
        `drain deadline reached (${config.drainDeadlineMs}ms), forcing exit (inflight=${inflightRequests})`,
      );
      process.exit(1);
    }
    logger.info(`draining... inflight=${inflightRequests}`);
  }, 2_000);
  poll.unref();
});
