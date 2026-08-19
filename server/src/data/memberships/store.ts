import type { PoolClient } from 'pg';

import { PgGovernanceMigrationIssueStore } from '../governance-issues/store.js';
import { PgGovernanceMigrationRunner, governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import type {
  LegacyMembershipBackfillInput,
  MembershipBackfillResult,
  MembershipIdentityPatch,
  PlatformAdmin,
  PlatformAdminPatch,
  TenantMembership,
} from './types.js';
import { MembershipInvariantError } from './types.js';

export interface PgMembershipStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

export class PgMembershipStore {
  readonly membershipsTable: string;
  readonly platformAdminsTable: string;
  private readonly issueStore: PgGovernanceMigrationIssueStore;
  private readonly tablePrefix?: string;

  constructor(private readonly options: PgMembershipStoreOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.tablePrefix = options.tablePrefix;
    this.membershipsTable = `${prefix}_tenant_memberships`;
    this.platformAdminsTable = `${prefix}_platform_admins`;
    this.issueStore = new PgGovernanceMigrationIssueStore(options.pool, options.tablePrefix);
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async createMembership(input: {
    tenantId: string;
    userId: string;
    persona: TenantMembership['persona'];
    createdBy: string;
  }): Promise<TenantMembership> {
    if (!input.tenantId.trim() || !input.userId.trim() || !input.createdBy.trim()) {
      throw new MembershipInvariantError('MEMBERSHIP_IDENTITY_INVALID');
    }
    return this.withTransaction(async client => {
      // 用户落库会触发异步 legacy_projection；若影子投影先写入，治理创建应接管该行而不是误报重复。
      const created = await client.query(`
        INSERT INTO ${this.membershipsTable} (
          tenant_id, user_id, persona, is_owner, status, source, created_by, updated_by
        ) VALUES ($1, $2, $3, FALSE, 'active', 'governance', $4, $4)
        ON CONFLICT (user_id) DO UPDATE SET
          persona = EXCLUDED.persona,
          status = EXCLUDED.status,
          source = 'governance',
          version = ${this.membershipsTable}.version + 1,
          updated_at = NOW(),
          updated_by = EXCLUDED.updated_by
        WHERE ${this.membershipsTable}.source = 'legacy_projection'
        RETURNING *
      `, [input.tenantId, input.userId, input.persona, input.createdBy]);
      if (!created.rows[0]) throw new MembershipInvariantError('MEMBERSHIP_ALREADY_EXISTS');
      return rowToMembership(created.rows[0]);
    });
  }

  async offboardMembership(input: {
    tenantId: string;
    userId: string;
    handoffTargetUserId: string;
    updatedBy: string;
  }): Promise<{ offboarded: TenantMembership; handoffTarget: TenantMembership }> {
    if (!input.tenantId.trim() || !input.userId.trim() || !input.handoffTargetUserId.trim()
      || input.userId === input.handoffTargetUserId) {
      throw new MembershipInvariantError('MEMBERSHIP_IDENTITY_INVALID');
    }
    return this.withTransaction(async client => {
      const result = await client.query(
        `SELECT * FROM ${this.membershipsTable} WHERE tenant_id=$1 AND user_id IN ($2,$3) FOR UPDATE`,
        [input.tenantId, input.userId, input.handoffTargetUserId],
      );
      const current = result.rows.find(row => String(row.user_id) === input.userId);
      const target = result.rows.find(row => String(row.user_id) === input.handoffTargetUserId);
      if (!current || !target || target.status !== 'active') {
        throw new MembershipInvariantError('MEMBERSHIP_NOT_FOUND');
      }
      await client.query(`
        UPDATE ${this.membershipsTable}
        SET persona='org_admin',is_owner=TRUE,status='active',version=version+1,
            updated_at=NOW(),updated_by=$4
        WHERE tenant_id=$1 AND user_id=$3
      `, [input.tenantId, input.userId, input.handoffTargetUserId, input.updatedBy]);
      const offboarded = await client.query(`
        UPDATE ${this.membershipsTable}
        SET is_owner=FALSE,status='disabled',version=version+1,updated_at=NOW(),updated_by=$3
        WHERE tenant_id=$1 AND user_id=$2 RETURNING *
      `, [input.tenantId, input.userId, input.updatedBy]);
      const handoff = await client.query(
        `SELECT * FROM ${this.membershipsTable} WHERE tenant_id=$1 AND user_id=$2`,
        [input.tenantId, input.handoffTargetUserId],
      );
      return { offboarded: rowToMembership(offboarded.rows[0]), handoffTarget: rowToMembership(handoff.rows[0]) };
    });
  }

  async getMembership(tenantId: string, userId: string): Promise<TenantMembership | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.membershipsTable} WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );
    return result.rows[0] ? rowToMembership(result.rows[0]) : null;
  }

  async listMemberships(tenantId: string): Promise<TenantMembership[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.membershipsTable} WHERE tenant_id = $1 ORDER BY created_at, user_id`,
      [tenantId],
    );
    return result.rows.map(rowToMembership);
  }

  async getPlatformAdmin(userId: string): Promise<PlatformAdmin | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.platformAdminsTable} WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0] ? rowToPlatformAdmin(result.rows[0]) : null;
  }

  async listPlatformAdmins(): Promise<PlatformAdmin[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.platformAdminsTable} ORDER BY created_at, user_id`,
    );
    return result.rows.map(rowToPlatformAdmin);
  }

  async updateMembershipIdentity(
    tenantId: string,
    userId: string,
    patch: MembershipIdentityPatch,
  ): Promise<TenantMembership> {
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`membership:${tenantId}`]);
      const currentResult = await client.query(
        `SELECT * FROM ${this.membershipsTable}
         WHERE tenant_id = $1 AND user_id = $2
         FOR UPDATE`,
        [tenantId, userId],
      );
      const currentRow = currentResult.rows[0];
      if (!currentRow) throw new MembershipInvariantError('MEMBERSHIP_NOT_FOUND');
      const current = rowToMembership(currentRow);
      if (current.version !== patch.expectedVersion) {
        throw new MembershipInvariantError('MEMBERSHIP_VERSION_CONFLICT');
      }

      const persona = patch.persona ?? current.persona;
      const isOwner = patch.isOwner ?? current.isOwner;
      const status = patch.status ?? current.status;
      if (isOwner && persona !== 'org_admin') {
        throw new MembershipInvariantError('OWNER_MUST_BE_ORG_ADMIN');
      }

      if (patch.authorization.kind === 'platform_recovery') {
        const platformActor = await client.query(
          `SELECT status FROM ${this.platformAdminsTable} WHERE user_id = $1 FOR UPDATE`,
          [patch.updatedBy],
        );
        const explicitCustomerScope = patch.authorization.actorTenantId !== tenantId;
        const hasReason = Boolean(patch.authorization.reason?.trim());
        const recoveryOnly = persona === 'org_admin' && isOwner && status === 'active'
          && patch.persona !== 'member' && patch.isOwner !== false && patch.status !== 'disabled';
        if (platformActor.rows[0]?.status !== 'active' || !explicitCustomerScope || !hasReason || !recoveryOnly) {
          throw new MembershipInvariantError('PLATFORM_RECOVERY_SCOPE_REQUIRED');
        }
      } else {
        let actor = current;
        if (patch.updatedBy !== userId) {
          const actorResult = await client.query(
            `SELECT * FROM ${this.membershipsTable}
             WHERE tenant_id = $1 AND user_id = $2
             FOR UPDATE`,
            [tenantId, patch.updatedBy],
          );
          if (!actorResult.rows[0]) throw new MembershipInvariantError('MEMBERSHIP_CHANGE_FORBIDDEN');
          actor = rowToMembership(actorResult.rows[0]);
        }
        if (patch.authorization.actorTenantId !== tenantId
          || actor.status !== 'active' || actor.persona !== 'org_admin') {
          throw new MembershipInvariantError('MEMBERSHIP_CHANGE_FORBIDDEN');
        }
        if (!actor.isOwner) {
          const changesAdminIdentity = persona !== current.persona || isOwner !== current.isOwner;
          const changesPeerAdminStatus = status !== current.status
            && (current.persona === 'org_admin' || current.isOwner);
          if (changesAdminIdentity || changesPeerAdminStatus) {
            throw new MembershipInvariantError('MEMBERSHIP_CHANGE_FORBIDDEN');
          }
        }
      }

      const willBeEffectiveOwner = isOwner && persona === 'org_admin' && status === 'active';
      const otherOwners = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM ${this.membershipsTable}
         WHERE tenant_id = $1
           AND user_id <> $2
           AND persona = 'org_admin'
           AND is_owner = TRUE
           AND status = 'active'`,
        [tenantId, userId],
      );
      const effectiveOwnerCount = Number(otherOwners.rows[0]?.count ?? 0)
        + (willBeEffectiveOwner ? 1 : 0);
      if (effectiveOwnerCount < 1) {
        throw new MembershipInvariantError('LAST_EFFECTIVE_OWNER_PROTECTED');
      }

      const updated = await client.query(`
        UPDATE ${this.membershipsTable}
        SET persona = $3,
            is_owner = $4,
            status = $5,
            source = 'governance',
            version = version + 1,
            updated_at = NOW(),
            updated_by = $6
        WHERE tenant_id = $1 AND user_id = $2 AND version = $7
        RETURNING *
      `, [tenantId, userId, persona, isOwner, status, patch.updatedBy, patch.expectedVersion]);
      if (!updated.rows[0]) {
        throw new MembershipInvariantError('MEMBERSHIP_VERSION_CONFLICT');
      }
      return rowToMembership(updated.rows[0]);
    });
  }

  async updatePlatformAdmin(userId: string, patch: PlatformAdminPatch): Promise<PlatformAdmin> {
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['platform-admins']);
      const currentResult = await client.query(
        `SELECT * FROM ${this.platformAdminsTable} WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      const currentRow = currentResult.rows[0];
      if (!currentRow) throw new MembershipInvariantError('PLATFORM_ADMIN_NOT_FOUND');
      const current = rowToPlatformAdmin(currentRow);
      if (current.version !== patch.expectedVersion) {
        throw new MembershipInvariantError('PLATFORM_ADMIN_VERSION_CONFLICT');
      }
      const otherActive = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM ${this.platformAdminsTable}
         WHERE user_id <> $1 AND status = 'active'`,
        [userId],
      );
      const effectiveAdminCount = Number(otherActive.rows[0]?.count ?? 0)
        + (patch.status === 'active' ? 1 : 0);
      if (effectiveAdminCount < 1) {
        throw new MembershipInvariantError('LAST_PLATFORM_ADMIN_PROTECTED');
      }
      const updated = await client.query(`
        UPDATE ${this.platformAdminsTable}
        SET status = $2,
            source = 'governance',
            version = version + 1,
            updated_at = NOW(),
            updated_by = $3
        WHERE user_id = $1 AND version = $4
        RETURNING *
      `, [userId, patch.status, patch.updatedBy, patch.expectedVersion]);
      if (!updated.rows[0]) {
        throw new MembershipInvariantError('PLATFORM_ADMIN_VERSION_CONFLICT');
      }
      return rowToPlatformAdmin(updated.rows[0]);
    });
  }

  async backfillLegacyIdentities(input: LegacyMembershipBackfillInput): Promise<MembershipBackfillResult> {
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['governance-membership-backfill']);
      const knownTenantIds = new Set(input.tenants.map(tenant => tenant.id));
      const membershipsByTenant = new Map<string, typeof input.users>();
      let membershipsProjected = 0;
      let platformAdminsProjected = 0;
      let issuesRecorded = 0;

      for (const user of input.users) {
        if (user.tenantId === input.platformTenantId) {
          if (user.role !== 'admin') {
            await this.issueStore.open({
              issueType: 'platform_tenant_member_forbidden',
              tenantId: user.tenantId,
              resourceType: 'user',
              resourceId: user.id,
              createdBy: input.projectedBy,
            }, client);
            issuesRecorded += 1;
            continue;
          }
          await client.query(`
            INSERT INTO ${this.platformAdminsTable} (
              user_id, status, source, created_by, updated_by
            ) VALUES ($1, $2, 'legacy_projection', $3, $3)
            ON CONFLICT (user_id) DO UPDATE SET
              status = EXCLUDED.status,
              version = ${this.platformAdminsTable}.version + 1,
              updated_at = NOW(),
              updated_by = EXCLUDED.updated_by
            WHERE ${this.platformAdminsTable}.source = 'legacy_projection'
              AND ${this.platformAdminsTable}.status IS DISTINCT FROM EXCLUDED.status
          `, [user.id, user.disabled ? 'disabled' : 'active', input.projectedBy]);
          platformAdminsProjected += 1;
          continue;
        }

        if (!knownTenantIds.has(user.tenantId)) {
          await this.issueStore.open({
            issueType: 'membership_tenant_missing',
            tenantId: user.tenantId,
            resourceType: 'user',
            resourceId: user.id,
            createdBy: input.projectedBy,
          }, client);
          issuesRecorded += 1;
          continue;
        }

        const tenantUsers = membershipsByTenant.get(user.tenantId) ?? [];
        tenantUsers.push(user);
        membershipsByTenant.set(user.tenantId, tenantUsers);
        await client.query(`
          INSERT INTO ${this.membershipsTable} (
            tenant_id, user_id, persona, is_owner, status, source, created_by, updated_by
          ) VALUES ($1, $2, $3, FALSE, $4, 'legacy_projection', $5, $5)
          ON CONFLICT (tenant_id, user_id) DO UPDATE SET
            persona = EXCLUDED.persona,
            status = EXCLUDED.status,
            version = ${this.membershipsTable}.version + 1,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by
          WHERE ${this.membershipsTable}.source = 'legacy_projection'
            AND (
              ${this.membershipsTable}.persona IS DISTINCT FROM EXCLUDED.persona
              OR ${this.membershipsTable}.status IS DISTINCT FROM EXCLUDED.status
            )
        `, [
          user.tenantId,
          user.id,
          user.role === 'admin' ? 'org_admin' : 'member',
          user.disabled ? 'disabled' : 'active',
          input.projectedBy,
        ]);
        membershipsProjected += 1;
      }

      for (const tenant of input.tenants) {
        if (tenant.id === input.platformTenantId) continue;
        const activeOwnerResult = await client.query(
          `SELECT user_id FROM ${this.membershipsTable}
           WHERE tenant_id = $1 AND persona = 'org_admin' AND is_owner = TRUE AND status = 'active'
           FOR UPDATE`,
          [tenant.id],
        );
        if (activeOwnerResult.rows.length > 0) continue;

        const activeAdmins = (membershipsByTenant.get(tenant.id) ?? [])
          .filter(user => user.role === 'admin' && !user.disabled);
        if (activeAdmins.length === 1) {
          await client.query(`
            UPDATE ${this.membershipsTable}
            SET is_owner = TRUE,
                version = version + 1,
                updated_at = NOW(),
                updated_by = $3
            WHERE tenant_id = $1 AND user_id = $2 AND source = 'legacy_projection'
          `, [tenant.id, activeAdmins[0].id, input.projectedBy]);
          continue;
        }

        await this.issueStore.open({
          issueType: activeAdmins.length === 0 ? 'owner_recovery_required' : 'owner_migration_pending',
          tenantId: tenant.id,
          resourceType: 'tenant',
          resourceId: tenant.id,
          detail: { activeAdminCount: activeAdmins.length },
          createdBy: input.projectedBy,
        }, client);
        issuesRecorded += 1;
      }

      const activePlatformAdmins = input.users.filter(user =>
        user.tenantId === input.platformTenantId && user.role === 'admin' && !user.disabled,
      );
      if (activePlatformAdmins.length === 0) {
        await this.issueStore.open({
          issueType: 'platform_admin_recovery_required',
          tenantId: input.platformTenantId,
          resourceType: 'tenant',
          resourceId: input.platformTenantId,
          createdBy: input.projectedBy,
        }, client);
        issuesRecorded += 1;
      }

      return { membershipsProjected, platformAdminsProjected, issuesRecorded };
    });
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

function rowToMembership(row: Record<string, unknown>): TenantMembership {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    persona: row.persona as TenantMembership['persona'],
    isOwner: Boolean(row.is_owner),
    status: row.status as TenantMembership['status'],
    source: row.source as TenantMembership['source'],
    version: Number(row.version),
    createdAt: new Date(String(row.created_at)).toISOString(),
    createdBy: String(row.created_by),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    updatedBy: String(row.updated_by),
  };
}

function rowToPlatformAdmin(row: Record<string, unknown>): PlatformAdmin {
  return {
    userId: String(row.user_id),
    status: row.status as PlatformAdmin['status'],
    source: row.source as PlatformAdmin['source'],
    version: Number(row.version),
    createdAt: new Date(String(row.created_at)).toISOString(),
    createdBy: String(row.created_by),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    updatedBy: String(row.updated_by),
  };
}
