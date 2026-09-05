import type { AppConfig } from './config.js';
import { resolveWebToolsConfig } from './runtimeGovernanceCredentials.js';
import { CredentialResolutionError } from '../security/credentialResolutionError.js';
import type { SecretVault } from '../security/secretVault.js';
import type { ResolvedWebToolsConfig } from '../agent/webToolProvider.js';

interface WebToolsRuntimeTarget {
  webTools?: ResolvedWebToolsConfig;
  toolControls?: AppConfig['toolControls'];
}

export type WebToolsRuntimeUpdateCommit = () => void;
export type WebToolsRuntimeUpdatePreparer = (
  next: AppConfig['webTools'],
) => Promise<WebToolsRuntimeUpdateCommit>;
export type WebToolsRuntimeUpdater = (next: AppConfig['webTools']) => Promise<void>;

type ToolSettings = Pick<AppConfig, 'toolControls' | 'webTools'>;

/**
 * 先解析 webTools 凭据、但不改执行侧；调用方确认候选配置仍有效后再同步 commit。
 * 这样跨进程热更新可以把 AppConfig、执行配置和 observed identity 放在同一发布点。
 */
export function createWebToolsRuntimeUpdatePreparer(deps: {
  target: WebToolsRuntimeTarget;
  secretVault: SecretVault;
  logger?: { warn: (msg: string) => void };
}): WebToolsRuntimeUpdatePreparer {
  return async function prepareWebToolsRuntimeUpdate(
    next: AppConfig['webTools'],
  ): Promise<WebToolsRuntimeUpdateCommit> {
    try {
      const resolved = await resolveWebToolsConfig(next, deps.secretVault);
      return () => {
        if (resolved) deps.target.webTools = resolved;
        else delete deps.target.webTools;
      };
    } catch (err) {
      const detail = err instanceof CredentialResolutionError
        ? `${err.code} field=${err.field}`
        : 'UNEXPECTED_RUNTIME_CONFIG_ERROR';
      deps.logger?.warn(`webTools 运行时配置刷新失败，继续使用旧配置：${detail}`);
      throw err;
    }
  };
}

/** 把准备与提交封装成管理端直写所需的一步式 updater。 */
export function createWebToolsRuntimeUpdater(deps: {
  target: WebToolsRuntimeTarget;
  secretVault: SecretVault;
  logger?: { warn: (msg: string) => void };
}): WebToolsRuntimeUpdater {
  const prepare = createWebToolsRuntimeUpdatePreparer(deps);
  return async function applyWebToolsRuntimeUpdate(next: AppConfig['webTools']): Promise<void> {
    const commit = await prepare(next);
    commit();
  };
}

/**
 * 管理端保存工具设置后的运行时应用：先完成凭据解析与执行侧提交，成功后再更新
 * AppConfig/toolControls；失败时三者都保留旧值。
 */
export function createToolSettingsUpdater(deps: {
  config: ToolSettings;
  target: WebToolsRuntimeTarget;
  applyWebTools: WebToolsRuntimeUpdater;
}): (settings: ToolSettings) => Promise<void> {
  return async function updateToolSettingsConfig(settings: ToolSettings): Promise<void> {
    await deps.applyWebTools(settings.webTools);
    deps.config.toolControls = settings.toolControls;
    deps.config.webTools = settings.webTools;
    deps.target.toolControls = settings.toolControls;
  };
}
