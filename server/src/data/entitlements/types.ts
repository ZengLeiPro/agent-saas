import type { TenantSettings } from '../tenants/types.js';

export type EntitlementSource = 'plan_default' | 'platform_override' | 'legacy_migrated';
export type EntitlementStatus = 'trial' | 'active' | 'suspended' | 'expired';
export type EntitlementResourceType =
  | 'model'
  | 'agent_template'
  | 'skill'
  | 'connector'
  | 'environment_template'
  | 'tool';
export type EntitlementScopeMode = 'all' | 'selected';

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
