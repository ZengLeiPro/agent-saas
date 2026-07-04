/**
 * ky-azeroth Personal Access Token 配置加载器
 *
 * 维护"(tenantId, agent 用户名) → ky-azeroth PAT"的静态映射，每次 dispatch
 * 时按当前 (user.tenantId, user.username) 查表并注入 AZEROTH_TOKEN /
 * AZEROTH_API_URL 到 SDK 子进程 env。
 *
 * 设计原则：
 *  - 配置文件路径放在 agent 项目内（被 sandbox `~/code` deny 覆盖，LLM 不可见）
 *  - 文件被 .gitignore，不入版本库
 *  - 每次调用同步读（文件 <1KB，无需缓存），改完立即生效
 *  - 查不到对应用户 → 不注入（CLI 会因缺 token 失败，符合"未授权"语义）
 *  - 配置文件不存在 / JSON 损坏 → 同样不注入，记 warn 日志后继续
 *
 * 配置文件格式 v2（多组织改造 PR 6 起，向后兼容 v1 扁平格式）：
 * v2 (新): {
 *   "azerothApiUrl": "http://azeroth-internal:3000",
 *   "tenants": {
 *     "kaiyan": {
 *       "tokens": {
 *         "huangyiping": {
 *           "token": "pat_xxx",
 *           "kyUsername": "13797075467",
 *           "employeeName": "黄艺萍",
 *           "roles": ["ADMIN"]
 *         },
 *         "huangsilin": "pat_yyy"
 *       }
 *     },
 *     "wain": {
 *       "tokens": { "li": "pat_zzz" }
 *     }
 *   }
 * }
 *
 * v1 (旧扁平格式，仍支持): {
 *   "azerothApiUrl": "...",
 *   "tokens": { "username": "pat_xxx" }
 * }
 * v1 内的所有 tokens 自动归到 legacy tenant（一次性迁移，运维可手动改 v2 后享受多组织隔离）。
 */

import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { createLogger } from '../../utils/logger.js';
import { LEGACY_TENANT_ID } from '../../data/tenants/types.js';

const logger = createLogger('azeroth-tokens');

type AzerothTokenEntry = string | {
  token?: string;
  /** ky-azeroth /users/me 返回的 username，通常是手机号或 admin */
  kyUsername?: string;
  /** ky-azeroth employee.id，用于更强校验；可选 */
  employeeId?: string;
  /** ky-azeroth employee.name，便于肉眼审计 */
  employeeName?: string;
  /** 期望角色 code，例如 ADMIN/SALES/PM/DEVELOPER */
  roles?: string[];
  /** 运维备注，不参与运行时判断 */
  note?: string;
};

interface AzerothTenantTokens {
  /** agent-saas username → ky-azeroth PAT 或带审计 metadata 的对象 */
  tokens?: Record<string, AzerothTokenEntry>;
}

interface AzerothTokensConfig {
  /** 默认 api url，可被 env AZEROTH_API_URL 覆盖 */
  azerothApiUrl?: string;
  /** v2 二级映射：tenantSlug → { tokens: { username → PAT } } */
  tenants?: Record<string, AzerothTenantTokens>;
  /** v1 兼容字段：扁平 username → PAT，自动归到 LEGACY_TENANT_ID */
  tokens?: Record<string, AzerothTokenEntry>;
}

export interface AzerothInjection {
  /** 注入到子进程 env 的 AZEROTH_TOKEN（PAT 明文） */
  token: string;
  /** 注入到子进程 env 的 AZEROTH_API_URL（可选） */
  apiUrl?: string;
}

export interface AzerothTokenBinding {
  tenantId: string;
  username: string;
  token: string;
  kyUsername?: string;
  employeeId?: string;
  employeeName?: string;
  roles?: string[];
  source: 'v2' | 'v1';
}

