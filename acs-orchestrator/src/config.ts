import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  DEFAULT_CODING_HAND_NETWORK_POLICY,
  parseNetworkPolicyFromEnv,
  type NetworkPolicyConfig,
} from 'server/runtime/networkPolicy.js';

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
  skipProvisionOnSameRecipe: boolean;
  lifecycleEnabled: boolean;
  sandboxCleanupIntervalMs: number;
  sandboxIdlePauseMs: number;
  sandboxTtlMs: number;
  /**
   * 07-05：CI 临时 sandbox（名字以 `as-ws-ci-` 开头）走的短 TTL，覆盖 sandboxTtlMs。
   * CI sandbox 用完一次就没有复用价值，不该占 7 天 TTL 慢慢过期。默认 6h。
   * 设为 0 = 关闭这条特殊路径，回退到普通 sandboxTtlMs。
   */
  sandboxCiTtlMs: number;
  sandboxOrphanGraceMs: number;
  maxRunningSandboxes: number;
  warnRunningSandboxes: number;
  networkPolicy: NetworkPolicyConfig;
  snat: AcsSnatConfig;
  runtimeConfigPath?: string;
  alertWebhookUrl?: string;
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

export type AcsSnatMode = 'disabled' | 'probe-only' | 'per-sandbox';

export interface AcsSnatConfig {
  mode: AcsSnatMode;
  aliyunCliPath: string;
  regionId?: string;
  snatTableId?: string;
  snatIp?: string;
  entryNamePrefix: string;
  maxManagedEntries: number;
  requestTimeoutMs: number;
  stabilizeAfterCreateMs: number;
}

export interface AcsRuntimeConfigSnapshot {
  maxRunningSandboxes: number;
  warnRunningSandboxes: number;
  runtimeConfigPath?: string;
  persisted: boolean;
}

export interface AcsRuntimeConfigPatch {
  maxRunningSandboxes?: number;
  warnRunningSandboxes?: number;
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
  if (raw === 'disabled' || raw === 'probe-only' || raw === 'per-sandbox') return raw;
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
  validateRuntimeConfigValues(patch);
  return patch;
}

function parseRuntimeConfigInt(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  if (value < 0 || value > 1_000) throw new Error(`${name} must be between 0 and 1000`);
  return value;
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
  };
  validateRuntimeConfigValues(next);
  config.maxRunningSandboxes = next.maxRunningSandboxes;
  config.warnRunningSandboxes = next.warnRunningSandboxes;
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
  if (snatMode !== 'disabled' && (!snatRegionId || !snatTableId || !snatIp)) {
    throw new Error('ACS_SNAT_MODE 启用时必须配置 ACS_SNAT_REGION_ID / ACS_SNAT_TABLE_ID / ACS_SNAT_IP');
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
    skipProvisionOnSameRecipe: readBoolEnv('ACS_SKIP_PROVISION_ON_SAME_RECIPE', true),
    lifecycleEnabled: readBoolEnv('ACS_SANDBOX_LIFECYCLE_ENABLED', true),
    sandboxCleanupIntervalMs: readIntEnv('ACS_SANDBOX_CLEANUP_INTERVAL_MS', 60_000, { min: 10_000, max: 24 * 60 * 60_000 }),
    sandboxIdlePauseMs: readIntEnv('ACS_SANDBOX_IDLE_PAUSE_MS', 5 * 60_000, { min: 0, max: 7 * 24 * 60 * 60_000 }),
    sandboxTtlMs: readIntEnv('ACS_SANDBOX_TTL_MS', 7 * 24 * 60 * 60_000, { min: 0, max: 30 * 24 * 60 * 60_000 }),
    sandboxCiTtlMs: readIntEnv('ACS_SANDBOX_CI_TTL_MS', 6 * 60 * 60_000, { min: 0, max: 30 * 24 * 60 * 60_000 }),
    sandboxOrphanGraceMs: readIntEnv('ACS_SANDBOX_ORPHAN_GRACE_MS', 30 * 60_000, { min: 0, max: 7 * 24 * 60 * 60_000 }),
    maxRunningSandboxes: readIntEnv('ACS_SANDBOX_MAX_RUNNING', 8, { min: 0, max: 1_000 }),
    warnRunningSandboxes: readIntEnv('ACS_SANDBOX_WARN_RUNNING', 6, { min: 0, max: 1_000 }),
    networkPolicy: parseNetworkPolicyFromEnv(process.env, 'ACS_NETWORK_POLICY', DEFAULT_CODING_HAND_NETWORK_POLICY),
    snat: {
      mode: snatMode,
      aliyunCliPath: process.env.ACS_ALIYUN_CLI_PATH?.trim() || 'aliyun',
      ...(snatRegionId ? { regionId: snatRegionId } : {}),
      ...(snatTableId ? { snatTableId } : {}),
      ...(snatIp ? { snatIp } : {}),
      entryNamePrefix: process.env.ACS_SNAT_ENTRY_NAME_PREFIX?.trim() || 'agent-saas-acs',
      maxManagedEntries: readIntEnv('ACS_SNAT_MAX_MANAGED_ENTRIES', 12, { min: 1, max: 200 }),
      requestTimeoutMs: readIntEnv('ACS_SNAT_REQUEST_TIMEOUT_MS', 20_000, { min: 1_000, max: 120_000 }),
      stabilizeAfterCreateMs: readIntEnv('ACS_SNAT_STABILIZE_AFTER_CREATE_MS', 8_000, { min: 0, max: 60_000 }),
    },
    ...(runtimeConfigPath ? { runtimeConfigPath } : {}),
    alertWebhookUrl: process.env.ACS_ALERT_WEBHOOK_URL?.trim() || undefined,
    alertWebhookBearerToken: process.env.ACS_ALERT_WEBHOOK_BEARER_TOKEN?.trim() || undefined,
    alertMinIntervalMs: readIntEnv('ACS_ALERT_MIN_INTERVAL_MS', 5 * 60_000, { min: 0, max: 24 * 60 * 60_000 }),
    capabilities: readRuntimeCapabilities(),
    logLevel: readLogLevel(),
  };
  applyRuntimeConfigPatch(base, persistedRuntimeConfig);
  return base;
}
