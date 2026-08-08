import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { PgGovernanceMigrationIssueStore } from '../governance-issues/index.js';
import { PgGovernanceMigrationRunner, governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import { PLATFORM_TENANT_ID } from '../tenants/types.js';
import {
  AssignmentInvariantError,
  type AssignmentResolution,
  type AssignmentResourceType,
  type AssignmentSubject,
  type LegacyAssignmentBackfillInput,
  type LegacyAssignmentBackfillResult,
  type LegacyAssignmentUser,
  type ResourceAssignment,
  type ResourceAssignmentInput,
  type ResourceAssignmentSet,
  type UserResourcePreference,
} from './types.js';

export interface PgAssignmentStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
  platformTenantId?: string;
}

type DesiredAssignment = {
  assigneeType: ResourceAssignment['assigneeType'];
  assigneeId?: string;
  effect: ResourceAssignment['effect'];
};

export class PgAssignmentStore {
  readonly assignmentSetsTable: string;
  readonly assignmentsTable: string;
  readonly preferencesTable: string;
  private readonly issueStore: PgGovernanceMigrationIssueStore;
  private readonly platformTenantId: string;

  constructor(private readonly options: PgAssignmentStoreOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.assignmentSetsTable = `${prefix}_resource_assignment_sets`;
    this.assignmentsTable = `${prefix}_resource_assignments`;
    this.preferencesTable = `${prefix}_user_resource_preferences`;
    this.issueStore = new PgGovernanceMigrationIssueStore(options.pool, options.tablePrefix);
    this.platformTenantId = options.platformTenantId ?? PLATFORM_TENANT_ID;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.options.tablePrefix).run();
  }

  async getAssignmentSet(
    tenantId: string,
    resourceType: AssignmentResourceType,
    resourceId: string,
  ): Promise<ResourceAssignmentSet | null> {
    this.assertCustomerTenant(tenantId);
    const setResult = await this.options.pool.query(
      `SELECT * FROM ${this.assignmentSetsTable}
       WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3`,
      [tenantId, resourceType, resourceId],
    );
    if (!setResult.rows[0]) return null;
    const assignments = await this.options.pool.query(
      `SELECT * FROM ${this.assignmentsTable}
       WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3
       ORDER BY assignee_type, assignee_id NULLS FIRST, assignment_id`,
      [tenantId, resourceType, resourceId],
    );
    return rowToAssignmentSet(setResult.rows[0], assignments.rows);
  }

  async replaceAssignments(
    tenantId: string,
    resourceType: AssignmentResourceType,
    resourceId: string,
    inputs: ResourceAssignmentInput[],
    expectedVersion: number,
    updatedBy: string,
  ): Promise<ResourceAssignmentSet> {
    this.assertCustomerTenant(tenantId);
    const normalized = normalizeAssignmentInputs(inputs);
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `assignment:${tenantId}:${resourceType}:${resourceId}`,
      ]);
      const current = await client.query(
        `SELECT * FROM ${this.assignmentSetsTable}
         WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3
         FOR UPDATE`,
        [tenantId, resourceType, resourceId],
      );
      if (!current.rows[0]) throw new AssignmentInvariantError('ASSIGNMENT_SET_NOT_FOUND');
      if (Number(current.rows[0].version) !== expectedVersion) {
        throw new AssignmentInvariantError('ASSIGNMENT_SET_VERSION_CONFLICT');
      }
      const setResult = await client.query(`
        UPDATE ${this.assignmentSetsTable}
        SET source = 'governance',
            version = version + 1,
            updated_at = NOW(),
            updated_by = $4
        WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3 AND version = $5
        RETURNING *
      `, [tenantId, resourceType, resourceId, updatedBy, expectedVersion]);
      if (!setResult.rows[0]) {
        throw new AssignmentInvariantError('ASSIGNMENT_SET_VERSION_CONFLICT');
      }
      await client.query(
        `DELETE FROM ${this.assignmentsTable}
         WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3`,
        [tenantId, resourceType, resourceId],
      );
      const rows: Record<string, unknown>[] = [];
      for (const input of normalized) {
        const assignmentId = randomUUID();
        const inserted = await client.query(`
          INSERT INTO ${this.assignmentsTable} (
            assignment_id, tenant_id, resource_type, resource_id,
            assignee_type, assignee_id, effect, origin,
            created_by, updated_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
          RETURNING *
        `, [
          assignmentId,
          tenantId,
          resourceType,
          resourceId,
          input.assigneeType,
          input.assigneeId ?? null,
          input.effect,
          input.origin ?? 'direct',
          updatedBy,
        ]);
        rows.push(inserted.rows[0]);
      }
      return rowToAssignmentSet(setResult.rows[0], rows);
    });
  }

  async setUserPreference(
    userId: string,
    resourceType: string,
    resourceId: string,
    enabled: boolean,
    expectedVersion: number,
  ): Promise<UserResourcePreference> {
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `preference:${userId}:${resourceType}:${resourceId}`,
      ]);
      const current = await client.query(
        `SELECT * FROM ${this.preferencesTable}
         WHERE user_id = $1 AND resource_type = $2 AND resource_id = $3
         FOR UPDATE`,
        [userId, resourceType, resourceId],
      );
      if (!current.rows[0]) {
        if (expectedVersion !== 0) {
          throw new AssignmentInvariantError('PREFERENCE_VERSION_CONFLICT');
        }
        const inserted = await client.query(`
          INSERT INTO ${this.preferencesTable} (
            user_id, resource_type, resource_id, enabled, source
          ) VALUES ($1, $2, $3, $4, 'user')
          RETURNING *
        `, [userId, resourceType, resourceId, enabled]);
        return rowToPreference(inserted.rows[0]);
      }
      if (Number(current.rows[0].version) !== expectedVersion) {
        throw new AssignmentInvariantError('PREFERENCE_VERSION_CONFLICT');
      }
      const updated = await client.query(`
        UPDATE ${this.preferencesTable}
        SET enabled = $4,
            source = 'user',
            version = version + 1,
            updated_at = NOW()
        WHERE user_id = $1 AND resource_type = $2 AND resource_id = $3 AND version = $5
        RETURNING *
      `, [userId, resourceType, resourceId, enabled, expectedVersion]);
      if (!updated.rows[0]) throw new AssignmentInvariantError('PREFERENCE_VERSION_CONFLICT');
      return rowToPreference(updated.rows[0]);
    });
  }

  async listUserPreferences(userId: string): Promise<UserResourcePreference[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.preferencesTable} WHERE user_id = $1 ORDER BY resource_type, resource_id`,
      [userId],
    );
    return result.rows.map(rowToPreference);
  }

  async backfillLegacyAssignments(input: LegacyAssignmentBackfillInput): Promise<LegacyAssignmentBackfillResult> {
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['governance-assignment-backfill']);
      let resourceSetsProjected = 0;
      let assignmentsProjected = 0;
      let preferencesProjected = 0;
      let issuesRecorded = 0;
      const usersByTenant = groupUsersByTenant(input.users);

      const recordIssue = async (args: {
        issueType: string;
        tenantId?: string;
        resourceType?: string;
        resourceId?: string;
        legacyKey?: string;
        detail?: Record<string, string | number | boolean | null>;
      }) => {
        await this.issueStore.open({ ...args, createdBy: input.projectedBy }, client);
        issuesRecorded += 1;
      };

      for (const agent of input.orgAgents) {
        if (agent.tenantId === input.platformTenantId) {
          await recordIssue({
            issueType: 'platform_resource_quarantine_required',
            tenantId: agent.tenantId,
            resourceType: 'org_agent',
            resourceId: agent.id,
          });
          continue;
        }
        const desired = await legacyAudienceAssignments(
          agent.tenantId,
          'org_agent',
          agent.id,
          agent.audience.exposure,
          agent.audience.usernames,
          usersByTenant.get(agent.tenantId) ?? [],
          recordIssue,
        );
        if ((agent.audience.departmentIds?.length ?? 0) > 0 || (agent.audience.roles?.length ?? 0) > 0) {
          await recordIssue({
            issueType: 'legacy_directory_assignment_semantics_pending',
            tenantId: agent.tenantId,
            resourceType: 'org_agent',
            resourceId: agent.id,
            detail: {
              departmentCount: agent.audience.departmentIds?.length ?? 0,
              roleCount: agent.audience.roles?.length ?? 0,
            },
          });
        }
        const changed = await this.upsertLegacySet(
          client,
          agent.tenantId,
          'org_agent',
          agent.id,
          desired,
          input.projectedBy,
        );
        if (changed) {
          resourceSetsProjected += 1;
          assignmentsProjected += desired.length;
        }
      }

      for (const [tenantId, config] of Object.entries(input.tenantSkillConfigs)) {
        if (tenantId === input.platformTenantId) continue;
        const poolRules = config.skills ?? {};
        const ownRules = config.ownSkills ?? {};
        const collisions = new Set(
          Object.keys(poolRules).filter(skillId => Object.hasOwn(ownRules, skillId)),
        );
        for (const skillId of collisions) {
          await recordIssue({
            issueType: 'legacy_skill_resource_id_collision',
            tenantId,
            resourceType: 'skill',
            resourceId: skillId,
          });
        }
        const rules = Object.entries({ ...poolRules, ...ownRules })
          .filter(([skillId]) => !collisions.has(skillId));
        if (config.enabledSkills && Object.keys(poolRules).length === 0) {
          await recordIssue({
            issueType: 'legacy_skill_assignment_catalog_required',
            tenantId,
            resourceType: 'skill',
            resourceId: '*',
            detail: { enabledSkillCount: config.enabledSkills.length },
          });
        }
        for (const [skillId, rule] of rules) {
          const desired = rule.enabled
            ? await legacyAudienceAssignments(
              tenantId,
              'skill',
              skillId,
              rule.exposure,
              rule.usernames,
              usersByTenant.get(tenantId) ?? [],
              recordIssue,
            )
            : [];
          const changed = await this.upsertLegacySet(
            client,
            tenantId,
            'skill',
            skillId,
            desired,
            input.projectedBy,
          );
          if (changed) {
            resourceSetsProjected += 1;
            assignmentsProjected += desired.length;
          }
        }
      }

      for (const [username, config] of Object.entries(input.userSkillConfigs)) {
        const matches = input.users.filter(user => user.username.toLocaleLowerCase() === username.toLocaleLowerCase());
        if (matches.length !== 1) {
          await recordIssue({
            issueType: 'preference_username_unresolved',
            resourceType: 'skill',
            legacyKey: username,
            detail: { matchCount: matches.length },
          });
          continue;
        }
        const user = matches[0];
        if (user.tenantId === input.platformTenantId) {
          await recordIssue({
            issueType: 'platform_user_preference_quarantined',
            tenantId: user.tenantId,
            resourceType: 'skill',
            resourceId: '*',
            legacyKey: username,
          });
          continue;
        }
        const selectedSkillIds = [...new Set(config.selectedSkills)];
        for (const skillId of selectedSkillIds) {
          const result = await client.query(`
            INSERT INTO ${this.preferencesTable} (
              user_id, resource_type, resource_id, enabled, source
            ) VALUES ($1, 'skill', $2, TRUE, 'legacy_projection')
            ON CONFLICT (user_id, resource_type, resource_id) DO UPDATE SET
              enabled = TRUE,
              version = ${this.preferencesTable}.version + 1,
              updated_at = NOW()
            WHERE ${this.preferencesTable}.source = 'legacy_projection'
              AND ${this.preferencesTable}.enabled IS DISTINCT FROM TRUE
            RETURNING 1
          `, [user.id, skillId]);
          if (result.rowCount) preferencesProjected += 1;
        }
        const disabled = await client.query(`
          UPDATE ${this.preferencesTable}
          SET enabled = FALSE,
              version = version + 1,
              updated_at = NOW()
          WHERE user_id = $1
            AND resource_type = 'skill'
            AND source = 'legacy_projection'
            AND enabled = TRUE
            AND NOT (resource_id = ANY($2::text[]))
          RETURNING 1
        `, [user.id, selectedSkillIds]);
        preferencesProjected += disabled.rowCount ?? 0;
      }

      return { resourceSetsProjected, assignmentsProjected, preferencesProjected, issuesRecorded };
    });
  }

  private async upsertLegacySet(
    client: PoolClient,
    tenantId: string,
    resourceType: AssignmentResourceType,
    resourceId: string,
    desiredInput: DesiredAssignment[],
    projectedBy: string,
  ): Promise<boolean> {
    const desired = normalizeDesiredAssignments(desiredInput);
    const currentSet = await client.query(
      `SELECT * FROM ${this.assignmentSetsTable}
       WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3
       FOR UPDATE`,
      [tenantId, resourceType, resourceId],
    );
    if (currentSet.rows[0]?.source === 'governance') return false;
    const currentAssignments = currentSet.rows[0]
      ? await client.query(
        `SELECT assignee_type, assignee_id, effect, origin
         FROM ${this.assignmentsTable}
         WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3
         ORDER BY assignee_type, assignee_id NULLS FIRST, effect`,
        [tenantId, resourceType, resourceId],
      )
      : { rows: [] as Record<string, unknown>[] };
    const currentKeys = currentAssignments.rows.map(legacyAssignmentRowKey).sort();
    const desiredKeys = desired.map(assignmentKey).sort();
    if (
      currentSet.rows[0]
      && currentKeys.length === desiredKeys.length
      && currentKeys.every((key, index) => key === desiredKeys[index])
    ) {
      return false;
    }

    await client.query(`
      INSERT INTO ${this.assignmentSetsTable} (
        tenant_id, resource_type, resource_id, source, created_by, updated_by
      ) VALUES ($1, $2, $3, 'legacy_projection', $4, $4)
      ON CONFLICT (tenant_id, resource_type, resource_id) DO UPDATE SET
        version = ${this.assignmentSetsTable}.version + 1,
        updated_at = NOW(),
        updated_by = EXCLUDED.updated_by
      WHERE ${this.assignmentSetsTable}.source = 'legacy_projection'
    `, [tenantId, resourceType, resourceId, projectedBy]);
    await client.query(
      `DELETE FROM ${this.assignmentsTable}
       WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3 AND origin = 'migration'`,
      [tenantId, resourceType, resourceId],
    );
    for (const assignment of desired) {
      await client.query(`
        INSERT INTO ${this.assignmentsTable} (
          assignment_id, tenant_id, resource_type, resource_id,
          assignee_type, assignee_id, effect, origin,
          created_by, updated_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'migration', $8, $8)
      `, [
        randomUUID(),
        tenantId,
        resourceType,
        resourceId,
        assignment.assigneeType,
        assignment.assigneeId ?? null,
        assignment.effect,
        projectedBy,
      ]);
    }
    return true;
  }

  private assertCustomerTenant(tenantId: string): void {
    if (tenantId === this.platformTenantId) {
      throw new AssignmentInvariantError('PLATFORM_TENANT_GOVERNANCE_FORBIDDEN');
    }
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function resolveAssignment(
  assignments: Array<Pick<ResourceAssignment, 'assigneeType' | 'assigneeId' | 'effect'>>,
  subject: AssignmentSubject,
): AssignmentResolution {
  const matches = assignments.filter(assignment => assignmentMatches(assignment, subject));
  if (matches.some(assignment => assignment.effect === 'deny')) return 'denied';
  if (matches.some(assignment => assignment.effect === 'allow')) return 'assigned';
  return 'needs_assignment';
}

async function legacyAudienceAssignments(
  tenantId: string,
  resourceType: AssignmentResourceType,
  resourceId: string,
  exposure: 'all' | 'allow_users' | 'deny_users',
  usernames: string[],
  users: LegacyAssignmentUser[],
  recordIssue: (args: {
    issueType: string;
    tenantId?: string;
    resourceType?: string;
    resourceId?: string;
    legacyKey?: string;
    detail?: Record<string, string | number | boolean | null>;
  }) => Promise<void>,
): Promise<DesiredAssignment[]> {
  if (exposure === 'all') return [{ assigneeType: 'everyone', effect: 'allow' }];
  const desired: DesiredAssignment[] = exposure === 'deny_users'
    ? [{ assigneeType: 'everyone', effect: 'allow' }]
    : [];
  for (const username of [...new Set(usernames)]) {
    const normalized = username.toLocaleLowerCase();
    const matches = users.filter(user => user.username.toLocaleLowerCase() === normalized);
    if (matches.length !== 1) {
      await recordIssue({
        issueType: exposure === 'deny_users'
          ? 'deny_username_assignment_unresolved'
          : 'allow_username_assignment_unresolved',
        tenantId,
        resourceType,
        resourceId,
        legacyKey: username,
        detail: { matchCount: matches.length },
      });
      continue;
    }
    desired.push({
      assigneeType: 'user',
      assigneeId: matches[0].id,
      effect: exposure === 'deny_users' ? 'deny' : 'allow',
    });
  }
  return desired;
}

function normalizeAssignmentInputs(inputs: ResourceAssignmentInput[]): ResourceAssignmentInput[] {
  const normalized = inputs.map(input => {
    const assigneeId = input.assigneeId?.trim();
    if (
      (input.assigneeType === 'everyone' && assigneeId)
      || (input.assigneeType !== 'everyone' && !assigneeId)
    ) {
      throw new AssignmentInvariantError('INVALID_ASSIGNMENT_ASSIGNEE');
    }
    return {
      ...input,
      ...(input.assigneeType === 'everyone' ? { assigneeId: undefined } : { assigneeId }),
    };
  });
  const keys = normalized.map(input => `${input.assigneeType}:${input.assigneeId ?? ''}`);
  if (new Set(keys).size !== keys.length) {
    throw new AssignmentInvariantError('INVALID_ASSIGNMENT_ASSIGNEE');
  }
  return normalized;
}

function normalizeDesiredAssignments(inputs: DesiredAssignment[]): DesiredAssignment[] {
  const byAssignee = new Map<string, DesiredAssignment>();
  for (const input of inputs) {
    const key = `${input.assigneeType}:${input.assigneeId ?? ''}`;
    const current = byAssignee.get(key);
    if (!current || input.effect === 'deny') byAssignee.set(key, input);
  }
  return [...byAssignee.values()].sort((a, b) => assignmentKey(a).localeCompare(assignmentKey(b)));
}

function assignmentMatches(
  assignment: Pick<ResourceAssignment, 'assigneeType' | 'assigneeId'>,
  subject: AssignmentSubject,
): boolean {
  if (assignment.assigneeType === 'everyone') return true;
  if (assignment.assigneeType === 'user') return assignment.assigneeId === subject.userId;
  if (assignment.assigneeType === 'directory_group') {
    return subject.directoryGroupIds?.includes(assignment.assigneeId ?? '') === true;
  }
  return assignment.assigneeId === subject.agentId;
}

function groupUsersByTenant(users: LegacyAssignmentUser[]): Map<string, LegacyAssignmentUser[]> {
  const result = new Map<string, LegacyAssignmentUser[]>();
  for (const user of users) {
    const current = result.get(user.tenantId) ?? [];
    current.push(user);
    result.set(user.tenantId, current);
  }
  return result;
}

function assignmentKey(input: DesiredAssignment): string {
  return `${input.assigneeType}:${input.assigneeId ?? ''}:${input.effect}:migration`;
}

function legacyAssignmentRowKey(row: Record<string, unknown>): string {
  return `${String(row.assignee_type)}:${row.assignee_id ? String(row.assignee_id) : ''}:${String(row.effect)}:${String(row.origin)}`;
}

function rowToAssignmentSet(
  row: Record<string, unknown>,
  assignmentRows: Record<string, unknown>[],
): ResourceAssignmentSet {
  return {
    tenantId: String(row.tenant_id),
    resourceType: row.resource_type as AssignmentResourceType,
    resourceId: String(row.resource_id),
    source: row.source as ResourceAssignmentSet['source'],
    version: Number(row.version),
    assignments: assignmentRows.map(rowToAssignment),
    createdAt: new Date(String(row.created_at)).toISOString(),
    createdBy: String(row.created_by),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    updatedBy: String(row.updated_by),
  };
}

function rowToAssignment(row: Record<string, unknown>): ResourceAssignment {
  return {
    assignmentId: String(row.assignment_id),
    tenantId: String(row.tenant_id),
    resourceType: row.resource_type as AssignmentResourceType,
    resourceId: String(row.resource_id),
    assigneeType: row.assignee_type as ResourceAssignment['assigneeType'],
    ...(row.assignee_id ? { assigneeId: String(row.assignee_id) } : {}),
    effect: row.effect as ResourceAssignment['effect'],
    origin: row.origin as ResourceAssignment['origin'],
    version: Number(row.version),
    createdAt: new Date(String(row.created_at)).toISOString(),
    createdBy: String(row.created_by),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    updatedBy: String(row.updated_by),
  };
}

function rowToPreference(row: Record<string, unknown>): UserResourcePreference {
  return {
    userId: String(row.user_id),
    resourceType: String(row.resource_type),
    resourceId: String(row.resource_id),
    enabled: Boolean(row.enabled),
    source: row.source as UserResourcePreference['source'],
    version: Number(row.version),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}
