import {
  MANAGEMENT_ACTIONS_V1,
  type ManagementActionV1,
} from '../../../../shared/src/types/governance.js';

export type ActionAuthority = 'platform' | 'tenant' | 'owner' | 'personal' | 'use';

export interface ActionDefinition {
  action: string;
  authority: ActionAuthority;
  highRisk?: boolean;
  /** Evaluated only by the narrow management snapshot service, never by AccessEvaluator. */
  managementOnly?: boolean;
}

const standardDefinitions = [
  { action: 'platform_admin.manage', authority: 'platform', highRisk: true },
  { action: 'tenant.create', authority: 'platform', highRisk: true },
  { action: 'tenant.disable', authority: 'platform', highRisk: true },
  { action: 'tenant.delete', authority: 'platform', highRisk: true },
  { action: 'tenant.entitlement.update', authority: 'platform', highRisk: true },
  { action: 'membership.owner.grant', authority: 'owner', highRisk: true },
  { action: 'membership.owner.revoke', authority: 'owner', highRisk: true },
  { action: 'membership.admin.grant', authority: 'owner', highRisk: true },
  { action: 'membership.admin.revoke', authority: 'owner', highRisk: true },
  { action: 'membership.member.manage', authority: 'tenant' },
  { action: 'tenant.policy.update', authority: 'tenant' },
  { action: 'org_agent.create', authority: 'tenant' },
  { action: 'org_agent.update', authority: 'tenant' },
  { action: 'org_agent.assign', authority: 'tenant' },
  { action: 'org_agent.run', authority: 'use' },
  { action: 'skill.manage', authority: 'tenant' },
  { action: 'skill.use', authority: 'use' },
  { action: 'connector.manage', authority: 'tenant' },
  { action: 'connector.use', authority: 'use' },
  { action: 'credential.manage', authority: 'tenant', highRisk: true },
  { action: 'credential.use', authority: 'use' },
  { action: 'environment.manage', authority: 'tenant' },
  { action: 'environment.use', authority: 'use' },
  { action: 'org_knowledge.manage', authority: 'tenant' },
  { action: 'org_knowledge.use', authority: 'use' },
  { action: 'personal_agent.run', authority: 'personal' },
  { action: 'personal_agent.update', authority: 'personal' },
  { action: 'personal_memory.manage', authority: 'personal' },
  { action: 'personal_persona.manage', authority: 'personal' },
  { action: 'personal_skill.manage', authority: 'personal' },
] as const satisfies readonly ActionDefinition[];

const managementDefinitions = MANAGEMENT_ACTIONS_V1.map((action): ActionDefinition => {
  const authority = action.split('.')[1];
  if (authority !== 'personal' && authority !== 'tenant' && authority !== 'platform') {
    throw new Error(`Invalid management action authority: ${action}`);
  }
  return { action, authority, managementOnly: true };
});

export const ACTION_CATALOG = new Map<string, ActionDefinition>(
  [...standardDefinitions, ...managementDefinitions].map((definition) => [definition.action, definition]),
);

export function getActionDefinition(action: string): ActionDefinition | undefined {
  const definition = ACTION_CATALOG.get(action);
  return definition?.managementOnly ? undefined : definition;
}

/** Narrow accessor for management snapshot evaluation; never falls back to the general catalog. */
export function getManagementActionDefinition(action: ManagementActionV1): Readonly<ActionDefinition> | undefined {
  const definition = ACTION_CATALOG.get(action);
  return definition?.managementOnly === true ? definition : undefined;
}
