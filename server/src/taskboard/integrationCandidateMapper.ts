import {
  TASKBOARD_INTEGRATION_CANDIDATE_STATES,
  type TaskBoardIntegrationCandidate,
  type TaskBoardIntegrationCandidateRevision,
  type TaskBoardIntegrationCandidateSourceSnapshot,
  type TaskBoardIntegrationWorkflowVersion,
} from '../../../shared/src/types/taskboard.js';
import { TaskboardValidationError } from './types.js';
import { toIso } from './storeHelpers.js';

const candidateStates = new Set<string>(TASKBOARD_INTEGRATION_CANDIDATE_STATES);

export function rowToIntegrationCandidate(row: Record<string, unknown>): TaskBoardIntegrationCandidate {
  const state = String(row.state);
  if (!candidateStates.has(state)) {
    throw new TaskboardValidationError(`Unsupported candidate state: ${state}`, 'TASKBOARD_CANDIDATE_STATE_UNSUPPORTED');
  }
  const policySnapshot = jsonObject(row.policy_snapshot);
  if (!policySnapshot) {
    throw new TaskboardValidationError('Candidate policy snapshot is invalid', 'TASKBOARD_CANDIDATE_POLICY_INVALID');
  }
  return {
    id: String(row.id),
    integrationTaskId: String(row.integration_task_id),
    repositoryId: String(row.repository_id),
    baseBranch: String(row.base_branch),
    branch: String(row.branch),
    ...(row.provider_pull_request_id ? { providerPullRequestId: String(row.provider_pull_request_id) } : {}),
    state: state as TaskBoardIntegrationCandidate['state'],
    currentRevision: Number(row.current_revision),
    workRound: Number(row.work_round),
    version: Number(row.version),
    workflowEpoch: String(row.workflow_epoch),
    laneEpoch: String(row.lane_epoch),
    policyRevision: String(row.policy_revision),
    mergeMethod: String(row.merge_method) as TaskBoardIntegrationCandidate['mergeMethod'],
    policySnapshot,
    ...(row.source_set_digest ? { sourceSetDigest: String(row.source_set_digest) } : {}),
    ...(row.approved_revision !== null && row.approved_revision !== undefined
      ? { approvedRevision: Number(row.approved_revision) }
      : {}),
    ...(row.approved_review_execution_id
      ? { approvedReviewExecutionId: String(row.approved_review_execution_id) }
      : {}),
    ...(row.merged_commit_oid ? { mergedCommitOid: String(row.merged_commit_oid) } : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function rowToIntegrationCandidateRevision(
  row: Record<string, unknown>,
): TaskBoardIntegrationCandidateRevision {
  return {
    candidateId: String(row.candidate_id),
    revision: Number(row.revision),
    digestVersion: Number(row.digest_version) as 1,
    baseOid: String(row.base_oid),
    headOid: String(row.head_oid),
    treeOid: String(row.tree_oid),
    sourceSetDigest: String(row.source_set_digest),
    subjectDigest: String(row.subject_digest),
    policySnapshotDigest: String(row.policy_snapshot_digest),
    policyRevision: String(row.policy_revision),
    mergeMethod: String(row.merge_method) as TaskBoardIntegrationCandidateRevision['mergeMethod'],
    workRound: Number(row.work_round),
    ...(row.work_execution_id ? { workExecutionId: String(row.work_execution_id) } : {}),
    ...(row.review_execution_id ? { reviewExecutionId: String(row.review_execution_id) } : {}),
    createdAt: toIso(row.created_at),
  };
}

export function rowToIntegrationCandidateSourceSnapshot(
  row: Record<string, unknown>,
): TaskBoardIntegrationCandidateSourceSnapshot {
  return {
    candidateId: String(row.candidate_id),
    revision: Number(row.revision),
    order: Number(row.source_order),
    integrationSourceId: String(row.integration_source_id),
    deliveryTaskId: String(row.delivery_task_id),
    deliveryTaskVersion: Number(row.delivery_task_version),
    repositoryId: String(row.repository_id),
    providerPullRequestId: String(row.provider_pull_request_id),
    frozenHeadOid: String(row.frozen_head_oid),
    frozenBaseOid: String(row.frozen_base_oid),
    reviewedSubjectDigest: String(row.reviewed_subject_digest),
    reviewExecutionId: String(row.review_execution_id),
    reviewReceiptDigest: String(row.review_receipt_digest),
    requirementDigest: String(row.requirement_digest),
    createdAt: toIso(row.created_at),
  };
}

/** Legacy rows created before v3 migration are always routed to v2. */
export function integrationWorkflowVersionFromRow(row: Record<string, unknown>): TaskBoardIntegrationWorkflowVersion {
  if (row.workflow_version === null || row.workflow_version === undefined) return 2;
  const version = Number(row.workflow_version);
  if (version === 2 || version === 3) return version;
  throw new TaskboardValidationError(
    `Unsupported integration workflow version: ${String(row.workflow_version)}`,
    'TASKBOARD_WORKFLOW_VERSION_UNSUPPORTED',
  );
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}
