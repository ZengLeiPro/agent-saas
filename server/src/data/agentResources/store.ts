import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { PgGovernanceMigrationRunner, governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import {
  AgentResourceInvariantError,
  type CreateManagedAgentInput,
  type ManagedAgentResource,
  type ManagedAgentVersion,
  type PublishManagedAgentVersionInput,
} from './types.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,95}$/;
const FORBIDDEN_DEFINITION_KEYS = new Set([
  'secret', 'secretref', 'password', 'token', 'credential', 'credentialid',
  'apikey', 'accesstoken', 'authtoken', 'clientsecret', 'privatekey',
  'messagetext', 'messagebody', 'rawparameters', 'rawparams',
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter(key => record[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

export function assertManagedAgentDefinitionSafe(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertManagedAgentDefinitionSafe);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_DEFINITION_KEYS.has(normalizedKey(key))) {
      throw new AgentResourceInvariantError('AGENT_DEFINITION_SENSITIVE');
    }
    assertManagedAgentDefinitionSafe(child);
  }
}

function rowToResource(row: Record<string, unknown>): ManagedAgentResource {
  return {
    agentId: String(row.agent_id), tenantId: String(row.tenant_id),
    kind: row.kind as ManagedAgentResource['kind'], ownerUserId: String(row.owner_user_id),
    ...(row.template_id ? { templateId: String(row.template_id) } : {}),
    status: row.status as ManagedAgentResource['status'],
    ...(row.current_version_id ? { currentVersionId: String(row.current_version_id) } : {}),
    revision: Number(row.revision),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    createdBy: String(row.created_by),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    updatedBy: String(row.updated_by),
    ...(row.archived_at ? { archivedAt: row.archived_at instanceof Date ? row.archived_at.toISOString() : String(row.archived_at) } : {}),
    ...(row.archived_by ? { archivedBy: String(row.archived_by) } : {}),
  };
}

function rowToVersion(row: Record<string, unknown>): ManagedAgentVersion {
  return {
    versionId: String(row.version_id), agentId: String(row.agent_id),
    versionNumber: Number(row.version_number), definition: row.definition_json as Record<string, unknown>,
    digest: String(row.digest),
    publishedAt: row.published_at instanceof Date ? row.published_at.toISOString() : String(row.published_at),
    publishedBy: String(row.published_by),
  };
}

export class PgAgentResourceStore {
  readonly resourcesTable: string;
  readonly versionsTable: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: { pool: GovernancePgPool; tablePrefix?: string }) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.tablePrefix = options.tablePrefix;
    this.resourcesTable = `${prefix}_managed_agents`;
    this.versionsTable = `${prefix}_managed_agent_versions`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async get(agentId: string): Promise<ManagedAgentResource | null> {
    const result = await this.options.pool.query(`SELECT * FROM ${this.resourcesTable} WHERE agent_id=$1`, [agentId]);
    return result.rows[0] ? rowToResource(result.rows[0]) : null;
  }

  async getForTenant(tenantId: string, agentId: string): Promise<ManagedAgentResource | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.resourcesTable} WHERE tenant_id=$1 AND agent_id=$2`, [tenantId, agentId],
    );
    return result.rows[0] ? rowToResource(result.rows[0]) : null;
  }

  async findPersonalByOwner(tenantId: string, ownerUserId: string): Promise<ManagedAgentResource | null> {
    const result = await this.options.pool.query(`
      SELECT * FROM ${this.resourcesTable}
      WHERE tenant_id=$1 AND owner_user_id=$2 AND kind='personal_agent' AND status <> 'archived'
      ORDER BY created_at, agent_id LIMIT 1
    `, [tenantId, ownerUserId]);
    return result.rows[0] ? rowToResource(result.rows[0]) : null;
  }

  async getVersion(versionId: string): Promise<ManagedAgentVersion | null> {
    const result = await this.options.pool.query(`SELECT * FROM ${this.versionsTable} WHERE version_id=$1`, [versionId]);
    return result.rows[0] ? rowToVersion(result.rows[0]) : null;
  }

  async create(input: CreateManagedAgentInput): Promise<ManagedAgentResource> {
    const agentId = input.agentId ?? `${input.kind.replace('_agent', '')}-${randomUUID()}`;
    if (!ID_PATTERN.test(agentId) || !ID_PATTERN.test(input.tenantId) || !input.ownerUserId.trim()) {
      throw new AgentResourceInvariantError('AGENT_RESOURCE_INVALID');
    }
    const result = await this.options.pool.query(`
      INSERT INTO ${this.resourcesTable} (
        agent_id,tenant_id,kind,owner_user_id,template_id,status,created_by,updated_by
      ) VALUES ($1,$2,$3,$4,$5,'draft',$6,$6)
      ON CONFLICT (agent_id) DO NOTHING
      RETURNING *
    `, [agentId, input.tenantId, input.kind, input.ownerUserId, input.templateId ?? null, input.createdBy]);
    if (!result.rows[0]) throw new AgentResourceInvariantError('AGENT_RESOURCE_VERSION_CONFLICT');
    return rowToResource(result.rows[0]);
  }

  async publishVersion(input: PublishManagedAgentVersionInput): Promise<{
    resource: ManagedAgentResource;
    version: ManagedAgentVersion;
    created: boolean;
  }> {
    assertManagedAgentDefinitionSafe(input.definition);
    const digest = createHash('sha256').update(canonicalize(input.definition)).digest('hex');
    return this.withTransaction(async client => {
      const resourceResult = await client.query(
        `SELECT * FROM ${this.resourcesTable} WHERE tenant_id=$1 AND agent_id=$2 FOR UPDATE`,
        [input.tenantId, input.agentId],
      );
      if (!resourceResult.rows[0]) throw new AgentResourceInvariantError('AGENT_RESOURCE_NOT_FOUND');
      const current = rowToResource(resourceResult.rows[0]);
      if (current.status === 'archived') throw new AgentResourceInvariantError('AGENT_RESOURCE_ARCHIVED');
      if (current.revision !== input.expectedRevision) {
        throw new AgentResourceInvariantError('AGENT_RESOURCE_VERSION_CONFLICT');
      }
      const duplicate = await client.query(
        `SELECT * FROM ${this.versionsTable} WHERE agent_id=$1 AND digest=$2`, [input.agentId, digest],
      );
      if (duplicate.rows[0]) return { resource: current, version: rowToVersion(duplicate.rows[0]), created: false };
      const nextNumber = await client.query<{ next_version: string }>(
        `SELECT COALESCE(MAX(version_number),0)+1 AS next_version FROM ${this.versionsTable} WHERE agent_id=$1`,
        [input.agentId],
      );
      const versionId = `agentv-${randomUUID()}`;
      const versionResult = await client.query(`
        INSERT INTO ${this.versionsTable} (
          version_id,agent_id,version_number,definition_json,digest,published_by
        ) VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING *
      `, [versionId, input.agentId, Number(nextNumber.rows[0]?.next_version ?? 1), JSON.stringify(input.definition), digest, input.publishedBy]);
      const updated = await client.query(`
        UPDATE ${this.resourcesTable}
        SET status='enabled',current_version_id=$2,revision=revision+1,updated_at=NOW(),updated_by=$3
        WHERE agent_id=$1 AND revision=$4 RETURNING *
      `, [input.agentId, versionId, input.publishedBy, input.expectedRevision]);
      if (!updated.rows[0]) throw new AgentResourceInvariantError('AGENT_RESOURCE_VERSION_CONFLICT');
      return { resource: rowToResource(updated.rows[0]), version: rowToVersion(versionResult.rows[0]), created: true };
    });
  }

  async setStatus(
    tenantId: string,
    agentId: string,
    status: 'enabled' | 'disabled',
    expectedRevision: number,
    updatedBy: string,
  ): Promise<ManagedAgentResource> {
    const result = await this.options.pool.query(`
      UPDATE ${this.resourcesTable}
      SET status=$3,revision=revision+1,updated_at=NOW(),updated_by=$4
      WHERE tenant_id=$1 AND agent_id=$2 AND revision=$5 AND status IN ('enabled','disabled') RETURNING *
    `, [tenantId, agentId, status, updatedBy, expectedRevision]);
    if (!result.rows[0]) {
      const current = await this.getForTenant(tenantId, agentId);
      if (!current) throw new AgentResourceInvariantError('AGENT_RESOURCE_NOT_FOUND');
      if (current.status === 'archived') throw new AgentResourceInvariantError('AGENT_RESOURCE_ARCHIVED');
      if (current.status === 'draft') throw new AgentResourceInvariantError('AGENT_RESOURCE_INVALID_TRANSITION');
      throw new AgentResourceInvariantError('AGENT_RESOURCE_VERSION_CONFLICT');
    }
    return rowToResource(result.rows[0]);
  }

  async archive(tenantId: string, agentId: string, expectedRevision: number, archivedBy: string): Promise<ManagedAgentResource> {
    const result = await this.options.pool.query(`
      UPDATE ${this.resourcesTable}
      SET status='archived',revision=revision+1,archived_at=NOW(),archived_by=$4,
          updated_at=NOW(),updated_by=$4
      WHERE tenant_id=$1 AND agent_id=$2 AND revision=$3 AND status <> 'archived' RETURNING *
    `, [tenantId, agentId, expectedRevision, archivedBy]);
    if (!result.rows[0]) {
      const current = await this.getForTenant(tenantId, agentId);
      if (!current) throw new AgentResourceInvariantError('AGENT_RESOURCE_NOT_FOUND');
      if (current.status === 'archived') throw new AgentResourceInvariantError('AGENT_RESOURCE_ARCHIVED');
      throw new AgentResourceInvariantError('AGENT_RESOURCE_VERSION_CONFLICT');
    }
    return rowToResource(result.rows[0]);
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
