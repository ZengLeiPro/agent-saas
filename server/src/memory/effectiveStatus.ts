import type {
  TenantMemoryFeatureStatus,
  TenantMemoryFeatureStatusMap,
  TenantSettings,
} from '../../../shared/src/types/tenant.js';

export interface ResolveTenantMemoryFeatureStatusInput {
  features: Partial<TenantSettings['features']> | undefined;
  platformPollingEnabled: boolean;
  pollingRuntimeAvailable: boolean;
  platformConsolidationEnabled: boolean;
  consolidationRuntimeAvailable: boolean;
}

function resolveIndependentFeature(
  configured: boolean,
  platformEnabled: boolean,
  runtimeAvailable: boolean,
): TenantMemoryFeatureStatus {
  if (!configured) return { configured: false, effective: false };
  if (!platformEnabled) return { configured: true, effective: false, blockedBy: 'platform_disabled' };
  if (!runtimeAvailable) return { configured: true, effective: false, blockedBy: 'runtime_unavailable' };
  return { configured: true, effective: true };
}

/**
 * 只描述配置层是否实际生效，不把“用户近期无活动”等单次执行条件冒充为租户状态。
 * 三项状态共用这一权威解析，避免 API 展示与 Runtime 门禁各写一套布尔表达式。
 */
export function resolveTenantMemoryFeatureStatus(
  input: ResolveTenantMemoryFeatureStatusInput,
): TenantMemoryFeatureStatusMap {
  const pollingConfigured = input.features?.memoryPollingEnabled === true;
  const consolidationConfigured = input.features?.memoryConsolidationEnabled === true;
  const delegationConfigured = input.features?.memoryWriteDelegationEnabled === true;

  const polling = resolveIndependentFeature(
    pollingConfigured,
    input.platformPollingEnabled,
    input.pollingRuntimeAvailable,
  );
  const consolidation = resolveIndependentFeature(
    consolidationConfigured,
    input.platformConsolidationEnabled,
    input.consolidationRuntimeAvailable,
  );

  let delegation: TenantMemoryFeatureStatus;
  if (!delegationConfigured) {
    delegation = { configured: false, effective: false };
  } else if (!input.platformConsolidationEnabled) {
    delegation = { configured: true, effective: false, blockedBy: 'platform_disabled' };
  } else if (!input.consolidationRuntimeAvailable) {
    delegation = { configured: true, effective: false, blockedBy: 'runtime_unavailable' };
  } else if (!consolidationConfigured) {
    delegation = { configured: true, effective: false, blockedBy: 'dependency_disabled' };
  } else {
    delegation = { configured: true, effective: true };
  }

  return {
    memoryPollingEnabled: polling,
    memoryConsolidationEnabled: consolidation,
    memoryWriteDelegationEnabled: delegation,
  };
}
