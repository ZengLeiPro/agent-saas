import pg, { type PoolClient } from 'pg';

import type {
  TaskBoard,
  TaskBoardRepositoryConfig,
  TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import { boardRepositoryFragment, parseStageModels, rowToBoard } from './boardFields.js';
import { latestTaskActivityProjection, rowToTask, toIso, visibleCommentPredicate } from './storeHelpers.js';
import { TaskboardNotFoundError, type TaskboardIdentity } from './types.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export interface TaskboardTaskAccessHost {
  tasksTable: string;
  boardsTable: string;
  membersTable: string;
  commentsTable: string;
  changesTable: string;
  integrationSourcesTable: string;
  remediationAttemptsTable: string;
  requireBoard(
    db: PgPool | PoolClient,
    identity: TaskboardIdentity,
    boardId: string,
    forUpdate: boolean,
    ownerOnly?: boolean,
  ): Promise<TaskBoard>;
}

export async function loadBoard(
  store: Pick<TaskboardTaskAccessHost, 'boardsTable' | 'membersTable'>,
  db: PgPool | PoolClient,
  identity: TaskboardIdentity,
  boardId: string,
  forUpdate: boolean,
  ownerOnly: boolean,
): Promise<TaskBoard> {
  const result = await db.query(
    `SELECT b.id, b.owner_user_id, b.name, b.description, b.visibility, b.prompt, b.model, b.stage_models, b.stage_prompts,
            b.repository, b.integration_policy, b.version, b.archived_at, b.created_at, b.updated_at,
            CASE WHEN b.owner_user_id=$3 THEN 'owner' ELSE COALESCE(m.role,'viewer') END AS board_role
       FROM ${store.boardsTable} b
       LEFT JOIN ${store.membersTable} m ON m.board_id=b.id AND m.user_id=$3
      WHERE b.id=$1 AND b.tenant_id=$2
        AND (b.owner_user_id=$3 OR ($4::boolean=false AND b.visibility='organization'))
      ${forUpdate ? 'FOR UPDATE OF b' : ''}`,
    [boardId, identity.tenantId, identity.ownerUserId, ownerOnly],
  );
  if (!result.rows[0]) throw new TaskboardNotFoundError('Board not found');
  return rowToBoard(result.rows[0], identity.ownerUserId);
}

