import { randomUUID } from 'node:crypto';

import { PgGovernanceMigrationRunner, governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import {
  CONTENT_ACCESS_GRANT_SCOPES,
  ContentAccessGrantInvariantError,
  type AuthorizeContentAccessInput,
  type ContentAccessGrant,
  type ContentAccessGrantScope,
  type CreateContentAccessGrantInput,
  type ListContentAccessGrantsInput,
  type RevokeContentAccessGrantInput,
} from './types.js';

const VALID_SCOPES = new Set<string>(CONTENT_ACCESS_GRANT_SCOPES);

export interface PgContentAccessGrantStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function validDate(value: string | Date): Date | undefined {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function rowScopes(value: unknown): ContentAccessGrantScope[] {
  if (!Array.isArray(value)) return [];
  return value.filter((scope): scope is ContentAccessGrantScope => typeof scope === 'string' && VALID_SCOPES.has(scope));
}

function rowToGrant(row: Record<string, unknown>): ContentAccessGrant {
  return {
    grantId: String(row.grant_id),
    tenantId: String(row.tenant_id),
    subjectUserId: String(row.subject_user_id),
    targetType: row.target_type as ContentAccessGrant['targetType'],
    targetId: String(row.target_id),
    scopes: rowScopes(row.scopes),
    purpose: String(row.purpose),
    reasonCode: String(row.reason_code),
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
    status: row.status as ContentAccessGrant['status'],
    revision: Number(row.revision),
    createdBy: String(row.created_by),
    ...(row.revoked_by ? { revokedBy: String(row.revoked_by) } : {}),
  };
}

export class PgContentAccessGrantStore {
  readonly grantsTable: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: PgContentAccessGrantStoreOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.tablePrefix = options.tablePrefix;
    this.grantsTable = `${prefix}_content_access_grants`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async create(input: CreateContentAccessGrantInput): Promise<ContentAccessGrant> {
    const expiresAt = validDate(input.expiresAt);
    if (!nonEmpty(input.tenantId) || !nonEmpty(input.subjectUserId)
      || !nonEmpty(input.targetId) || !['session', 'guardrail_collection'].includes(input.targetType)
      || !nonEmpty(input.purpose) || !nonEmpty(input.reasonCode) || !nonEmpty(input.createdBy)
      || input.scopes.length === 0 || input.scopes.some(scope => !VALID_SCOPES.has(scope))
      || (input.targetType === 'session' && input.scopes.some(scope => scope === 'guardrail_read'))
      || (input.targetType === 'guardrail_collection'
        && (input.targetId !== input.tenantId || input.scopes.some(scope => scope !== 'guardrail_read')))
      || !expiresAt || expiresAt.getTime() <= Date.now()) {
      throw new ContentAccessGrantInvariantError('CONTENT_ACCESS_GRANT_INVALID');
    }
    const scopes = [...new Set(input.scopes)];
    const result = await this.options.pool.query(`
      INSERT INTO ${this.grantsTable} (
        grant_id,tenant_id,subject_user_id,target_type,target_id,scopes,purpose,reason_code,
        expires_at,status,revision,created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',1,$10)
      RETURNING *
    `, [
      randomUUID(), input.tenantId, input.subjectUserId, input.targetType, input.targetId,
      scopes, input.purpose, input.reasonCode, expiresAt, input.createdBy,
    ]);
    return rowToGrant(result.rows[0]);
  }

  async list(input: ListContentAccessGrantsInput): Promise<ContentAccessGrant[]> {
    if (!nonEmpty(input.tenantId) || (input.subjectUserId !== undefined && !nonEmpty(input.subjectUserId))) {
      throw new ContentAccessGrantInvariantError('CONTENT_ACCESS_GRANT_INVALID');
    }
    const result = await this.options.pool.query(`
      SELECT * FROM ${this.grantsTable}
      WHERE tenant_id=$1
        AND ($2::text IS NULL OR subject_user_id=$2)
        AND ($3::text IS NULL OR status=$3)
      ORDER BY expires_at,grant_id
    `, [input.tenantId, input.subjectUserId ?? null, input.status ?? null]);
    return result.rows.map(rowToGrant);
  }

  async authorize(input: AuthorizeContentAccessInput): Promise<boolean> {
    const at = validDate(input.at ?? new Date());
    if (!nonEmpty(input.tenantId) || !nonEmpty(input.subjectUserId)
      || !nonEmpty(input.targetId) || !['session', 'guardrail_collection'].includes(input.targetType)
      || !VALID_SCOPES.has(input.scope) || !at) return false;

    const result = await this.options.pool.query(`
      SELECT * FROM ${this.grantsTable}
      WHERE tenant_id=$1 AND subject_user_id=$2
        AND target_type=$3 AND target_id=$4
        AND status='active' AND expires_at>$5 AND $6=ANY(scopes)
      ORDER BY expires_at,grant_id
      LIMIT 1
    `, [input.tenantId, input.subjectUserId, input.targetType, input.targetId, at, input.scope]);
    const row = result.rows[0];
    if (!row) return false;

    const grant = rowToGrant(row);
    const expiresAt = validDate(grant.expiresAt);
    return grant.tenantId === input.tenantId
      && grant.subjectUserId === input.subjectUserId
      && grant.targetType === input.targetType
      && grant.targetId === input.targetId
      && grant.status === 'active'
      && grant.scopes.includes(input.scope)
      && Boolean(expiresAt && expiresAt.getTime() > at.getTime());
  }

  async revoke(input: RevokeContentAccessGrantInput): Promise<ContentAccessGrant> {
    if (!nonEmpty(input.tenantId) || !nonEmpty(input.grantId) || !nonEmpty(input.revokedBy)
      || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new ContentAccessGrantInvariantError('CONTENT_ACCESS_GRANT_INVALID');
    }
    const result = await this.options.pool.query(`
      UPDATE ${this.grantsTable}
      SET status='revoked',revision=revision+1,revoked_by=$4
      WHERE tenant_id=$1 AND grant_id=$2 AND revision=$3 AND status='active'
      RETURNING *
    `, [input.tenantId, input.grantId, input.expectedRevision, input.revokedBy]);
    if (!result.rows[0]) {
      throw new ContentAccessGrantInvariantError('CONTENT_ACCESS_GRANT_VERSION_CONFLICT');
    }
    return rowToGrant(result.rows[0]);
  }
}
