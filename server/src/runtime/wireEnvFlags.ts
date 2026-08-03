/**
 * Per-tenant wire 行为开关（2026-08-03 dws wrapper 灰度批）。
 *
 * 背景：tenantSharedEnv（`workspace-shared/<slug>/.ky-agent/settings.json`）只作用于
 * ServerLocal/Container 执行路径（buildTenantScopedEnv）；server-remote ACS hand 的
 * env 走 wire（buildTenantRemoteHandWireEnv → pickHandEnv → pod spawn env），历史上
 * 只带 AZEROTH 凭据。平台行为开关（如 KY_DWS_WRAPPER_ENABLE）需要按租户到达
 * ACS sandbox，因此从 tenantSharedEnv 中按**严格白名单**提取后随 wire 下发。
 *
 * 白名单纪律：只放「平台自有、非凭据、值为短开关」的 KY_ 前缀变量。凭据/密钥
 * 一律不进这里——wire 凭据走 resolveAzerothInjection / 连接器 Vault 路径。
 *
 * 进程语义：与 setConnectorDictionary 同模式的 module-level 注册；Web 与 Runtime
 * Worker 进程各自启动时经 runtime.ts 加载 tenantSharedEnv 后注册一次。settings.json
 * 变更本就需要重启生效，故无跨进程刷新需求。
 */

const WIRE_TENANT_FLAG_ALLOWLIST: ReadonlySet<string> = new Set([
  'KY_DWS_WRAPPER_ENABLE',
]);

let tenantWireFlags: Record<string, Record<string, string>> = {};

/** runtime 启动时注册：从 tenantSharedEnv 提取白名单内的开关。重复调用整体替换。 */
export function setTenantWireFlags(
  tenantSharedEnv: Record<string, Record<string, string>> | undefined | null,
): void {
  const next: Record<string, Record<string, string>> = {};
  for (const [slug, env] of Object.entries(tenantSharedEnv ?? {})) {
    for (const [key, value] of Object.entries(env)) {
      if (!WIRE_TENANT_FLAG_ALLOWLIST.has(key)) continue;
      if (typeof value !== 'string' || value.length === 0) continue;
      (next[slug] ??= {})[key] = value;
    }
  }
  tenantWireFlags = next;
}

/** wire env 装配时按租户读取；未配置返回空对象。 */
export function getTenantWireFlags(tenantId: string): Record<string, string> {
  const flags = tenantWireFlags[tenantId];
  return flags ? { ...flags } : {};
}

/** 测试用：清空注册状态。 */
export function resetTenantWireFlagsForTest(): void {
  tenantWireFlags = {};
}
