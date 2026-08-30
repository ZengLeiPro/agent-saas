import type { ModelProviderOptions } from '../types/index.js';
import type { RunRecord } from './runStore.js';
import type { RuntimeSessionRecord } from './sessionCatalog.js';
import type { RawRuntimeRunDispatchConfig } from './rawRuntimeRunDispatchTypes.js';

const DEFAULT_MODEL = 'gpt-5.4-mini';

type ModelResolutionConfig = Pick<
  RawRuntimeRunDispatchConfig,
  'modelResolver' | 'defaultModelResolver'
>;

export function resolveRuntimeModelRef(
  config: ModelResolutionConfig,
  requestedModel: string | undefined,
  tenantId?: string,
  hasExplicitConnection = false,
): string | undefined {
  if (requestedModel || hasExplicitConnection) return requestedModel;
  return config.defaultModelResolver?.(tenantId)?.ref;
}

export function resolveRuntimeModelOptions(
  config: Pick<RawRuntimeRunDispatchConfig, 'modelResolver'>,
  requestedModel: string | undefined,
  explicitConnection?: { apiKey?: string; baseUrl?: string },
  explicitProviderOptions?: ModelProviderOptions,
  tenantId?: string,
): {
  model: string;
  modelConnection?: { apiKey?: string; baseUrl?: string };
  modelProviderOptions?: ModelProviderOptions;
} {
  if (explicitConnection) {
    return {
      model: requestedModel || DEFAULT_MODEL,
      modelConnection: explicitConnection,
      ...(explicitProviderOptions ? { modelProviderOptions: explicitProviderOptions } : {}),
    };
  }
  if (requestedModel && config.modelResolver) {
    const resolved = config.modelResolver(requestedModel, tenantId);
    if (!resolved) throw new Error(`模型不可用：${requestedModel}`);
    return {
      model: resolved.model,
      ...(resolved.connection ? { modelConnection: resolved.connection } : {}),
      ...(resolved.providerOptions ? { modelProviderOptions: resolved.providerOptions } : {}),
    };
  }
  return { model: requestedModel || DEFAULT_MODEL };
}

export function resolveWakeModelRef(
  run: Pick<RunRecord, 'model' | 'metadata'>,
  session: Pick<RuntimeSessionRecord, 'modelRef'>,
): string | undefined {
  const persistedRef =
    typeof run.metadata?.modelRef === 'string' ? run.metadata.modelRef.trim() : '';
  return persistedRef || session.modelRef || run.model;
}
