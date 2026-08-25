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
        CHECK (audit_status IN ('pending','delivering','retry_wait','delivered','dead_letter')),
      audit_attempt INTEGER NOT NULL DEFAULT 0 CHECK (audit_attempt >= 0),
      max_audit_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_audit_attempts >= 1),
      audit_lease_owner UUID,
      audit_lease_expires_at TIMESTAMPTZ,
      audit_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_audit_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_id, receipt_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${receipts}_tenant_retry_idx
      ON ${receipts} (tenant_id, audit_status, audit_next_attempt_at, audit_lease_expires_at, created_at)`,
    `CREATE INDEX IF NOT EXISTS ${receipts}_ready_idx
      ON ${receipts} (audit_status, audit_next_attempt_at, created_at)`,
  ];
}

/** Upgrade receipts created by the original retention migration without losing pending audit work. */
export function buildContextRetentionRetryMigrationSql(tablePrefix?: string): string[] {
  const { receipts } = contextRetentionTableNames(tablePrefix);
  return [
    `ALTER TABLE ${receipts} ADD COLUMN IF NOT EXISTS max_audit_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_audit_attempts >= 1)`,
    `ALTER TABLE ${receipts} ADD COLUMN IF NOT EXISTS audit_lease_owner UUID`,
    `ALTER TABLE ${receipts} ADD COLUMN IF NOT EXISTS audit_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `UPDATE ${receipts} SET audit_next_attempt_at=COALESCE(audit_next_attempt_at,created_at,NOW())
      WHERE audit_status IN ('pending','retry_wait')`,
    `DO $$ DECLARE constraint_name TEXT; BEGIN
      SELECT conname INTO constraint_name FROM pg_constraint
      WHERE conrelid='${receipts}'::regclass AND contype='c'
        AND pg_get_constraintdef(oid) LIKE '%audit_status%';
      IF constraint_name IS NOT NULL
        AND pg_get_constraintdef((SELECT oid FROM pg_constraint
          WHERE conrelid='${receipts}'::regclass AND conname=constraint_name)) NOT LIKE '%dead_letter%'
      THEN
        EXECUTE format('ALTER TABLE ${receipts} DROP CONSTRAINT %I', constraint_name);
        ALTER TABLE ${receipts} ADD CONSTRAINT ${receipts}_audit_status_check
          CHECK (audit_status IN ('pending','delivering','retry_wait','delivered','dead_letter'));
      END IF;
    END $$`,
    `CREATE INDEX IF NOT EXISTS ${receipts}_ready_idx
      ON ${receipts} (audit_status, audit_next_attempt_at, created_at)`,
  ];
}