export interface AzerothTokenVerificationSummary {
  total: number;
  verified: number;
  mismatched: number;
  missingMetadata: number;
  failed: number;
  skipped: number;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface AzerothWhoamiResponse {
  username?: string;
  employee?: { id?: string; name?: string } | null;
  roles?: Array<{ code?: string }>;
}

/**
 * 配置文件路径解析。
 *
 * 优先 env AZEROTH_TOKENS_FILE（用于测试/生产 systemd），否则用项目内默认路径。
 * 默认路径 = `<repoRoot>/server/config/azeroth-tokens.json`。
 *
 * 注意：生产 release 会轮换，真实 PAT 文件建议通过 AZEROTH_TOKENS_FILE 指到
 * `/etc/agent-saas/azeroth-tokens.json` 一类稳定路径；默认路径主要服务本地开发。
 */
export function resolveAzerothTokensConfigPath(): string {
  const fromEnv = process.env['AZEROTH_TOKENS_FILE'];
  if (fromEnv) return fromEnv;
  return fileURLToPath(new URL('../../../config/azeroth-tokens.json', import.meta.url));
}

let _warnedMissing = false;
let _warnedParseError = false;

function loadConfig(): AzerothTokensConfig | null {
  const path = resolveAzerothTokensConfigPath();
  if (!existsSync(path)) {
    if (!_warnedMissing) {
      logger.warn('azeroth-tokens.json not found, ky-azeroth CLI 将无 PAT 注入', { path });
      _warnedMissing = true;
    }
    return null;
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as AzerothTokensConfig;
    return parsed;
  } catch (err) {
    if (!_warnedParseError) {
      logger.error('azeroth-tokens.json 解析失败', { path, err: String(err) });
      _warnedParseError = true;
    }
    return null;
  }
}

function normalizeTokenEntry(entry: AzerothTokenEntry | undefined): Omit<AzerothTokenBinding, 'tenantId' | 'username' | 'source'> | null {
  if (typeof entry === 'string') {
    const token = entry.trim();
    return token ? { token } : null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const token = typeof entry.token === 'string' ? entry.token.trim() : '';
  if (!token) return null;
  return {
    token,
    ...(typeof entry.kyUsername === 'string' && entry.kyUsername.trim()
      ? { kyUsername: entry.kyUsername.trim() }
      : {}),
    ...(typeof entry.employeeId === 'string' && entry.employeeId.trim()
      ? { employeeId: entry.employeeId.trim() }
      : {}),
    ...(typeof entry.employeeName === 'string' && entry.employeeName.trim()
      ? { employeeName: entry.employeeName.trim() }
      : {}),
    ...(Array.isArray(entry.roles)
      ? { roles: entry.roles.filter((role): role is string => typeof role === 'string' && role.trim().length > 0).map(role => role.trim()) }
      : {}),
  };
}

export function listAzerothTokenBindings(): AzerothTokenBinding[] {
  const config = loadConfig();
  if (!config) return [];
  const bindings: AzerothTokenBinding[] = [];

  for (const [tenantId, tenantConfig] of Object.entries(config.tenants ?? {})) {
    for (const [username, entry] of Object.entries(tenantConfig.tokens ?? {})) {
      const normalized = normalizeTokenEntry(entry);
      if (!normalized) continue;
      bindings.push({ tenantId, username, source: 'v2', ...normalized });
    }
  }

  for (const [username, entry] of Object.entries(config.tokens ?? {})) {
    const normalized = normalizeTokenEntry(entry);
    if (!normalized) continue;
    bindings.push({ tenantId: LEGACY_TENANT_ID, username, source: 'v1', ...normalized });
  }

  return bindings;
}

function buildUsersMeUrl(apiUrl: string): string {
  const base = apiUrl.replace(/\/+$/, '');
  return base.endsWith('/api/v1') ? `${base}/users/me` : `${base}/api/v1/users/me`;
}

function sameRoles(expected: string[] | undefined, actual: string[]): boolean {
  if (!expected || expected.length === 0) return true;
  const expectedSorted = [...expected].sort();
  const actualSorted = [...actual].sort();
  return expectedSorted.length === actualSorted.length
    && expectedSorted.every((role, idx) => role === actualSorted[idx]);
}

async function fetchWhoami(fetchFn: FetchLike, url: string, token: string, timeoutMs: number): Promise<AzerothWhoamiResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json() as AzerothWhoamiResponse;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyAzerothTokenMetadata(options: {
  fetchFn?: FetchLike;
  timeoutMs?: number;
} = {}): Promise<AzerothTokenVerificationSummary> {
  const config = loadConfig();
  const bindings = listAzerothTokenBindings();
  const summary: AzerothTokenVerificationSummary = {
    total: bindings.length,
    verified: 0,
    mismatched: 0,
    missingMetadata: 0,
    failed: 0,
    skipped: 0,
  };

  if (!config || bindings.length === 0) return summary;

  const apiUrl = config.azerothApiUrl || process.env['AZEROTH_API_URL'];
  if (!apiUrl) {
    summary.skipped = bindings.length;
    logger.warn('跳过 ky-azeroth PAT metadata 校验：未配置 azerothApiUrl/AZEROTH_API_URL');
    return summary;
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (!fetchFn) {
    summary.skipped = bindings.length;
    logger.warn('跳过 ky-azeroth PAT metadata 校验：当前运行时没有 fetch');
    return summary;
  }

  const url = buildUsersMeUrl(apiUrl);
  const timeoutMs = options.timeoutMs ?? 5_000;

  for (const binding of bindings) {
    const hasMetadata = Boolean(binding.kyUsername || binding.employeeId || binding.employeeName || binding.roles?.length);
    if (!hasMetadata) {
      summary.missingMetadata += 1;
      logger.warn('ky-azeroth PAT 缺少审计 metadata', {
        tenantId: binding.tenantId,
        username: binding.username,
      });
    }

    try {
      const me = await fetchWhoami(fetchFn, url, binding.token, timeoutMs);
      const actualRoles = Array.isArray(me.roles)
        ? me.roles.map(role => role.code).filter((role): role is string => typeof role === 'string')
        : [];
      const mismatches: string[] = [];
      if (binding.kyUsername && me.username !== binding.kyUsername) mismatches.push('kyUsername');
      if (binding.employeeId && me.employee?.id !== binding.employeeId) mismatches.push('employeeId');
      if (binding.employeeName && me.employee?.name !== binding.employeeName) mismatches.push('employeeName');
      if (!sameRoles(binding.roles, actualRoles)) mismatches.push('roles');

      if (mismatches.length > 0) {
        summary.mismatched += 1;
        logger.error('ky-azeroth PAT metadata 校验不一致', {
          tenantId: binding.tenantId,
          username: binding.username,
          fields: mismatches,
          expected: {
            kyUsername: binding.kyUsername,
            employeeId: binding.employeeId,
            employeeName: binding.employeeName,
            roles: binding.roles,
          },
          actual: {
            kyUsername: me.username,
            employeeId: me.employee?.id,
            employeeName: me.employee?.name,
            roles: actualRoles,
          },
        });
      } else {
        summary.verified += 1;
      }
    } catch (err) {
      summary.failed += 1;
      logger.error('ky-azeroth PAT metadata 校验失败', {
        tenantId: binding.tenantId,
        username: binding.username,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('ky-azeroth PAT metadata 校验完成', summary);
  return summary;
}

/**
 * 按 (tenantId, agent 用户名) 二级查 PAT 注入信息。
 * 查不到返回 null，调用方决定不注入即可。
 *
 * 查找顺序（多组织改造 PR 6）：
 *   1) v2 路径：config.tenants[tenantId].tokens[username]
 *   2) v1 兼容：当 tenantId === LEGACY_TENANT_ID 时，回退到 config.tokens[username]
 *      （存量部署只有 v1 扁平格式时让开沿日常组织继续工作）
 *
 * 跨组织串号防御：非默认组织的 username 不会回退到 v1 表，即使 v1 表里有同名 username，
 * wain/zengky 也拿不到 kaiyan/zengky 的 PAT。
 */
export function resolveAzerothInjection(tenantId: string, username: string): AzerothInjection | null {
  if (!username || !tenantId) return null;
  const config = loadConfig();
  if (!config) return null;

  // v2 二级查表
  let token = normalizeTokenEntry(config.tenants?.[tenantId]?.tokens?.[username])?.token;

  // v1 兼容：仅 legacy tenant 回退到扁平表
  if (!token && tenantId === LEGACY_TENANT_ID) {
    token = normalizeTokenEntry(config.tokens?.[username])?.token;
  }

  if (!token || token.trim().length === 0) return null;
  return {
    token: token.trim(),
    apiUrl: config.azerothApiUrl,
  };
}
