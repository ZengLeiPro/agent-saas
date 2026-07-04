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
 *         "huangyiping": "pat_xxx",
 *         "huangsilin":  "pat_yyy"
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

interface AzerothTenantTokens {
  /** username → PAT 映射 */
  tokens?: Record<string, string>;
}

interface AzerothTokensConfig {
  /** 默认 api url，可被 env AZEROTH_API_URL 覆盖 */
  azerothApiUrl?: string;
  /** v2 二级映射：tenantSlug → { tokens: { username → PAT } } */
  tenants?: Record<string, AzerothTenantTokens>;
  /** v1 兼容字段：扁平 username → PAT，自动归到 LEGACY_TENANT_ID */
  tokens?: Record<string, string>;
}

export interface AzerothInjection {
  /** 注入到子进程 env 的 AZEROTH_TOKEN（PAT 明文） */
  token: string;
  /** 注入到子进程 env 的 AZEROTH_API_URL（可选） */
  apiUrl?: string;
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
  let token = config.tenants?.[tenantId]?.tokens?.[username];

  // v1 兼容：仅 legacy tenant 回退到扁平表
  if (!token && tenantId === LEGACY_TENANT_ID) {
    token = config.tokens?.[username];
  }

  if (!token || token.trim().length === 0) return null;
  return {
    token: token.trim(),
    apiUrl: config.azerothApiUrl,
  };
}
