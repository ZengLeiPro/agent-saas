import type { PgTaskboardStore } from '../../taskboard/store.js';
import type {
  ContextSourceAuthorizationSubject,
  ContextSourceAuthorizer,
  ContextSourceLocator,
} from './sourceAuthorization.js';

export interface TaskboardSourceLocator extends ContextSourceLocator {
  sourceKind: 'taskboard' | string;
}

/** Only the existing store's live pool/table identities are needed; no ACL mirror is trusted. */
export type TaskboardAuthorizationStore = Pick<PgTaskboardStore, 'pool' | 'boardsTable' | 'tasksTable'>;

/**
 * Native Taskboard ACL: an active snapshot/event follows its board. Personal boards
 * are owner-only, organization boards are tenant-wide. Member rows deliberately play
 * no role. Delete events remain visible to whoever can currently see the board, while
 * deleted snapshots are denied.
 */
export class TaskboardContextSourceAuthorizer implements ContextSourceAuthorizer<TaskboardSourceLocator> {
  constructor(private readonly store: TaskboardAuthorizationStore) {}

  async authorize(
    subject: ContextSourceAuthorizationSubject,
    locator: TaskboardSourceLocator,
  ): Promise<boolean> {
    return (await this.authorizeBatch(subject, [locator]))[0] === true;
  }

  async authorizeBatch(
    subject: ContextSourceAuthorizationSubject,
    locators: readonly TaskboardSourceLocator[],
  ): Promise<readonly boolean[]> {
    if (locators.length === 0) return [];
    const eligible = locators.map((locator, index) => ({ locator, index })).filter(({ locator }) =>
      locator.sourceKind.toLowerCase() === 'taskboard'
      && locator.resourceType !== 'unknown'
      && !(locator.recordType === 'snapshot' && locator.deleted)
      && Boolean(locator.boardId || locator.taskId));
    const decisions = locators.map(() => false);
    if (eligible.length === 0) return decisions;

    const requestRows = eligible.map(({ locator, index }) => ({
      idx: index,
      recordType: locator.recordType,
      resourceType: locator.resourceType,
      boardId: locator.boardId ?? null,
      taskId: locator.taskId ?? null,
    }));
    const result = await this.store.pool.query(`
      WITH requested AS (
        SELECT * FROM JSONB_TO_RECORDSET($3::jsonb) AS request(
          idx integer, "recordType" text, "resourceType" text, "boardId" text, "taskId" text
        )
      )
      SELECT request.idx
      FROM requested request
      LEFT JOIN ${this.store.tasksTable} task ON task.id=request."taskId"
      JOIN ${this.store.boardsTable} board
        ON board.id=COALESCE(request."boardId",task.board_id)
      WHERE board.tenant_id=$1
        AND (board.owner_user_id=$2 OR board.visibility='organization')
        AND (
          request."resourceType"='board'
          OR (request."resourceType"='task' AND task.id IS NOT NULL AND task.board_id=board.id)
        )
        AND (
          request."recordType"='event'
          OR request."resourceType"='board'
          OR task.deleted_at IS NULL
        )
    `, [subject.tenantId, subject.userId, JSON.stringify(requestRows)]);
    for (const row of result.rows as Array<Record<string, unknown>>) {
      const index = Number(row.idx);
      if (Number.isSafeInteger(index) && index >= 0 && index < decisions.length) decisions[index] = true;
    }
    return decisions;
  }
}

/** Compatibility alias for composition roots/tests preferring the shorter name. */
export { TaskboardContextSourceAuthorizer as TaskboardSourceAuthorizer };
