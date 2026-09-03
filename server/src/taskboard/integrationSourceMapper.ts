import type { TaskBoardIntegrationSource } from '../../../shared/src/types/taskboard.js';
import { toIso } from './storeHelpers.js';

export function rowToIntegrationSource(row: Record<string, unknown>): TaskBoardIntegrationSource {
  const state = normalizeSourceState(row.state);
  return {
    id: String(row.id),
    integrationTaskId: String(row.integration_task_id),
    deliveryTaskId: String(row.delivery_task_id),
    ...(row.delivery_task_identifier ? { deliveryTaskIdentifier: String(row.delivery_task_identifier) } : {}),
    ...(row.delivery_task_title ? { deliveryTaskTitle: String(row.delivery_task_title) } : {}),
    repositoryId: String(row.repository_id),
    ...(row.provider_pull_request_id ? { providerPullRequestId: String(row.provider_pull_request_id) } : {}),
    ...(row.frozen_head_oid ? { frozenHeadOid: String(row.frozen_head_oid) } : {}),
    order: Number(row.source_order),
    state,
    ...(row.merged_commit_oid ? { mergedCommitOid: String(row.merged_commit_oid) } : {}),
    ...(state === 'needs_human' && row.last_error ? { lastError: String(row.last_error) } : {}),
    updatedAt: toIso(row.updated_at),
  };
}

function normalizeSourceState(value: unknown): TaskBoardIntegrationSource['state'] {
  const state = String(value);
  if (state === 'merged' || state === 'canceled' || state === 'needs_human') return state;
  return 'pending';
}
