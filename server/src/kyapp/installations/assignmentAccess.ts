import type { PgAssignmentStore } from '../../data/assignments/store.js';
import { AssignmentInvariantError } from '../../data/assignments/types.js';
import type { PgDirectoryGroupStore } from '../../data/directoryGroups/store.js';
import type { GovernancePgPool } from '../../data/governance-schema/index.js';

export interface EffectiveInstallationSubject {
  subjectType: 'user' | 'agent';
  subjectId: string;
  bindings: Array<{
    assignmentId: string;
    assigneeType: string;
    assigneeId?: string;
    effect: string;
    origin: string;
  }>;
}

/** 业务系统专用只读授权投影；不改动治理 Store 的启动期迁移基线。 */
export class KyAppAssignmentAccess {
  constructor(
    private readonly pool: GovernancePgPool,
    private readonly assignments: PgAssignmentStore,
    private readonly groups?: Pick<
      PgDirectoryGroupStore,
      'listGroupIdsForUser' | 'groupsTable' | 'membersTable'
    >,
  ) {}

  readonly listEffectiveResourceIds: PgAssignmentStore['listEffectiveResourceIds'] = (
    tenantId,
    userId,
    resourceType,
    agentId,
  ) => {
    if (resourceType !== 'system_installation')
      return this.assignments.listEffectiveResourceIds(tenantId, userId, resourceType, agentId);
    return this.read(tenantId, userId, false, agentId);
  };

  /** 壳只用此结果保留停用标签；Gateway 始终使用上面的 enabled 过滤。 */
  listVisibleInstallationIds(tenantId: string, userId: string) {
    return this.read(tenantId, userId, true);
  }

  /**
   * 有效授权清单的集合查询。用户和 Agent 各自展开一次，拒绝规则覆盖允许规则，
   * 查询次数不随组织人数或 Agent 数增长。
   */
  async listEffectiveSubjectsForInstallation(input: {
    tenantId: string;
    installationId: string;
    userIds: string[];
    agentIds: string[];
  }): Promise<EffectiveInstallationSubject[]> {
    const groupClause = this.groups
      ? `OR (a.assignee_type='directory_group' AND EXISTS (
          SELECT 1 FROM ${this.groups.membersTable} gm
          JOIN ${this.groups.groupsTable} g
            ON g.tenant_id=gm.tenant_id AND g.group_id=gm.group_id AND g.status='active'
          WHERE gm.tenant_id=$1 AND gm.user_id=u.subject_id AND gm.group_id=a.assignee_id
        ))`
      : '';
    if (!this.groups) {
      const unresolved = await this.pool.query(
        `SELECT 1 FROM ${this.assignments.assignmentsTable}
         WHERE tenant_id=$1 AND resource_type='system_installation' AND resource_id=$2
           AND assignee_type='directory_group' LIMIT 1`,
        [input.tenantId, input.installationId],
      );
      if (unresolved.rows.length)
        throw new AssignmentInvariantError('ASSIGNMENT_GROUP_SUBJECT_UNRESOLVED');
    }
    const result = await this.pool.query(
      `WITH user_subjects AS (SELECT unnest($3::text[]) AS subject_id),
       agent_subjects AS (SELECT unnest($4::text[]) AS subject_id),
       matched AS (
         SELECT 'user'::text AS subject_type,u.subject_id,a.*
         FROM user_subjects u
         JOIN ${this.assignments.assignmentsTable} a ON
           a.assignee_type='everyone'
           OR (a.assignee_type='user' AND a.assignee_id=u.subject_id)
           ${groupClause}
         WHERE a.tenant_id=$1 AND a.resource_type='system_installation' AND a.resource_id=$2
         UNION ALL
         SELECT 'agent'::text AS subject_type,g.subject_id,a.*
         FROM agent_subjects g
         JOIN ${this.assignments.assignmentsTable} a ON
           a.assignee_type='everyone' OR (a.assignee_type='agent' AND a.assignee_id=g.subject_id)
         WHERE a.tenant_id=$1 AND a.resource_type='system_installation' AND a.resource_id=$2
       )
       SELECT m.subject_type,m.subject_id,
         JSON_AGG(JSON_BUILD_OBJECT('assignmentId',m.assignment_id,'assigneeType',m.assignee_type,
           'assigneeId',m.assignee_id,'effect',m.effect,'origin',m.origin)
           ORDER BY m.assignment_id) AS bindings
       FROM matched m
       JOIN ${this.assignments.assignmentSetsTable} s
         ON s.tenant_id=m.tenant_id AND s.resource_type=m.resource_type AND s.resource_id=m.resource_id
       WHERE s.resource_status='enabled'
       GROUP BY m.subject_type,m.subject_id
       HAVING BOOL_OR(m.effect='allow') AND NOT BOOL_OR(m.effect='deny')
       ORDER BY m.subject_type,m.subject_id`,
      [input.tenantId, input.installationId, input.userIds, input.agentIds],
    );
    return result.rows.map((row) => ({
      subjectType: row.subject_type as 'user' | 'agent',
      subjectId: String(row.subject_id),
      bindings: (Array.isArray(row.bindings) ? row.bindings : []).map(
        (binding: Record<string, unknown>) => ({
          assignmentId: String(binding.assignmentId),
          assigneeType: String(binding.assigneeType),
          ...(binding.assigneeId ? { assigneeId: String(binding.assigneeId) } : {}),
          effect: String(binding.effect),
          origin: String(binding.origin),
        }),
      ),
    }));
  }

