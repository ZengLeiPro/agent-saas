/**
 * OpenAI Agents runtime option helpers.
 *
 * 这里不再构造 Claude Agent SDK options，只保留平台级环境变量合并逻辑。
 *
 * 多组织改造 PR 6 P0-5：
 *   - sharedEnv 是平台共享环境变量（v1 兼容路径 `workspace-shared/.ky-agent/settings.json`
 *     直接加载；当前仅平台根组织会在敏感 env 剥离后复原）
 *   - tenantSharedEnv[<tenantSlug>] 是 per-tenant 覆盖（v2 路径
 *     `workspace-shared/<tenantSlug>/.ky-agent/settings.json`）
 *   - buildEnv(config, tenantId) 优先取 tenantSharedEnv[tenantId]，未配置 fallback
 *     到 sharedEnv（防止漏配 tenant 时仍有可用 env）
 *   - 关键密钥（如 DASHSCOPE_API_KEY）建议**只放 per-tenant**，不放共享 fallback，
 *     防止"漏配回退到默认 → 烧默认组织额度"。
 */

import type { ProxyConfig, AgentConfig } from '../types/index.js';

export interface AgentOptionsConfig {
  proxy?: ProxyConfig;
  agent: AgentConfig;
  /** 平台共享 env，等价于 v1 单文件加载结果。 */
  sharedEnv?: Record<string, string>;
  /** Per-tenant env 覆盖：tenantSlug → env。优先级高于 sharedEnv。 */
  tenantSharedEnv?: Record<string, Record<string, string>>;
  sharedDir?: string;
}

/**
 * 多组织改造 PR 6：tenantId 优先 → tenantSharedEnv[tenantId]，否则 fallback sharedEnv。
 * 不传 tenantId 时按旧行为只取 sharedEnv（向后兼容无 tenant 入口）。
 */
export function buildEnv(config: AgentOptionsConfig, tenantId?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }

  // PR 6 P0-5：先合并 default 共享 env（提供 fallback 基础），再用 tenant 覆盖
  if (config.sharedEnv) {
    for (const [key, value] of Object.entries(config.sharedEnv)) {
      env[key] = value;
    }
  }
  if (tenantId && config.tenantSharedEnv?.[tenantId]) {
    for (const [key, value] of Object.entries(config.tenantSharedEnv[tenantId])) {
      env[key] = value;
    }
  }

  if (config.proxy) {
    if (config.proxy.HTTP_PROXY) {
      env.HTTP_PROXY = config.proxy.HTTP_PROXY;
      env.http_proxy = config.proxy.HTTP_PROXY;
    }
    if (config.proxy.HTTPS_PROXY) {
      env.HTTPS_PROXY = config.proxy.HTTPS_PROXY;
      env.https_proxy = config.proxy.HTTPS_PROXY;
    }
    if (config.proxy.NO_PROXY) {
      env.NO_PROXY = config.proxy.NO_PROXY;
      env.no_proxy = config.proxy.NO_PROXY;
    }
  }

  return env;
}
