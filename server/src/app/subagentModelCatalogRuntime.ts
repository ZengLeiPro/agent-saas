import type { TenantSettings } from '../data/tenants/types.js';
import type { ModelsConfig } from '../types/index.js';
import type { SubagentBaseModelCatalog } from '../runtime/subagent/subagentModelCatalog.js';
import { getTenantPublicModelList, resolveModelRef } from './models.js';

export function createSubagentModelCatalogGetter(input: {
  getRuntimeModels: () => ModelsConfig | undefined;
  getTenantSettings: (tenantId: string) => TenantSettings | undefined;
}): (tenantId: string | undefined) => SubagentBaseModelCatalog | null {
  return (tenantId) => {
    const models = input.getRuntimeModels();
    if (!models) return null;
    const visible = getTenantPublicModelList(
      models,
      tenantId ? input.getTenantSettings(tenantId) : undefined,
    );
    return {
      defaultRef: visible.default,
      models: visible.groups.flatMap((group) =>
        group.models.map((model) => {
          const ref = `${group.id}/${model.id}`;
          const resolved = resolveModelRef(models, ref);
          return {
            ref,
            name: model.name,
            ...(model.description ? { description: model.description } : {}),
            ...(resolved?.providerOptions?.reasoningEffortCapability
              ? { effort: resolved.providerOptions.reasoningEffortCapability }
              : {}),
          };
        }),
      ),
    };
  };
}