  private async read(
    tenantId: string,
    userId: string,
    includeDisabled: boolean,
    agentId?: string,
  ): ReturnType<PgAssignmentStore['listEffectiveResourceIds']> {
    const tables = this.assignments;
    const groupRules = await this.pool.query(
      `SELECT 1 FROM ${tables.assignmentsTable} a
      JOIN ${tables.assignmentSetsTable} s USING (tenant_id,resource_type,resource_id)
      WHERE a.tenant_id=$1 AND a.resource_type='system_installation' AND a.assignee_type='directory_group'
      AND (s.resource_status='enabled' OR $2::boolean) LIMIT 1`,
      [tenantId, includeDisabled],
    );
    let groupIds: string[] = [];
    if (groupRules.rows.length) {
      if (!this.groups) throw new AssignmentInvariantError('ASSIGNMENT_GROUP_SUBJECT_UNRESOLVED');
      groupIds = await this.groups.listGroupIdsForUser(tenantId, userId);
    }
    const result = await this.pool.query(
      `SELECT s.resource_id,s.version AS assignment_version,
      MIN(a.assignment_id) FILTER (WHERE a.effect='allow') AS binding_id,
      JSON_AGG(JSON_BUILD_OBJECT('assignmentId',a.assignment_id,'assigneeType',a.assignee_type,
        'assigneeId',a.assignee_id,'effect',a.effect,'origin',a.origin) ORDER BY a.assignment_id) AS bindings
      FROM ${tables.assignmentSetsTable} s JOIN ${tables.assignmentsTable} a USING (tenant_id,resource_type,resource_id)
      WHERE s.tenant_id=$1 AND s.resource_type='system_installation' AND (s.resource_status='enabled' OR $5::boolean)
      AND (a.assignee_type='everyone' OR (a.assignee_type='user' AND a.assignee_id=$2)
        OR (a.assignee_type='agent' AND a.assignee_id=$3)
        OR (a.assignee_type='directory_group' AND a.assignee_id=ANY($4::text[])))
      GROUP BY s.resource_id,s.version HAVING BOOL_OR(a.effect='allow') AND NOT BOOL_OR(a.effect='deny')
      ORDER BY s.resource_id`,
      [tenantId, userId, agentId ?? null, groupIds, includeDisabled],
    );
    return result.rows.map((row) => ({
      resourceId: String(row.resource_id),
      bindingId: String(row.binding_id),
      assignmentVersion: Number(row.assignment_version),
      finalEffect: 'allow' as const,
      bindings: row.bindings,
    }));
  }
}
