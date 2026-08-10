import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { PgGovernanceMigrationRunner, governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import {
  ResourceReferenceInvariantError,
  type ReplaceResourceReferencesInput,
  type ResourceReference,
  type ResourceRetirementImpact,
} from './types.js';

export interface PgResourceReferenceStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

function rowToReference(row: Record<string, unknown>): ResourceReference {
  return {
    referenceId: String(row.reference_id),
    tenantId: String(row.tenant_id),
    sourceType: String(row.source_type),
    sourceId: String(row.source_id),
    ...(row.source_version ? { sourceVersion: String(row.source_version) } : {}),
    targetType: String(row.target_type),
    targetId: String(row.target_id),
    ...(row.target_version ? { targetVersion: String(row.target_version) } : {}),
    relation: String(row.relation),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    createdBy: String(row.created_by),
  };
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export class PgResourceReferenceStore {
  readonly referencesTable: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: PgResourceReferenceStoreOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.tablePrefix = options.tablePrefix;
    this.referencesTable = `${prefix}_resource_references`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async listReferencers(tenantId: string, targetType: string, targetId: string): Promise<ResourceReference[]> {
    const result = await this.options.pool.query(`
      SELECT * FROM ${this.referencesTable}
      WHERE tenant_id=$1 AND target_type=$2 AND target_id=$3
      ORDER BY source_type, source_id, relation
    `, [tenantId, targetType, targetId]);
    return result.rows.map(rowToReference);
  }

  async listDependencies(tenantId: string, sourceType: string, sourceId: string): Promise<ResourceReference[]> {
    const result = await this.options.pool.query(`
      SELECT * FROM ${this.referencesTable}
      WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3
      ORDER BY target_type, target_id, relation
    `, [tenantId, sourceType, sourceId]);
    return result.rows.map(rowToReference);
  }

  async replaceSourceReferences(input: ReplaceResourceReferencesInput): Promise<ResourceReference[]> {
    if (!nonEmpty(input.tenantId) || !nonEmpty(input.sourceType) || !nonEmpty(input.sourceId)
      || input.references.some(reference => !nonEmpty(reference.targetType)
        || !nonEmpty(reference.targetId)
        || !nonEmpty(reference.relation)
        || (reference.targetType === input.sourceType && reference.targetId === input.sourceId))) {
      throw new ResourceReferenceInvariantError('RESOURCE_REFERENCE_INVALID');
    }
    const unique = new Map<string, typeof input.references[number]>();
    for (const reference of input.references) {
      const key = `${reference.targetType}\u0000${reference.targetId}\u0000${reference.relation}`;
      unique.set(key, reference);
    }
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `resource-reference:${input.tenantId}:${input.sourceType}:${input.sourceId}`,
      ]);
      await client.query(
        `DELETE FROM ${this.referencesTable} WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3`,
        [input.tenantId, input.sourceType, input.sourceId],
      );
      const rows: ResourceReference[] = [];
      for (const reference of unique.values()) {
        const result = await client.query(`
          INSERT INTO ${this.referencesTable} (
            reference_id,tenant_id,source_type,source_id,source_version,
            target_type,target_id,target_version,relation,created_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
        `, [
          randomUUID(), input.tenantId, input.sourceType, input.sourceId,
          input.sourceVersion ?? null, reference.targetType, reference.targetId,
          reference.targetVersion ?? null, reference.relation, input.updatedBy,
        ]);
        rows.push(rowToReference(result.rows[0]));
      }
      return rows;
    });
  }

  async previewRetirement(tenantId: string, targetType: string, targetId: string): Promise<ResourceRetirementImpact> {
    const references = await this.listReferencers(tenantId, targetType, targetId);
    return {
      tenantId,
      targetType,
      targetId,
      hardDeleteAllowed: references.length === 0,
      referenceCount: references.length,
      references,
    };
  }

  async assertHardDeleteAllowed(tenantId: string, targetType: string, targetId: string): Promise<void> {
    const impact = await this.previewRetirement(tenantId, targetType, targetId);
    if (!impact.hardDeleteAllowed) {
      throw new ResourceReferenceInvariantError('RESOURCE_HARD_DELETE_BLOCKED');
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
