import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

import { PgGovernanceMigrationRunner, governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import type { DirectoryGroup, DirectoryGroupMember, UpsertDirectoryGroupProjectionInput } from './types.js';

export interface PgDirectoryGroupStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
  validateMember?: (tenantId: string, userId: string) => Promise<boolean>;
}

function groupFromRow(row: Record<string, unknown>): DirectoryGroup {
  return {
    groupId: String(row.group_id),
    tenantId: String(row.tenant_id),
    source: row.source as DirectoryGroup['source'],
    ...(row.external_group_id ? { externalGroupId: String(row.external_group_id) } : {}),
    displayName: String(row.display_name),
    ...(row.parent_group_id ? { parentGroupId: String(row.parent_group_id) } : {}),
    status: row.status as DirectoryGroup['status'],
    version: Number(row.version),
    ...(row.source_revision ? { sourceRevision: String(row.source_revision) } : {}),
    ...(row.projected_at ? { projectedAt: new Date(String(row.projected_at)).toISOString() } : {}),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export class PgDirectoryGroupStore {
  readonly groupsTable: string;
  readonly membersTable: string;

  constructor(private readonly options: PgDirectoryGroupStoreOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.groupsTable = `${prefix}_directory_groups`;
    this.membersTable = `${prefix}_directory_group_members`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.options.tablePrefix).run();
  }

  async getGroup(tenantId: string, groupId: string): Promise<DirectoryGroup | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.groupsTable} WHERE tenant_id=$1 AND group_id=$2`,
      [tenantId, groupId],
    );
    return result.rows[0] ? groupFromRow(result.rows[0]) : null;
  }

  async listGroups(tenantId: string): Promise<DirectoryGroup[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.groupsTable} WHERE tenant_id=$1 ORDER BY display_name,group_id`,
      [tenantId],
    );
    return result.rows.map(groupFromRow);
  }

  async listGroupIdsForUser(tenantId: string, userId: string): Promise<string[]> {
    const result = await this.options.pool.query(
      `SELECT m.group_id FROM ${this.membersTable} m
       JOIN ${this.groupsTable} g ON g.group_id=m.group_id AND g.tenant_id=m.tenant_id
       JOIN ${governanceTablePrefix(this.options.tablePrefix)}_tenant_memberships tm
         ON tm.tenant_id=m.tenant_id AND tm.user_id=m.user_id AND tm.status='active'
       WHERE m.tenant_id=$1 AND m.user_id=$2 AND g.status='active'
       ORDER BY m.group_id`,
      [tenantId, userId],
    );
    return result.rows.map(row => String(row.group_id));
  }

  async listMembers(tenantId: string, groupId: string): Promise<DirectoryGroupMember[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.membersTable} WHERE tenant_id=$1 AND group_id=$2 ORDER BY user_id`,
      [tenantId, groupId],
    );
    return result.rows.map(row => ({
      tenantId: String(row.tenant_id),
      groupId: String(row.group_id),
      userId: String(row.user_id),
      source: row.source as DirectoryGroupMember['source'],
      version: Number(row.version),
    }));
  }

  async getAssignmentSnapshot(tenantId: string, groupId: string, maxAgeMs = 15 * 60_000): Promise<{
    group: DirectoryGroup; memberUserIds: string[]; digest: string; fresh: boolean;
  } | null> {
    const group = await this.getGroup(tenantId, groupId);
    if (!group || group.status !== 'active') return null;
    const result = await this.options.pool.query<{ user_id: string; version: string }>(
      `SELECT gm.user_id,gm.version FROM ${this.membersTable} gm
       JOIN ${governanceTablePrefix(this.options.tablePrefix)}_tenant_memberships tm
         ON tm.tenant_id=gm.tenant_id AND tm.user_id=gm.user_id AND tm.status='active'
       WHERE gm.tenant_id=$1 AND gm.group_id=$2 ORDER BY gm.user_id`, [tenantId, groupId],
    );
    const memberUserIds = result.rows.map(row => row.user_id);
    const digest = createHash('sha256').update(JSON.stringify({
      groupId, version: group.version, sourceRevision: group.sourceRevision ?? null,
      members: result.rows.map(row => [row.user_id, Number(row.version)]),
    })).digest('hex');
    const fresh = group.source === 'governance'
      || Boolean(group.projectedAt && Date.now() - Date.parse(group.projectedAt) <= maxAgeMs);
    return { group, memberUserIds, digest, fresh };
  }

  async upsertProjection(input: UpsertDirectoryGroupProjectionInput): Promise<DirectoryGroup> {
    if (input.source === 'dingtalk' && !input.sourceRevision?.trim()) {
      throw new Error('DIRECTORY_SOURCE_REVISION_REQUIRED');
    }
    const memberUserIds = [...new Set(input.memberUserIds)];
    if (memberUserIds.length && !this.options.validateMember) {
      throw new Error('DIRECTORY_MEMBER_AUTHORITY_UNAVAILABLE');
    }
    for (const userId of memberUserIds) {
      if (!await this.options.validateMember!(input.tenantId, userId)) {
        throw new Error('DIRECTORY_MEMBER_TENANT_MISMATCH');
      }
    }
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      if (input.parentGroupId) {
        if (input.parentGroupId === input.groupId) throw new Error('DIRECTORY_GROUP_CYCLE');
        const parent = await client.query(
          `SELECT 1 FROM ${this.groupsTable} WHERE tenant_id=$1 AND group_id=$2 FOR SHARE`,
          [input.tenantId, input.parentGroupId],
        );
        if (!parent.rows[0]) throw new Error('DIRECTORY_PARENT_TENANT_MISMATCH');
        const cycle = await client.query(
          `WITH RECURSIVE ancestors(group_id,parent_group_id,visited) AS (
             SELECT group_id,parent_group_id,ARRAY[group_id]
             FROM ${this.groupsTable} WHERE tenant_id=$1 AND group_id=$2
             UNION ALL
             SELECT g.group_id,g.parent_group_id,a.visited||g.group_id
             FROM ${this.groupsTable} g JOIN ancestors a
               ON g.tenant_id=$1 AND g.group_id=a.parent_group_id
             WHERE NOT g.group_id=ANY(a.visited)
           ) SELECT 1 FROM ancestors WHERE group_id=$3 LIMIT 1`,
          [input.tenantId, input.parentGroupId, input.groupId],
        );
        if (cycle.rows[0]) throw new Error('DIRECTORY_GROUP_CYCLE');
      }
      const group = await this.upsertGroup(client, input);
      await client.query(
        `DELETE FROM ${this.membersTable} WHERE tenant_id=$1 AND group_id=$2`,
        [input.tenantId, input.groupId],
      );
      for (const userId of memberUserIds) {
        await client.query(
          `INSERT INTO ${this.membersTable} (tenant_id,group_id,user_id,source,version)
           VALUES ($1,$2,$3,$4,1)`,
          [input.tenantId, input.groupId, userId, input.source],
        );
      }
      await client.query('COMMIT');
      return group;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async upsertGroup(
    client: PoolClient,
    input: UpsertDirectoryGroupProjectionInput,
  ): Promise<DirectoryGroup> {
    const result = await client.query(
      `INSERT INTO ${this.groupsTable} (
         group_id,tenant_id,source,external_group_id,display_name,parent_group_id,status,version,source_revision,projected_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,NOW())
       ON CONFLICT (group_id) DO UPDATE SET
         display_name=EXCLUDED.display_name,parent_group_id=EXCLUDED.parent_group_id,
         status=EXCLUDED.status,external_group_id=EXCLUDED.external_group_id,
         source_revision=EXCLUDED.source_revision,projected_at=NOW(),
         version=${this.groupsTable}.version+1,updated_at=NOW()
       WHERE ${this.groupsTable}.tenant_id=EXCLUDED.tenant_id
         AND ${this.groupsTable}.source=EXCLUDED.source
       RETURNING *`,
      [
        input.groupId, input.tenantId, input.source, input.externalGroupId ?? null,
        input.displayName, input.parentGroupId ?? null, input.status,
        input.sourceRevision ?? `governance:${input.groupId}`,
      ],
    );
    if (!result.rows[0]) throw new Error('DIRECTORY_GROUP_IDENTITY_CONFLICT');
    return groupFromRow(result.rows[0]);
  }
}
