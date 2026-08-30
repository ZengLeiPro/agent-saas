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
 * 刷新点挂在解析器上而不是定时器上——这里是所有模型解析的唯一入口；异步候选提交
 * 期间同步解析器 fail closed，完成后的下一次解析使用新配置。未变化时只有节流 statSync。
 */
import type { AppConfig } from './config.js';
import { getTenantPublicModelList, isModelAllowedForTenant, resolveModelRef } from './models.js';
import type { TenantStore } from '../data/tenants/store.js';
import type { GuardrailModelConfig } from '../agent/guardrail.js';
import type { TitleGeneratorConfig } from '../agent/titleGenerator.js';
import { createSharedConfigRefresher, type SharedConfigRefresher } from './sharedConfigRefresher.js';
import { applyModelsHotUpdate, prepareModelsHotUpdate } from './modelsHotUpdate.js';
import type { WebToolsRuntimeUpdateCommit } from './webToolsRuntimeUpdate.js';
import type { SttRuntimeUpdateCommit } from './sttRuntimeUpdate.js';

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
  /** titleGenerator 缺省/被删除时与启动阶段一致的标题模型兜底。 */
  defaultTitleModel?: string;
  /** 模型配置跨进程刷新后，替换门禁模型链。 */
  onGuardrailModelConfigsUpdated: (next: GuardrailModelConfig[]) => void;
  /** config.json 中系统提示语先规范化，再返回无失败的注册表提交。 */
  prepareSystemPromptOverridesUpdate: (
    next: NonNullable<AppConfig['systemPrompts']>,
  ) => () => void;
  /** webTools 变化后准备无副作用的执行侧提交；配置候选确认后再原子应用。 */
  prepareWebToolsUpdate?: (
    next: AppConfig['webTools'],
  ) => WebToolsRuntimeUpdateCommit | Promise<WebToolsRuntimeUpdateCommit>;
  /** STT 变化后准备无副作用的执行侧提交；配置候选确认后再原子应用。 */
  prepareSttUpdate?: (
    next: AppConfig['stt'],
  ) => SttRuntimeUpdateCommit | Promise<SttRuntimeUpdateCommit>;
  initialRuntimeModels?: NonNullable<AppConfig['models']>;
  resolveRuntimeModels?: (
    next: NonNullable<AppConfig['models']>,
  ) => Promise<NonNullable<AppConfig['models']>>;
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
      ...(params.defaultTitleModel ? { defaultTitleModel: params.defaultTitleModel } : {}),
      updateGuardrailModelConfigs: params.onGuardrailModelConfigsUpdated,
    },
    prepareSystemPromptOverridesUpdate: params.prepareSystemPromptOverridesUpdate,
    ...(params.prepareWebToolsUpdate
      ? { prepareWebToolsUpdate: params.prepareWebToolsUpdate }
      : {}),
    ...(params.prepareSttUpdate ? { prepareSttUpdate: params.prepareSttUpdate } : {}),
    onModelsUpdated: async (nextConfig) => {
      if (!nextConfig.models) throw new Error('models 未配置');
      const resolved = params.resolveRuntimeModels
        ? await params.resolveRuntimeModels(nextConfig.models)
        : nextConfig.models;
      const commitDerivedModels = prepareModelsHotUpdate({
        config: nextConfig,
        target: {
          titleGeneratorConfigs: params.titleGeneratorConfigs,
          ...(params.defaultTitleModel ? { defaultTitleModel: params.defaultTitleModel } : {}),
          updateGuardrailModelConfigs: params.onGuardrailModelConfigsUpdated,
        },
        models: resolved,
      });
      return () => {
        runtimeModels = resolved;
        commitDerivedModels();
      };
    },
    ...(params.onConfigReloaded ? { onConfigReloaded: params.onConfigReloaded } : {}),
    ...(params.validateConfigReload ? { validateConfigReload: params.validateConfigReload } : {}),
    tenantStore,
    tenantsFilePath,
    logger,
  });

  // 同步 resolver 每次强制 stat；无法等待异步 prepare 时拒绝本次解析，避免旧密钥/权限。
  const refreshForSyncResolution = (): boolean => {
    const outcome = sharedConfigRefresher.refreshIfChanged(true);
    if (outcome instanceof Promise) {
      void outcome.catch((error) => logger?.warn(`[Models] 异步配置刷新失败：${String(error)}`));
      return false;
    }
    return outcome;
  };
  const modelResolver: ModelResolver | undefined = config.models
    ? (ref, tenantId) => {
        if (!refreshForSyncResolution() || !runtimeModels) return null;
        const tenantSettings = tenantId ? tenantStore?.getSettings(tenantId) : undefined;
        if (!isModelAllowedForTenant(runtimeModels, tenantSettings, ref)) return null;
        return resolveModelRef(runtimeModels, ref);
      }
    : undefined;

  const defaultModelResolver: DefaultModelResolver | undefined = config.models
    ? (tenantId) => {
        if (!refreshForSyncResolution()) return null;
        const tenantSettings = tenantId ? tenantStore?.getSettings(tenantId) : undefined;
        if (!runtimeModels) return null;
        const ref = getTenantPublicModelList(runtimeModels, tenantSettings).default
          || runtimeModels.default;
        const resolved = isModelAllowedForTenant(runtimeModels, tenantSettings, ref)
          ? resolveModelRef(runtimeModels, ref)
          : null;
        return resolved ? { ref, ...resolved } : null;
      }
    : undefined;

  return { modelResolver, defaultModelResolver, sharedConfigRefresher, updateModelsConfig };
}
