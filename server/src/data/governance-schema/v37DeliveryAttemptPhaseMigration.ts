export function governanceV37DeliveryAttemptPhaseStatements(prefix: string): string[] {
  const deliveries = `${prefix}_agent_dws_delivery_intents`;
  return [
    `ALTER TABLE ${deliveries} ADD COLUMN IF NOT EXISTS provider_started_at TIMESTAMPTZ`,
    `ALTER TABLE ${deliveries} ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ`,
    `ALTER TABLE ${deliveries} ADD COLUMN IF NOT EXISTS provider_attempt_phase TEXT
      NOT NULL DEFAULT 'legacy_unknown'`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid='${deliveries}'::regclass
          AND contype='c' AND pg_get_constraintdef(oid) LIKE '%provider_attempt_phase%') THEN
        ALTER TABLE ${deliveries} ADD CONSTRAINT ${prefix}_dwsd_phase_ck
          CHECK (provider_attempt_phase IN ('legacy_unknown','before_provider','provider_started'));
      END IF;
    END $$`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_dwsd_due_idx
      ON ${deliveries}(next_attempt_at,created_at,delivery_id)
      WHERE delivery_state='pending'`,
  ];
}
