import type { ModelsConfig } from '../types/index.js';
import type { ImageUnderstandingModelConfig } from '../runtime/imageUnderstanding.js';
import { resolveModelRef } from './models.js';

export function resolveImageUnderstandingModelConfigs(
  models: ModelsConfig | undefined,
): ImageUnderstandingModelConfig[] {
  const imageUnderstanding = models?.imageUnderstanding;
  if (!models || !imageUnderstanding) return [];
  return [imageUnderstanding.model, ...(imageUnderstanding.fallbackModels ?? [])]
    .filter((ref) => {
      const separator = ref.indexOf('/');
      if (separator < 1) return false;
      const groupId = ref.slice(0, separator);
      const modelId = ref.slice(separator + 1);
      return models.groups.some(
        (group) => group.id === groupId && group.models.some((model) => model.id === modelId),
      );
    })
    .map((ref) => resolveModelRef(models, ref))
    .filter((resolved): resolved is NonNullable<typeof resolved> => !!resolved)
    .map((resolved) => ({
      model: resolved.model,
      connection: resolved.connection,
      providerOptions: resolved.providerOptions,
    }));
}
