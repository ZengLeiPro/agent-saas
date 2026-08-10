import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { PgGovernanceMigrationIssueStore } from '../governance-issues/store.js';
import { PgGovernanceMigrationRunner, governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import {
  CredentialInvariantError,
  type CredentialBackfillResult,
  type CredentialInput,
  type CredentialStatusPatch,
  type GovernanceCredential,
  type LegacyCredentialBackfillInput,
} from './types.js';

export interface PgCredentialStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

function rowToCredential(row: Record<string, unknown>): GovernanceCredential {
  return {
    credentialId: String(row.credential_id),
    tenantId: String(row.tenant_id),
    ...(row.connector_id ? { connectorId: String(row.connector_id) } : {}),
    kind: row.kind as GovernanceCredential['kind'],
    ...(row.owner_user_id ? { ownerUserId: String(row.owner_user_id) } : {}),
    ...(row.custodian_user_id ? { custodianUserId: String(row.custodian_user_id) } : {}),
    ...(row.owner_username ? { ownerUsername: String(row.owner_username) } : {}),
    ...(row.alias ? { alias: String(row.alias) } : {}),
    purpose: String(row.purpose),
    scopeSummary: (row.scope_summary_json && typeof row.scope_summary_json === 'object')
      ? row.scope_summary_json as Record<string, unknown>
      : {},
    status: row.status as GovernanceCredential['status'],
    generation: Number(row.generation),
    secretRef: String(row.secret_ref),
    ...(row.expires_at ? { expiresAt: new Date(String(row.expires_at)).toISOString() } : {}),
    ...(row.last_validated_at ? { lastValidatedAt: new Date(String(row.last_validated_at)).toISOString() } : {}),
    source: row.source as GovernanceCredential['source'],
    version: Number(row.version),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    createdBy: String(row.created_by),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

export class PgCredentialStore {
  readonly credentialsTable: string;
  private readonly issueStore: PgGovernanceMigrationIssueStore;
  private readonly tablePrefix?: string;

  constructor(private readonly options: PgCredentialStoreOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.tablePrefix = options.tablePrefix;
    this.credentialsTable = `${prefix}_credentials`;
    this.issueStore = new PgGovernanceMigrationIssueStore(options.pool, options.tablePrefix);
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async create(input: CredentialInput): Promise<GovernanceCredential> {
    if (!input.secretRef.trim()) throw new CredentialInvariantError('CREDENTIAL_SECRET_REF_MISSING');
    if (!['org_shared', 'personal_grant', 'infrastructure'].includes(input.kind)) {
      throw new CredentialInvariantError('CREDENTIAL_KIND_INVALID');
    }
    if (input.kind === 'personal_grant' && !input.ownerUserId?.trim()) {
      throw new CredentialInvariantError('CREDENTIAL_PERSONAL_OWNER_MISSING');
    }
    if (input.kind === 'org_shared' && !input.custodianUserId?.trim()) {
      throw new CredentialInvariantError('CREDENTIAL_ORG_CUSTODIAN_MISSING');
    }
    if (!input.purpose.trim()) throw new CredentialInvariantError('CREDENTIAL_PURPOSE_MISSING');
    const credentialId = randomUUID();
    const result = await this.options.pool.query(`
      INSERT INTO ${this.credentialsTable} (
        credential_id, tenant_id, connector_id, kind, owner_user_id, custodian_user_id,
        owner_username, alias, purpose, scope_summary_json, status, generation,
        secret_ref, expires_at, source, created_by, updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'active',1,$11,$12,'governance',$13,$13)
      ON CONFLICT (secret_ref) DO NOTHING
      RETURNING *
    `, [
      credentialId,
      input.tenantId,
      input.connectorId ?? null,
      input.kind,
      input.ownerUserId ?? null,
      input.custodianUserId ?? null,
      input.ownerUsername ?? null,
      input.alias ?? null,
      input.purpose,
      JSON.stringify(input.scopeSummary ?? {}),
      input.secretRef,
      input.expiresAt ?? null,
      input.createdBy,
    ]);
    if (!result.rows[0]) throw new CredentialInvariantError('CREDENTIAL_SECRET_REF_CONFLICT');
    return rowToCredential(result.rows[0]);
  }

  async get(credentialId: string): Promise<GovernanceCredential | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.credentialsTable} WHERE credential_id = $1`,
      [credentialId],
    );
    return result.rows[0] ? rowToCredential(result.rows[0]) : null;
  }

  async getBySecretRef(secretRef: string): Promise<GovernanceCredential | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.credentialsTable} WHERE secret_ref = $1`,
      [secretRef],
    );
    return result.rows[0] ? rowToCredential(result.rows[0]) : null;
  }

  async listForOwner(tenantId: string, ownerUserId: string): Promise<GovernanceCredential[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.credentialsTable}
       WHERE tenant_id = $1 AND owner_user_id = $2
       ORDER BY created_at, credential_id`,
      [tenantId, ownerUserId],
    );
    return result.rows.map(rowToCredential);
  }

  async listForTenant(tenantId: string): Promise<GovernanceCredential[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.credentialsTable} WHERE tenant_id = $1 ORDER BY created_at, credential_id`,
      [tenantId],
    );
    return result.rows.map(rowToCredential);
  }

  async bumpGenerationBySecretRef(secretRef: string, updatedBy: string): Promise<GovernanceCredential | null> {
    if (!secretRef.trim() || !updatedBy.trim()) throw new CredentialInvariantError('CREDENTIAL_GENERATION_INVALID');
    const result = await this.options.pool.query(`
      UPDATE ${this.credentialsTable}
      SET generation = generation + 1,
          version = version + 1,
          updated_at = NOW(),
          updated_by = $2
      WHERE secret_ref = $1 AND status IN ('active','rotation_due')
      RETURNING *
    `, [secretRef, updatedBy]);
    return result.rows[0] ? rowToCredential(result.rows[0]) : null;
  }

  async updateStatus(credentialId: string, patch: CredentialStatusPatch): Promise<GovernanceCredential> {
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`credential:${credentialId}`]);
      const currentResult = await client.query(
        `SELECT * FROM ${this.credentialsTable} WHERE credential_id = $1 FOR UPDATE`,
        [credentialId],
      );
      if (!currentResult.rows[0]) throw new CredentialInvariantError('CREDENTIAL_NOT_FOUND');
      const current = rowToCredential(currentResult.rows[0]);
      if (current.version !== patch.expectedVersion) {
        throw new CredentialInvariantError('CREDENTIAL_VERSION_CONFLICT');
      }
      if (current.status === 'revoked') throw new CredentialInvariantError('CREDENTIAL_REVOKED_NO_REUSE');
      if (current.status === 'suspended' && patch.status === 'suspended') {
        throw new CredentialInvariantError('CREDENTIAL_ALREADY_SUSPENDED');
      }
      const updated = await client.query(`
        UPDATE ${this.credentialsTable}
        SET status = $2,
            generation = CASE WHEN $2 = 'revoked' THEN generation + 1 ELSE generation END,
            source = 'governance',
            version = version + 1,
            updated_at = NOW(),
            updated_by = $3
        WHERE credential_id = $1 AND version = $4
        RETURNING *
      `, [credentialId, patch.status, patch.updatedBy, patch.expectedVersion]);
      if (!updated.rows[0]) throw new CredentialInvariantError('CREDENTIAL_VERSION_CONFLICT');
      return rowToCredential(updated.rows[0]);
    });
  }

  /**
   * Legacy connector 连接 → governance credential 投影。规则与 Membership 一致：
   * - 只回填 `connected` 且带有效 secretRef 的连接；disconnected 墓碑不再迁回。
   * - owner 优先用 immutable userId；缺失时按同租户 case-insensitive 唯一 username 命中。
   * - username 未命中或多命中都不猜：记 issue，等 P2 Credential Broker 批次人工确认。
   * - ON CONFLICT(secret_ref) 只更新 legacy_projection 行，governance 写入不被回填覆盖。
   */
  async backfillLegacyCredentials(input: LegacyCredentialBackfillInput): Promise<CredentialBackfillResult> {
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['governance-credential-backfill']);
      let credentialsProjected = 0;
      let issuesRecorded = 0;

      const usersByUsernameByTenant = new Map<string, LegacyCredentialBackfillInput['users']>();
      for (const user of input.users) {
        const key = `${user.tenantId}\u0000${user.username.toLowerCase()}`;
        usersByUsernameByTenant.set(key, [...(usersByUsernameByTenant.get(key) ?? []), user]);
      }

      for (const connection of input.connections) {
        if (connection.status !== 'connected') continue;
        for (const [slot, secretRef] of Object.entries(connection.credentialRefs ?? {})) {
          if (!secretRef) continue;
          const legacyKey = `${connection.username}:${connection.connectorId}:${slot}`;
          if (connection.tenantId === input.platformTenantId) {
            await this.issueStore.open({
              issueType: 'platform_tenant_credential_forbidden',
              tenantId: connection.tenantId,
              resourceType: 'credential',
              resourceId: connection.connectorId,
              legacyKey,
              detail: { connectorId: connection.connectorId, slot },
              createdBy: input.projectedBy,
            }, client);
            issuesRecorded += 1;
            continue;
          }
          let ownerUserId = connection.userId;
          let ownerUsername = connection.userId ? undefined : connection.username;
          if (!ownerUserId) {
            const candidates = usersByUsernameByTenant.get(
              `${connection.tenantId}\u0000${connection.username.toLowerCase()}`,
            ) ?? [];
            if (candidates.length === 1) {
              ownerUserId = candidates[0].id;
              ownerUsername = candidates[0].username;
            } else {
              await this.issueStore.open({
                issueType: candidates.length === 0
                  ? 'credential_owner_unresolved'
                  : 'credential_owner_ambiguous',
                tenantId: connection.tenantId,
                resourceType: 'credential',
                resourceId: connection.connectorId,
                legacyKey,
                detail: { connectorId: connection.connectorId, slot, candidateCount: candidates.length },
                createdBy: input.projectedBy,
              }, client);
              issuesRecorded += 1;
              continue;
            }
          }
          await client.query(`
            INSERT INTO ${this.credentialsTable} (
              credential_id, tenant_id, connector_id, kind, owner_user_id, owner_username,
              purpose, scope_summary_json, status, generation, secret_ref, source, created_by, updated_by
            ) VALUES ($1,$2,$3,'personal_grant',$4,$5,$6,$7::jsonb,'active',1,$8,'legacy_projection',$9,$9)
            ON CONFLICT (secret_ref) DO UPDATE SET
              status = EXCLUDED.status,
              scope_summary_json = EXCLUDED.scope_summary_json,
              version = ${this.credentialsTable}.version + 1,
              updated_at = NOW(),
              updated_by = EXCLUDED.updated_by
            WHERE ${this.credentialsTable}.source = 'legacy_projection'
              AND (
                ${this.credentialsTable}.status IS DISTINCT FROM EXCLUDED.status
                OR ${this.credentialsTable}.scope_summary_json IS DISTINCT FROM EXCLUDED.scope_summary_json
              )
          `, [
            randomUUID(),
            connection.tenantId,
            connection.connectorId,
            ownerUserId,
            ownerUsername ?? null,
            `legacy:${connection.connectorId}:${slot}`,
            JSON.stringify({
              legacyCapability: connection.capabilities?.mcp === true ? 'mcp' : 'connector',
              scopes: [`${connection.connectorId}:*`],
            }),
            secretRef,
            input.projectedBy,
          ]);
          credentialsProjected += 1;
        }
      }

      return { credentialsProjected, issuesRecorded };
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
