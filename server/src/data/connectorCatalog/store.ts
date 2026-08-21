import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { PgGovernanceMigrationRunner, governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import { BUILTIN_CONNECTOR_DEFINITIONS } from './builtins.js';
import {
  ConnectorCatalogInvariantError,
  type ConnectorDefinition,
  type ConnectorDefinitionStatus,
  type ConnectorDefinitionVersion,
  type PublishConnectorDefinitionInput,
} from './types.js';

export interface PgConnectorCatalogStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FORBIDDEN_DEFINITION_KEYS = new Set([
  'apikey', 'accesstoken', 'clientsecret', 'credential', 'credentialid',
  'password', 'secret', 'secretref', 'token', 'refreshtoken',
]);
const SENSITIVE_VALUE_PATTERN = /(?:authorization\s*:\s*bearer|bearer\s+[a-z0-9._~-]{8,}|(?:token|secret|password|api[_-]?key)\s*(?:=|:)\s*\S+)/i;

function assertNoSensitiveDefinition(value: unknown): void {
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE_PATTERN.test(value)) {
      throw new ConnectorCatalogInvariantError('CONNECTOR_DEFINITION_SENSITIVE');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoSensitiveDefinition);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (FORBIDDEN_DEFINITION_KEYS.has(normalized)) {
      throw new ConnectorCatalogInvariantError('CONNECTOR_DEFINITION_SENSITIVE');
    }
    assertNoSensitiveDefinition(child);
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter(key => record[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function rowToDefinition(row: Record<string, unknown>): ConnectorDefinition {
  return {
    connectorId: String(row.connector_id),
    name: String(row.name),
    status: row.status as ConnectorDefinitionStatus,
    ...(row.current_version_id ? { currentVersionId: String(row.current_version_id) } : {}),
    authMethods: Array.isArray(row.auth_methods_json) ? row.auth_methods_json.map(String) : [],
    capabilitySchema: row.capability_schema_json && typeof row.capability_schema_json === 'object'
      ? row.capability_schema_json as Record<string, unknown>
      : {},
    version: Number(row.version),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    createdBy: String(row.created_by),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

function rowToVersion(row: Record<string, unknown>): ConnectorDefinitionVersion {
  return {
    versionId: String(row.version_id),
    connectorId: String(row.connector_id),
    versionNumber: Number(row.version_number),
    definition: row.definition_json as Record<string, unknown>,
    digest: String(row.digest),
    publishedAt: row.published_at instanceof Date ? row.published_at.toISOString() : String(row.published_at),
    publishedBy: String(row.published_by),
  };
}

export class PgConnectorCatalogStore {
  readonly definitionsTable: string;
  readonly versionsTable: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: PgConnectorCatalogStoreOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.tablePrefix = options.tablePrefix;
    this.definitionsTable = `${prefix}_connector_definitions`;
    this.versionsTable = `${prefix}_connector_definition_versions`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async get(connectorId: string): Promise<ConnectorDefinition | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.definitionsTable} WHERE connector_id = $1`,
      [connectorId],
    );
    return result.rows[0] ? rowToDefinition(result.rows[0]) : null;
  }

  async getVersion(versionId: string): Promise<ConnectorDefinitionVersion | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.versionsTable} WHERE version_id = $1`,
      [versionId],
    );
    return result.rows[0] ? rowToVersion(result.rows[0]) : null;
  }

  async list(): Promise<ConnectorDefinition[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.definitionsTable} ORDER BY connector_id`,
    );
    return result.rows.map(rowToDefinition);
  }

  async publish(input: PublishConnectorDefinitionInput): Promise<{
    definition: ConnectorDefinition;
    publishedVersion: ConnectorDefinitionVersion;
    created: boolean;
  }> {
    this.validatePublishInput(input);
    const payload = {
      name: input.name,
      authMethods: [...new Set(input.authMethods)].sort(),
      capabilitySchema: input.capabilitySchema,
      definition: input.definition,
    };
    const digest = createHash('sha256').update(canonicalize(payload)).digest('hex');
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`connector:${input.connectorId}`]);
      const currentResult = await client.query(
        `SELECT * FROM ${this.definitionsTable} WHERE connector_id = $1 FOR UPDATE`,
        [input.connectorId],
      );
      const current = currentResult.rows[0] ? rowToDefinition(currentResult.rows[0]) : null;
      if (current?.status === 'retired') throw new ConnectorCatalogInvariantError('CONNECTOR_RETIRED');

      if (!current) {
        await client.query(`
          INSERT INTO ${this.definitionsTable} (
            connector_id, name, status, auth_methods_json, capability_schema_json,
            version, created_by, updated_by
          ) VALUES ($1,$2,'draft',$3::jsonb,$4::jsonb,1,$5,$5)
        `, [
          input.connectorId,
          input.name,
          JSON.stringify(payload.authMethods),
          JSON.stringify(input.capabilitySchema),
          input.publishedBy,
        ]);
      }

      const duplicate = await client.query(
        `SELECT * FROM ${this.versionsTable} WHERE connector_id = $1 AND digest = $2`,
        [input.connectorId, digest],
      );
      if (duplicate.rows[0]) {
        const definitionResult = await client.query(
          `SELECT * FROM ${this.definitionsTable} WHERE connector_id = $1`,
          [input.connectorId],
        );
        return {
          definition: rowToDefinition(definitionResult.rows[0]),
          publishedVersion: rowToVersion(duplicate.rows[0]),
          created: false,
        };
      }

      const nextVersion = await client.query(
        `SELECT COALESCE(MAX(version_number), 0)::bigint + 1 AS next_version
         FROM ${this.versionsTable} WHERE connector_id = $1`,
        [input.connectorId],
      );
      const versionNumber = Number(nextVersion.rows[0]?.next_version ?? 1);
      const versionId = randomUUID();
      const versionResult = await client.query(`
        INSERT INTO ${this.versionsTable} (
          version_id, connector_id, version_number, definition_json, digest, published_by
        ) VALUES ($1,$2,$3,$4::jsonb,$5,$6)
        RETURNING *
      `, [versionId, input.connectorId, versionNumber, JSON.stringify(payload), digest, input.publishedBy]);
      const definitionResult = await client.query(`
        UPDATE ${this.definitionsTable}
        SET name = $2,
            status = 'published',
            current_version_id = $3,
            auth_methods_json = $4::jsonb,
            capability_schema_json = $5::jsonb,
            version = version + 1,
            updated_at = NOW(),
            updated_by = $6
        WHERE connector_id = $1
        RETURNING *
      `, [
        input.connectorId,
        input.name,
        versionId,
        JSON.stringify(payload.authMethods),
        JSON.stringify(input.capabilitySchema),
        input.publishedBy,
      ]);
      return {
        definition: rowToDefinition(definitionResult.rows[0]),
        publishedVersion: rowToVersion(versionResult.rows[0]),
        created: true,
      };
    });
  }

  async updateStatus(
    connectorId: string,
    status: Extract<ConnectorDefinitionStatus, 'disabled' | 'retired'>,
    expectedVersion: number,
    updatedBy: string,
  ): Promise<ConnectorDefinition> {
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`connector:${connectorId}`]);
      const currentResult = await client.query(
        `SELECT * FROM ${this.definitionsTable} WHERE connector_id = $1 FOR UPDATE`,
        [connectorId],
      );
      if (!currentResult.rows[0]) throw new ConnectorCatalogInvariantError('CONNECTOR_NOT_FOUND');
      const current = rowToDefinition(currentResult.rows[0]);
      if (current.status === 'retired') throw new ConnectorCatalogInvariantError('CONNECTOR_RETIRED');
      if (current.version !== expectedVersion) {
        throw new ConnectorCatalogInvariantError('CONNECTOR_VERSION_CONFLICT');
      }
      const result = await client.query(`
        UPDATE ${this.definitionsTable}
        SET status = $2,
            version = version + 1,
            updated_at = NOW(),
            updated_by = $3
        WHERE connector_id = $1 AND version = $4
        RETURNING *
      `, [connectorId, status, updatedBy, expectedVersion]);
      if (!result.rows[0]) throw new ConnectorCatalogInvariantError('CONNECTOR_VERSION_CONFLICT');
      return rowToDefinition(result.rows[0]);
    });
  }

  async ensureBuiltins(publishedBy: string): Promise<{ created: number; unchanged: number }> {
    let created = 0;
    let unchanged = 0;
    for (const builtin of BUILTIN_CONNECTOR_DEFINITIONS) {
      const current = await this.get(builtin.connectorId);
      // 运维显式 disabled/retired 的 builtin 不能被启动回填重新激活。
      if (current && (current.status === 'disabled' || current.status === 'retired')) {
        unchanged += 1;
        continue;
      }
      const result = await this.publish({ ...builtin, publishedBy });
      if (result.created) created += 1;
      else unchanged += 1;
    }
    return { created, unchanged };
  }

  private validatePublishInput(input: PublishConnectorDefinitionInput): void {
    if (!ID_PATTERN.test(input.connectorId)
      || !input.name.trim()
      || input.authMethods.some(method => !method.trim())
      || !input.definition
      || typeof input.definition !== 'object') {
      throw new ConnectorCatalogInvariantError('CONNECTOR_DEFINITION_INVALID');
    }
    assertNoSensitiveDefinition(input.capabilitySchema);
    assertNoSensitiveDefinition(input.definition);
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