export async function requireTaskWithBoard(
  store: TaskboardTaskAccessHost,
  db: PgPool | PoolClient,
  identity: TaskboardIdentity,
  taskId: string,
  forUpdate: boolean,
  creationClaimToken?: string,
): Promise<{
  task: TaskBoardTask;
  boardArchivedAt?: string;
  boardModel?: string;
  boardStageModels?: TaskBoard['stageModels'];
  boardRepository?: TaskBoardRepositoryConfig;
  boardOwnerUserId: string;
  boardRole: TaskBoard['role'];
}> {
  let lockedBoard: TaskBoard | undefined;
  if (forUpdate) {
    const ownership = await db.query(
      `SELECT t.board_id
         FROM ${store.tasksTable} t
         JOIN ${store.boardsTable} b ON b.id=t.board_id
        WHERE t.id=$1 AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')
          AND t.deleted_at IS NULL
          AND (t.creation_state='complete' OR t.creation_lease_id=$4)`,
      [taskId, identity.tenantId, identity.ownerUserId, creationClaimToken ?? null],
    );
    if (!ownership.rows[0]) throw new TaskboardNotFoundError('Task not found');
    lockedBoard = await store.requireBoard(db, identity, String(ownership.rows[0].board_id), true);
  }

  const result = await db.query(
    `SELECT t.*,
            b.archived_at AS board_archived_at,
            b.model AS board_model, b.stage_models AS board_stage_models, b.repository AS board_repository,
            b.owner_user_id AS board_owner_user_id, m.role AS board_member_role,
            (SELECT count(*)::int FROM ${store.commentsTable} c WHERE c.task_id=t.id AND ${visibleCommentPredicate('c', store.changesTable)}) AS comment_count,
            ${latestTaskActivityProjection('t', store.commentsTable, store.changesTable)} AS latest_activity_at,
            COALESCE(
              (SELECT s.id FROM ${store.integrationSourcesTable} s WHERE s.delivery_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1),
              (SELECT s.id FROM ${store.remediationAttemptsTable} a JOIN ${store.integrationSourcesTable} s ON s.id=a.integration_source_id WHERE a.remediation_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1)
            ) AS integration_source_id,
            COALESCE(
              (SELECT s.integration_task_id FROM ${store.integrationSourcesTable} s WHERE s.delivery_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1),
              (SELECT s.integration_task_id FROM ${store.remediationAttemptsTable} a JOIN ${store.integrationSourcesTable} s ON s.id=a.integration_source_id WHERE a.remediation_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1)
            ) AS integration_task_id,
            COALESCE(
              (SELECT s.delivery_task_id FROM ${store.integrationSourcesTable} s WHERE s.delivery_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1),
              (SELECT s.delivery_task_id FROM ${store.remediationAttemptsTable} a JOIN ${store.integrationSourcesTable} s ON s.id=a.integration_source_id WHERE a.remediation_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1)
            ) AS root_delivery_task_id,
            COALESCE(
              (SELECT s.state FROM ${store.integrationSourcesTable} s WHERE s.delivery_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1),
              (SELECT s.state FROM ${store.remediationAttemptsTable} a JOIN ${store.integrationSourcesTable} s ON s.id=a.integration_source_id WHERE a.remediation_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1)
            ) AS integration_state,
            (SELECT i.identifier FROM ${store.integrationSourcesTable} s JOIN ${store.tasksTable} i ON i.id=s.integration_task_id
              WHERE s.delivery_task_id=t.id OR EXISTS (SELECT 1 FROM ${store.remediationAttemptsTable} a WHERE a.integration_source_id=s.id AND a.remediation_task_id=t.id)
              ORDER BY s.updated_at DESC LIMIT 1) AS integration_task_identifier,
            (SELECT i.title FROM ${store.integrationSourcesTable} s JOIN ${store.tasksTable} i ON i.id=s.integration_task_id
              WHERE s.delivery_task_id=t.id OR EXISTS (SELECT 1 FROM ${store.remediationAttemptsTable} a WHERE a.integration_source_id=s.id AND a.remediation_task_id=t.id)
              ORDER BY s.updated_at DESC LIMIT 1) AS integration_task_title,
            (SELECT d.identifier FROM ${store.integrationSourcesTable} s JOIN ${store.tasksTable} d ON d.id=s.delivery_task_id
              WHERE s.delivery_task_id=t.id OR EXISTS (SELECT 1 FROM ${store.remediationAttemptsTable} a WHERE a.integration_source_id=s.id AND a.remediation_task_id=t.id)
              ORDER BY s.updated_at DESC LIMIT 1) AS root_delivery_task_identifier,
            (SELECT d.title FROM ${store.integrationSourcesTable} s JOIN ${store.tasksTable} d ON d.id=s.delivery_task_id
              WHERE s.delivery_task_id=t.id OR EXISTS (SELECT 1 FROM ${store.remediationAttemptsTable} a WHERE a.integration_source_id=s.id AND a.remediation_task_id=t.id)
              ORDER BY s.updated_at DESC LIMIT 1) AS root_delivery_task_title
       FROM ${store.tasksTable} t
       JOIN ${store.boardsTable} b ON b.id=t.board_id LEFT JOIN ${store.membersTable} m ON m.board_id=b.id AND m.user_id=$3
      WHERE t.id=$1 AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')
        AND t.deleted_at IS NULL
        AND (t.creation_state='complete' OR t.creation_lease_id=$4)
      ${forUpdate ? 'FOR UPDATE OF t' : ''}`,
    [taskId, identity.tenantId, identity.ownerUserId, creationClaimToken ?? null],
  );
  if (!result.rows[0]) throw new TaskboardNotFoundError('Task not found');
  const row = result.rows[0];
  const boardArchivedAt = lockedBoard?.archivedAt
    ?? (row.board_archived_at ? toIso(row.board_archived_at) : undefined);
  const boardModel = lockedBoard?.model ?? (row.board_model ? String(row.board_model) : undefined);
  const boardStageModels = lockedBoard?.stageModels ?? parseStageModels(row.board_stage_models);
  return {
    task: rowToTask(row),
    ...(boardArchivedAt ? { boardArchivedAt } : {}),
    ...(boardModel ? { boardModel } : {}),
    ...(Object.keys(boardStageModels).length ? { boardStageModels } : {}),
    ...boardRepositoryFragment(lockedBoard?.repository, row.board_repository),
    boardOwnerUserId: lockedBoard?.ownerUserId ?? String(row.board_owner_user_id),
    boardRole: lockedBoard?.role
      ?? (String(row.board_owner_user_id) === identity.ownerUserId
        ? 'owner'
        : row.board_member_role ? String(row.board_member_role) as TaskBoard['role'] : 'viewer'),
  };
}
