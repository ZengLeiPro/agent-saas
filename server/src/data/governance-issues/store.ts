import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import type {
  GovernanceMigrationIssue,
  OpenGovernanceMigrationIssueInput,
} from './types.js';

type Queryable = Pick<GovernancePgPool, 'query'> | Pick<PoolClient, 'query'>;

export class PgGovernanceMigrationIssueStore {
  readonly issuesTable: string;

  constructor(private readonly pool: GovernancePgPool, tablePrefix?: string) {
    const prefix = governanceTablePrefix(tablePrefix);
    this.issuesTable = `${prefix}_governance_migration_issues`;
  }

  async open(input: OpenGovernanceMigrationIssueInput, queryable: Queryable = this.pool): Promise<GovernanceMigrationIssue> {
    const issueId = randomUUID();
    const result = await queryable.query(`
      INSERT INTO ${this.issuesTable} (
        issue_id, issue_type, tenant_id, resource_type, resource_id, legacy_key,
        detail_json, status, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'open', $8)
      ON CONFLICT (
        issue_type,
        (COALESCE(tenant_id, '')),
        (COALESCE(resource_type, '')),
        (COALESCE(resource_id, '')),
        (COALESCE(legacy_key, ''))
      ) WHERE status = 'open'
      DO UPDATE SET
        detail_json = EXCLUDED.detail_json,
        version = CASE
          WHEN ${this.issuesTable}.detail_json IS DISTINCT FROM EXCLUDED.detail_json
            THEN ${this.issuesTable}.version + 1
          ELSE ${this.issuesTable}.version
        END
      RETURNING *
    `, [
      issueId,
      input.issueType,
      input.tenantId ?? null,
      input.resourceType ?? null,
      input.resourceId ?? null,
      input.legacyKey ?? null,
      JSON.stringify(input.detail ?? {}),
      input.createdBy,
    ]);
    return rowToIssue(result.rows[0]);
  }

  async listOpen(tenantId?: string): Promise<GovernanceMigrationIssue[]> {
    const result = await this.pool.query(`
      SELECT * FROM ${this.issuesTable}
      WHERE status = 'open' AND ($1::text IS NULL OR tenant_id = $1)
      ORDER BY created_at, issue_id
    `, [tenantId ?? null]);
    return result.rows.map(rowToIssue);
  }

  async resolve(issueId: string, resolvedBy: string, status: 'resolved' | 'ignored'): Promise<GovernanceMigrationIssue | null> {
    const result = await this.pool.query(`
      UPDATE ${this.issuesTable}
      SET status = $2,
          version = version + 1,
          resolved_at = NOW(),
          resolved_by = $3
      WHERE issue_id = $1 AND status = 'open'
      RETURNING *
    `, [issueId, status, resolvedBy]);
    return result.rows[0] ? rowToIssue(result.rows[0]) : null;
  }
}

function rowToIssue(row: Record<string, unknown>): GovernanceMigrationIssue {
  return {
    issueId: String(row.issue_id),
    issueType: String(row.issue_type),
    ...(row.tenant_id ? { tenantId: String(row.tenant_id) } : {}),
    ...(row.resource_type ? { resourceType: String(row.resource_type) } : {}),
    ...(row.resource_id ? { resourceId: String(row.resource_id) } : {}),
    ...(row.legacy_key ? { legacyKey: String(row.legacy_key) } : {}),
    detail: (row.detail_json ?? {}) as GovernanceMigrationIssue['detail'],
    status: row.status as GovernanceMigrationIssue['status'],
    version: Number(row.version),
    createdAt: new Date(String(row.created_at)).toISOString(),
    createdBy: String(row.created_by),
    ...(row.resolved_at ? { resolvedAt: new Date(String(row.resolved_at)).toISOString() } : {}),
    ...(row.resolved_by ? { resolvedBy: String(row.resolved_by) } : {}),
  };
}
