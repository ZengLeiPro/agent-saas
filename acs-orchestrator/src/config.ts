import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ipv4CidrsOverlap, parseIpv4Cidr } from './cidr.js';
import {
  DEFAULT_CODING_HAND_NETWORK_POLICY,
  parseNetworkPolicyFromEnv,
  type NetworkPolicyConfig,
} from 'server/runtime/networkPolicy.js';
import {
  DEFAULT_EGRESS_CONFIG,
  parseProxyUrl,
  type EgressPackageMirrorsConfig,
  type EgressSandboxProxyConfig,
} from 'server/runtime/egressPolicy.js';

export interface AcsOrchestratorConfig {
  port: number;
  host: string;
  authToken: string;
  kubectlPath: string;
  kubeconfig?: string;
  namespace: string;
  sandboxApiVersion: string;
  sandboxKind: string;
  sandboxCrdName: string;
  trafficPolicyCrdName: string;
  sandboxImage: string;
  sandboxContainerName: string;
  sandboxRuntimes: string[];
  workspaceMountPath: string;
  hostWorkspaceRoot?: string;
  pvcName?: string;
  imagePullSecretNames: string[];
  imagePullPolicy: 'Always' | 'IfNotPresent' | 'Never';
  sandboxRunAsUser: number;
  sandboxRunAsGroup: number;
  sandboxFsGroup?: number;
  cpuRequest: string;
  memoryRequest: string;
  cpuLimit?: string;
  memoryLimit?: string;
  sandboxWaitTimeoutMs: number;
  execTimeoutMs: number;
  /**
   * 2026-08-03 CPU 治理 P0a：/health 深度检查（kubectl CRD/RBAC/namespace +
   * Sandbox inventory + SNAT 查询）结果缓存时长。生产实测 HandHealthScanner
   * 串行扫 900+ 条同 endpoint hands 会把 /health 打成 ~1 QPS，每次 fork ~7 个
   * kubectl/aliyun 子进程 ≈ 0.86 核。缓存期内 /health 直接返回上次深检快照；
   * draining / inflight / image 等部署门禁字段永远实时。0 = 关闭缓存。
   */
  healthDeepCacheMs: number;
  /**
   * 2026-07-31 方案3-P0：Pod 注解 `image.alibabacloud.com/enable-image-cache`。
   * 开启后 ACS 自动按镜像名匹配最新可用 ImageCache（官方称拉取耗时缩短 90%+）；
   * 无匹配缓存时无副作用（回退正常拉取）。缓存本体由发版侧创建（acc OpenAPI
   * create-image-cache），此开关只控制新建 Sandbox 是否参与匹配。
   */
  imageCacheEnabled: boolean;
  skipProvisionOnSameRecipe: boolean;
  lifecycleEnabled: boolean;
  sandboxCleanupIntervalMs: number;
  sandboxIdlePauseMs: number;
  sandboxTtlMs: number;
  /**
   * 07-05：CI 临时 sandbox（名字以 `as-ws-ci-` 开头）走的短 TTL，覆盖 sandboxTtlMs。
   * CI sandbox 用完一次就没有复用价值，workflow 正常退出会立即删除；默认 1h
   * 只用于 cleanup trap / 进程 / 控制面异常时的泄漏兜底。
   * 设为 0 = 关闭这条特殊路径，回退到普通 sandboxTtlMs。
   */
  sandboxCiTtlMs: number;
  sandboxOrphanGraceMs: number;
  /**
   * 2026-08-01：broken Paused sandbox（假暂停，如 SandboxPaused 卡 False/ImageChanged）
   * 的自愈回收宽限期。condition 翻转/最后活跃/创建三个时间戳全部超过该宽限才删除 CR，
   * 防误伤正常 pause/resume 瞬态。0 = 关闭自愈（不建议：假暂停持续按运行态计费）。
   */
  sandboxBrokenRecycleGraceMs: number;
  maxRunningSandboxes: number;
  warnRunningSandboxes: number;
  drainDeadlineMs: number;
  networkPolicy: NetworkPolicyConfig;
  snat: AcsSnatConfig;
  /** 出口代理与镜像源；由 server 侧配置页经 PATCH /runtime-config 下发 */
  egress: AcsEgressConfig;
  runtimeConfigPath?: string;
  /**
   * 2026-08-01：改为 URL 列表，逐个尝试直到成功。server 蓝绿部署下单一固定端口
   * （3200/3201）会在切色或部署窗口不可达（07-25 起历轮 prewarm failed 告警全部
   * `fetch failed` 丢失即此因）；env `ACS_ALERT_WEBHOOK_URL` 支持逗号分隔多地址。
   */
  alertWebhookUrls: string[];
  alertWebhookBearerToken?: string;
  alertMinIntervalMs: number;
  capabilities: AcsRuntimeCapabilities;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface AcsRuntimeCapabilities {
  browser: boolean;
  media: boolean;
  officeDocuments: boolean;
  pythonBasePackages: boolean;
}

/**
 * - `per-sandbox`：每个 Sandbox pod 一条 `<podIp>/32` SNAT 条目（2026-08-10 前的唯一模式）。
 * - `shared-cidr`：整个 pod 网段共用一条条目（2026-08-10 新增，配套 per-session Sandbox）。
 *   pod 数与 SNAT 条目彻底解耦，且新 pod 不再需要建条目 → 省掉每次 8s 的传播等待。
 *   核查依据：per-pod 无任何隔离语义（所有条目指向同一 SnatIp），网络策略走
 *   TrafficPolicy CRD 与 SNAT 正交；生产 pod 7 天实测全部落在同一 /24，
 *   而 ECS 在另一 /24 且各自持公网 IP 不经 SNAT。详见
 *   `assets/20260810/acs-a/03-SNAT网段共享可行性核查.md`。
 */
export type AcsSnatMode = 'disabled' | 'probe-only' | 'per-sandbox' | 'shared-cidr';

export interface AcsSnatConfig {
  mode: AcsSnatMode;
  aliyunCliPath: string;
  regionId?: string;
  snatTableId?: string;
  snatIp?: string;
  entryNamePrefix: string;
  /**
   * `shared-cidr` 模式下托管的 pod 网段（如 `172.16.179.0/24`）。
   * 必须只覆盖 ACS pod，不能把 ECS 等自带公网 IP 的资源圈进来。
   * `sharedCidr` 仅保留给旧配置对象兼容；新代码统一读取 `sharedCidrs`。
   */
  sharedCidr?: string;
  sharedCidrs?: string[];
  maxManagedEntries: number;
  requestTimeoutMs: number;
  stabilizeAfterCreateMs: number;
  /**
   * 2026-08-03 CPU 治理 P2：SNAT 只读状态查询（aliyun CLI DescribeSnatTableEntries，
   * 实测单次 fork 峰值 75% CPU）结果缓存时长。仅缓存展示型 status 快照；
   * ensure/delete/cleanupOrphans 等有真实语义的路径不走缓存。0 = 关闭。
   */
  statusCacheMs: number;
}

/**
 * 网络出口（代理 / 镜像源）配置（2026-07-25）。
 * 由 server 侧「网络出口」配置页经 PATCH /runtime-config 下发并持久化到
 * runtimeConfigPath，orchestrator 重启后仍生效。
 *
 * 注意生效边界：proxy/mirror 通过 Pod spec env 注入，容器创建时固化，
 * 因此只对**新建 Sandbox** 生效；已运行的容器要等自然 pause/重建。
 */
export interface AcsEgressConfig {
  proxy: EgressSandboxProxyConfig;
  packageMirrors: EgressPackageMirrorsConfig;
}

export interface AcsRuntimeConfigSnapshot {
  maxRunningSandboxes: number;
  warnRunningSandboxes: number;
  drainDeadlineMs: number;
  egress: AcsEgressConfig;
  runtimeConfigPath?: string;
  persisted: boolean;
}

export interface AcsRuntimeConfigPatch {
  maxRunningSandboxes?: number;
  warnRunningSandboxes?: number;
  drainDeadlineMs?: number;
  egress?: AcsEgressConfig;
}

function readIntEnv(name: string, fallback: number, opts: { min?: number; max?: number } = {}): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) throw new Error(`${name} 非法: ${raw}`);
  if (opts.min !== undefined && value < opts.min) throw new Error(`${name} 必须 >= ${opts.min}`);
  if (opts.max !== undefined && value > opts.max) throw new Error(`${name} 必须 <= ${opts.max}`);
  return value;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 未配置`);
  return value;
}

function readOptionalPathEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? resolve(raw) : undefined;
}

function readImagePullPolicy(): AcsOrchestratorConfig['imagePullPolicy'] {
  const raw = process.env.ACS_SANDBOX_IMAGE_PULL_POLICY?.trim();
  if (!raw) return 'IfNotPresent';
  if (raw === 'Always' || raw === 'IfNotPresent' || raw === 'Never') return raw;
  throw new Error(`ACS_SANDBOX_IMAGE_PULL_POLICY 非法: ${raw}`);
}

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} 非法: ${process.env[name]}（仅支持 true/false）`);
}

