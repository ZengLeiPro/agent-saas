import type { PoolClient } from 'pg';

import type { TaskBoardExecutionIntegrationCandidate } from '../../../shared/src/types/taskboard.js';
import {
  rowToIntegrationCandidate,
  rowToIntegrationCandidateRevision,
  rowToIntegrationCandidateSourceSnapshot,
} from './integrationCandidateMapper.js';
import { integrationCandidateTableNames } from './integrationCandidateSchema.js';

export async function loadExecutionIntegrationCandidate(
  client: Pick<PoolClient, 'query'>,
  integrationSourcesTable: string,
  taskId: string,
): Promise<TaskBoardExecutionIntegrationCandidate | undefined> {
  const tables = integrationCandidateTableNames(integrationSourcesTable);
  const candidateResult = await client.query(
    `SELECT * FROM ${tables.candidatesTable} WHERE integration_task_id=$1 LIMIT 1`,
    [taskId],
  );
  if (!candidateResult.rows[0]) return undefined;
  const candidate = rowToIntegrationCandidate(candidateResult.rows[0]);
  if (candidate.currentRevision === 0) return { candidate, sourceSnapshots: [] };
  const [revisionResult, snapshotResult] = await Promise.all([
    client.query(
      `SELECT * FROM ${tables.revisionsTable} WHERE candidate_id=$1 AND revision=$2`,
      [candidate.id, candidate.currentRevision],
    ),
    client.query(
      `SELECT * FROM ${tables.sourceSnapshotsTable} WHERE candidate_id=$1 AND revision=$2 ORDER BY source_order`,
      [candidate.id, candidate.currentRevision],
    ),
  ]);
  return {
    candidate,
    ...(revisionResult.rows[0] ? { revision: rowToIntegrationCandidateRevision(revisionResult.rows[0]) } : {}),
    sourceSnapshots: snapshotResult.rows.map(rowToIntegrationCandidateSourceSnapshot),
  };
}
