import { resolveAssignment } from '../../../data/assignments/index.js';
import type { AssignmentResourceType, ResourceAssignmentSet } from '../../../data/assignments/types.js';
import type { AccessEvaluationRequest, PolicyProvider, PolicyProviderResult } from '../types.js';

interface AssignmentReader {
  getAssignmentSet(
    tenantId: string,
    resourceType: AssignmentResourceType,
    resourceId: string,
  ): Promise<ResourceAssignmentSet | null>;
}

export class AssignmentPolicy implements PolicyProvider {
  readonly layer = 'assignment' as const;

  constructor(private readonly store: AssignmentReader) {}

  async evaluate(request: AccessEvaluationRequest): Promise<PolicyProviderResult> {
    const required = request.context?.assignment;
    if (!required?.required) return this.notApplicable();
    const tenantId = request.resource.tenantId;
    if (!tenantId) return this.deny('ASSIGNMENT_TENANT_REQUIRED');
    const subjectId = request.subject.subjectType === 'human'
      ? request.subject.subjectId
      : request.subject.delegatedUserId;
    if (!subjectId) return this.deny('ASSIGNMENT_SUBJECT_REQUIRED');
    const set = await this.store.getAssignmentSet(tenantId, required.resourceType, required.resourceId);
    if (!set) return this.condition('ASSIGNMENT_REQUIRED', 'request_assignment');
    if (set.assignments.some(item => item.assigneeType === 'directory_group')
      && required.directoryGroupIds === undefined) {
      return this.deny('ASSIGNMENT_GROUP_SUBJECT_UNRESOLVED', set.version);
    }
    const resolution = resolveAssignment(set.assignments, {
      userId: subjectId,
      directoryGroupIds: required.directoryGroupIds,
      agentId: required.agentIds?.[0],
    });
    if (resolution === 'denied') return this.deny('EXPLICIT_ASSIGNMENT_DENY', set.version);
    if (resolution === 'needs_assignment') return this.condition('ASSIGNMENT_REQUIRED', 'request_assignment', set.version);
    return {
      layer: this.layer,
      result: 'pass',
      reasonCode: 'RESOURCE_ASSIGNED',
      sourceVersion: set.version,
      snapshot: { assignmentVersion: set.version },
    };
  }

  private notApplicable(): PolicyProviderResult {
    return { layer: this.layer, result: 'not_applicable', reasonCode: 'ASSIGNMENT_NOT_REQUIRED' };
  }

  private deny(reasonCode: string, version?: number): PolicyProviderResult {
    return {
      layer: this.layer,
      result: 'deny',
      reasonCode,
      ...(version !== undefined ? { sourceVersion: version, snapshot: { assignmentVersion: version } } : {}),
    };
  }

  private condition(reasonCode: string, nextAction: string, version?: number): PolicyProviderResult {
    return {
      layer: this.layer,
      result: 'condition',
      reasonCode,
      nextAction,
      ...(version !== undefined ? { sourceVersion: version, snapshot: { assignmentVersion: version } } : {}),
    };
  }
}
