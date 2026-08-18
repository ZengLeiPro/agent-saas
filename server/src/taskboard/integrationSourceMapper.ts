import type { TaskBoardIntegrationSource } from '../../../shared/src/types/taskboard.js';
import { toIso } from './storeHelpers.js';

export function rowToIntegrationSource(row: Record<string, unknown>): TaskBoardIntegrationSource {
  return {
    id: String(row.id),
    integrationTaskId: String(row.integration_task_id),
    deliveryTaskId: String(row.delivery_task_id),
    ...(row.delivery_task_identifier ? { deliveryTaskIdentifier: String(row.delivery_task_identifier) } : {}),
    ...(row.delivery_task_title ? { deliveryTaskTitle: String(row.delivery_task_title) } : {}),
    repositoryId: String(row.repository_id),
    providerPullRequestId: String(row.provider_pull_request_id),
    reviewedSubjectDigest: String(row.reviewed_subject_digest),
    order: Number(row.source_order),
    state: String(row.state) as TaskBoardIntegrationSource['state'],
    attemptCount: Number(row.attempt_count),
    remediationCount: Number(row.remediation_count ?? 0),
    ...(row.provider_receipt_id ? { providerReceiptId: String(row.provider_receipt_id) } : {}),
    ...(row.merged_commit_oid ? { mergedCommitOid: String(row.merged_commit_oid) } : {}),
    ...(row.remediation_task_id ? { remediationTaskId: String(row.remediation_task_id) } : {}),
    ...(Array.isArray(row.remediation_attempts) ? {
      remediationAttempts: row.remediation_attempts.flatMap((attempt) => {
        if (!attempt || typeof attempt !== 'object') return [];
        const value = attempt as Record<string, unknown>;
        return [{
          id: String(value.id),
          round: Number(value.round),
          remediationTaskId: String(value.remediationTaskId),
          ...(value.remediationTaskIdentifier
            ? { remediationTaskIdentifier: String(value.remediationTaskIdentifier) }
            : {}),
          ...(value.remediationTaskTitle ? { remediationTaskTitle: String(value.remediationTaskTitle) } : {}),
          state: String(value.state) as 'active' | 'resolved' | 'superseded' | 'canceled',
          ...(value.resolvedAt ? { resolvedAt: toIso(value.resolvedAt) } : {}),
        }];
      }),
    } : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    updatedAt: toIso(row.updated_at),
  };
}
