import type { PgTaskboardStore } from '../../../taskboard/store.js';
import type { TaskboardContextReader } from './ports.js';
import type {
  TaskboardBoardRow,
  TaskboardChangeRow,
  TaskboardPage,
  TaskboardTaskRow,
  TaskboardVisibility,
} from './types.js';

type ReaderHost = Pick<PgTaskboardStore, 'pool' | 'boardsTable' | 'tasksTable' | 'changesTable'>;
type Row = Record<string, unknown>;

export class PgTaskboardContextReader implements TaskboardContextReader {
  constructor(private readonly host: ReaderHost) {}

  async listTenantIds(): Promise<string[]> {
    const result = await this.host.pool.query(
      `SELECT DISTINCT tenant_id FROM ${this.host.boardsTable} ORDER BY tenant_id`,
    );
    return result.rows.map(row => String(row.tenant_id));
  }

  async listBoards(tenantId: string, cursor: string | undefined, limit: number): Promise<TaskboardPage<TaskboardBoardRow>> {
    const result = await this.host.pool.query(
      `SELECT id,tenant_id,owner_user_id,name,description,visibility,version,archived_at,created_at,updated_at
         FROM ${this.host.boardsTable}
        WHERE tenant_id=$1 AND id>$2
        ORDER BY id
        LIMIT $3`,
      [tenantId, cursor ?? '', limit + 1],
    );
    return boundedPage(result.rows.map(boardFromRow), limit, row => row.id);
  }

  async listTasks(tenantId: string, cursor: string | undefined, limit: number): Promise<TaskboardPage<TaskboardTaskRow>> {
    const result = await this.host.pool.query(
      `${taskSelect(this.host)}
        WHERE b.tenant_id=$1 AND t.id>$2
        ORDER BY t.id
        LIMIT $3`,
      [tenantId, cursor ?? '', limit + 1],
    );
    return boundedPage(result.rows.map(taskFromRow), limit, row => row.id);
  }

  async getBoard(tenantId: string, boardId: string): Promise<TaskboardBoardRow | null> {
    const result = await this.host.pool.query(
      `SELECT id,tenant_id,owner_user_id,name,description,visibility,version,archived_at,created_at,updated_at
         FROM ${this.host.boardsTable}
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, boardId],
    );
    return result.rows[0] ? boardFromRow(result.rows[0]) : null;
  }

  async getTask(tenantId: string, taskId: string): Promise<TaskboardTaskRow | null> {
    const result = await this.host.pool.query(
      `${taskSelect(this.host)}
        WHERE b.tenant_id=$1 AND t.id=$2`,
      [tenantId, taskId],
    );
    return result.rows[0] ? taskFromRow(result.rows[0]) : null;
  }

  async getChangeUpperBound(tenantId: string): Promise<string> {
    const result = await this.host.pool.query(
      `SELECT COALESCE(MAX(c.seq),0)::text AS seq
         FROM ${this.host.changesTable} c
         LEFT JOIN ${this.host.tasksTable} t ON t.id=c.task_id
         JOIN ${this.host.boardsTable} b ON b.id=COALESCE(c.board_id,t.board_id)
        WHERE b.tenant_id=$1`,
      [tenantId],
    );
    return String(result.rows[0]?.seq ?? '0');
  }

  async listChanges(
    tenantId: string,
    afterSeq: string,
    throughSeq: string,
    limit: number,
  ): Promise<TaskboardPage<TaskboardChangeRow>> {
    const result = await this.host.pool.query(
      `SELECT c.seq::text AS seq,c.resource_type,c.resource_id,c.change_type,c.actor_type,c.actor_id,
              c.tombstone,c.created_at,b.tenant_id,b.owner_user_id,b.visibility
         FROM ${this.host.changesTable} c
         LEFT JOIN ${this.host.tasksTable} t ON t.id=c.task_id
         JOIN ${this.host.boardsTable} b ON b.id=COALESCE(c.board_id,t.board_id)
        WHERE b.tenant_id=$1 AND c.seq>$2::bigint AND c.seq<=$3::bigint
        ORDER BY c.seq
        LIMIT $4`,
      [tenantId, afterSeq, throughSeq, limit],
    );
    const items = result.rows.map(changeFromRow);
    return {
      items,
      ...(items.length === limit ? { nextCursor: items[items.length - 1]!.seq } : {}),
    };
  }
}

function taskSelect(host: Pick<ReaderHost, 'boardsTable' | 'tasksTable'>): string {
  return `SELECT t.id,b.tenant_id,t.board_id,b.name AS board_name,b.owner_user_id,b.visibility,
                 t.identifier,t.kind,t.title,t.description,t.status,t.priority,t.labels,t.due_at,
                 t.creator_user_id,t.creator_name,t.version,t.archived_at,t.deleted_at,t.completed_at,
                 t.created_at,t.updated_at
            FROM ${host.tasksTable} t
            JOIN ${host.boardsTable} b ON b.id=t.board_id`;
}

function boundedPage<T>(items: T[], limit: number, cursor: (item: T) => string): TaskboardPage<T> {
  const hasMore = items.length > limit;
  const pageItems = hasMore ? items.slice(0, limit) : items;
  return {
    items: pageItems,
    ...(hasMore ? { nextCursor: cursor(pageItems[pageItems.length - 1]!) } : {}),
  };
}

function boardFromRow(row: Row): TaskboardBoardRow {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    ...(optionalString(row.description) ? { description: optionalString(row.description) } : {}),
    visibility: visibility(row.visibility),
    version: Number(row.version),
    ...(optionalIso(row.archived_at) ? { archivedAt: optionalIso(row.archived_at) } : {}),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  };
}

function taskFromRow(row: Row): TaskboardTaskRow {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    boardId: String(row.board_id),
    boardName: String(row.board_name),
    ownerUserId: String(row.owner_user_id),
    visibility: visibility(row.visibility),
    identifier: String(row.identifier),
    kind: String(row.kind),
    title: String(row.title),
    description: String(row.description ?? ''),
    status: String(row.status),
    priority: String(row.priority),
    labels: Array.isArray(row.labels) ? row.labels.map(String) : [],
    ...(optionalIso(row.due_at) ? { dueAt: optionalIso(row.due_at) } : {}),
    ...(optionalString(row.creator_user_id) ? { creatorUserId: optionalString(row.creator_user_id) } : {}),
    ...(optionalString(row.creator_name) ? { creatorName: optionalString(row.creator_name) } : {}),
    version: Number(row.version),
    ...(optionalIso(row.archived_at) ? { archivedAt: optionalIso(row.archived_at) } : {}),
    ...(optionalIso(row.deleted_at) ? { deletedAt: optionalIso(row.deleted_at) } : {}),
    ...(optionalIso(row.completed_at) ? { completedAt: optionalIso(row.completed_at) } : {}),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  };
}

function changeFromRow(row: Row): TaskboardChangeRow {
  return {
    seq: String(row.seq),
    tenantId: String(row.tenant_id),
    resourceType: row.resource_type === 'board' ? 'board' : 'task',
    resourceId: String(row.resource_id),
    changeType: String(row.change_type),
    actorType: row.actor_type === 'user' || row.actor_type === 'agent' ? row.actor_type : 'system',
    actorId: String(row.actor_id),
    tombstone: Boolean(row.tombstone),
    createdAt: requiredIso(row.created_at),
    ownerUserId: String(row.owner_user_id),
    visibility: visibility(row.visibility),
  };
}

function visibility(value: unknown): TaskboardVisibility {
  return value === 'organization' ? 'organization' : 'personal';
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function optionalIso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredIso(value);
}

function requiredIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
