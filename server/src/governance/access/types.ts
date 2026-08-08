import type { AssignmentResourceType } from '../../data/assignments/types.js';
import type { EntitlementResourceType } from '../../data/entitlements/types.js';
import type { SubjectContext } from '../subject/types.js';

export const POLICY_LAYERS = [
  'platform_invariant',
  'entitlement',
  'persona',
  'tenant_policy',
  'assignment',
  'long_term_grant',
  'runtime_approval',
] as const;

export type PolicyLayer = typeof POLICY_LAYERS[number];
export type PolicyResult = 'pass' | 'deny' | 'condition' | 'not_applicable';
export type AccessState = 'allowed' | 'denied' | 'needs_assignment' | 'needs_user_authorization' | 'needs_runtime_approval';

export interface AccessResourceRef {
  type: AssignmentResourceType | 'membership' | 'tenant' | 'platform' | 'personal_agent';
  id: string;
  tenantId?: string;
  ownerUserId?: string;
  enabled?: boolean;
  tenantStatus?: 'active' | 'disabled' | 'suspended';
}

export interface AccessEvaluationContext {
  entitlement?: {
    resourceType: EntitlementResourceType;
    resourceId?: string;
  };
  tenantPolicyKey?: string;
  assignment?: {
    required: boolean;
    resourceType: AssignmentResourceType;
    resourceId: string;
    username?: string;
    directoryGroupIds?: string[];
    agentIds?: string[];
  };
  longTermGrant?: {
    required: boolean;
    generation?: number;
    active?: boolean;
  };
  runtimeApproval?: {
    required: boolean;
    approved?: boolean;
  };
}

export interface AccessEvaluationRequest {
  subject: SubjectContext;
  action: string;
  resource: AccessResourceRef;
  context?: AccessEvaluationContext;
  evaluatedAt?: Date;
}

export interface PolicySnapshotPatch {
  membershipVersion?: number;
  entitlementVersion?: number;
  tenantPolicyVersion?: number;
  assignmentVersion?: number;
  grantGeneration?: number;
}

export interface PolicyProviderResult {
  layer: PolicyLayer;
  result: PolicyResult;
  reasonCode: string;
  sourceVersion?: number;
  snapshot?: PolicySnapshotPatch;
  nextAction?: string;
}

export interface PolicyProvider {
  readonly layer: PolicyLayer;
  evaluate(request: AccessEvaluationRequest): Promise<PolicyProviderResult>;
}

export interface AccessDecision {
  id: string;
  verdict: 'allow' | 'deny' | 'conditional';
  action: string;
  resourceType: AccessResourceRef['type'];
  resourceId: string;
  tenantId?: string;
  subjectType: SubjectContext['subjectType'];
  subjectId: string;
  accessState: AccessState;
  reasonCode: string;
  decisiveLayer: PolicyLayer;
  chain: PolicyProviderResult[];
  policySnapshot: PolicySnapshotPatch;
  nextActions: string[];
  evaluatedAt: string;
}
