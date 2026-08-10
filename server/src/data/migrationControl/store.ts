import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { PgGovernanceMigrationRunner, governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import {
  GOVERNANCE_MIGRATION_DOMAINS,
  GovernanceMigrationControlInvariantError,
  type GovernanceMigrationControl,
  type GovernanceMigrationDomain,
  type GovernanceMigrationDomainState,
  type GovernanceShadowDifference,
} from './types.js';

function rowToControl(row: Record<string, unknown>): GovernanceMigrationControl {
  return {
    controlId: 'global', mode: row.mode as GovernanceMigrationControl['mode'],
    writeAuthority: row.write_authority as GovernanceMigrationControl['writeAuthority'],
    legacyWritesSealed: row.legacy_writes_sealed === true,
    compatibilityProjectionEnabled: row.compatibility_projection_enabled === true,
    rollbackEnabled: row.rollback_enabled === true,
    revision: Number(row.revision),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    updatedBy: String(row.updated_by), updateReason: String(row.update_reason),
  };
}

function rowToDomain(row: Record<string, unknown>): GovernanceMigrationDomainState {
  return {
    domain: row.domain as GovernanceMigrationDomain,
    status: row.status as GovernanceMigrationDomainState['status'],
    comparedCount: Number(row.compared_count), matchedCount: Number(row.matched_count),
    differenceCount: Number(row.difference_count), unresolvedBlockingCount: Number(row.unresolved_blocking_count),
    lastBatchTotal: Number(row.last_batch_total ?? 0),
    lastBatchMatched: Number(row.last_batch_matched ?? 0),
    lastBatchDifferences: Number(row.last_batch_differences ?? 0),
    ...(row.last_batch_at ? { lastBatchAt: row.last_batch_at instanceof Date ? row.last_batch_at.toISOString() : String(row.last_batch_at) } : {}),
    revision: Number(row.revision),
    ...(row.last_compared_at ? { lastComparedAt: row.last_compared_at instanceof Date ? row.last_compared_at.toISOString() : String(row.last_compared_at) } : {}),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

function rowToDifference(row: Record<string, unknown>): GovernanceShadowDifference {
  return {
    differenceId: String(row.difference_id), domain: row.domain as GovernanceMigrationDomain,
    ...(row.tenant_scope ? { tenantId: String(row.tenant_scope) } : {}),
    resourceType: String(row.resource_type), resourceId: String(row.resource_id),
    category: row.category as GovernanceShadowDifference['category'],
    ...(row.legacy_digest ? { legacyDigest: String(row.legacy_digest) } : {}),
    ...(row.governance_digest ? { governanceDigest: String(row.governance_digest) } : {}),
    blocking: row.blocking === true, status: row.status as GovernanceShadowDifference['status'],
    firstSeenAt: row.first_seen_at instanceof Date ? row.first_seen_at.toISOString() : String(row.first_seen_at),
    lastSeenAt: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : String(row.last_seen_at),
    ...(row.resolved_at ? { resolvedAt: row.resolved_at instanceof Date ? row.resolved_at.toISOString() : String(row.resolved_at) } : {}),
    ...(row.resolved_by ? { resolvedBy: String(row.resolved_by) } : {}),
    ...(row.resolution_reason ? { resolutionReason: String(row.resolution_reason) } : {}),
  };
}

export class PgGovernanceMigrationControlStore {
  readonly controlTable: string;
  readonly domainsTable: string;
  readonly differencesTable: string;
  readonly migrationIssuesTable: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: { pool: GovernancePgPool; tablePrefix?: string }) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.tablePrefix = options.tablePrefix;
    this.controlTable = `${prefix}_governance_migration_control`;
    this.domainsTable = `${prefix}_governance_migration_domains`;
    this.differencesTable = `${prefix}_governance_shadow_differences`;
    this.migrationIssuesTable = `${prefix}_governance_migration_issues`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
    await this.options.pool.query(`
      INSERT INTO ${this.controlTable} (
        control_id,mode,write_authority,legacy_writes_sealed,
        compatibility_projection_enabled,rollback_enabled,updated_by,update_reason
      ) VALUES ('global','shadow','dual',FALSE,TRUE,TRUE,'system:migration','initial shadow mode')
      ON CONFLICT (control_id) DO NOTHING
    `);
    for (const domain of GOVERNANCE_MIGRATION_DOMAINS) {
      await this.options.pool.query(`
        INSERT INTO ${this.domainsTable} (domain,status,updated_by)
        VALUES ($1,'shadow','system:migration') ON CONFLICT (domain) DO NOTHING
      `, [domain]);
    }
  }

  async getControl(): Promise<GovernanceMigrationControl> {
    const result = await this.options.pool.query(`SELECT * FROM ${this.controlTable} WHERE control_id='global'`);
    if (!result.rows[0]) throw new GovernanceMigrationControlInvariantError('MIGRATION_CONTROL_NOT_FOUND');
    return rowToControl(result.rows[0]);
  }

  async listDomains(): Promise<GovernanceMigrationDomainState[]> {
    const result = await this.options.pool.query(`SELECT * FROM ${this.domainsTable} ORDER BY domain`);
    return result.rows.map(rowToDomain);
  }

  async updateSettings(input: {
    expectedRevision: number;
    writeAuthority: GovernanceMigrationControl['writeAuthority'];
    legacyWritesSealed: boolean;
    compatibilityProjectionEnabled: boolean;
    rollbackEnabled: boolean;
    updatedBy: string;
    reason: string;
  }): Promise<GovernanceMigrationControl> {
    const result = await this.options.pool.query(`
      UPDATE ${this.controlTable}
      SET write_authority=$2,legacy_writes_sealed=$3,compatibility_projection_enabled=$4,
          rollback_enabled=$5,revision=revision+1,updated_at=NOW(),updated_by=$6,update_reason=$7
      WHERE control_id='global' AND revision=$1 AND mode='shadow' RETURNING *
    `, [
      input.expectedRevision, input.writeAuthority, input.legacyWritesSealed,
      input.compatibilityProjectionEnabled, input.rollbackEnabled, input.updatedBy, input.reason,
    ]);
    if (result.rows[0]) return rowToControl(result.rows[0]);
    const current = await this.getControl();
    if (current.revision !== input.expectedRevision) {
      throw new GovernanceMigrationControlInvariantError('MIGRATION_CONTROL_VERSION_CONFLICT');
    }
    throw new GovernanceMigrationControlInvariantError('MIGRATION_CONTROL_INVALID_TRANSITION');
  }

  async incrementDomainComparison(domain: GovernanceMigrationDomain, matched: boolean): Promise<GovernanceMigrationDomainState> {
    const result = await this.options.pool.query(`
      UPDATE ${this.domainsTable} d
      SET compared_count=compared_count+1,
          matched_count=matched_count+CASE WHEN $2 THEN 1 ELSE 0 END,
          difference_count=difference_count+CASE WHEN $2 THEN 0 ELSE 1 END,
          unresolved_blocking_count=(
            SELECT COUNT(*) FROM ${this.differencesTable} x
            WHERE x.domain=d.domain AND x.status='open' AND x.blocking=TRUE
          ),
          status=CASE WHEN NOT $2 OR EXISTS (
            SELECT 1 FROM ${this.differencesTable} x
            WHERE x.domain=d.domain AND x.status='open' AND x.blocking=TRUE
          ) THEN 'shadow' ELSE d.status END,
          revision=revision+1,last_compared_at=NOW(),updated_at=NOW(),updated_by='system:shadow-comparator'
      WHERE d.domain=$1 RETURNING d.*
    `, [domain, matched]);
    if (!result.rows[0]) throw new GovernanceMigrationControlInvariantError('MIGRATION_CONTROL_NOT_FOUND');
    return rowToDomain(result.rows[0]);
  }

  async recordDomainSnapshot(input: {
    domain: GovernanceMigrationDomain;
    expectedRevision: number;
    comparedCount: number;
    matchedCount: number;
    differenceCount: number;
    unresolvedBlockingCount: number;
    updatedBy: string;
  }): Promise<GovernanceMigrationDomainState> {
    const values = [input.comparedCount, input.matchedCount, input.differenceCount, input.unresolvedBlockingCount];
    if (values.some(value => !Number.isInteger(value) || value < 0)
      || input.matchedCount + input.differenceCount !== input.comparedCount) {
      throw new GovernanceMigrationControlInvariantError('MIGRATION_DOMAIN_NOT_READY');
    }
    const ready = input.comparedCount > 0
      && input.differenceCount === 0
      && input.unresolvedBlockingCount === 0;
    const result = await this.options.pool.query(`
      UPDATE ${this.domainsTable}
      SET status=$2,compared_count=$3,matched_count=$4,difference_count=$5,
          unresolved_blocking_count=$6,last_batch_total=$3,last_batch_matched=$4,
          last_batch_differences=$5,last_batch_at=NOW(),revision=revision+1,last_compared_at=NOW(),
          updated_at=NOW(),updated_by=$7
      WHERE domain=$1 AND revision=$8 AND status IN ('shadow','ready') RETURNING *
    `, [
      input.domain, ready ? 'ready' : 'shadow', input.comparedCount, input.matchedCount,
      input.differenceCount, input.unresolvedBlockingCount, input.updatedBy, input.expectedRevision,
    ]);
    if (!result.rows[0]) throw new GovernanceMigrationControlInvariantError('MIGRATION_DOMAIN_VERSION_CONFLICT');
    return rowToDomain(result.rows[0]);
  }

  async resolveDifferencesForResource(input: {
    domain: GovernanceMigrationDomain;
    tenantId?: string;
    resourceType: string;
    resourceId: string;
    resolvedBy: string;
  }): Promise<number> {
    const result = await this.options.pool.query(`
      UPDATE ${this.differencesTable}
      SET status='resolved',resolved_at=NOW(),resolved_by=$5,resolution_reason='shadow_values_converged',last_seen_at=NOW()
      WHERE domain=$1 AND tenant_scope=$2 AND resource_type=$3 AND resource_id=$4 AND status='open'
      RETURNING difference_id
    `, [input.domain, input.tenantId ?? '', input.resourceType, input.resourceId, input.resolvedBy]);
    return result.rowCount ?? 0;
  }

  async recordDifference(input: {
    domain: GovernanceMigrationDomain;
    tenantId?: string;
    resourceType: string;
    resourceId: string;
    category: GovernanceShadowDifference['category'];
    legacyDigest?: string;
    governanceDigest?: string;
    blocking: boolean;
  }): Promise<GovernanceShadowDifference> {
    const tenantScope = input.tenantId ?? '';
    const result = await this.options.pool.query(`
      INSERT INTO ${this.differencesTable} (
        difference_id,domain,tenant_scope,resource_type,resource_id,category,
        legacy_digest,governance_digest,blocking,status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open')
      ON CONFLICT (domain,tenant_scope,resource_type,resource_id,category)
      DO UPDATE SET legacy_digest=EXCLUDED.legacy_digest,governance_digest=EXCLUDED.governance_digest,
        blocking=EXCLUDED.blocking,status='open',last_seen_at=NOW(),resolved_at=NULL,
        resolved_by=NULL,resolution_reason=NULL
      RETURNING *
    `, [
      `diff-${randomUUID()}`, input.domain, tenantScope, input.resourceType, input.resourceId,
      input.category, input.legacyDigest ?? null, input.governanceDigest ?? null, input.blocking,
    ]);
    return rowToDifference(result.rows[0]);
  }

  async countOpenBlockingDifferences(domain: GovernanceMigrationDomain): Promise<number> {
    const result = await this.options.pool.query(`
      SELECT COUNT(*)::text AS total
      FROM ${this.differencesTable}
      WHERE domain=$1 AND status='open' AND blocking=TRUE
    `, [domain]);
    return Number(result.rows[0]?.total ?? 0);
  }

  async listDifferences(input: {
    domain?: GovernanceMigrationDomain;
    status?: GovernanceShadowDifference['status'];
    limit?: number;
  } = {}): Promise<GovernanceShadowDifference[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 200, 1000));
    const result = await this.options.pool.query(`
      SELECT * FROM ${this.differencesTable}
      WHERE ($1::text IS NULL OR domain=$1)
        AND ($2::text IS NULL OR status=$2)
      ORDER BY blocking DESC,last_seen_at DESC,difference_id
      LIMIT $3
    `, [input.domain ?? null, input.status ?? null, limit]);
    return result.rows.map(rowToDifference);
  }

  async resolveDifference(
    differenceId: string,
    resolvedBy: string,
    reason: string,
    accept: boolean,
  ): Promise<GovernanceShadowDifference> {
    const result = await this.options.pool.query(`
      UPDATE ${this.differencesTable}
      SET status=$2,resolved_at=NOW(),resolved_by=$3,resolution_reason=$4,last_seen_at=NOW()
      WHERE difference_id=$1 AND status='open' RETURNING *
    `, [differenceId, accept ? 'accepted' : 'resolved', resolvedBy, reason]);
    if (!result.rows[0]) throw new GovernanceMigrationControlInvariantError('MIGRATION_DIFFERENCE_NOT_FOUND');
    return rowToDifference(result.rows[0]);
  }

  async transitionMode(input: {
    expectedRevision: number;
    mode: GovernanceMigrationControl['mode'];
    updatedBy: string;
    reason: string;
  }): Promise<GovernanceMigrationControl> {
    return this.withTransaction(async client => {
      const currentResult = await client.query(
        `SELECT * FROM ${this.controlTable} WHERE control_id='global' FOR UPDATE`,
      );
      if (!currentResult.rows[0]) throw new GovernanceMigrationControlInvariantError('MIGRATION_CONTROL_NOT_FOUND');
      const current = rowToControl(currentResult.rows[0]);
      if (current.revision !== input.expectedRevision) {
        throw new GovernanceMigrationControlInvariantError('MIGRATION_CONTROL_VERSION_CONFLICT');
      }
      this.assertTransition(current, input.mode);
      if (input.mode === 'enforce') await this.assertEnforcementReady(client, current);
      const result = await client.query(`
        UPDATE ${this.controlTable}
        SET mode=$2,revision=revision+1,updated_at=NOW(),updated_by=$3,update_reason=$4
        WHERE control_id='global' AND revision=$1 RETURNING *
      `, [input.expectedRevision, input.mode, input.updatedBy, input.reason]);
      if (!result.rows[0]) throw new GovernanceMigrationControlInvariantError('MIGRATION_CONTROL_VERSION_CONFLICT');
      const domainStatus = input.mode === 'enforce' ? 'enforced' : input.mode === 'rollback' ? 'rollback' : 'shadow';
      await client.query(
        `UPDATE ${this.domainsTable} SET status=$1,revision=revision+1,updated_at=NOW(),updated_by=$2`,
        [domainStatus, input.updatedBy],
      );
      return rowToControl(result.rows[0]);
    });
  }

  private assertTransition(current: GovernanceMigrationControl, next: GovernanceMigrationControl['mode']): void {
    const valid = (current.mode === 'shadow' && next === 'enforce')
      || (current.mode === 'enforce' && next === 'rollback' && current.rollbackEnabled)
      || (current.mode === 'rollback' && next === 'shadow');
    if (!valid) throw new GovernanceMigrationControlInvariantError('MIGRATION_CONTROL_INVALID_TRANSITION');
  }

  private async assertEnforcementReady(client: PoolClient, current: GovernanceMigrationControl): Promise<void> {
    if (current.writeAuthority !== 'governance' || !current.legacyWritesSealed
      || !current.compatibilityProjectionEnabled || !current.rollbackEnabled) {
      throw new GovernanceMigrationControlInvariantError('MIGRATION_DOMAIN_NOT_READY');
    }
    const domains = await client.query(`SELECT * FROM ${this.domainsTable} FOR UPDATE`);
    if (domains.rows.length !== GOVERNANCE_MIGRATION_DOMAINS.length
      || domains.rows.some(row => row.status !== 'ready' || Number(row.unresolved_blocking_count) !== 0)) {
      throw new GovernanceMigrationControlInvariantError('MIGRATION_DOMAIN_NOT_READY');
    }
    const differences = await client.query(`
      SELECT COUNT(*) AS count FROM ${this.differencesTable}
      WHERE status='open' AND blocking=TRUE
    `);
    if (Number(differences.rows[0]?.count ?? 0) > 0) {
      throw new GovernanceMigrationControlInvariantError('MIGRATION_BLOCKING_DIFFERENCES');
    }
    const migrationIssues = await client.query(`
      SELECT COUNT(*) AS count FROM ${this.migrationIssuesTable} WHERE status='open'
    `);
    if (Number(migrationIssues.rows[0]?.count ?? 0) > 0) {
      throw new GovernanceMigrationControlInvariantError('MIGRATION_BLOCKING_DIFFERENCES');
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
