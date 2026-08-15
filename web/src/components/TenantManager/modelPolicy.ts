import { governanceAccessApi } from "@agent/shared/lib/governanceApi";
import type { TenantSettings } from "./types";

export function cloneTenantSettings(settings: TenantSettings): TenantSettings {
  return {
    features: { ...settings.features },
    quotas: { ...settings.quotas },
    models: {
      ...settings.models,
      allowedModels: [...settings.models.allowedModels],
      displayOverrides: { ...(settings.models.displayOverrides ?? {}) },
    },
    mcp: {
      ...settings.mcp,
      defaultEnabledServerIds: [...settings.mcp.defaultEnabledServerIds],
    },
    branding: { ...settings.branding },
    personalization: { ...settings.personalization },
    security: { ...settings.security },
  };
}

interface ModelEntitlementScope {
  resourceType: string;
  mode: "all" | "selected";
  resourceIds: string[];
  version: number;
}

export interface TenantEntitlementsResponse {
  scopes: ModelEntitlementScope[];
}

interface ModelScopePreview {
  previewId: string;
  baselineDigest: string;
  expiresAt: string;
  impact: {
    nextVersion: number;
    blockers: string[];
  };
}

export async function saveTenantModelScope(
  tenantId: string,
  scopeVersion: number,
  allowedModels: string[],
): Promise<number> {
  const resourceIds = [...new Set(allowedModels)].sort();
  const command = {
    expectedVersion: scopeVersion,
    mode: resourceIds.length > 0 ? "selected" : "all",
    resourceIds,
  };
  const preview = await governanceAccessApi.previewEntitlementScope<ModelScopePreview>("model", command, tenantId);
  if (preview.impact.blockers.length > 0) {
    throw new Error(`模型范围变更被阻断：${preview.impact.blockers.join("、")}`);
  }
  await governanceAccessApi.updateEntitlementScope("model", {
    ...command,
    previewId: preview.previewId,
    baselineDigest: preview.baselineDigest,
    expiresAt: preview.expiresAt,
  }, tenantId);
  return preview.impact.nextVersion;
}