function readLogLevel(): AcsOrchestratorConfig['logLevel'] {
  const raw = process.env.ACS_ORCH_LOG_LEVEL?.trim() ?? 'info';
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  throw new Error(`ACS_ORCH_LOG_LEVEL 非法: ${raw}`);
}

function readRuntimeCapabilities(): AcsRuntimeCapabilities {
  return {
    browser: readBoolEnv('ACS_CAPABILITY_BROWSER', true),
    media: readBoolEnv('ACS_CAPABILITY_MEDIA', true),
    officeDocuments: readBoolEnv('ACS_CAPABILITY_OFFICE_DOCUMENTS', true),
    pythonBasePackages: readBoolEnv('ACS_CAPABILITY_PYTHON_BASE_PACKAGES', true),
  };
}

function readSnatMode(): AcsSnatMode {
  const raw = process.env.ACS_SNAT_MODE?.trim() || 'disabled';
  if (raw === 'disabled' || raw === 'probe-only' || raw === 'per-sandbox' || raw === 'shared-cidr') return raw;
  throw new Error(`ACS_SNAT_MODE 非法: ${raw}`);
}

function readStringListEnv(name: string): string[] {
  return (process.env[name]?.trim() ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readRuntimeConfigFile(path: string | undefined): AcsRuntimeConfigPatch {
  if (!path || !existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  return parseRuntimeConfigPatch(raw);
}

export function parseRuntimeConfigPatch(input: unknown): AcsRuntimeConfigPatch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('runtime config patch must be an object');
  const raw = input as Record<string, unknown>;
  const patch: AcsRuntimeConfigPatch = {};
  if ('maxRunningSandboxes' in raw) {
    patch.maxRunningSandboxes = parseRuntimeConfigInt('maxRunningSandboxes', raw.maxRunningSandboxes);
  }
  if ('warnRunningSandboxes' in raw) {
    patch.warnRunningSandboxes = parseRuntimeConfigInt('warnRunningSandboxes', raw.warnRunningSandboxes);
  }
  if ('drainDeadlineMs' in raw) {
    patch.drainDeadlineMs = parseRuntimeConfigDuration('drainDeadlineMs', raw.drainDeadlineMs);
  }
  if ('egress' in raw) {
    patch.egress = parseEgressConfigPatch(raw.egress);
  }
  validateRuntimeConfigValues(patch);
  return patch;
}

function parseRuntimeConfigInt(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  if (value < 0 || value > 1_000) throw new Error(`${name} must be between 0 and 1000`);
  return value;
}

function parseRuntimeConfigDuration(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  if (value < 1_000 || value > 24 * 60 * 60_000) throw new Error(`${name} must be between 1000 and 86400000`);
  return value;
}

function parseBool(name: string, value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function parseStringList(name: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings`);
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`${name}[${index}] must be a string`);
    return item.trim();
  }).filter(Boolean);
}

function parseOptionalString(name: string, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value.trim();
}

/**
 * 校验 server 下发的出口配置。启用但地址非法时直接拒绝——
 * 静默忽略会让管理员以为代理已生效，比报错更难排查。
 */
export function parseEgressConfigPatch(input: unknown): AcsEgressConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('egress must be an object');
  }
  const raw = input as Record<string, unknown>;
  const proxyRaw = (raw.proxy ?? {}) as Record<string, unknown>;
  const mirrorsRaw = (raw.packageMirrors ?? {}) as Record<string, unknown>;

  const proxy: EgressSandboxProxyConfig = {
    enabled: proxyRaw.enabled === undefined ? false : parseBool('egress.proxy.enabled', proxyRaw.enabled),
    proxyUrl: parseOptionalString('egress.proxy.proxyUrl', proxyRaw.proxyUrl),
    noProxy: parseStringList('egress.proxy.noProxy', proxyRaw.noProxy),
  };
  if (proxy.enabled && !parseProxyUrl(proxy.proxyUrl)) {
    throw new Error('egress.proxy.enabled=true 时 proxyUrl 必须是合法的 http/https/socks5 地址');
  }

  const packageMirrors: EgressPackageMirrorsConfig = {
    enabled: mirrorsRaw.enabled === undefined ? false : parseBool('egress.packageMirrors.enabled', mirrorsRaw.enabled),
    pipIndexUrl: parseOptionalString('egress.packageMirrors.pipIndexUrl', mirrorsRaw.pipIndexUrl),
    pipTrustedHost: parseOptionalString('egress.packageMirrors.pipTrustedHost', mirrorsRaw.pipTrustedHost),
    npmRegistry: parseOptionalString('egress.packageMirrors.npmRegistry', mirrorsRaw.npmRegistry),
  };
  if (packageMirrors.enabled && !packageMirrors.pipIndexUrl && !packageMirrors.npmRegistry) {
    throw new Error('egress.packageMirrors.enabled=true 时至少需要 pipIndexUrl 或 npmRegistry');
  }

  return { proxy, packageMirrors };
}

function defaultEgressConfig(): AcsEgressConfig {
  return {
    proxy: { ...DEFAULT_EGRESS_CONFIG.sandbox, noProxy: [] },
    packageMirrors: { ...DEFAULT_EGRESS_CONFIG.packageMirrors },
  };
}

function cloneEgressConfig(value: AcsEgressConfig | undefined): AcsEgressConfig {
  if (!value) return defaultEgressConfig();
  return {
    proxy: { ...value.proxy, noProxy: [...(value.proxy?.noProxy ?? [])] },
    packageMirrors: { ...value.packageMirrors },
  };
}

function validateRuntimeConfigValues(values: AcsRuntimeConfigPatch): void {
  if (
    values.maxRunningSandboxes !== undefined
    && values.warnRunningSandboxes !== undefined
    && values.maxRunningSandboxes > 0
    && values.warnRunningSandboxes > values.maxRunningSandboxes
  ) {
    throw new Error('warnRunningSandboxes must be <= maxRunningSandboxes');
  }
}

export function runtimeConfigSnapshot(config: AcsOrchestratorConfig): AcsRuntimeConfigSnapshot {
  return {
    maxRunningSandboxes: config.maxRunningSandboxes,
    warnRunningSandboxes: config.warnRunningSandboxes,
    drainDeadlineMs: config.drainDeadlineMs,
    // 容错 undefined：生产上已存在的 runtime-config.json 是旧格式（只有三个配额字段），
    // 启动回灌时 config.egress 可能还没被赋值。
    egress: cloneEgressConfig(config.egress),
    ...(config.runtimeConfigPath ? { runtimeConfigPath: config.runtimeConfigPath } : {}),
    persisted: Boolean(config.runtimeConfigPath),
  };
}

export function applyRuntimeConfigPatch(
  config: AcsOrchestratorConfig,
  patch: AcsRuntimeConfigPatch,
): AcsRuntimeConfigSnapshot {
  const next = {
    maxRunningSandboxes: patch.maxRunningSandboxes ?? config.maxRunningSandboxes,
    warnRunningSandboxes: patch.warnRunningSandboxes ?? config.warnRunningSandboxes,
    drainDeadlineMs: patch.drainDeadlineMs ?? config.drainDeadlineMs,
    egress: cloneEgressConfig(patch.egress ?? config.egress),
  };
  validateRuntimeConfigValues(next);
  if (config.snat?.mode === 'shared-cidr') {
    const rollbackCapacity = config.snat.maxManagedEntries - (config.snat.sharedCidrs?.length ?? 0) - 2;
    if (next.maxRunningSandboxes <= 0 || next.maxRunningSandboxes > rollbackCapacity) {
      throw new Error(
        `maxRunningSandboxes ${next.maxRunningSandboxes} must be within shared-cidr rollback capacity 1..${rollbackCapacity}`,
      );
    }
  }
  config.maxRunningSandboxes = next.maxRunningSandboxes;
  config.warnRunningSandboxes = next.warnRunningSandboxes;
  config.drainDeadlineMs = next.drainDeadlineMs;
  config.egress = next.egress;
  if (config.runtimeConfigPath) {
    mkdirSync(dirname(config.runtimeConfigPath), { recursive: true });
    writeFileSync(config.runtimeConfigPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  }
  return runtimeConfigSnapshot(config);
}

export function loadConfigFromEnv(): AcsOrchestratorConfig {
  const authToken = readRequiredEnv('ACS_ORCH_AUTH_TOKEN');
  if (authToken.length < 8) throw new Error('ACS_ORCH_AUTH_TOKEN 过短 (<8 chars)，拒绝启动');
  const runtimeConfigPath = readOptionalPathEnv('ACS_ORCH_RUNTIME_CONFIG_FILE');
  const persistedRuntimeConfig = readRuntimeConfigFile(runtimeConfigPath);
  const snatMode = readSnatMode();
  const snatRegionId = process.env.ACS_SNAT_REGION_ID?.trim() || undefined;
  const snatTableId = process.env.ACS_SNAT_TABLE_ID?.trim() || undefined;
  const snatIp = process.env.ACS_SNAT_IP?.trim() || undefined;
  const legacySnatSharedCidr = process.env.ACS_SNAT_SHARED_CIDR?.trim() || undefined;
  const snatSharedCidrsRaw = process.env.ACS_SNAT_SHARED_CIDRS?.trim() || undefined;
  if (legacySnatSharedCidr && snatSharedCidrsRaw) {
    throw new Error('ACS_SNAT_SHARED_CIDR 与 ACS_SNAT_SHARED_CIDRS 不能同时配置');
  }
  const snatSharedCidrs = (snatSharedCidrsRaw ?? legacySnatSharedCidr ?? '')
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const parsed = parseIpv4Cidr(value);
      if (!parsed) {
        const variable = snatSharedCidrsRaw ? 'ACS_SNAT_SHARED_CIDRS' : 'ACS_SNAT_SHARED_CIDR';
        throw new Error(`${variable} 非法: ${value}`);
      }
      return parsed.canonical;
    })
    .filter((value, index, values) => values.indexOf(value) === index);
  const snatMaxManagedEntries = readIntEnv('ACS_SNAT_MAX_MANAGED_ENTRIES', 12, { min: 1, max: 200 });
  if (snatMode !== 'disabled' && (!snatRegionId || !snatTableId || !snatIp)) {
    throw new Error('ACS_SNAT_MODE 启用时必须配置 ACS_SNAT_REGION_ID / ACS_SNAT_TABLE_ID / ACS_SNAT_IP');
  }
  if (snatMode === 'shared-cidr') {
    if (snatSharedCidrs.length === 0) {
      throw new Error('ACS_SNAT_MODE=shared-cidr 时必须配置 ACS_SNAT_SHARED_CIDRS（或旧变量 ACS_SNAT_SHARED_CIDR）');
    }
    const parsedCidrs = snatSharedCidrs.map((value) => parseIpv4Cidr(value)!);
    for (const cidr of parsedCidrs) {
      if (cidr.prefixLength < 24) {
        throw new Error(`ACS_SNAT_SHARED_CIDRS 拒绝过宽网段（最宽 /24）: ${cidr.canonical}`);
      }
    }
    for (let left = 0; left < parsedCidrs.length; left++) {
      for (let right = left + 1; right < parsedCidrs.length; right++) {
        if (ipv4CidrsOverlap(parsedCidrs[left]!, parsedCidrs[right]!)) {
          throw new Error(`ACS_SNAT_SHARED_CIDRS 存在重叠: ${parsedCidrs[left]!.canonical},${parsedCidrs[right]!.canonical}`);
        }
      }
    }
    if (snatMaxManagedEntries < snatSharedCidrs.length) {
      throw new Error(
        `ACS_SNAT_MAX_MANAGED_ENTRIES=${snatMaxManagedEntries} 小于共享网段数 ${snatSharedCidrs.length}`,
      );
    }
  }
  const base: AcsOrchestratorConfig = {
    port: readIntEnv('ACS_ORCH_PORT', 3300, { min: 1, max: 65_535 }),
    host: process.env.ACS_ORCH_HOST?.trim() || '127.0.0.1',
    authToken,
    kubectlPath: process.env.ACS_KUBECTL_PATH?.trim() || 'kubectl',
    kubeconfig: readOptionalPathEnv('KUBECONFIG') ?? readOptionalPathEnv('ACS_KUBECONFIG'),
    namespace: process.env.ACS_NAMESPACE?.trim() || 'agent-saas-coding',
    sandboxApiVersion: process.env.ACS_SANDBOX_API_VERSION?.trim() || 'agents.kruise.io/v1alpha1',
    sandboxKind: process.env.ACS_SANDBOX_KIND?.trim() || 'Sandbox',
    sandboxCrdName: process.env.ACS_SANDBOX_CRD_NAME?.trim() || 'sandboxes.agents.kruise.io',
    trafficPolicyCrdName: process.env.ACS_TRAFFIC_POLICY_CRD_NAME?.trim() || 'trafficpolicies.network.alibabacloud.com',
    sandboxImage: readRequiredEnv('ACS_SANDBOX_IMAGE'),
    sandboxContainerName: process.env.ACS_SANDBOX_CONTAINER_NAME?.trim() || 'sandbox',
    sandboxRuntimes: readStringListEnv('ACS_SANDBOX_RUNTIMES'),
    workspaceMountPath: process.env.ACS_WORKSPACE_MOUNT_PATH?.trim() || '/workspace',
    hostWorkspaceRoot: readOptionalPathEnv('ACS_HOST_WORKSPACE_ROOT'),
    pvcName: process.env.ACS_WORKSPACE_PVC_NAME?.trim() || undefined,
    imagePullSecretNames: readStringListEnv('ACS_SANDBOX_IMAGE_PULL_SECRET_NAMES'),
    imagePullPolicy: readImagePullPolicy(),
    sandboxRunAsUser: readIntEnv('ACS_SANDBOX_RUN_AS_USER', 501, { min: 1, max: 2_147_483_647 }),
    sandboxRunAsGroup: readIntEnv('ACS_SANDBOX_RUN_AS_GROUP', 20, { min: 1, max: 2_147_483_647 }),
    ...(process.env.ACS_SANDBOX_FS_GROUP?.trim()
      ? { sandboxFsGroup: readIntEnv('ACS_SANDBOX_FS_GROUP', 20, { min: 1, max: 2_147_483_647 }) }
      : {}),
    cpuRequest: process.env.ACS_SANDBOX_CPU_REQUEST?.trim() || '250m',
    memoryRequest: process.env.ACS_SANDBOX_MEMORY_REQUEST?.trim() || '512Mi',
    cpuLimit: process.env.ACS_SANDBOX_CPU_LIMIT?.trim() || undefined,
    memoryLimit: process.env.ACS_SANDBOX_MEMORY_LIMIT?.trim() || undefined,
    sandboxWaitTimeoutMs: readIntEnv('ACS_SANDBOX_WAIT_TIMEOUT_MS', 90_000, { min: 1_000, max: 600_000 }),
    execTimeoutMs: readIntEnv('ACS_EXEC_TIMEOUT_MS', 120_000, { min: 1_000, max: 600_000 }),
    healthDeepCacheMs: readIntEnv('ACS_HEALTH_DEEP_CACHE_MS', 15_000, { min: 0, max: 300_000 }),
    imageCacheEnabled: readBoolEnv('ACS_SANDBOX_IMAGE_CACHE_ENABLED', true),
    skipProvisionOnSameRecipe: readBoolEnv('ACS_SKIP_PROVISION_ON_SAME_RECIPE', true),
    lifecycleEnabled: readBoolEnv('ACS_SANDBOX_LIFECYCLE_ENABLED', true),
    sandboxCleanupIntervalMs: readIntEnv('ACS_SANDBOX_CLEANUP_INTERVAL_MS', 60_000, { min: 10_000, max: 24 * 60 * 60_000 }),
    // 2026-08-10 曾磊拍板：idle pause 4h -> 5min（推翻 07-31 的 5min -> 4h）。
    //
    // 07-31 改成 4h 的依据是「ACS pause 后唤醒走删除重建（35-110s），resume
    // 快路径 7 天 0 命中」——该观测在今天已不成立。08-10 受控实测：pause 持续
    // 5min 与 15min 后 resume 均为 **0 秒**，且 pod uid 前后完全一致，说明是
    // 原 pod 恢复、走真正的快路径，而非删除重建。
    //
    // 配合 per-session Sandbox（A 方案）：pod 数从「每 workspace 1 个」变成
    // 「每顶层会话组 1 个」，idle 窗口直接决定总 pod·h——4h 会让每个短会话都
    // 拖 4 小时空转。既然唤醒零代价，窗口就该收紧。
    sandboxIdlePauseMs: readIntEnv('ACS_SANDBOX_IDLE_PAUSE_MS', 5 * 60_000, { min: 0, max: 7 * 24 * 60 * 60_000 }),
    // 2026-08-12 曾磊拍板：per-session 后每天十几到几十个新会话会各自留下休眠盘，
    // 不能只按已复用会话的 24h 命中率定 TTL。过去 30 天全量模拟中 2h 仍保住
    // 92.0% 复用，同时把平均保留库存从 16.19 降至 2.34，故普通/Taskboard 改为 2h。
    sandboxTtlMs: readIntEnv('ACS_SANDBOX_TTL_MS', 2 * 60 * 60_000, { min: 0, max: 30 * 24 * 60 * 60_000 }),
    // CI 正常路径由 workflow EXIT trap 即时删除；1h 只兜底异常泄漏。
    sandboxCiTtlMs: readIntEnv('ACS_SANDBOX_CI_TTL_MS', 60 * 60_000, { min: 0, max: 30 * 24 * 60 * 60_000 }),
    sandboxOrphanGraceMs: readIntEnv('ACS_SANDBOX_ORPHAN_GRACE_MS', 30 * 60_000, { min: 0, max: 7 * 24 * 60 * 60_000 }),
    // 宽限默认 5min：正常 pause 收敛 <2min（生产实测），5min 足以避开瞬态；
    // 且必须小于发布门禁的等待窗口（acs-sandbox.yml 5.5 段 8min），否则门禁等不到自愈。
    sandboxBrokenRecycleGraceMs: readIntEnv('ACS_SANDBOX_BROKEN_RECYCLE_GRACE_MS', 5 * 60_000, { min: 0, max: 24 * 60 * 60_000 }),
    // 2026-08-10 曾磊拍板：不设业务使用配额，只保留高位全局安全阀 + 钉钉告警，
    // 用途是挡住 bug 风暴（如 07-28 一个 agent fan-out 9 个孙 agent 那类），
    // 而不是限制正常使用。旧默认 8/6 是 per-workspace 时代的值，per-session 下
    // 一个用户开 9 个会话就会撞顶。
    //
    // ⚠️ 前置条件：该值必须与 SNAT 能力匹配。`per-sandbox` 模式下每 pod 一条
    // SNAT 条目、超限直接 throw 且无降级，故高位安全阀只在 `shared-cidr`
    // （条目数由明确允许的网段数决定，与 pod 数解耦）下才真正可用。maxRunning 超限走 LRU pause 腾位、
    // 有优雅降级，是应该先撞上的那道墙。
    maxRunningSandboxes: readIntEnv('ACS_SANDBOX_MAX_RUNNING', 200, { min: 0, max: 1_000 }),
    warnRunningSandboxes: readIntEnv('ACS_SANDBOX_WARN_RUNNING', 150, { min: 0, max: 1_000 }),
    drainDeadlineMs: readIntEnv('ACS_ORCH_DRAIN_DEADLINE_MS', 120_000, { min: 1_000, max: 24 * 60 * 60_000 }),
    networkPolicy: parseNetworkPolicyFromEnv(process.env, 'ACS_NETWORK_POLICY', DEFAULT_CODING_HAND_NETWORK_POLICY),
    snat: {
      mode: snatMode,
      aliyunCliPath: process.env.ACS_ALIYUN_CLI_PATH?.trim() || 'aliyun',
      ...(snatRegionId ? { regionId: snatRegionId } : {}),
      ...(snatTableId ? { snatTableId } : {}),
      ...(snatIp ? { snatIp } : {}),
      ...(snatSharedCidrs.length > 0 ? {
        sharedCidr: snatSharedCidrs[0],
        sharedCidrs: snatSharedCidrs,
      } : {}),
      entryNamePrefix: process.env.ACS_SNAT_ENTRY_NAME_PREFIX?.trim() || 'agent-saas-acs',
      maxManagedEntries: snatMaxManagedEntries,
      requestTimeoutMs: readIntEnv('ACS_SNAT_REQUEST_TIMEOUT_MS', 20_000, { min: 1_000, max: 120_000 }),
      stabilizeAfterCreateMs: readIntEnv('ACS_SNAT_STABILIZE_AFTER_CREATE_MS', 8_000, { min: 0, max: 60_000 }),
      statusCacheMs: readIntEnv('ACS_SNAT_STATUS_CACHE_MS', 20_000, { min: 0, max: 300_000 }),
    },
    // 默认全关；实际值由 server 下发的 runtime-config 覆盖（下方 applyRuntimeConfigPatch）
    egress: defaultEgressConfig(),
    ...(runtimeConfigPath ? { runtimeConfigPath } : {}),
    alertWebhookUrls: (process.env.ACS_ALERT_WEBHOOK_URL ?? '')
      .split(',')
      .map((url) => url.trim())
      .filter((url) => url.length > 0),
    alertWebhookBearerToken: process.env.ACS_ALERT_WEBHOOK_BEARER_TOKEN?.trim() || undefined,
    alertMinIntervalMs: readIntEnv('ACS_ALERT_MIN_INTERVAL_MS', 5 * 60_000, { min: 0, max: 24 * 60 * 60_000 }),
    capabilities: readRuntimeCapabilities(),
    logLevel: readLogLevel(),
  };
  applyRuntimeConfigPatch(base, persistedRuntimeConfig);
  return base;
}
