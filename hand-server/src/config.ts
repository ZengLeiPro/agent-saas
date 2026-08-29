import { resolve } from 'node:path';
import {
  DEFAULT_ISOLATED_NETWORK_POLICY,
  parseNetworkPolicyFromEnv,
  type NetworkPolicyConfig,
} from 'server/runtime/networkPolicy.js';

export interface HandServerConfig {
  /** HTTP server 监听端口；默认 3300。 */
  port: number;
  /** HTTP server 监听地址；默认 127.0.0.1，Docker bridge/组织 ECS hand 可显式设 0.0.0.0。 */
  host: string;
  /** Bearer 鉴权 token；启动时必须配置，否则拒绝启动（防裸跑）。 */
  authToken: string;
  /**
   * 所有 workspaceId 都映射到 `${sandboxRoot}/${workspaceId}` 下。
   * 默认 `${HOME}/.ky-hand-server-sandbox`；启动时按需 mkdir。
   */
  sandboxRoot: string;
  workspace: {
    mode?: number;
    uid?: number;
    gid?: number;
  };
  /** Hand backend：本机直接跑（local）或 docker 容器（container）。默认 container。 */
  backend: 'local' | 'container';
  networkPolicy: NetworkPolicyConfig;
  container: {
    image?: string;
    dockerPath?: string;
    user?: string;
    memory?: string;
    cpus?: string;
    pidsLimit?: number;
    readOnly?: boolean;
    tmpfs?: string[];
    capDrop?: string[];
    securityOpt?: string[];
  };
  /** 日志 level。 */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /**
   * Durable Tool Invocation（TASK-316）：invocation journal 落盘目录。
   * `mode: 'memory'` 表示显式关闭持久化（退回纯内存行为，仅建议测试环境用）。
   * `explicit` = 目录由 HAND_INVOCATION_STORE_DIR 显式指定（init 失败时拒绝启动，
   * 而不是静默退化成内存模式）。
   */
  invocationStore:
    { mode: 'file'; dir: string; retentionMs: number; explicit: boolean } | { mode: 'memory' };
  /** SIGTERM drain：等待在途 invocation 收尾的最长时间；超时后强退。 */
  drainTimeoutMs: number;
}

function parseBoolEnv(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} 非法: ${process.env[name]}（仅支持 true/false）`);
}

function parseIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} 非法: ${raw}`);
  }
  return parsed;
}

function parseModeEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw.replace(/^0o/i, ''), 8);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0o777) {
    throw new Error(`${name} 非法: ${raw}（应为八进制权限，如 0770）`);
  }
  return parsed;
}

function parseListEnv(name: string, delimiter = ','): string[] | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  return raw
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveIntEnv(name: string): number | undefined {
  const parsed = parseIntEnv(name);
  if (parsed === undefined) return undefined;
  if (parsed <= 0) throw new Error(`${name} 非法: ${process.env[name]}（必须为正整数）`);
  return parsed;
}

export function loadConfigFromEnv(): HandServerConfig {
  const port = Number.parseInt(process.env.HAND_SERVER_PORT ?? '3300', 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`HAND_SERVER_PORT 非法: ${process.env.HAND_SERVER_PORT}`);
  }

  const authToken = process.env.HAND_SERVER_AUTH_TOKEN;
  if (!authToken || authToken.length < 8) {
    throw new Error('HAND_SERVER_AUTH_TOKEN 未配置或过短 (<8 chars)，拒绝启动');
  }

  const sandboxRoot = process.env.HAND_SERVER_SANDBOX_ROOT
    ? resolve(process.env.HAND_SERVER_SANDBOX_ROOT)
    : resolve(process.env.HOME ?? '/tmp', '.ky-hand-server-sandbox');

  const backendRaw = (process.env.HAND_SERVER_BACKEND ?? 'container').toLowerCase();
  if (backendRaw !== 'local' && backendRaw !== 'container') {
    throw new Error(`HAND_SERVER_BACKEND 非法: ${backendRaw}（仅支持 local / container）`);
  }

  const logLevel = (process.env.HAND_SERVER_LOG_LEVEL ?? 'info') as HandServerConfig['logLevel'];

  const invocationStoreRaw = process.env.HAND_INVOCATION_STORE_DIR?.trim();
  const invocationStore: HandServerConfig['invocationStore'] =
    invocationStoreRaw && ['memory', 'none', 'off'].includes(invocationStoreRaw.toLowerCase())
      ? { mode: 'memory' }
      : {
          mode: 'file',
          dir: invocationStoreRaw
            ? resolve(invocationStoreRaw)
            : resolve(process.env.HOME ?? '/tmp', '.ky-hand-server-invocations'),
          retentionMs: Math.max(
            60_000,
            parsePositiveIntEnv('HAND_INVOCATION_RETENTION_MS') ?? 24 * 60 * 60_000,
          ),
          explicit: Boolean(invocationStoreRaw),
        };
  const drainTimeoutMs = parsePositiveIntEnv('HAND_DRAIN_TIMEOUT_MS') ?? 30_000;

  return {
    port,
    host: process.env.HAND_SERVER_HOST?.trim() || '127.0.0.1',
    authToken,
    sandboxRoot,
    workspace: {
      mode: parseModeEnv('HAND_WORKSPACE_MODE'),
      uid: parseIntEnv('HAND_WORKSPACE_UID'),
      gid: parseIntEnv('HAND_WORKSPACE_GID'),
    },
    backend: backendRaw,
    networkPolicy: parseNetworkPolicyFromEnv(
      process.env,
      'HAND_NETWORK_POLICY',
      DEFAULT_ISOLATED_NETWORK_POLICY,
    ),
    container: {
      image:
        process.env.HAND_CONTAINER_IMAGE?.trim() ||
        process.env.KY_AGENT_CONTAINER_IMAGE?.trim() ||
        undefined,
      dockerPath: process.env.HAND_CONTAINER_DOCKER_PATH?.trim() || undefined,
      user: process.env.HAND_CONTAINER_USER?.trim() || undefined,
      memory: process.env.HAND_CONTAINER_MEMORY?.trim() || undefined,
      cpus: process.env.HAND_CONTAINER_CPUS?.trim() || undefined,
      pidsLimit: parseIntEnv('HAND_CONTAINER_PIDS_LIMIT'),
      readOnly: parseBoolEnv('HAND_CONTAINER_READ_ONLY'),
      tmpfs: parseListEnv('HAND_CONTAINER_TMPFS', ';'),
      capDrop: parseListEnv('HAND_CONTAINER_CAP_DROP'),
      securityOpt: parseListEnv('HAND_CONTAINER_SECURITY_OPT'),
    },
    logLevel,
    invocationStore,
    drainTimeoutMs,
  };
}
