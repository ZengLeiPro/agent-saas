import type { TenantSettings } from '../tenants/types.js';

export type EntitlementSource = 'plan_default' | 'platform_override' | 'legacy_migrated';
export type EntitlementStatus = 'trial' | 'active' | 'suspended' | 'expired';
export const ENTITLEMENT_RESOURCE_TYPES = [
  'model',
  'tool',
  'connector',
  'agent_template',
  'skill',
  'environment_template',
] as const;
export type EntitlementResourceType = typeof ENTITLEMENT_RESOURCE_TYPES[number];
export type EntitlementScopeMode = 'all' | 'selected';

/**
 * `tool` Entitlement 管理的是租户能力开关，不是 Agent runtime descriptor。
 * 该清单同时约束治理目录、存量投影和运行前授权，避免跨层 ID 漂移。
 */
export const TOOL_ENTITLEMENT_RESOURCE_IDS = [
  'files',
  'cron',
  'mcp',
  'custom_skill',
  'personal_agent',
  'org_knowledge',
  'image_gen',
  'memory_polling',
  'memory_consolidation',
  'memory_write_delegation',
] as const;
export type ToolEntitlementResourceId = typeof TOOL_ENTITLEMENT_RESOURCE_IDS[number];
export const PERSONAL_AGENT_TOOL_ENTITLEMENT_ID: ToolEntitlementResourceId = 'personal_agent';

export interface TenantEntitlementSet {
  tenantId: string;
  source: EntitlementSource;
  status: EntitlementStatus;
  effectiveFrom?: string;
  effectiveTo?: string;
  limits: Record<string, number>;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  updateReason: string;
}

export interface EntitlementResourceScope {
  tenantId: string;
  resourceType: EntitlementResourceType;
  mode: EntitlementScopeMode;
  resourceIds: string[];
  source: 'legacy_projection' | 'governance';
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export const TENANT_POLICY_KEYS = [
  'agent.personal.enabled',
  'automation.cron.enabled',
  'connector.global_servers.allowed',
  'connector.mcp.enabled',
  'connector.personal_oauth.allowed',
  'connector.tenant_servers.allowed',
  'credential.org_shared.allowed',
  'knowledge.org.enabled',
  'memory.consolidation.enabled',
  'memory.personal.enabled',
  'memory.polling.billable',
  'memory.polling.enabled',
  'memory.write_delegation.enabled',
  'model.group_names.visible',
  'model.user_switch.allowed',
  'org.first_day_guide_bar.enabled',
  'runtime.debug_mode.allowed',
  'runtime.debug_mode.enabled',
  'runtime.high_risk_tool.mode',
  'security.dingtalk_binding.required',
  'session.auto_compact.enabled',
  'session.context_token_details.allowed',
  'session.context_tokens.visible',
  'session.files.enabled',
  'session.qa.mask_tool_inputs',
  'skill.custom.enabled',
  'skill.member_opt_in.allowed',
  'tool.image_gen.enabled',
] as const;

export type TenantPolicyKey = typeof TENANT_POLICY_KEYS[number];

/** 调试模式由 TenantSettings 统一写入；保留 Policy key 仅用于旧数据读取与审计兼容。 */
export const DEBUG_MODE_TENANT_POLICY_KEYS: readonly TenantPolicyKey[] = [
  'runtime.debug_mode.allowed',
  'runtime.debug_mode.enabled',
];

export function isDebugModeTenantPolicyKey(policyKey: string): boolean {
  return DEBUG_MODE_TENANT_POLICY_KEYS.includes(policyKey as TenantPolicyKey);
}

export const NON_BOOLEAN_TENANT_POLICY_KEYS: readonly TenantPolicyKey[] = [
  'runtime.high_risk_tool.mode',
];

export function isBooleanTenantPolicyKey(policyKey: string): policyKey is TenantPolicyKey {
  return (TENANT_POLICY_KEYS as readonly string[]).includes(policyKey)
    && !NON_BOOLEAN_TENANT_POLICY_KEYS.includes(policyKey as TenantPolicyKey);
}

/** 当前组织策略写接口只接受 boolean；非 boolean 策略保持只读，避免值类型被错误改写。 */
export const ORGANIZATION_EDITABLE_TENANT_POLICY_KEYS: readonly TenantPolicyKey[] = TENANT_POLICY_KEYS
  .filter(policyKey => !isDebugModeTenantPolicyKey(policyKey) && isBooleanTenantPolicyKey(policyKey));

export function isOrganizationEditableTenantPolicyKey(policyKey: string): policyKey is TenantPolicyKey {
  return ORGANIZATION_EDITABLE_TENANT_POLICY_KEYS.includes(policyKey as TenantPolicyKey);
}

export type TenantPolicyValue = boolean | string | number | null | string[] | Record<string, boolean | string | number | null>;

export interface TenantPolicy {
  tenantId: string;
  policyKey: TenantPolicyKey;
  value: TenantPolicyValue;
  source: 'legacy_projection' | 'governance';
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface LegacyEntitlementTenant {
  id: string;
  disabled?: boolean;
  settings?: TenantSettings;
}

export interface LegacyEntitlementBackfillInput {
  tenants: LegacyEntitlementTenant[];
  platformTenantId: string;
  projectedBy: string;
}

export interface LegacyEntitlementBackfillResult {
  tenantsProjected: number;
  scopesProjected: number;
  policiesProjected: number;
  issuesRecorded: number;
}

export interface EntitlementScopeBaselineBackfillResult {
  tenantsScanned: number;
  scopesInserted: number;
  scopesSkipped: number;
  tenantsWithErrors: number;
  issuesRecorded: number;
}

export type EntitlementInvariantCode =
  | 'PLATFORM_TENANT_GOVERNANCE_FORBIDDEN'
  | 'ENTITLEMENT_NOT_FOUND'
  | 'ENTITLEMENT_VERSION_CONFLICT'
  | 'ENTITLEMENT_SCOPE_NOT_FOUND'
  | 'ENTITLEMENT_SCOPE_VERSION_CONFLICT'
  | 'POLICY_NOT_FOUND'
  | 'POLICY_VERSION_CONFLICT'
  | 'INVALID_POLICY_KEY';

export class EntitlementInvariantError extends Error {
  constructor(readonly code: EntitlementInvariantCode) {
    super(code);
    this.name = 'EntitlementInvariantError';
  }
}
