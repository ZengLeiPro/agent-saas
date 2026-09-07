import type { PgAssignmentStore } from '../../data/assignments/store.js';
import { AssignmentInvariantError } from '../../data/assignments/types.js';
import type { PgDirectoryGroupStore } from '../../data/directoryGroups/store.js';
import type { GovernancePgPool } from '../../data/governance-schema/index.js';

/** 业务系统专用只读授权投影；不改动治理 Store 的启动期迁移基线。 */
export class KyAppAssignmentAccess {
  constructor(
    private readonly pool: GovernancePgPool,
    private readonly assignments: PgAssignmentStore,
    private readonly groups?: Pick<PgDirectoryGroupStore, 'listGroupIdsForUser'>,
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
