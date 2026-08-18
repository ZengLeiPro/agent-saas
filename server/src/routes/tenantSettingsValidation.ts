import { z } from 'zod';

import type { TenantSettings } from '../data/tenants/types.js';

const optionalNumber = z.preprocess(
  value => value === '' || value === null ? undefined : value,
  z.number().int().positive().optional(),
);

export const tenantSettingsSchema = z.object({
  features: z.object({
    filesEnabled: z.boolean(),
    cronEnabled: z.boolean(),
    mcpEnabled: z.boolean(),
    customSkillsEnabled: z.boolean(),
    debugModeAllowed: z.boolean(),
    debugModeEnabled: z.boolean().optional(),
    autoCompactEnabled: z.boolean().optional(),
    personalAgentEnabled: z.boolean().optional(),
    kbEnabled: z.boolean().optional(),
    memoryPollingEnabled: z.boolean().optional(),
    memoryPollChargesCredits: z.boolean().optional(),
    imageGenEnabled: z.boolean().optional(),
    memoryConsolidationEnabled: z.boolean().optional(),
    memoryWriteDelegationEnabled: z.boolean().optional(),
  }).optional(),
  quotas: z.object({
    maxUsers: optionalNumber,
    maxAdmins: optionalNumber,
    maxStorageMb: optionalNumber,
    monthlyTokenLimit: optionalNumber,
    maxTurnsPerRequest: optionalNumber,
    rateLimitMaxRequests: optionalNumber,
  }).optional(),
  models: z.object({
    defaultModel: z.string().max(200).optional(),
    allowedModels: z.array(z.string().max(200)).optional(),
    allowUserModelSwitch: z.boolean(),
    showGroupNames: z.boolean().optional(),
    showContextTokens: z.boolean().optional(),
    allowContextTokenDetails: z.boolean().optional(),
    displayOverrides: z.record(z.string().max(200), z.object({
      displayName: z.string().max(100).optional(),
      description: z.string().max(500).optional(),
      recommended: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
      groupDisplayName: z.string().max(100).optional(),
    })).optional(),
  }).optional(),
  mcp: z.object({
    allowTenantServers: z.boolean(),
    allowGlobalServers: z.boolean(),
    defaultEnabledServerIds: z.array(z.string().max(200)).optional(),
  }).optional(),
  branding: z.object({
    displayName: z.string().max(100).optional(),
    logoUrl: z.string().max(500).optional(),
    primaryColor: z.string().max(32).optional(),
  }).optional(),
  personalization: z.object({
    firstDayGuideBarEnabled: z.boolean().optional(),
  }).optional(),
  security: z.object({
    passwordMinLength: optionalNumber,
    sessionTtlHours: optionalNumber,
    requireDingtalkBinding: z.boolean(),
  }).optional(),
});

export type TenantSettingsPatch = z.infer<typeof tenantSettingsSchema>;

export function tenantSettingsPolicyError(
  patch: TenantSettingsPatch,
  current: TenantSettings,
  platformAdmin: boolean,
): { status: 400 | 403; error: string } | null {
  const requestedDebugModeAllowed = patch.features?.debugModeAllowed;
  const requestedDebugModeEnabled = patch.features?.debugModeEnabled;

  if (!platformAdmin) {
    if (
      requestedDebugModeAllowed !== undefined
      && requestedDebugModeAllowed !== current.features.debugModeAllowed
    ) {
      return { status: 403, error: '调试模式平台授权仅平台管理员可配置' };
    }
    patch.features = {
      ...current.features,
      ...(patch.features ?? {}),
      debugModeAllowed: current.features.debugModeAllowed,
    };

    const requestedImageGenEnabled = patch.features?.imageGenEnabled;
    const currentImageGenEnabled = current.features.imageGenEnabled === true;
    if (requestedImageGenEnabled !== undefined && requestedImageGenEnabled !== currentImageGenEnabled) {
      return { status: 403, error: 'AI 生图能力仅平台管理员可配置' };
    }
    patch.features = {
      ...current.features,
      ...(patch.features ?? {}),
      imageGenEnabled: currentImageGenEnabled,
    };

    const requested = patch.models?.allowContextTokenDetails;
    const currentValue = current.models.allowContextTokenDetails === true;
    const requestedShowContextTokens = patch.models?.showContextTokens ?? current.models.showContextTokens;
    const nextValue = requestedShowContextTokens === false ? false : requested ?? currentValue;
    if (nextValue !== currentValue) return { status: 403, error: '上下文 Token 明细仅平台管理员可配置' };
    patch.models = {
      ...current.models,
      ...(patch.models ?? {}),
      allowContextTokenDetails: currentValue,
    };

    if (patch.quotas !== undefined) {
      const changed = (Object.keys(patch.quotas) as Array<keyof typeof patch.quotas>)
        .some(key => patch.quotas?.[key] !== undefined && patch.quotas[key] !== current.quotas[key]);
      if (changed) return { status: 403, error: '组织配额仅平台管理员可配置' };
    }
    patch.quotas = { ...current.quotas };
  }

  const finalDebugModeAllowed = patch.features?.debugModeAllowed
    ?? current.features.debugModeAllowed;
  if (!platformAdmin && !finalDebugModeAllowed && requestedDebugModeEnabled === true) {
    return { status: 400, error: '平台尚未授予调试模式，组织不能开启' };
  }
  const finalDebugModeEnabled = finalDebugModeAllowed
    ? (patch.features?.debugModeEnabled ?? current.features.debugModeEnabled ?? false)
    : false;
  patch.features = {
    ...current.features,
    ...(patch.features ?? {}),
    debugModeAllowed: finalDebugModeAllowed,
    debugModeEnabled: finalDebugModeEnabled,
  };

  const finalConsolidation = patch.features?.memoryConsolidationEnabled
    ?? (current.features.memoryConsolidationEnabled === true);
  const finalDelegation = patch.features?.memoryWriteDelegationEnabled
    ?? (current.features.memoryWriteDelegationEnabled === true);
  if (finalDelegation && !finalConsolidation) {
    return { status: 400, error: '「记忆写入剥离 v2」依赖「会话记忆整合」：请先开启会话记忆整合，或同时关闭两者' };
  }
  return null;
}
