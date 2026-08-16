import type { AppConfig } from './config.js';
import { resolveWebToolsConfig } from './runtimeGovernanceCredentials.js';
import type { SecretVault } from '../security/secretVault.js';
import type { ResolvedWebToolsConfig } from '../agent/webToolProvider.js';

interface WebToolsRuntimeTarget {
  webTools?: ResolvedWebToolsConfig;
  toolControls?: AppConfig['toolControls'];
}

export type WebToolsRuntimeUpdater = (next: AppConfig['webTools']) => Promise<void>;

type ToolSettings = Pick<AppConfig, 'toolControls' | 'webTools'>;

/**
 * 把 webTools 配置解析成运行时形态（apiKeyRef → 明文）后替换执行侧配置。
 *
 * 管理端直写与跨进程刷新共用这一条路径。2026-08-16 把搜索源从腾讯换成智谱时，
 * config.json 与 ws-only 进程内存都已更新，但 runtime-worker 没有这条链路，
 * 仍用启动快照里的旧 provider，真实会话持续报旧供应商的鉴权错误。
 */
export function createWebToolsRuntimeUpdater(deps: {
  target: WebToolsRuntimeTarget;
  secretVault: SecretVault;
  logger?: { warn: (msg: string) => void };
}): WebToolsRuntimeUpdater {
  return async function applyWebToolsRuntimeUpdate(next: AppConfig['webTools']): Promise<void> {
    try {
      const resolved = await resolveWebToolsConfig(next, deps.secretVault);
      if (resolved) deps.target.webTools = resolved;
      else delete deps.target.webTools;
    } catch (err) {
      // 保留旧配置：一次坏凭据不应让正在服务的进程失去搜索能力。
      deps.logger?.warn(
        `webTools 运行时配置刷新失败，继续使用旧配置：${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  };
}

/**
 * 管理端保存工具设置后的运行时应用：更新内存 AppConfig，再把凭据解析结果写回执行侧配置。
 * 与跨进程刷新共用同一个 updater，避免两条路径走偏。
 */
export function createToolSettingsUpdater(deps: {
  config: ToolSettings;
  target: WebToolsRuntimeTarget;
  applyWebTools: WebToolsRuntimeUpdater;
}): (settings: ToolSettings) => Promise<void> {
  return async function updateToolSettingsConfig(settings: ToolSettings): Promise<void> {
    deps.config.toolControls = settings.toolControls;
    deps.config.webTools = settings.webTools;
    deps.target.toolControls = settings.toolControls;
    await deps.applyWebTools(settings.webTools);
  };
}
