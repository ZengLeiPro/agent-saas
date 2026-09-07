/**
 * 模型配置热更新的单一实现。
 *
 * 两个调用方共用这段逻辑，二者必须产生完全一致的内存状态：
 *   1. Web 进程 `PUT /api/admin/models` 写盘后立即应用（平台管理页保存即生效）；
 *   2. runtime-worker 进程发现 config.json 已被别的进程改写后应用
 *      （见 sharedConfigRefresher.ts）。
 *
 * 背景（2026-08-09 千问故障）：08-02 Web/Runtime Worker 解耦后，平台管理页新增的
 * 模型组只更新了收到该 HTTP 请求的 Web 进程内存，真正执行 run 的 runtime-worker
 * 仍持有启动快照，导致模型「下拉框能选、一发就报缺少 apiKey」。
 */
import type { AppConfig } from './config.js';
import type { ModelsConfig } from '../types/index.js';
import { configureModelPricing } from '../data/usage/pricing.js';
import type { TitleGeneratorConfig } from '../agent/titleGenerator.js';
import type { GuardrailModelConfig } from '../agent/guardrail.js';
import { resolveTitleGeneratorConfigs } from './titleGeneratorConfigs.js';
import { resolveGuardrailModelConfigs } from './guardrailModelConfigs.js';
import { resolveModelRefStrict } from './models.js';

/** applyModelsHotUpdate 需要写回的运行时切面；抽成最小接口便于测试。 */
export interface ModelsHotUpdateTarget {
  updateGuardrailModelConfigs: (next: GuardrailModelConfig[]) => void;
  /** 已生效的门禁链；跨进程热更新用它生成回滚快照，不能重解旧持久化配置。 */
  getGuardrailModelConfigs?: () => readonly GuardrailModelConfig[];
  titleGeneratorConfigs?: TitleGeneratorConfig[];
  /** titleGenerator 未配置/被删除时恢复与启动阶段一致的默认标题模型。 */
  defaultTitleModel?: string;
}

/**
 * 把一份新的 models 配置原子应用到当前进程。
 *
 * 派生链（门禁 / 标题生成）必须先完整解析；配置仍引用模型但派生链为空时拒绝
 * 整次更新，禁止 AppConfig/identity 已前进而执行侧仍保留旧链。
 */
export type ModelsHotUpdateCommit = () => void;

export interface ModelsHotUpdateTransaction {
  commit: ModelsHotUpdateCommit;
  rollback: ModelsHotUpdateCommit;
}

/** 启动与热更新共用同一套辅助模型引用门禁，禁止同一配置一边容忍、一边拒绝。 */
export function assertAuxiliaryModelRefsResolvable(config: AppConfig, models: ModelsConfig): void {
  const merged = { ...models, default: models.default };
  const chains = [
    ['guardrail', config.guardrail?.model, config.guardrail?.fallbackModels],
    ['title generator', config.titleGenerator?.model, config.titleGenerator?.fallbackModels],
  ] as const;
  for (const [label, primary, fallbacks] of chains) {
    const unresolved = primary
      ? [primary, ...(fallbacks ?? [])].filter((ref) => !resolveModelRefStrict(merged, ref))
      : [];
    if (unresolved.length > 0) {
      throw new Error(`${label} model chain cannot be resolved: ${unresolved.join(', ')}`);
    }
  }
}

/**
 * 先解析所有派生模型链，再返回只做同步赋值的 commit。这样解析异常发生在任何
 * 运行态改变之前，共享配置刷新器可以与其他切面一起提交。
 */
export function prepareModelsHotUpdate(params: {
  config: AppConfig;
  target: ModelsHotUpdateTarget;
  models: ModelsConfig;
}): ModelsHotUpdateCommit {
  const { config, target, models } = params;
  const merged = { ...models, default: models.default };
  assertAuxiliaryModelRefsResolvable(config, merged);
  const nextGuardrail = resolveGuardrailModelConfigs({ models: merged, guardrail: config.guardrail });
  const nextTitleGenerators = resolveTitleGeneratorConfigs({
    models: merged,
    titleGenerator: config.titleGenerator,
    defaultModel: target.defaultTitleModel,
  });

  return () => {
    configureModelPricing(models);
    target.updateGuardrailModelConfigs(nextGuardrail);
    if (target.titleGeneratorConfigs) {
      target.titleGeneratorConfigs.splice(
        0,
        target.titleGeneratorConfigs.length,
        ...nextTitleGenerators,
      );
    } else {
      target.titleGeneratorConfigs = nextTitleGenerators;
    }
  };
}

/**
 * 候选从新配置解析；回滚只恢复提交前已经生效的运行态快照。旧 config.json 可能
 * 含启动期曾容忍的悬空引用，不能为了修复它再次严格解析它，否则会形成恢复死锁。
 */
export function prepareModelsHotUpdateTransaction(params: {
  config: AppConfig;
  target: ModelsHotUpdateTarget;
  models: ModelsConfig;
  previousModels: ModelsConfig;
}): ModelsHotUpdateTransaction {
  const previousGuardrail = [...(params.target.getGuardrailModelConfigs?.() ?? [])];
  const previousTitleGenerators = [...(params.target.titleGeneratorConfigs ?? [])];
  const commit = prepareModelsHotUpdate(params);
  return {
    commit,
    rollback: () => {
      configureModelPricing(params.previousModels);
      params.target.updateGuardrailModelConfigs(previousGuardrail);
      if (params.target.titleGeneratorConfigs) {
        params.target.titleGeneratorConfigs.splice(
          0,
          params.target.titleGeneratorConfigs.length,
          ...previousTitleGenerators,
        );
      } else {
        params.target.titleGeneratorConfigs = previousTitleGenerators;
      }
    },
  };
}

export function applyModelsHotUpdate(params: {
  config: AppConfig;
  target: ModelsHotUpdateTarget;
  models: ModelsConfig;
}): void {
  prepareModelsHotUpdate(params)();
}
