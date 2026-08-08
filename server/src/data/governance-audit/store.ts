import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import type {
  GovernanceAuditAppendInput,
  GovernanceAuditEvent,
  GovernanceAuditMetadata,
  GovernanceAuditStore,
} from './types.js';

type PgPool = pg.Pool;

const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_NAME_PATTERN = /^[a-zA-Z0-9_.:-]{1,120}$/;
const FORBIDDEN_METADATA_KEY = /(secret|token|password|message|content|persona|memory|prompt|parameter|argument)/i;

function safeIdentifier(value: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) throw new Error(`Invalid PostgreSQL identifier: ${value}`);
  return value;
}

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
}

export interface PgGovernanceAuditStoreOptions {
  pool: PgPool;
  tablePrefix?: string;
}

export class PgGovernanceAuditStore implements GovernanceAuditStore {
  readonly eventsTable: string;
  readonly schemaVersionsTable: string;

  constructor(private readonly options: PgGovernanceAuditStoreOptions) {
    const prefix = safeIdentifier(options.tablePrefix ?? 'runtime');
    this.eventsTable = `${prefix}_governance_audit_events`;
    this.schemaVersionsTable = `${prefix}_governance_schema_versions`;
  }

  async init(): Promise<void> {
    await this.options.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.schemaVersionsTable} (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.options.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.eventsTable} (
        sequence BIGSERIAL UNIQUE NOT NULL,
        audit_id TEXT PRIMARY KEY,
        correlation_id TEXT NOT NULL,
        change_id TEXT,
        actor_type TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        actor_persona TEXT NOT NULL,
        actor_tenant_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_tenant_id TEXT,
        purpose TEXT NOT NULL,
        reason TEXT,
        before_digest TEXT,
        after_digest TEXT,
        result TEXT NOT NULL CHECK (result IN ('intent', 'succeeded', 'failed')),
        occurred_at TIMESTAMPTZ NOT NULL,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await this.options.pool.query(`
      CREATE INDEX IF NOT EXISTS ${this.eventsTable}_correlation_idx
      ON ${this.eventsTable} (correlation_id, sequence)
    `);
    await this.options.pool.query(`
      CREATE INDEX IF NOT EXISTS ${this.eventsTable}_target_idx
      ON ${this.eventsTable} (target_tenant_id, target_type, target_id, occurred_at DESC)
    `);
    await this.options.pool.query(`
      INSERT INTO ${this.schemaVersionsTable} (version)
      VALUES (1)
      ON CONFLICT (version) DO NOTHING
    `);
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
}
