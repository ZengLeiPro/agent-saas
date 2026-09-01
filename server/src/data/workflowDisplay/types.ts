import type { WorkflowDisplayPolicy } from '../../../../shared/src/types/workflowDisplay.js';

export interface WorkflowDisplayPoliciesFileData {
  version: 1;
  policies: WorkflowDisplayPolicy[];
}

export interface UpsertWorkflowDisplayPolicyInput {
  tenantId: string;
  scope: WorkflowDisplayPolicy['scope'];
  subjectId: string;
  subjectLabel: string;
  displayCount: number;
  workflowIds: string[];
  expectedRevision: number;
  actorId: string;
}
