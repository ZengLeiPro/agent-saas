export type ActionAuthority = 'platform' | 'tenant' | 'owner' | 'personal' | 'use';

export interface ActionDefinition {
  action: string;
  authority: ActionAuthority;
  highRisk?: boolean;
}

const definitions = [
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

export const ACTION_CATALOG = new Map<string, ActionDefinition>(
  definitions.map((definition) => [definition.action, definition]),
);

export function getActionDefinition(action: string): ActionDefinition | undefined {
  return ACTION_CATALOG.get(action);
}
