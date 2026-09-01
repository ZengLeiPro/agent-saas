export type WorkflowDisplayScope = 'tenant' | 'position' | 'user';

export type WorkflowDisplaySource = WorkflowDisplayScope | 'platform';

export interface WorkflowDisplayPolicy {
  tenantId: string;
  scope: WorkflowDisplayScope;
  subjectId: string;
  subjectLabel: string;
  displayCount: number;
  workflowIds: string[];
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface EffectiveWorkflowDisplayConfig {
  source: WorkflowDisplaySource;
  displayCount: number;
  workflowIds: string[];
  revision: number;
}

export interface WorkflowDisplayPosition {
  id: string;
  label: string;
  memberCount: number;
}

export interface WorkflowDisplayMember {
  id: string;
  username: string;
  displayName: string;
  position?: string;
  disabled: boolean;
}

export interface WorkflowDisplayPoliciesResponse {
  tenantId: string;
  policies: WorkflowDisplayPolicy[];
  positions: WorkflowDisplayPosition[];
  members: WorkflowDisplayMember[];
}
