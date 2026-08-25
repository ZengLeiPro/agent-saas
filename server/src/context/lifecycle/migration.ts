import { contextTablePrefix } from '../store/migration.js';

export interface ContextRetentionTableNames {
  receipts: string;
}

export function contextRetentionTableNames(tablePrefix?: string): ContextRetentionTableNames {
  const prefix = contextTablePrefix(tablePrefix);
  return { receipts: `${prefix}_context_retention_receipts` };
}

export function buildContextRetentionMigrationSql(tablePrefix?: string): string[] {
  const { receipts } = contextRetentionTableNames(tablePrefix);
  return [
    `CREATE TABLE IF NOT EXISTS ${receipts} (
      tenant_id TEXT NOT NULL,
      receipt_id UUID NOT NULL,
      receipt_json JSONB NOT NULL,
      audit_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (audit_status IN ('pending','delivering','retry_wait','delivered')),
      audit_attempt INTEGER NOT NULL DEFAULT 0 CHECK (audit_attempt >= 0),
      audit_lease_expires_at TIMESTAMPTZ,
      last_audit_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, receipt_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${receipts}_tenant_retry_idx
      ON ${receipts} (tenant_id, audit_status, audit_lease_expires_at, created_at)`,
  ];
}
