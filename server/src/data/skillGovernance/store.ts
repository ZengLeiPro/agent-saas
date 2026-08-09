import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { PgGovernanceMigrationRunner, governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import {
  SkillGovernanceInvariantError,
  type GovernedSkillResource,
  type GovernedSkillVersion,
  type SkillCandidate,
} from './types.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,95}$/;
const FORBIDDEN_KEYS = new Set([
  'secret', 'secretref', 'password', 'token', 'credential', 'credentialid',
  'apikey', 'accesstoken', 'authtoken', 'clientsecret', 'privatekey',
  'instanceid', 'sessionid', 'workspaceid', 'messagetext', 'messagebody', 'rawparams', 'rawparameters',
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

function digestDefinition(definition: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalize(definition)).digest('hex');
}

export function assertGovernedSkillDefinitionSafe(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertGovernedSkillDefinitionSafe);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(normalizedKey(key))) {
      throw new SkillGovernanceInvariantError('SKILL_DEFINITION_SENSITIVE');
    }
    assertGovernedSkillDefinitionSafe(child);
  }
}

function rowToResource(row: Record<string, unknown>): GovernedSkillResource {
  return {
    skillId: String(row.skill_id), tenantId: String(row.tenant_id),
    scope: row.scope as GovernedSkillResource['scope'],
    ...(row.owner_user_id ? { ownerUserId: String(row.owner_user_id) } : {}),
    status: row.status as GovernedSkillResource['status'],
    ...(row.current_version_id ? { currentVersionId: String(row.current_version_id) } : {}),
    revision: Number(row.revision),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    createdBy: String(row.created_by),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

function rowToVersion(row: Record<string, unknown>): GovernedSkillVersion {
  return {
    versionId: String(row.version_id), skillId: String(row.skill_id),
    versionNumber: Number(row.version_number), definition: row.definition_json as Record<string, unknown>,
    digest: String(row.digest),
    ...(row.source_candidate_id ? { sourceCandidateId: String(row.source_candidate_id) } : {}),
    publishedAt: row.published_at instanceof Date ? row.published_at.toISOString() : String(row.published_at),
    publishedBy: String(row.published_by),
  };
}

function rowToCandidate(row: Record<string, unknown>): SkillCandidate {
  return {
    candidateId: String(row.candidate_id), tenantId: String(row.tenant_id),
    ownerUserId: String(row.owner_user_id), targetSkillId: String(row.target_skill_id),
    definition: row.definition_json as Record<string, unknown>, digest: String(row.digest),
    status: row.status as SkillCandidate['status'], revision: Number(row.revision),
    ...(row.submitted_at ? { submittedAt: row.submitted_at instanceof Date ? row.submitted_at.toISOString() : String(row.submitted_at) } : {}),
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at instanceof Date ? row.reviewed_at.toISOString() : String(row.reviewed_at) } : {}),
    ...(row.reviewed_by ? { reviewedBy: String(row.reviewed_by) } : {}),
    ...(row.review_reason ? { reviewReason: String(row.review_reason) } : {}),
    ...(row.published_version_id ? { publishedVersionId: String(row.published_version_id) } : {}),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export class PgSkillGovernanceStore {
  readonly resourcesTable: string;
  readonly versionsTable: string;
  readonly candidatesTable: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: { pool: GovernancePgPool; tablePrefix?: string }) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.tablePrefix = options.tablePrefix;
    this.resourcesTable = `${prefix}_governed_skills`;
    this.versionsTable = `${prefix}_governed_skill_versions`;
    this.candidatesTable = `${prefix}_skill_candidates`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async listPersonalByOwner(tenantId: string, ownerUserId: string): Promise<GovernedSkillResource[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.resourcesTable} WHERE tenant_id=$1 AND owner_user_id=$2 AND scope='personal' ORDER BY skill_id`,
      [tenantId, ownerUserId],
    );
    return result.rows.map(rowToResource);
  }

  async getResource(skillId: string): Promise<GovernedSkillResource | null> {
    const result = await this.options.pool.query(`SELECT * FROM ${this.resourcesTable} WHERE skill_id=$1`, [skillId]);
    return result.rows[0] ? rowToResource(result.rows[0]) : null;
  }

  async getVersion(versionId: string): Promise<GovernedSkillVersion | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.versionsTable} WHERE version_id=$1`, [versionId],
    );
    return result.rows[0] ? rowToVersion(result.rows[0]) : null;
  }

  async getCandidate(tenantId: string, candidateId: string): Promise<SkillCandidate | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.candidatesTable} WHERE tenant_id=$1 AND candidate_id=$2`, [tenantId, candidateId],
    );
    return result.rows[0] ? rowToCandidate(result.rows[0]) : null;
  }

  async createResource(input: {
    skillId: string;
    tenantId: string;
    scope: GovernedSkillResource['scope'];
    ownerUserId?: string;
    createdBy: string;
  }): Promise<GovernedSkillResource> {
    if (!ID_PATTERN.test(input.skillId) || !ID_PATTERN.test(input.tenantId)
      || (input.scope === 'personal' && !input.ownerUserId?.trim())) {
      throw new SkillGovernanceInvariantError(
        input.scope === 'personal' ? 'SKILL_PERSONAL_OWNER_REQUIRED' : 'SKILL_RESOURCE_INVALID',
      );
    }
    const result = await this.options.pool.query(`
      INSERT INTO ${this.resourcesTable} (
        skill_id,tenant_id,scope,owner_user_id,status,created_by,updated_by
      ) VALUES ($1,$2,$3,$4,'draft',$5,$5)
      ON CONFLICT (skill_id) DO NOTHING RETURNING *
    `, [input.skillId, input.tenantId, input.scope, input.ownerUserId ?? null, input.createdBy]);
    if (!result.rows[0]) throw new SkillGovernanceInvariantError('SKILL_RESOURCE_VERSION_CONFLICT');
    return rowToResource(result.rows[0]);
  }

  async publishVersion(input: {
    tenantId: string;
    skillId: string;
    expectedRevision: number;
    definition: Record<string, unknown>;
    publishedBy: string;
    sourceCandidateId?: string;
  }): Promise<{ resource: GovernedSkillResource; version: GovernedSkillVersion; created: boolean }> {
    assertGovernedSkillDefinitionSafe(input.definition);
    return this.withTransaction(client => this.publishVersionInTransaction(client, {
      skillId: input.skillId,
      expectedRevision: input.expectedRevision,
      definition: input.definition,
      publishedBy: input.publishedBy,
      ...(input.sourceCandidateId ? { sourceCandidateId: input.sourceCandidateId } : {}),
      expectedTenantId: input.tenantId,
    }));
  }

  async createCandidate(input: {
    tenantId: string;
    ownerUserId: string;
    targetSkillId: string;
    definition: Record<string, unknown>;
  }): Promise<SkillCandidate> {
    if (!ID_PATTERN.test(input.tenantId) || !ID_PATTERN.test(input.targetSkillId) || !input.ownerUserId.trim()) {
      throw new SkillGovernanceInvariantError('SKILL_RESOURCE_INVALID');
    }
    assertGovernedSkillDefinitionSafe(input.definition);
    const target = await this.getResource(input.targetSkillId);
    if (!target) throw new SkillGovernanceInvariantError('SKILL_RESOURCE_NOT_FOUND');
    if (target.tenantId !== input.tenantId) {
      throw new SkillGovernanceInvariantError('SKILL_RESOURCE_TENANT_MISMATCH');
    }
    if (target.status === 'retired') throw new SkillGovernanceInvariantError('SKILL_RESOURCE_RETIRED');
    const result = await this.options.pool.query(`
      INSERT INTO ${this.candidatesTable} (
        candidate_id,tenant_id,owner_user_id,target_skill_id,definition_json,digest,status
      ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,'draft') RETURNING *
    `, [
      `skillc-${randomUUID()}`, input.tenantId, input.ownerUserId, input.targetSkillId,
      JSON.stringify(input.definition), digestDefinition(input.definition),
    ]);
    return rowToCandidate(result.rows[0]);
  }

  async submitCandidate(
    tenantId: string,
    candidateId: string,
    ownerUserId: string,
    expectedRevision: number,
  ): Promise<SkillCandidate> {
    const result = await this.options.pool.query(`
      UPDATE ${this.candidatesTable}
      SET status='submitted',revision=revision+1,submitted_at=NOW(),updated_at=NOW()
      WHERE tenant_id=$1 AND candidate_id=$2 AND owner_user_id=$3 AND revision=$4 AND status='draft'
      RETURNING *
    `, [tenantId, candidateId, ownerUserId, expectedRevision]);
    if (result.rows[0]) return rowToCandidate(result.rows[0]);
    const current = await this.getCandidate(tenantId, candidateId);
    if (!current) throw new SkillGovernanceInvariantError('SKILL_CANDIDATE_NOT_FOUND');
    if (current.ownerUserId !== ownerUserId) throw new SkillGovernanceInvariantError('SKILL_CANDIDATE_OWNER_MISMATCH');
    if (current.revision !== expectedRevision) throw new SkillGovernanceInvariantError('SKILL_CANDIDATE_VERSION_CONFLICT');
    throw new SkillGovernanceInvariantError('SKILL_CANDIDATE_INVALID_TRANSITION');
  }

  async reviewCandidate(input: {
    tenantId: string;
    candidateId: string;
    expectedRevision: number;
    verdict: 'approved' | 'rejected';
    reviewedBy: string;
    reason: string;
  }): Promise<SkillCandidate> {
    const result = await this.options.pool.query(`
      UPDATE ${this.candidatesTable}
      SET status=$3,revision=revision+1,reviewed_at=NOW(),reviewed_by=$4,review_reason=$5,updated_at=NOW()
      WHERE tenant_id=$1 AND candidate_id=$2 AND revision=$6 AND status='submitted' RETURNING *
    `, [input.tenantId, input.candidateId, input.verdict, input.reviewedBy, input.reason, input.expectedRevision]);
    if (result.rows[0]) return rowToCandidate(result.rows[0]);
    const current = await this.getCandidate(input.tenantId, input.candidateId);
    if (!current) throw new SkillGovernanceInvariantError('SKILL_CANDIDATE_NOT_FOUND');
    if (current.revision !== input.expectedRevision) throw new SkillGovernanceInvariantError('SKILL_CANDIDATE_VERSION_CONFLICT');
    throw new SkillGovernanceInvariantError('SKILL_CANDIDATE_INVALID_TRANSITION');
  }

  async publishApprovedCandidate(input: {
    tenantId: string;
    candidateId: string;
    expectedCandidateRevision: number;
    expectedSkillRevision: number;
    publishedBy: string;
  }): Promise<{ candidate: SkillCandidate; resource: GovernedSkillResource; version: GovernedSkillVersion }> {
    return this.withTransaction(async client => {
      const candidateResult = await client.query(
        `SELECT * FROM ${this.candidatesTable} WHERE tenant_id=$1 AND candidate_id=$2 FOR UPDATE`,
        [input.tenantId, input.candidateId],
      );
      if (!candidateResult.rows[0]) throw new SkillGovernanceInvariantError('SKILL_CANDIDATE_NOT_FOUND');
      const candidate = rowToCandidate(candidateResult.rows[0]);
      if (candidate.revision !== input.expectedCandidateRevision) {
        throw new SkillGovernanceInvariantError('SKILL_CANDIDATE_VERSION_CONFLICT');
      }
      if (candidate.status !== 'approved') {
        throw new SkillGovernanceInvariantError('SKILL_CANDIDATE_INVALID_TRANSITION');
      }
      if (digestDefinition(candidate.definition) !== candidate.digest) {
        throw new SkillGovernanceInvariantError('SKILL_CANDIDATE_DIGEST_MISMATCH');
      }
      const published = await this.publishVersionInTransaction(client, {
        skillId: candidate.targetSkillId,
        expectedRevision: input.expectedSkillRevision,
        definition: candidate.definition,
        publishedBy: input.publishedBy,
        sourceCandidateId: candidate.candidateId,
        expectedTenantId: candidate.tenantId,
      });
      const updatedCandidate = await client.query(`
        UPDATE ${this.candidatesTable}
        SET status='published',revision=revision+1,published_version_id=$3,updated_at=NOW()
        WHERE tenant_id=$1 AND candidate_id=$2 AND revision=$4 AND status='approved' RETURNING *
      `, [input.tenantId, candidate.candidateId, published.version.versionId, input.expectedCandidateRevision]);
      if (!updatedCandidate.rows[0]) throw new SkillGovernanceInvariantError('SKILL_CANDIDATE_VERSION_CONFLICT');
      return { candidate: rowToCandidate(updatedCandidate.rows[0]), resource: published.resource, version: published.version };
    });
  }

  async retire(tenantId: string, skillId: string, expectedRevision: number, retiredBy: string): Promise<GovernedSkillResource> {
    const result = await this.options.pool.query(`
      UPDATE ${this.resourcesTable}
      SET status='retired',revision=revision+1,updated_at=NOW(),updated_by=$4
      WHERE tenant_id=$1 AND skill_id=$2 AND revision=$3 AND status <> 'retired' RETURNING *
    `, [tenantId, skillId, expectedRevision, retiredBy]);
    if (result.rows[0]) return rowToResource(result.rows[0]);
    const current = await this.getResource(skillId);
    if (current && current.tenantId !== tenantId) throw new SkillGovernanceInvariantError('SKILL_RESOURCE_NOT_FOUND');
    if (!current) throw new SkillGovernanceInvariantError('SKILL_RESOURCE_NOT_FOUND');
    if (current.status === 'retired') throw new SkillGovernanceInvariantError('SKILL_RESOURCE_RETIRED');
    throw new SkillGovernanceInvariantError('SKILL_RESOURCE_VERSION_CONFLICT');
  }

  private async publishVersionInTransaction(client: PoolClient, input: {
    skillId: string;
    expectedRevision: number;
    definition: Record<string, unknown>;
    publishedBy: string;
    sourceCandidateId?: string;
    expectedTenantId?: string;
  }): Promise<{ resource: GovernedSkillResource; version: GovernedSkillVersion; created: boolean }> {
    assertGovernedSkillDefinitionSafe(input.definition);
    const resourceResult = await client.query(
      `SELECT * FROM ${this.resourcesTable} WHERE skill_id=$1 FOR UPDATE`, [input.skillId],
    );
    if (!resourceResult.rows[0]) throw new SkillGovernanceInvariantError('SKILL_RESOURCE_NOT_FOUND');
    const current = rowToResource(resourceResult.rows[0]);
    if (input.expectedTenantId && current.tenantId !== input.expectedTenantId) {
      throw new SkillGovernanceInvariantError('SKILL_RESOURCE_TENANT_MISMATCH');
    }
    if (current.status === 'retired') throw new SkillGovernanceInvariantError('SKILL_RESOURCE_RETIRED');
    if (current.revision !== input.expectedRevision) {
      throw new SkillGovernanceInvariantError('SKILL_RESOURCE_VERSION_CONFLICT');
    }
    const digest = digestDefinition(input.definition);
    const duplicate = await client.query(
      `SELECT * FROM ${this.versionsTable} WHERE skill_id=$1 AND digest=$2`, [input.skillId, digest],
    );
    if (duplicate.rows[0]) return { resource: current, version: rowToVersion(duplicate.rows[0]), created: false };
    const nextNumber = await client.query<{ next_version: string }>(
      `SELECT COALESCE(MAX(version_number),0)+1 AS next_version FROM ${this.versionsTable} WHERE skill_id=$1`,
      [input.skillId],
    );
    const versionId = `skillv-${randomUUID()}`;
    const versionResult = await client.query(`
      INSERT INTO ${this.versionsTable} (
        version_id,skill_id,version_number,definition_json,digest,source_candidate_id,published_by
      ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING *
    `, [
      versionId, input.skillId, Number(nextNumber.rows[0]?.next_version ?? 1),
      JSON.stringify(input.definition), digest, input.sourceCandidateId ?? null, input.publishedBy,
    ]);
    const updated = await client.query(`
      UPDATE ${this.resourcesTable}
      SET status='published',current_version_id=$2,revision=revision+1,updated_at=NOW(),updated_by=$3
      WHERE skill_id=$1 AND revision=$4 RETURNING *
    `, [input.skillId, versionId, input.publishedBy, input.expectedRevision]);
    if (!updated.rows[0]) throw new SkillGovernanceInvariantError('SKILL_RESOURCE_VERSION_CONFLICT');
    return { resource: rowToResource(updated.rows[0]), version: rowToVersion(versionResult.rows[0]), created: true };
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
