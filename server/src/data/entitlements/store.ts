import type { PoolClient } from 'pg';

import { PgGovernanceMigrationIssueStore } from '../governance-issues/index.js';
import { PgGovernanceMigrationRunner, governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import { DEFAULT_TENANT_SETTINGS, PLATFORM_TENANT_ID, type TenantSettings } from '../tenants/types.js';
import {
  EntitlementInvariantError,
  TENANT_POLICY_KEYS,
  type EntitlementResourceScope,
  type EntitlementResourceType,
  type EntitlementScopeMode,
  type EntitlementStatus,
  type LegacyEntitlementBackfillInput,
  type LegacyEntitlementBackfillResult,
  type TenantEntitlementSet,
  type TenantPolicy,
  type TenantPolicyKey,
  type TenantPolicyValue,
} from './types.js';

export interface PgEntitlementStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
  platformTenantId?: string;
}

export interface EntitlementSetPatch {
  status?: EntitlementStatus;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  limits?: Record<string, number>;
  expectedVersion: number;
  updatedBy: string;
  updateReason: string;
}

export interface EntitlementScopePatch {
  mode: EntitlementScopeMode;
  resourceIds: string[];
  expectedVersion: number;
  updatedBy: string;
}

export class PgEntitlementStore {
  readonly entitlementSetsTable: string;
  readonly scopesTable: string;
  readonly itemsTable: string;
  readonly policiesTable: string;
  private readonly issueStore: PgGovernanceMigrationIssueStore;
  private readonly platformTenantId: string;

