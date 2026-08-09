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
import { resolveModelRef } from './models.js';
import { configureModelPricing } from '../data/usage/pricing.js';
import type { TitleGeneratorConfig } from '../agent/titleGenerator.js';
import type { GuardrailModelConfig } from '../agent/guardrail.js';

/** applyModelsHotUpdate 需要写回的运行时切面；抽成最小接口便于测试。 */
export interface ModelsHotUpdateTarget {
  updateGuardrailModelConfigs: (next: GuardrailModelConfig[]) => void;
  titleGeneratorConfigs?: TitleGeneratorConfig[];
}

/**
 * 把一份新的 models 配置应用到当前进程。
 *
 * 派生链（门禁 / 标题生成）遵循「解析失败就保留原链」——热更新瞬时不应把已经
 * 工作的功能打挂。注意门禁必须排在标题之前重建：标题分支带 early-return，
 * 放在后面会被它吞掉。
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
    const nextGuardrail: GuardrailModelConfig[] = [];
    const mainGuardrail = resolveModelRef(merged, config.guardrail.model);
    if (mainGuardrail) {
      nextGuardrail.push({
        model: mainGuardrail.model,
        connection: mainGuardrail.connection,
      });
      for (const ref of config.guardrail.fallbackModels ?? []) {
        const fb = resolveModelRef(merged, ref);
        if (fb) nextGuardrail.push({ model: fb.model, connection: fb.connection });
      }
      target.updateGuardrailModelConfigs(nextGuardrail);
    }
  }

  if (!config.titleGenerator?.model) return;
  const next: TitleGeneratorConfig[] = [];
  const resolvedMain = resolveModelRef(merged, config.titleGenerator.model);
  if (!resolvedMain) return;
  next.push({ model: resolvedMain.model, connection: resolvedMain.connection });
  for (const ref of config.titleGenerator.fallbackModels ?? []) {
    const fb = resolveModelRef(merged, ref);
    if (fb) next.push({ model: fb.model, connection: fb.connection });
  }
  target.titleGeneratorConfigs = next;
}
