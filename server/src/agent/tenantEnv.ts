/**
 * 子进程 env 的多组织身份隔离装配（防御纵深，2026-06-22 落地）。
 *
 * 背景：
 *   raw runtime 的 ServerLocalExecutionProvider._runShellStreaming 历史上直接传
 *   `process.env` 给 spawn() 子进程，意味着 brain 启动时配置的默认组织凭据
 *   （AZEROTH_TOKEN / API keys）会被任何 server-local Shell 子进程直接继承。
 *
 *   当前 toolRuntime gate 已经把非平台用户挡在 server-local 之外
 *   （hasIsolatedExecution=false 时 throw），所以"组织用户读到平台 admin 的
 *   process.env"在产品语义下不会发生——但这是**单点防御**。一旦 gate 因
 *   sessionOwner.tenantId 缺失误判 fail-open、或未来重构被改坏，env 全继承会
 *   立即成为泄漏路径。
 *
 *   ContainerExecutionProvider 历史上则是另一面：默认 options.env={}，**完全没**
 *   给容器装配任何 env，导致非平台用户在容器里调 ky-azeroth CLI 拿不到 PAT
 *   （"未授权"）。
 *
 * 本模块统一两条路径的 env 装配规则：
 *   - 匿名（tenantId 缺失）：保留完整 process.env，兼容 cron / 内部 dispatch。
 *   - 所有明确 tenant（含 DEFAULT_TENANT_ID/admin）：先从 process.env 剔除敏感
 *     凭据；平台根组织再复原 sharedEnv 显式配置，非平台组织再按
 *     tenantSharedEnv[tenantId] 覆盖（per-tenant 显式配置），最后按
 *     (tenantId, username) 调 resolveAzerothInjection 注入。组织没配的密钥保持
 *     缺失 → 下游 CLI fail-closed 报"未授权"。
 *
 * 这条规则同时给 ServerLocalExecutionProvider（防御纵深）和
 * ContainerExecutionProvider（功能补齐：让组织用户在容器里能用 ky-azeroth）使用。
 */
import { resolveAzerothInjection } from '../integrations/azeroth/tokens.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { buildEnv, type AgentOptionsConfig } from './options.js';
import type { WorkspaceRef } from './toolRuntime.js';

/**
 * 必须从 process.env 起点删除的"凭据级" key 白名单。
 *
 * 规则：只剔除"可能漏组织的凭据"，PATH / NODE_ENV / LANG / HTTP_PROXY 等共享配置
 * 保留（删它们会破坏组织用户的工具链）。
 *
 * 新增凭据时记得加进来（任何 *_TOKEN / *_KEY / *_SECRET）；漏一个等于漏组织。
 */
const SENSITIVE_ENV_KEYS = [
  'AZEROTH_TOKEN',
  'AZEROTH_API_URL',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DASHSCOPE_API_KEY',
  'MOONSHOT_API_KEY',
  'BAIDU_API_KEY',
  'ZHIPU_API_KEY',
  'DEEPSEEK_API_KEY',
  'KIMI_API_KEY',
  'GROQ_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const;

const SENSITIVE_ENV_KEY_SET = new Set<string>(SENSITIVE_ENV_KEYS);
const SENSITIVE_ENV_KEY_PATTERNS = [
  /(^|_)API_KEY$/,
  /(^|_)TOKEN$/,
  /(^|_)SECRET$/,
  /(^|_)PASSWORD$/,
  /(^|_)PRIVATE_KEY$/,
  /(^|_)ACCESS_KEY$/,
] as const;

export interface TenantScopedEnvOptions {
  agentOptions: AgentOptionsConfig;
}

/**
 * 按 workspace tenant 装配子进程 env（ServerLocal / Container 共用同一规则）。
 *
 * @see {@link SENSITIVE_ENV_KEYS} 非平台组织的剔除列表
 * @see {@link resolveAzerothInjection} v2 二级查表
 */
export function buildTenantScopedEnv(
  options: TenantScopedEnvOptions,
  workspace: WorkspaceRef,
): Record<string, string> {
  const tenantId = workspace.tenantId;
  const isAnonymous = !tenantId;

  // 起点：buildEnv 已经把 process.env + sharedEnv + tenantSharedEnv[tenantId] + proxy 合并
  const env = buildEnv(options.agentOptions, tenantId);

  if (!isAnonymous) {
    // 明确 tenant：先剔除 process.env 漏进来的敏感凭据。平台根组织也不能
    // 因 platform admin 默认进容器而继承宿主全量密钥。
    stripSensitiveEnv(env);
    // 再重新合并显式配置（buildEnv 已经合过一次，但敏感剔除会顺带删掉显式配置）。
    if (tenantId === DEFAULT_TENANT_ID && options.agentOptions.sharedEnv) {
      for (const [k, v] of Object.entries(options.agentOptions.sharedEnv)) {
        env[k] = v;
      }
    }
    const tenantOverride = options.agentOptions.tenantSharedEnv?.[tenantId];
    if (tenantOverride) {
      for (const [k, v] of Object.entries(tenantOverride)) {
        env[k] = v;
      }
    }
  }

  // azeroth per-(tenantId, username) 注入（平台 / 非平台都查）
  if (workspace.username) {
    const lookupTenantId = tenantId ?? DEFAULT_TENANT_ID;
    const injection = resolveAzerothInjection(lookupTenantId, workspace.username);
    if (injection) {
      env['AZEROTH_TOKEN'] = injection.token;
      if (injection.apiUrl) env['AZEROTH_API_URL'] = injection.apiUrl;
    }
  }

  return env;
}

/** 给测试 / 外部诊断暴露用。生产代码请通过 buildTenantScopedEnv 间接消费。 */
export function listSensitiveEnvKeys(): readonly string[] {
  return SENSITIVE_ENV_KEYS;
}

function stripSensitiveEnv(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (isSensitiveEnvKey(key)) {
      delete env[key];
    }
  }
}

function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY_SET.has(key)
    || SENSITIVE_ENV_KEY_PATTERNS.some((pattern) => pattern.test(key));
}
