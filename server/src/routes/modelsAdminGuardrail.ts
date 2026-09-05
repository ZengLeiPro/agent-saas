import type { AppConfig, GuardrailAppConfig, ModelsConfig } from '../app/config.js';
import { resolveModelRefStrict } from '../app/models.js';

/** 修复存量悬空引用时沿用运行时已经使用的 default；本次删除有效引用仍必须拒绝。 */
export function guardrailForModelsUpdate(
  current: AppConfig,
  models: ModelsConfig,
  submitted?: GuardrailAppConfig,
): GuardrailAppConfig | undefined {
  const guardrail = submitted ?? current.guardrail;
  if (!guardrail || !current.models) return guardrail;
  const previousModels = current.models;
  const previousRefs = new Set(
    current.guardrail ? [current.guardrail.model, ...(current.guardrail.fallbackModels ?? [])] : [],
  );
  let repaired = false;
  const chain = [guardrail.model, ...(guardrail.fallbackModels ?? [])].map((ref) => {
    if (
      !previousRefs.has(ref) ||
      resolveModelRefStrict(previousModels, ref) ||
      resolveModelRefStrict(models, ref)
    )
      return ref;
    repaired = true;
    return previousModels.default;
  });
  if (!repaired) return guardrail;
  return { ...guardrail, model: chain[0]!, fallbackModels: [...new Set(chain)].slice(1) };
}

export function validateGuardrailModels(
  models: ModelsConfig,
  guardrail: GuardrailAppConfig | undefined,
): void {
  if (!guardrail) return;
  const chain = [guardrail.model, ...(guardrail.fallbackModels ?? [])];
  if (new Set(chain).size !== chain.length) throw new Error('门禁模型链不能包含重复模型');
  for (const ref of chain) {
    const resolved = resolveModelRefStrict(models, ref);
    if (!resolved) throw new Error(`门禁模型引用不存在：${ref}`);
    if (resolved.providerOptions?.protocol === 'responses')
      throw new Error(`门禁模型仅支持 Chat Completions：${ref}`);
  }
}