  constructor(private readonly options: PgEntitlementStoreOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.entitlementSetsTable = `${prefix}_tenant_entitlement_sets`;
    this.scopesTable = `${prefix}_entitlement_resource_scopes`;
    this.itemsTable = `${prefix}_entitlement_resource_items`;
    this.policiesTable = `${prefix}_tenant_policies`;
    this.issueStore = new PgGovernanceMigrationIssueStore(options.pool, options.tablePrefix);
    this.platformTenantId = options.platformTenantId ?? PLATFORM_TENANT_ID;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.options.tablePrefix).run();
  }

  async getEntitlementSet(tenantId: string): Promise<TenantEntitlementSet | null> {
    this.assertCustomerTenant(tenantId);
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.entitlementSetsTable} WHERE tenant_id = $1`,
      [tenantId],
    );
    return result.rows[0] ? rowToEntitlementSet(result.rows[0]) : null;
  }

  async listResourceScopes(tenantId: string): Promise<EntitlementResourceScope[]> {
    this.assertCustomerTenant(tenantId);
    const result = await this.options.pool.query(`
      SELECT scope.*, COALESCE(
        ARRAY_AGG(item.resource_id ORDER BY item.resource_id)
          FILTER (WHERE item.resource_id IS NOT NULL),
        ARRAY[]::text[]
      ) AS resource_ids
      FROM ${this.scopesTable} scope
      LEFT JOIN ${this.itemsTable} item
        ON item.tenant_id = scope.tenant_id
       AND item.resource_type = scope.resource_type
      WHERE scope.tenant_id = $1
      GROUP BY scope.tenant_id, scope.resource_type
      ORDER BY scope.resource_type
    `, [tenantId]);
    return result.rows.map(rowToScope);
  }

  async getProjectionSnapshot(tenantId: string): Promise<unknown | undefined> {
    const [set, scopes, policies] = await Promise.all([
      this.getEntitlementSet(tenantId), this.listResourceScopes(tenantId), this.getPolicies(tenantId),
    ]);
    if (!set) return undefined;
    return {
      status: set.status,
      limits: set.limits,
      scopes: scopes.map(scope => ({
        resourceType: scope.resourceType, mode: scope.mode, resourceIds: [...scope.resourceIds].sort(),
      })).sort((a, b) => a.resourceType.localeCompare(b.resourceType)),
      policies: policies.map(policy => ({ policyKey: policy.policyKey, value: policy.value }))
        .sort((a, b) => a.policyKey.localeCompare(b.policyKey)),
    };
  }

  async getPolicies(tenantId: string): Promise<TenantPolicy[]> {
    this.assertCustomerTenant(tenantId);
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.policiesTable} WHERE tenant_id = $1 ORDER BY policy_key`,
      [tenantId],
    );
    return result.rows.map(rowToPolicy);
  }

  async updateEntitlementSet(tenantId: string, patch: EntitlementSetPatch): Promise<TenantEntitlementSet> {
    this.assertCustomerTenant(tenantId);
    validateLimits(patch.limits);
    const result = await this.options.pool.query(`
      UPDATE ${this.entitlementSetsTable}
      SET status = COALESCE($2, status),
          effective_from = CASE WHEN $3::boolean THEN $4::timestamptz ELSE effective_from END,
          effective_to = CASE WHEN $5::boolean THEN $6::timestamptz ELSE effective_to END,
          limits_json = COALESCE($7::jsonb, limits_json),
          source = 'platform_override',
          version = version + 1,
          updated_at = NOW(),
          updated_by = $8,
          update_reason = $9
      WHERE tenant_id = $1 AND version = $10
      RETURNING *
    `, [
      tenantId,
      patch.status ?? null,
      patch.effectiveFrom !== undefined,
      patch.effectiveFrom ?? null,
      patch.effectiveTo !== undefined,
      patch.effectiveTo ?? null,
      patch.limits ? JSON.stringify(patch.limits) : null,
      patch.updatedBy,
      patch.updateReason,
      patch.expectedVersion,
    ]);
    if (!result.rows[0]) {
      const exists = await this.options.pool.query(
        `SELECT 1 FROM ${this.entitlementSetsTable} WHERE tenant_id = $1`,
        [tenantId],
      );
      throw new EntitlementInvariantError(
        exists.rows[0] ? 'ENTITLEMENT_VERSION_CONFLICT' : 'ENTITLEMENT_NOT_FOUND',
      );
    }
    return rowToEntitlementSet(result.rows[0]);
  }

  async replaceResourceScope(
    tenantId: string,
    resourceType: EntitlementResourceType,
    patch: EntitlementScopePatch,
  ): Promise<EntitlementResourceScope> {
    this.assertCustomerTenant(tenantId);
    const resourceIds = normalizeResourceIds(patch.mode, patch.resourceIds);
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`entitlement:${tenantId}`]);
      const current = await client.query(
        `SELECT * FROM ${this.scopesTable}
         WHERE tenant_id = $1 AND resource_type = $2
         FOR UPDATE`,
        [tenantId, resourceType],
      );
      if (!current.rows[0]) throw new EntitlementInvariantError('ENTITLEMENT_SCOPE_NOT_FOUND');
      if (Number(current.rows[0].version) !== patch.expectedVersion) {
        throw new EntitlementInvariantError('ENTITLEMENT_SCOPE_VERSION_CONFLICT');
      }
      const updated = await client.query(`
        UPDATE ${this.scopesTable}
        SET mode = $3,
            source = 'governance',
            version = version + 1,
            updated_at = NOW(),
            updated_by = $4
        WHERE tenant_id = $1 AND resource_type = $2 AND version = $5
        RETURNING *
      `, [tenantId, resourceType, patch.mode, patch.updatedBy, patch.expectedVersion]);
      if (!updated.rows[0]) {
        throw new EntitlementInvariantError('ENTITLEMENT_SCOPE_VERSION_CONFLICT');
      }
      await client.query(
        `DELETE FROM ${this.itemsTable} WHERE tenant_id = $1 AND resource_type = $2`,
        [tenantId, resourceType],
      );
      for (const resourceId of resourceIds) {
        await client.query(`
          INSERT INTO ${this.itemsTable} (
            tenant_id, resource_type, resource_id, source, created_by
          ) VALUES ($1, $2, $3, 'governance', $4)
        `, [tenantId, resourceType, resourceId, patch.updatedBy]);
      }
      return rowToScope({ ...updated.rows[0], resource_ids: resourceIds });
    });
  }

  async updatePolicy(
    tenantId: string,
    policyKey: TenantPolicyKey,
    value: TenantPolicyValue,
    expectedVersion: number,
    updatedBy: string,
  ): Promise<TenantPolicy> {
    this.assertCustomerTenant(tenantId);
    assertPolicyKey(policyKey);
    const result = await this.options.pool.query(`
      UPDATE ${this.policiesTable}
      SET value_json = $3::jsonb,
          source = 'governance',
          version = version + 1,
          updated_at = NOW(),
          updated_by = $4
      WHERE tenant_id = $1 AND policy_key = $2 AND version = $5
      RETURNING *
    `, [tenantId, policyKey, JSON.stringify(value), updatedBy, expectedVersion]);
    if (!result.rows[0]) {
      const exists = await this.options.pool.query(
        `SELECT 1 FROM ${this.policiesTable} WHERE tenant_id = $1 AND policy_key = $2`,
        [tenantId, policyKey],
      );
      throw new EntitlementInvariantError(
        exists.rows[0] ? 'POLICY_VERSION_CONFLICT' : 'POLICY_NOT_FOUND',
      );
    }
    return rowToPolicy(result.rows[0]);
  }

  async backfillLegacySettings(input: LegacyEntitlementBackfillInput): Promise<LegacyEntitlementBackfillResult> {
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['governance-entitlement-backfill']);
      let tenantsProjected = 0;
      let scopesProjected = 0;
      let policiesProjected = 0;
      let issuesRecorded = 0;

      for (const tenant of input.tenants) {
        if (tenant.id === input.platformTenantId) continue;
        const settings = tenant.settings ?? DEFAULT_TENANT_SETTINGS;
        const limits = numericLimits(settings);
        await client.query(`
          INSERT INTO ${this.entitlementSetsTable} (
            tenant_id, source, status, limits_json,
            created_by, updated_by, update_reason
          ) VALUES ($1, 'legacy_migrated', $2, $3::jsonb, $4, $4, 'legacy_settings_projection')
          ON CONFLICT (tenant_id) DO UPDATE SET
            status = EXCLUDED.status,
            limits_json = EXCLUDED.limits_json,
            version = ${this.entitlementSetsTable}.version + 1,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by,
            update_reason = EXCLUDED.update_reason
          WHERE ${this.entitlementSetsTable}.source = 'legacy_migrated'
            AND (
              ${this.entitlementSetsTable}.status IS DISTINCT FROM EXCLUDED.status
              OR ${this.entitlementSetsTable}.limits_json IS DISTINCT FROM EXCLUDED.limits_json
            )
        `, [
          tenant.id,
          tenant.disabled ? 'suspended' : 'active',
          JSON.stringify(limits),
          input.projectedBy,
        ]);
        tenantsProjected += 1;

        const scopes = legacyScopes(settings);
        for (const scope of scopes) {
          const changed = await this.upsertLegacyScope(client, tenant.id, scope.resourceType, scope.mode, scope.resourceIds, input.projectedBy);
          if (changed) scopesProjected += 1;
        }

        for (const [policyKey, value] of legacyPolicies(settings)) {
          const result = await client.query(`
            INSERT INTO ${this.policiesTable} (
              tenant_id, policy_key, value_json, source, created_by, updated_by
            ) VALUES ($1, $2, $3::jsonb, 'legacy_projection', $4, $4)
            ON CONFLICT (tenant_id, policy_key) DO UPDATE SET
              value_json = EXCLUDED.value_json,
              version = ${this.policiesTable}.version + 1,
              updated_at = NOW(),
              updated_by = EXCLUDED.updated_by
            WHERE ${this.policiesTable}.source = 'legacy_projection'
              AND ${this.policiesTable}.value_json IS DISTINCT FROM EXCLUDED.value_json
            RETURNING 1
          `, [tenant.id, policyKey, JSON.stringify(value), input.projectedBy]);
          if (result.rowCount) policiesProjected += 1;
        }

        await this.issueStore.open({
          issueType: 'legacy_entitlement_policy_confirmation_required',
          tenantId: tenant.id,
          resourceType: 'tenant',
          resourceId: tenant.id,
          detail: {
            featureFlagCount: Object.keys(settings.features).length,
            quotaCount: Object.keys(limits).length,
          },
          createdBy: input.projectedBy,
        }, client);
        issuesRecorded += 1;
      }

      return { tenantsProjected, scopesProjected, policiesProjected, issuesRecorded };
    });
  }

  private async upsertLegacyScope(
    client: PoolClient,
    tenantId: string,
    resourceType: EntitlementResourceType,
    mode: EntitlementScopeMode,
    inputIds: string[],
    projectedBy: string,
  ): Promise<boolean> {
    const resourceIds = normalizeResourceIds(mode, inputIds);
    const current = await client.query(
      `SELECT * FROM ${this.scopesTable}
       WHERE tenant_id = $1 AND resource_type = $2
       FOR UPDATE`,
      [tenantId, resourceType],
    );
    if (current.rows[0]?.source === 'governance') return false;
    const currentItems = current.rows[0]
      ? await client.query(
        `SELECT resource_id FROM ${this.itemsTable}
         WHERE tenant_id = $1 AND resource_type = $2
         ORDER BY resource_id`,
        [tenantId, resourceType],
      )
      : { rows: [] as Array<{ resource_id: string }> };
    const existingIds = currentItems.rows.map(row => String(row.resource_id));
    const unchanged = current.rows[0]
      && current.rows[0].mode === mode
      && existingIds.length === resourceIds.length
      && existingIds.every((id, index) => id === resourceIds[index]);
    if (unchanged) return false;

    await client.query(`
      INSERT INTO ${this.scopesTable} (
        tenant_id, resource_type, mode, source, created_by, updated_by
      ) VALUES ($1, $2, $3, 'legacy_projection', $4, $4)
      ON CONFLICT (tenant_id, resource_type) DO UPDATE SET
        mode = EXCLUDED.mode,
        version = ${this.scopesTable}.version + 1,
        updated_at = NOW(),
        updated_by = EXCLUDED.updated_by
      WHERE ${this.scopesTable}.source = 'legacy_projection'
    `, [tenantId, resourceType, mode, projectedBy]);
    await client.query(
      `DELETE FROM ${this.itemsTable}
       WHERE tenant_id = $1 AND resource_type = $2 AND source = 'legacy_projection'`,
      [tenantId, resourceType],
    );
    for (const resourceId of resourceIds) {
      await client.query(`
        INSERT INTO ${this.itemsTable} (
          tenant_id, resource_type, resource_id, source, created_by
        ) VALUES ($1, $2, $3, 'legacy_projection', $4)
        ON CONFLICT (tenant_id, resource_type, resource_id) DO NOTHING
      `, [tenantId, resourceType, resourceId, projectedBy]);
    }
    return true;
  }

  private assertCustomerTenant(tenantId: string): void {
    if (tenantId === this.platformTenantId) {
      throw new EntitlementInvariantError('PLATFORM_TENANT_GOVERNANCE_FORBIDDEN');
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

export function normalizeLegacyEntitlementSettings(settings: TenantSettings, disabled = false): unknown {
  return {
    status: disabled ? 'suspended' : 'active',
    limits: numericLimits(settings),
    scopes: legacyScopes(settings).map(scope => ({
      resourceType: scope.resourceType, mode: scope.mode,
      resourceIds: [...scope.resourceIds].sort(),
    })).sort((a, b) => a.resourceType.localeCompare(b.resourceType)),
    policies: legacyPolicies(settings).map(([policyKey, value]) => ({ policyKey, value }))
      .sort((a, b) => a.policyKey.localeCompare(b.policyKey)),
  };
}

function legacyScopes(settings: TenantSettings): Array<{
  resourceType: EntitlementResourceType;
  mode: EntitlementScopeMode;
  resourceIds: string[];
}> {
  const tools = [
    [settings.features.filesEnabled, 'files'],
    [settings.features.cronEnabled, 'cron'],
    [settings.features.mcpEnabled, 'mcp'],
    [settings.features.customSkillsEnabled, 'custom_skill'],
    [settings.features.personalAgentEnabled !== false, 'personal_agent'],
    [settings.features.kbEnabled === true, 'org_knowledge'],
    [settings.features.imageGenEnabled === true, 'image_gen'],
    [settings.features.memoryPollingEnabled === true, 'memory_polling'],
    [settings.features.memoryConsolidationEnabled === true, 'memory_consolidation'],
    [settings.features.memoryWriteDelegationEnabled === true, 'memory_write_delegation'],
  ] as const;
  return [
    {
      resourceType: 'tool',
      mode: 'selected',
      resourceIds: tools.filter(([enabled]) => enabled).map(([, id]) => id),
    },
    {
      resourceType: 'model',
      mode: settings.models.allowedModels.length === 0 ? 'all' : 'selected',
      resourceIds: settings.models.allowedModels,
    },
    {
      resourceType: 'connector',
      mode: 'all',
      resourceIds: [],
    },
  ];
}

function legacyPolicies(settings: TenantSettings): Array<[TenantPolicyKey, TenantPolicyValue]> {
  return [
    ['agent.personal.enabled', settings.features.personalAgentEnabled !== false],
    ['automation.cron.enabled', settings.features.cronEnabled],
    ['connector.global_servers.allowed', settings.mcp.allowGlobalServers],
    ['connector.mcp.enabled', settings.features.mcpEnabled],
    ['connector.tenant_servers.allowed', settings.mcp.allowTenantServers],
    ['knowledge.org.enabled', settings.features.kbEnabled === true],
    ['memory.consolidation.enabled', settings.features.memoryConsolidationEnabled === true],
    ['memory.polling.billable', settings.features.memoryPollChargesCredits === true],
    ['memory.polling.enabled', settings.features.memoryPollingEnabled === true],
    ['memory.write_delegation.enabled', settings.features.memoryWriteDelegationEnabled === true],
    ['model.group_names.visible', settings.models.showGroupNames],
    ['model.user_switch.allowed', settings.models.allowUserModelSwitch],
    ['org.first_day_guide_bar.enabled', settings.personalization.firstDayGuideBarEnabled],
    ['runtime.debug_mode.allowed', settings.features.debugModeAllowed],
    ['runtime.debug_mode.enabled', settings.features.debugModeEnabled ?? false],
    ['security.dingtalk_binding.required', settings.security.requireDingtalkBinding],
    ['session.auto_compact.enabled', settings.features.autoCompactEnabled],
    ['session.context_token_details.allowed', settings.models.allowContextTokenDetails === true],
    ['session.context_tokens.visible', settings.models.showContextTokens !== false],
    ['session.files.enabled', settings.features.filesEnabled],
    ['skill.custom.enabled', settings.features.customSkillsEnabled],
    ['skill.member_opt_in.allowed', settings.features.customSkillsEnabled],
    ['tool.image_gen.enabled', settings.features.imageGenEnabled === true],
  ];
}

function numericLimits(settings: TenantSettings): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(settings.quotas)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  return result;
}

function normalizeResourceIds(mode: EntitlementScopeMode, input: string[]): string[] {
  if (mode === 'all') return [];
  return [...new Set(input.map(id => id.trim()).filter(Boolean))].sort();
}

function validateLimits(limits: Record<string, number> | undefined): void {
  if (!limits) return;
  for (const value of Object.values(limits)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('Entitlement limits must be finite non-negative numbers');
    }
  }
}

