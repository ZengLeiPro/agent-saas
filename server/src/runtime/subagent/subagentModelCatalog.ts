import type { EffortCapability } from '../../types/index.js';
import type { SubagentModelPolicy, SubagentModelResolver } from './subagentExecutionOptions.js';
import {
  resolveSubagentExecutionOptions,
  SubagentExecutionOptionsError,
} from './subagentExecutionOptions.js';

export interface SubagentCatalogModel {
  ref: string;
  name: string;
  description?: string;
  effort?: EffortCapability;
}

export interface SubagentBaseModelCatalog {
  defaultRef: string;
  models: SubagentCatalogModel[];
}

export interface SubagentVisibleModel extends SubagentCatalogModel {
  default: boolean;
  locked: boolean;
}

export function projectSubagentModelCatalog(input: {
  catalog: SubagentBaseModelCatalog;
  tenantId?: string;
  inheritedModelRef?: string;
  profileModel?: SubagentModelPolicy;
  workerModel?: SubagentModelPolicy;
  executionContextModelRef?: string;
}): SubagentVisibleModel[] {
  const byRef = new Map(input.catalog.models.map((model) => [model.ref, model]));
  const resolver: SubagentModelResolver = (ref) => {
    const model = byRef.get(ref);
    return model
      ? {
          model: ref,
          ...(model.effort ? { providerOptions: { reasoningEffortCapability: model.effort } } : {}),
        }
      : null;
  };
  const common = {
    tenantId: input.tenantId,
    modelResolver: resolver,
    inheritedModelRef: input.inheritedModelRef ?? input.catalog.defaultRef,
    profileModel: input.profileModel,
    workerModel: input.workerModel,
    executionContextModelRef: input.executionContextModelRef,
  };
  const effectiveDefault = resolveSubagentExecutionOptions(common);
  return input.catalog.models.flatMap((model) => {
    try {
      const resolved = resolveSubagentExecutionOptions({ ...common, requestedModelRef: model.ref });
      return [
        {
          ...model,
          default: resolved.resolvedModelRef === effectiveDefault.resolvedModelRef,
          locked: resolved.modelLocked,
        },
      ];
    } catch (error) {
      if (error instanceof SubagentExecutionOptionsError && error.code === 'MODEL_POLICY_CONFLICT')
        return [];
      throw error;
    }
  });
}

export function formatSubagentModelCatalog(models: SubagentVisibleModel[]): string {
  if (models.length === 0) return '当前场景没有可用的子 Agent 模型。';
  const rows = models.map((model) => {
    const effort =
      model.effort?.support === 'supported' && model.effort.values?.length
        ? `；effort=${model.effort.values.join('|')}${model.effort.defaultValue ? `（默认 ${model.effort.defaultValue}）` : ''}`
        : `；effort=${model.effort?.support ?? 'unknown'}`;
    return (
      `- ${model.ref}：${model.name}${model.description ? `，${model.description}` : ''}` +
      `${model.default ? '；默认' : ''}${model.locked ? '；锁定' : ''}${effort}`
    );
  });
  return ['当前可用的子 Agent 模型（已按组织与运行策略过滤）：', ...rows].join('\n');
}
