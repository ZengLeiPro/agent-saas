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

/** applyModelsHotUpdate 需要写回的运行时切面；抽成最小接口便于测试。 */
export interface ModelsHotUpdateTarget {
  updateGuardrailModelConfigs: (next: GuardrailModelConfig[]) => void;
  titleGeneratorConfigs?: TitleGeneratorConfig[];
}

/**
 * 把一份新的 models 配置应用到当前进程。
 *
 * 派生链（门禁 / 标题生成）遵循「解析失败就保留原链」——热更新瞬时不应把已经
 * 工作的功能打挂。标题数组原地替换，保证已经持有引用的消费方也能看到新配置。
 */
export function applyModelsHotUpdate(params: {
  config: AppConfig;
  target: ModelsHotUpdateTarget;
  models: ModelsConfig;
}): void {
  const { config, target, models } = params;

  configureModelPricing(models);
  const merged = { ...models, default: models.default };

  if (config.guardrail?.model) {
    const nextGuardrail = resolveGuardrailModelConfigs({ models: merged, guardrail: config.guardrail });
    if (nextGuardrail.length > 0) target.updateGuardrailModelConfigs(nextGuardrail);
  }

  const next = resolveTitleGeneratorConfigs({ models: merged, titleGenerator: config.titleGenerator });
  if (next.length > 0) {
    if (target.titleGeneratorConfigs) target.titleGeneratorConfigs.splice(0, target.titleGeneratorConfigs.length, ...next);
    else target.titleGeneratorConfigs = next;
  }
}