function assertPolicyKey(policyKey: string): asserts policyKey is TenantPolicyKey {
  if (!(TENANT_POLICY_KEYS as readonly string[]).includes(policyKey)) {
    throw new EntitlementInvariantError('INVALID_POLICY_KEY');
  }
}

function rowToEntitlementSet(row: Record<string, unknown>): TenantEntitlementSet {
  return {
    tenantId: String(row.tenant_id),
    source: row.source as TenantEntitlementSet['source'],
    status: row.status as TenantEntitlementSet['status'],
    ...(row.effective_from ? { effectiveFrom: new Date(String(row.effective_from)).toISOString() } : {}),
    ...(row.effective_to ? { effectiveTo: new Date(String(row.effective_to)).toISOString() } : {}),
    limits: (row.limits_json ?? {}) as Record<string, number>,
    version: Number(row.version),
    createdAt: new Date(String(row.created_at)).toISOString(),
    createdBy: String(row.created_by),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    updatedBy: String(row.updated_by),
    updateReason: String(row.update_reason),
  };
}

function rowToScope(row: Record<string, unknown>): EntitlementResourceScope {
  return {
    tenantId: String(row.tenant_id),
    resourceType: row.resource_type as EntitlementResourceType,
    mode: row.mode as EntitlementScopeMode,
    resourceIds: Array.isArray(row.resource_ids) ? row.resource_ids.map(String) : [],
    source: row.source as EntitlementResourceScope['source'],
    version: Number(row.version),
    createdAt: new Date(String(row.created_at)).toISOString(),
    createdBy: String(row.created_by),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    updatedBy: String(row.updated_by),
  };
}

function rowToPolicy(row: Record<string, unknown>): TenantPolicy {
  assertPolicyKey(String(row.policy_key));
  return {
    tenantId: String(row.tenant_id),
    policyKey: row.policy_key as TenantPolicyKey,
    value: row.value_json as TenantPolicyValue,
    source: row.source as TenantPolicy['source'],
    version: Number(row.version),
    createdAt: new Date(String(row.created_at)).toISOString(),
    createdBy: String(row.created_by),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    updatedBy: String(row.updated_by),
  };
}
