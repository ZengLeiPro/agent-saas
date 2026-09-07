import {
  governanceTablePrefix,
  type GovernancePgPool,
} from '../../data/governance-schema/index.js';
import type { JwtPayload } from '../../auth/types.js';
import type { PgKyAppSystemStore } from '../systems/store.js';
import { installationActions } from './managementPolicy.js';

const date = (value: unknown): string | null =>
  value == null ? null : value instanceof Date ? value.toISOString() : String(value);
export interface InstallationFilter {
  tenantId?: string;
  systemId?: string;
  status?: string;
  cursor?: string;
  limit: number;
}

/** 只读查询独立于启动期迁移模块；列表使用集合 JOIN，查询数不随行数增长。 */
export class KyAppManagementQueries {
  private readonly prefix: string;
  constructor(
    private readonly pool: GovernancePgPool,
    private readonly systems: PgKyAppSystemStore,
    tablePrefix?: string,
    private readonly eventsTable?: string,
  ) {
    this.prefix = governanceTablePrefix(tablePrefix);
  }
  async systemsList() {
    const result = await this.pool.query(`SELECT d.*, COALESCE(m.total,0)::int AS total,
      COALESCE(m.enabled,0)::int AS enabled, COALESCE(m.unhealthy,0)::int AS unhealthy,
      COALESCE(jsonb_array_length(v.manifest_json->'capabilities'),0) AS capabilities,
      (SELECT count(*)::int FROM jsonb_array_elements(COALESCE(v.manifest_json->'capabilities','[]'::jsonb)) c WHERE c->>'riskLevel'='external_write') AS writes
      FROM ${this.systems.definitionsTable} d
      LEFT JOIN ${this.systems.versionsTable} v ON v.system_id=d.system_id AND v.digest=d.published_digest
      LEFT JOIN (SELECT i.system_id,count(*) AS total,count(*) FILTER(WHERE i.status='enabled') AS enabled,
        count(*) FILTER(WHERE r.live_status='failed' OR r.ready_status='failed') AS unhealthy
        FROM ${this.systems.installationsTable} i LEFT JOIN ${this.prefix}_ky_app_installation_runtime r USING(installation_id)
        WHERE i.status<>'deleted' GROUP BY i.system_id) m ON m.system_id=d.system_id ORDER BY d.system_id`);
    return result.rows.map((row) => ({
      systemId: String(row.system_id),
      name: String(row.name),
      status: String(row.status),
      version: Number(row.version),
      publishedDigest: row.published_digest as string | null,
      metrics: {
        installationCount: Number(row.total),
        enabledInstallationCount: Number(row.enabled),
        unhealthyInstallationCount: Number(row.unhealthy),
        capabilityCount: Number(row.capabilities),
        externalWriteCapabilityCount: Number(row.writes),
      },
      allowedActions:
        row.status === 'retired'
          ? []
          : [
              'register_version',
              'review_version',
              'publish_version',
              ...(row.status === 'draft' ? [] : ['retire_system']),
              ...(row.status === 'published' ? ['start_delivery', 'disable_system'] : []),
            ],
    }));
  }
  async systemDetail(systemId: string, actor: string) {
    const [list, definition, versions] = await Promise.all([
      this.systemsList(),
      this.systems.getDefinition(systemId),
      this.systems.listVersions(systemId),
    ]);
    const summary = list.find((item) => item.systemId === systemId);
    return definition && summary
      ? {
          ...summary,
          definition,
          versions: versions.map((version) => ({
            ...version,
            allowedActions:
              definition.status === 'retired'
                ? []
                : [
                    ...(version.reviewStatus === 'pending' && version.createdBy !== actor
                      ? ['review_version']
                      : []),
                    ...(version.reviewStatus !== 'pending' ? ['publish_version'] : []),
                  ],
          })),
        }
      : null;
  }
  async executions() {
    const result = await this.pool.query(`SELECT execution_id,tenant_id,system_id,installation_id,status,current_step,updated_at FROM ${this.prefix}_ky_app_onboard_executions ORDER BY updated_at DESC,execution_id`);
    return result.rows.map(row => ({ executionId: row.execution_id, tenantId: row.tenant_id, systemId: row.system_id, installationId: row.installation_id, status: row.status, currentStep: row.current_step, updatedAt: date(row.updated_at) }));
  }
  async installationSummary(installationId: string) {
    const [delivery, assignments, credentials, runtime] = await Promise.all([
      this.pool.query(
        `SELECT delivered_at,offboarding_status FROM ${this.prefix}_ky_app_delivery_records WHERE installation_id=$1`,
        [installationId],
      ),
      this.pool.query(
        `SELECT assignee_type,effect FROM ${this.prefix}_resource_assignments WHERE resource_type='system_installation' AND resource_id=$1`,
        [installationId],
      ),
      this.pool.query(
        `SELECT credential_id,status,expires_at,acked_at,revoked_at FROM ${this.prefix}_ky_app_service_credentials WHERE installation_id=$1 ORDER BY issued_at DESC`,
        [installationId],
      ),
      this.pool.query(
        `SELECT manifest_digest,ready_status FROM ${this.prefix}_ky_app_installation_runtime WHERE installation_id=$1`,
        [installationId],
      ),
    ]);
    return {
      delivery: delivery.rows[0] ?? null,
      assignmentSummary: {
        ruleCount: assignments.rows.length,
        configured: assignments.rows.some((row) => row.effect === 'allow'),
      },
      credentialSummary: credentials.rows.map((row) => ({
        credentialId: row.credential_id,
        status: row.status,
        expiresAt: date(row.expires_at),
        ackedAt: date(row.acked_at),
        revokedAt: date(row.revoked_at),
      })),
      observedDigest: runtime.rows[0]?.manifest_digest ?? null,
      ready: runtime.rows[0]?.ready_status === 'ok',
    };
  }
  async installations(filter: InstallationFilter, user: JwtPayload) {
    const params: unknown[] = [];
    const where: string[] = [];
    for (const [column, value] of [
      ['tenant_id', filter.tenantId],
      ['system_id', filter.systemId],
      ['status', filter.status],
    ]) {
      if (value) {
        params.push(value);
        where.push(`i.${column}=$${params.length}`);
      }
    }
    if (filter.cursor) {
      const cursor = JSON.parse(Buffer.from(filter.cursor, 'base64url').toString()) as {
        at: string;
        id: string;
      };
      if (!cursor.at || !Number.isFinite(Date.parse(cursor.at)) || typeof cursor.id !== 'string')
        throw new Error('invalid cursor');
      params.push(cursor.at, cursor.id);
      where.push(
        `(i.updated_at < $${params.length - 1}::timestamptz OR (i.updated_at=$${params.length - 1}::timestamptz AND i.installation_id>$${params.length}))`,
      );
    }
    params.push(filter.limit + 1);
    const result = await this.pool.query(
      `SELECT i.installation_id,i.tenant_id,i.system_id,i.status,i.registered_digest,i.domain_verified_at,i.updated_at,
      to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
      d.name,d.published_digest,v.manifest_json->>'icon' AS icon,r.live_status,r.ready_status,r.manifest_digest,
      e.status AS delivery_status,${this.eventsTable ? 'u.last_usage_at' : 'NULL'} AS last_usage_at FROM ${this.systems.installationsTable} i
      JOIN ${this.systems.definitionsTable} d USING(system_id)
      LEFT JOIN ${this.systems.versionsTable} v ON v.system_id=d.system_id AND v.digest=d.published_digest
      LEFT JOIN ${this.prefix}_ky_app_installation_runtime r USING(installation_id)
      LEFT JOIN LATERAL (SELECT status FROM ${this.prefix}_ky_app_onboard_executions WHERE installation_id=i.installation_id ORDER BY updated_at DESC,execution_id LIMIT 1) e ON true
      ${this.eventsTable ? `LEFT JOIN (SELECT event_json->>'installationId' AS installation_id,MAX(timestamp) AS last_usage_at FROM ${this.eventsTable} WHERE event_type='tool_audit' GROUP BY 1) u ON u.installation_id=i.installation_id` : ''}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.updated_at DESC,i.installation_id ASC LIMIT $${params.length}`,
      params,
    );
    const rows = result.rows.slice(0, filter.limit);
    return {
      installations: rows.map((row) => ({
        installationId: String(row.installation_id),
        tenantId: String(row.tenant_id),
        systemId: String(row.system_id),
        systemName: String(row.name),
        icon: row.icon ?? null,
        status: row.status,
        registeredDigest: row.registered_digest,
        publishedDigest: row.published_digest,
        domainVerifiedAt: date(row.domain_verified_at),
        deliveryStatus: row.delivery_status ?? null,
        runtimeStatus:
          row.live_status === 'failed' || row.ready_status === 'failed'
            ? 'failed'
            : row.live_status === 'ok' && row.ready_status === 'ok'
              ? row.manifest_digest === row.registered_digest
                ? 'healthy'
                : 'warning'
              : row.live_status === 'maintenance'
                ? 'warning'
                : 'unknown',
        lastUsageAt: date(row.last_usage_at),
        updatedAt: date(row.updated_at),
        allowedActions: installationActions(user, {
          tenantId: String(row.tenant_id),
          status: row.status as 'pending',
        }),
      })),
      nextCursor:
        result.rows.length > filter.limit && rows.length
          ? Buffer.from(
              JSON.stringify({ at: rows.at(-1)!.cursor_at, id: rows.at(-1)!.installation_id }),
            ).toString('base64url')
          : null,
    };
  }
}
