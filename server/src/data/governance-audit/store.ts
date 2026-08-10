import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { PgGovernanceMigrationRunner, governanceTablePrefix } from '../governance-schema/index.js';
import type {
  GovernanceAuditAppendInput,
  GovernanceAuditEvent,
  GovernanceAuditMetadata,
  GovernanceAuditQuery,
  GovernanceAuditStore,
} from './types.js';

type PgPool = pg.Pool;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_NAME_PATTERN = /^[a-zA-Z0-9_.:-]{1,120}$/;
const FORBIDDEN_METADATA_KEY = /(secret|token|password|message|content|persona|memory|prompt|parameter|argument)/i;

function assertShortText(label: string, value: string, max: number): void {
  if (!value.trim() || value.length > max || /[\u0000]/.test(value)) {
    throw new Error(`Invalid governance audit ${label}`);
  }
}

function assertDigest(label: string, value: string | undefined): void {
  if (value !== undefined && !DIGEST_PATTERN.test(value)) {
    throw new Error(`Invalid governance audit ${label}`);
  }
}

function validateMetadata(metadata: GovernanceAuditMetadata): GovernanceAuditMetadata {
  const entries = Object.entries(metadata);
  if (entries.length > 32) throw new Error('Governance audit metadata has too many fields');
  for (const [key, value] of entries) {
    if (!SAFE_NAME_PATTERN.test(key) || FORBIDDEN_METADATA_KEY.test(key)) {
      throw new Error(`Unsafe governance audit metadata key: ${key}`);
    }
    if (typeof value === 'string' && (value.length > 500 || /[\u0000]/.test(value))) {
      throw new Error(`Invalid governance audit metadata value: ${key}`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`Invalid governance audit metadata number: ${key}`);
    }
  }
  return { ...metadata };
}

function normalizeEvent(input: GovernanceAuditAppendInput): GovernanceAuditEvent {
  if (!SAFE_NAME_PATTERN.test(input.action)) throw new Error('Invalid governance audit action');
  if (!SAFE_NAME_PATTERN.test(input.targetType)) throw new Error('Invalid governance audit targetType');
  assertShortText('actorUserId', input.actorUserId, 200);
  assertShortText('targetId', input.targetId, 1000);
  assertShortText('purpose', input.purpose, 200);
  if (input.reason !== undefined) assertShortText('reason', input.reason, 500);
  if (input.actorTenantId !== undefined) assertShortText('actorTenantId', input.actorTenantId, 120);
  if (input.targetTenantId !== undefined) assertShortText('targetTenantId', input.targetTenantId, 120);
  assertDigest('beforeDigest', input.beforeDigest);
  assertDigest('afterDigest', input.afterDigest);
  return {
    ...input,
    auditId: input.auditId ?? randomUUID(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    metadata: validateMetadata(input.metadata),
  };
}

export class InMemoryGovernanceAuditStore implements GovernanceAuditStore {
  readonly events: GovernanceAuditEvent[] = [];

  async append(input: GovernanceAuditAppendInput): Promise<GovernanceAuditEvent> {
    const event = normalizeEvent(input);
    this.events.push(event);
    return { ...event, metadata: { ...event.metadata } };
  }

  async list(query: GovernanceAuditQuery): Promise<GovernanceAuditEvent[]> {
    return this.events
      .filter(event => !query.targetTenantId || event.targetTenantId === query.targetTenantId)
      .filter(event => !query.before || event.occurredAt < query.before)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.auditId.localeCompare(a.auditId))
      .slice(0, query.limit)
      .map(event => ({ ...event, metadata: { ...event.metadata } }));
  }
}

export interface PgGovernanceAuditStoreOptions {
  pool: PgPool;
  tablePrefix?: string;
}

export class PgGovernanceAuditStore implements GovernanceAuditStore {
  readonly eventsTable: string;
  readonly schemaVersionsTable: string;

  constructor(private readonly options: PgGovernanceAuditStoreOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.eventsTable = `${prefix}_governance_audit_events`;
    this.schemaVersionsTable = `${prefix}_governance_schema_versions`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(
      this.options.pool,
      this.options.tablePrefix,
    ).run();
  }

  async append(input: GovernanceAuditAppendInput): Promise<GovernanceAuditEvent> {
    const event = normalizeEvent(input);
    await this.options.pool.query(`
      INSERT INTO ${this.eventsTable} (
        audit_id, correlation_id, change_id,
        actor_type, actor_user_id, actor_persona, actor_tenant_id,
        action, target_type, target_id, target_tenant_id,
        purpose, reason, before_digest, after_digest,
        result, occurred_at, metadata_json
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17::timestamptz, $18::jsonb
      )
      ON CONFLICT (audit_id) DO NOTHING
    `, [
      event.auditId,
      event.correlationId,
      event.changeId ?? null,
      event.actorType,
      event.actorUserId,
      event.actorPersona,
      event.actorTenantId ?? null,
      event.action,
      event.targetType,
      event.targetId,
      event.targetTenantId ?? null,
      event.purpose,
      event.reason ?? null,
      event.beforeDigest ?? null,
      event.afterDigest ?? null,
      event.result,
      event.occurredAt,
      JSON.stringify(event.metadata),
    ]);
    return event;
  }

  async list(query: GovernanceAuditQuery): Promise<GovernanceAuditEvent[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.targetTenantId) {
      params.push(query.targetTenantId);
      conditions.push(`target_tenant_id = $${params.length}`);
    }
    if (query.before) {
      params.push(query.before);
      conditions.push(`occurred_at < $${params.length}::timestamptz`);
    }
    params.push(query.limit);
    const result = await this.options.pool.query(`
      SELECT * FROM ${this.eventsTable}
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC, audit_id DESC
      LIMIT $${params.length}
    `, params);
    return result.rows.map(rowToAuditEvent);
  }
}

function rowToAuditEvent(row: Record<string, unknown>): GovernanceAuditEvent {
  const occurredAt = row.occurred_at;
  return {
    auditId: String(row.audit_id),
    correlationId: String(row.correlation_id),
    ...(row.change_id ? { changeId: String(row.change_id) } : {}),
    actorType: row.actor_type as GovernanceAuditEvent['actorType'],
    actorUserId: String(row.actor_user_id),
    actorPersona: row.actor_persona as GovernanceAuditEvent['actorPersona'],
    ...(row.actor_tenant_id ? { actorTenantId: String(row.actor_tenant_id) } : {}),
    action: String(row.action),
    targetType: String(row.target_type),
    targetId: String(row.target_id),
    ...(row.target_tenant_id ? { targetTenantId: String(row.target_tenant_id) } : {}),
    purpose: String(row.purpose),
    ...(row.reason ? { reason: String(row.reason) } : {}),
    ...(row.before_digest ? { beforeDigest: String(row.before_digest) } : {}),
    ...(row.after_digest ? { afterDigest: String(row.after_digest) } : {}),
    result: row.result as GovernanceAuditEvent['result'],
    occurredAt: occurredAt instanceof Date ? occurredAt.toISOString() : String(occurredAt),
    metadata: (row.metadata_json && typeof row.metadata_json === 'object'
      ? row.metadata_json
      : {}) as GovernanceAuditMetadata,
  };
}
