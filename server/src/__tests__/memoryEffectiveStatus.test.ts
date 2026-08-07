import { describe, expect, it } from 'vitest';

import { resolveTenantMemoryFeatureStatus } from '../memory/effectiveStatus.js';

const allConfigured = {
  memoryPollingEnabled: true,
  memoryConsolidationEnabled: true,
  memoryWriteDelegationEnabled: true,
};

describe('resolveTenantMemoryFeatureStatus', () => {
  it('平台与运行时均可用：三个租户开关实际生效', () => {
    expect(resolveTenantMemoryFeatureStatus({
      features: allConfigured,
      platformPollingEnabled: true,
      pollingRuntimeAvailable: true,
      platformConsolidationEnabled: true,
      consolidationRuntimeAvailable: true,
    })).toEqual({
      memoryPollingEnabled: { configured: true, effective: true },
      memoryConsolidationEnabled: { configured: true, effective: true },
      memoryWriteDelegationEnabled: { configured: true, effective: true },
    });
  });

  it('租户已开但平台总开关关闭：保留 configured=true，明确标记未生效', () => {
    const status = resolveTenantMemoryFeatureStatus({
      features: allConfigured,
      platformPollingEnabled: false,
      pollingRuntimeAvailable: true,
      platformConsolidationEnabled: false,
      consolidationRuntimeAvailable: true,
    });
    expect(status.memoryPollingEnabled).toEqual({
      configured: true,
      effective: false,
      blockedBy: 'platform_disabled',
    });
    expect(status.memoryConsolidationEnabled).toEqual({
      configured: true,
      effective: false,
      blockedBy: 'platform_disabled',
    });
    expect(status.memoryWriteDelegationEnabled).toEqual({
      configured: true,
      effective: false,
      blockedBy: 'platform_disabled',
    });
  });

  it('运行时依赖不可用：不把配置开关冒充为实际运行', () => {
    const status = resolveTenantMemoryFeatureStatus({
      features: allConfigured,
      platformPollingEnabled: true,
      pollingRuntimeAvailable: false,
      platformConsolidationEnabled: true,
      consolidationRuntimeAvailable: false,
    });
    expect(status.memoryPollingEnabled.blockedBy).toBe('runtime_unavailable');
    expect(status.memoryConsolidationEnabled.blockedBy).toBe('runtime_unavailable');
    expect(status.memoryWriteDelegationEnabled.blockedBy).toBe('runtime_unavailable');
  });

  it('非法旧配置 delegation=true/consolidation=false：依赖未满足', () => {
    const status = resolveTenantMemoryFeatureStatus({
      features: { memoryWriteDelegationEnabled: true, memoryConsolidationEnabled: false },
      platformPollingEnabled: true,
      pollingRuntimeAvailable: true,
      platformConsolidationEnabled: true,
      consolidationRuntimeAvailable: true,
    });
    expect(status.memoryWriteDelegationEnabled).toEqual({
      configured: true,
      effective: false,
      blockedBy: 'dependency_disabled',
    });
  });

  it('租户未开启：不附加误导性的阻断原因', () => {
    const status = resolveTenantMemoryFeatureStatus({
      features: undefined,
      platformPollingEnabled: false,
      pollingRuntimeAvailable: false,
      platformConsolidationEnabled: false,
      consolidationRuntimeAvailable: false,
    });
    expect(status.memoryPollingEnabled).toEqual({ configured: false, effective: false });
    expect(status.memoryConsolidationEnabled).toEqual({ configured: false, effective: false });
    expect(status.memoryWriteDelegationEnabled).toEqual({ configured: false, effective: false });
  });
});
