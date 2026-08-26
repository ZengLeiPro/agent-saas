import type { OrgAgentRecord } from '../orgAgents/types.js';
import type { TenantSkillConfig, UserSkillConfig } from '../skills/types.js';

export type AssignmentResourceType =
  | 'org_agent'
  | 'skill'
  | 'credential'
  | 'environment_template'
  | 'org_knowledge'
  | 'org_memory'
  | 'connector'
  | 'dws_delegation';
export type AssignmentAssigneeType = 'everyone' | 'user' | 'directory_group' | 'agent';
export type AssignmentEffect = 'allow' | 'deny';
export type AssignmentOrigin = 'direct' | 'migration' | 'policy_default';

export interface ResourceAssignment {
  assignmentId: string;
  tenantId: string;
  resourceType: AssignmentResourceType;
  resourceId: string;
  assigneeType: AssignmentAssigneeType;
  assigneeId?: string;
  effect: AssignmentEffect;
  origin: AssignmentOrigin;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ResourceAssignmentSet {
  tenantId: string;
  resourceType: AssignmentResourceType;
  resourceId: string;
  resourceName?: string;
  status?: 'enabled' | 'disabled';
  source: 'legacy_projection' | 'governance';
  version: number;
  assignments: ResourceAssignment[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ResourceAssignmentInput {
  assigneeType: AssignmentAssigneeType;
  assigneeId?: string;
  effect: AssignmentEffect;
  origin?: 'direct' | 'policy_default';
}

export interface AssignmentSubject {
  userId: string;
  directoryGroupIds?: string[];
  agentId?: string;
}

export type AssignmentResolution = 'assigned' | 'denied' | 'needs_assignment';

export interface UserResourcePreference {
  userId: string;
  resourceType: string;
  resourceId: string;
  enabled: boolean;
  source: 'legacy_projection' | 'user';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LegacyAssignmentUser {
  id: string;
  username: string;
  tenantId: string;
  disabled?: boolean;
}

export interface LegacyAssignmentBackfillInput {
  users: LegacyAssignmentUser[];
  orgAgents: OrgAgentRecord[];
  tenantSkillConfigs: Record<string, TenantSkillConfig>;
  userSkillConfigs: Record<string, UserSkillConfig>;
  platformTenantId: string;
  projectedBy: string;
  resolveSkillResourceId?: (user: LegacyAssignmentUser, legacySkillId: string) => string;
}

export interface LegacyAssignmentBackfillResult {
  resourceSetsProjected: number;
  assignmentsProjected: number;
  preferencesProjected: number;
  issuesRecorded: number;
}

export type AssignmentInvariantCode =
  | 'PLATFORM_TENANT_GOVERNANCE_FORBIDDEN'
  | 'ASSIGNMENT_SET_NOT_FOUND'
  | 'ASSIGNMENT_SET_VERSION_CONFLICT'
  | 'INVALID_ASSIGNMENT_ASSIGNEE'
  | 'PREFERENCE_VERSION_CONFLICT'
  | 'ASSIGNMENT_GROUP_SUBJECT_UNRESOLVED'
  | 'ASSIGNMENT_INVALID';

export class AssignmentInvariantError extends Error {
  constructor(readonly code: AssignmentInvariantCode) {
    super(code);
    this.name = 'AssignmentInvariantError';
  }
}
