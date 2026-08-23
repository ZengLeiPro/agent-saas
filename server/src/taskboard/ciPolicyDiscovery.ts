import type {
  TaskBoardCiPolicyDiscovery,
  TaskBoardIntegrationPolicy,
  TaskBoardRepositoryConfig,
} from '../../../shared/src/types/taskboard.js';

import type { RepositoryProvider } from './repositoryProvider.js';
import { TaskboardValidationError, type TaskboardIdentity } from './types.js';

interface CiPolicyDiscoveryHost {
  pool: { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
  tasksTable: string;
  repositoryProvider?: RepositoryProvider;
  getBoard(identity: TaskboardIdentity, boardId: string): Promise<{
    id: string;
    ownerUserId: string;
    repository?: TaskBoardRepositoryConfig;
    integrationPolicy?: TaskBoardIntegrationPolicy;
  }>;
}

export async function discoverBoardCiPolicy(
  host: CiPolicyDiscoveryHost,
  identity: TaskboardIdentity,
  boardId: string,
): Promise<TaskBoardCiPolicyDiscovery> {
  const board = await host.getBoard(identity, boardId);
  const repository = board.repository;
  const provider = host.repositoryProvider;
  if (!repository || !provider?.getRequiredGateCapabilities) {
    throw new TaskboardValidationError('Board repository CI discovery is unavailable', 'TASKBOARD_CI_UNAVAILABLE');
  }
  const latest = await host.pool.query(
    `SELECT provider_pull_request_id FROM ${host.tasksTable}
      WHERE board_id=$1 AND provider_pull_request_id IS NOT NULL AND deleted_at IS NULL
      ORDER BY updated_at DESC,id DESC LIMIT 1`,
    [boardId],
  );
  const providerPullRequestId = latest.rows[0]?.provider_pull_request_id
    ? String(latest.rows[0].provider_pull_request_id)
    : undefined;
  try {
    const [gates, snapshot] = await Promise.all([
      provider.getRequiredGateCapabilities(repository, repository.baseBranch, board.ownerUserId),
      providerPullRequestId
        ? provider.getPullRequest(repository, providerPullRequestId, board.ownerUserId)
        : Promise.resolve(undefined),
    ]);
    const providerKnown = gates.known && gates.unsupportedRules.length === 0 && !gates.mergeQueueRequired;
    const githubRequiredChecks = gates.requiredChecks;
    const boardRequiredChecks = board.integrationPolicy?.ciPolicy?.requiredChecks ?? [];
    const effectiveSource = !providerKnown
      ? 'unavailable'
      : githubRequiredChecks.length ? 'github'
        : boardRequiredChecks.length ? 'board' : 'unconfigured';
    return {
      boardId: board.id,
      repositoryId: repository.repositoryId,
      providerKnown,
      effectiveSource,
      githubRequiredChecks,
      boardRequiredChecks,
      effectiveRequiredChecks: effectiveSource === 'github'
        ? githubRequiredChecks
        : effectiveSource === 'board' ? boardRequiredChecks : [],
      observedChecks: snapshot?.observedChecks ?? [],
      ...(snapshot ? {
        providerPullRequestId: snapshot.providerPullRequestId,
        headOid: snapshot.headOid,
      } : {}),
      providerQueriedAt: new Date().toISOString(),
    };
  } catch (error) {
    throw new TaskboardValidationError(
      `Repository CI discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      'TASKBOARD_CI_UNAVAILABLE',
    );
  }
}
