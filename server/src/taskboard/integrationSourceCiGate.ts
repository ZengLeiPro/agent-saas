import type { TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import { assertPullRequestGate } from './deliveryPullRequests.js';
import type { RepositoryProvider } from './repositoryProvider.js';
import { TaskboardValidationError } from './types.js';

export async function assertIntegrationSourcesProviderReady(
  provider: RepositoryProvider | undefined,
  repository: TaskBoardRepositoryConfig,
  credentialOwnerId: string,
  sources: Record<string, unknown>[],
): Promise<void> {
  if (!provider) {
    throw new TaskboardValidationError('Repository provider is unavailable', 'TASKBOARD_CI_UNAVAILABLE');
  }
  for (const row of sources) {
    if (row.provider_ci_status !== 'success'
      || row.provider_ci_purpose !== 'review'
      || row.provider_ci_head_oid !== row.head_oid
      || row.provider_ci_execution_id !== row.review_execution_id) {
      throw new TaskboardValidationError(
        `Task ${String(row.identifier)} lacks current review CI evidence`,
        'TASKBOARD_CI_INSPECTION_REQUIRED',
      );
    }
    let current;
    try {
      current = await provider.getPullRequest(
        repository,
        String(row.provider_pull_request_id),
        credentialOwnerId,
      );
    } catch (error) {
      throw new TaskboardValidationError(
        `Repository provider inspection failed: ${error instanceof Error ? error.message : String(error)}`,
        'TASKBOARD_CI_UNAVAILABLE',
      );
    }
    assertPullRequestGate(current, {
      providerPullRequestId: String(row.provider_pull_request_id),
      headOid: String(row.head_oid),
      baseOid: String(row.base_oid),
      subjectDigest: String(row.reviewed_subject_digest),
    });
  }
}
