/**
 * 模型解析器工厂。
 *
 * 从 runtime.ts 抽出：解析器本身要跟「跨进程配置刷新」绑在一起才正确，两者放在
 * 同一个模块比散在 3700 行的 runtime.ts 里更好维护。
 *
 * 为什么解析前要对齐磁盘（2026-08-09 千问故障）：平台管理页由 ws-only 进程写
 * config.json / tenants.json，但 run 由 runtime-worker 进程执行。不刷新的话，
 * 新增模型会「下拉框能选、一发就报缺少 apiKey」，直到 worker 重启。
 *
 * 刷新点挂在解析器上而不是定时器上——这里是所有模型解析的唯一入口，能做到强一致
 * 无延迟窗口；未变化时开销只是一次受节流保护的 statSync。
 */
import type { AppConfig } from './config.js';
import { getTenantPublicModelList, isModelAllowedForTenant, resolveModelRef } from './models.js';
import type { TenantStore } from '../data/tenants/store.js';
import type { GuardrailModelConfig } from '../agent/guardrail.js';
import type { TitleGeneratorConfig } from '../agent/titleGenerator.js';
import { createSharedConfigRefresher, type SharedConfigRefresher } from './sharedConfigRefresher.js';
import { applyModelsHotUpdate } from './modelsHotUpdate.js';

export type ModelResolver = (
  ref: string,
  tenantId?: string,
) => ReturnType<typeof resolveModelRef> | null;

export type DefaultModelResolver = (
  tenantId?: string,
) => ({ ref: string } & NonNullable<ReturnType<typeof resolveModelRef>>) | null;

export interface ModelResolvers {
  modelResolver: ModelResolver | undefined;
  defaultModelResolver: DefaultModelResolver | undefined;
  sharedConfigRefresher: SharedConfigRefresher;
  updateModelsConfig: (models: NonNullable<AppConfig['models']>) => Promise<void>;
}

export function createModelResolvers(params: {
  config: AppConfig;
  processCwd: string;
  tenantStore?: TenantStore;
  tenantsFilePath?: string;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
  /** 已装配给 WebChannel / 会话路由的标题模型链；刷新时原地替换内容。 */
  titleGeneratorConfigs: TitleGeneratorConfig[];
  /** 模型配置跨进程刷新后，替换门禁模型链。 */
  onGuardrailModelConfigsUpdated: (next: GuardrailModelConfig[]) => void;
  /** config.json 中系统提示语覆盖变化后，刷新当前进程注册表。 */
  onSystemPromptOverridesUpdated: (next: NonNullable<AppConfig['systemPrompts']>) => void;
  /** webTools 变化后重新解析凭据并替换执行进程的运行时配置。 */
  onWebToolsUpdated?: (next: AppConfig['webTools']) => void;
  /** STT 变化后重新解析凭据并替换执行进程的 AudioTranscribe 配置。 */
  onSttUpdated?: (next: AppConfig['stt']) => void;
  initialRuntimeModels?: NonNullable<AppConfig['models']>;
  resolveRuntimeModels?: (next: NonNullable<AppConfig['models']>) => Promise<NonNullable<AppConfig['models']>>;
  /** config 文件重载成功后的回调（TASK-318：observed config identity 重算）。 */
  onConfigReloaded?: () => void;
  /** config 文件应用前的安全门禁（Production inline secret / ref version fail closed）。 */
  validateConfigReload?: (next: AppConfig) => void | Promise<void>;
}): ModelResolvers {
  const { config, processCwd, tenantStore, tenantsFilePath, logger } = params;

  let runtimeModels = params.initialRuntimeModels ?? config.models;
  const updateModelsConfig = async (models: NonNullable<AppConfig['models']>): Promise<void> => {
    const resolved = params.resolveRuntimeModels ? await params.resolveRuntimeModels(models) : models;
    runtimeModels = resolved;
    applyModelsHotUpdate({ config, target: {
      titleGeneratorConfigs: params.titleGeneratorConfigs,
      updateGuardrailModelConfigs: params.onGuardrailModelConfigsUpdated,
    }, models: resolved });
  };

  const sharedConfigRefresher = createSharedConfigRefresher({
    config,
    processCwd,
    target: {
      titleGeneratorConfigs: params.titleGeneratorConfigs,
      updateGuardrailModelConfigs: params.onGuardrailModelConfigsUpdated,
    },
    onSystemPromptOverridesUpdated: params.onSystemPromptOverridesUpdated,
    ...(params.onWebToolsUpdated ? { onWebToolsUpdated: params.onWebToolsUpdated } : {}),
    ...(params.onSttUpdated ? { onSttUpdated: params.onSttUpdated } : {}),
    onModelsUpdated: (next) => {
      void updateModelsConfig(next).catch((error) => logger?.warn(
        `[SharedConfig] 模型 SecretRef 解析失败，继续使用上一份运行时模型快照：${error instanceof Error ? error.message : String(error)}`,
      ));
    },
    ...(params.onConfigReloaded ? { onConfigReloaded: params.onConfigReloaded } : {}),
    ...(params.validateConfigReload ? { validateConfigReload: params.validateConfigReload } : {}),
    tenantStore,
    tenantsFilePath,
    logger,
  });

  const modelResolver: ModelResolver | undefined = config.models
    ? (ref, tenantId) => {
        sharedConfigRefresher.refreshIfChanged();
        const tenantSettings = tenantId ? tenantStore?.getSettings(tenantId) : undefined;
        if (!runtimeModels || !isModelAllowedForTenant(runtimeModels, tenantSettings, ref)) return null;
        return resolveModelRef(runtimeModels, ref);
      }
    : undefined;

  const defaultModelResolver: DefaultModelResolver | undefined = config.models
    ? (tenantId) => {
        sharedConfigRefresher.refreshIfChanged();
        const tenantSettings = tenantId ? tenantStore?.getSettings(tenantId) : undefined;
        if (!runtimeModels) return null;
        const ref = getTenantPublicModelList(runtimeModels, tenantSettings).default
          || runtimeModels.default;
        const resolved = modelResolver?.(ref, tenantId);
        return resolved ? { ref, ...resolved } : null;
      }
    : undefined;

  return { modelResolver, defaultModelResolver, sharedConfigRefresher, updateModelsConfig };
}
