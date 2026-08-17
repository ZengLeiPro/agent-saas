import { describe, expect, it } from 'vitest';
import { TASKBOARD_STATUSES } from '../../../shared/src/types/taskboard.js';
import { executionFieldMigrationSql, taskFieldMigrationSql } from './executionFields.js';
import { taskFieldsMigrationSql, taskTableSql } from './taskFields.js';

const EXPECTED_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'ready_to_merge',
  'blocked',
  'done',
  'canceled',
] as const;

function statusCheckSql(): string {
  return `CHECK (status IN (${EXPECTED_STATUSES.map((status) => `'${status}'`).join(', ')}))`;
}

describe('taskboard task status DDL', () => {
  it('creates task tables with the shared eight-stage status order', () => {
    expect(TASKBOARD_STATUSES).toEqual(EXPECTED_STATUSES);
    expect(taskTableSql('runtime_taskboard_tasks', 'runtime_taskboards')).toContain(statusCheckSql());
  });

  it('replaces the existing status CHECK without rewriting legacy statuses', () => {
    const sql = taskFieldsMigrationSql('runtime_taskboard_tasks');

    expect(sql).toContain(
      'ALTER TABLE runtime_taskboard_tasks DROP CONSTRAINT IF EXISTS runtime_taskboard_tasks_status_check;',
    );
    expect(sql).toContain(
      'ALTER TABLE runtime_taskboard_tasks ADD CONSTRAINT runtime_taskboard_tasks_status_check',
    );
    expect(sql).toContain(statusCheckSql());
    expect(sql).not.toMatch(/\bUPDATE\b/i);
  });

  it('keeps the session index non-unique for work execution reuse', () => {
    const sql = executionFieldMigrationSql('runtime_taskboard_execs');

    expect(sql).toContain('DROP INDEX IF EXISTS runtime_taskboard_execs_session_uidx;');
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS runtime_taskboard_execs_session_idx ON runtime_taskboard_execs (session_id, created_at DESC)',
    );
  });

  it('defines every delivery evidence column written by pull request registration', () => {
    const ddl = taskTableSql('runtime_taskboard_tasks', 'runtime_taskboards');
    const migration = taskFieldsMigrationSql('runtime_taskboard_tasks');
    for (const column of ['head_oid', 'base_oid']) {
      expect(ddl).toContain(`${column} TEXT`);
      expect(migration).toContain(
        `ALTER TABLE runtime_taskboard_tasks ADD COLUMN IF NOT EXISTS ${column} TEXT;`,
      );
    }
    // branch 由 executionFields.ts 的 taskFieldMigrationSql 补建，此处只确认整体不丢失
    expect(taskFieldMigrationSql('runtime_taskboard_tasks')).toContain('branch TEXT');
  });
});
