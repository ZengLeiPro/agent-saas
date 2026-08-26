/** v30: durable domain execution order and deletion receipt evidence. */
export function governanceV30ChangeJobStatements(changeJobs: string, changeJobDomains: string): string[] {
  return [
    `ALTER TABLE ${changeJobDomains} ADD COLUMN IF NOT EXISTS receipt_json JSONB`,
    // Domain execution order is state-machine data, not a lexical presentation detail.
    // Existing generic jobs get a deterministic lexical backfill; active tenant deletion
    // jobs are explicitly aligned to TENANT_DELETE_DOMAINS below.
    `ALTER TABLE ${changeJobDomains} ADD COLUMN IF NOT EXISTS ordinal INTEGER`,
    `WITH ordered AS (
      SELECT job_id,domain,ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY domain)::integer AS ordinal
      FROM ${changeJobDomains} WHERE ordinal IS NULL
    ) UPDATE ${changeJobDomains} d SET ordinal=ordered.ordinal
      FROM ordered WHERE d.job_id=ordered.job_id AND d.domain=ordered.domain`,
    `UPDATE ${changeJobDomains} d SET ordinal=CASE d.domain
      WHEN 'tenant_freeze' THEN 1 WHEN 'legacy_resources' THEN 2 WHEN 'assignments' THEN 3
      WHEN 'agents_skills' THEN 4 WHEN 'credentials' THEN 5 WHEN 'memberships' THEN 6
      WHEN 'tenant_configuration' THEN 7 WHEN 'audit_retention' THEN 8
      WHEN 'deletion_verification' THEN 9 WHEN 'tenant_record' THEN 10
      ELSE d.ordinal END
      FROM ${changeJobs} j
      WHERE d.job_id=j.job_id AND j.job_type='tenant_delete'
        AND j.status IN ('pending','running','retry_wait')`,
    `INSERT INTO ${changeJobDomains} (job_id,domain,ordinal,status)
      SELECT j.job_id,'deletion_verification',9,'pending' FROM ${changeJobs} j
      WHERE j.job_type='tenant_delete' AND j.status IN ('pending','running','retry_wait')
      ON CONFLICT (job_id,domain) DO NOTHING`,
    `ALTER TABLE ${changeJobDomains} ALTER COLUMN ordinal SET NOT NULL`,
    `ALTER TABLE ${changeJobDomains}
      ADD CONSTRAINT ${changeJobDomains}_ordinal_check CHECK (ordinal > 0)`,
    `ALTER TABLE ${changeJobDomains}
      ADD CONSTRAINT ${changeJobDomains}_receipt_object_check
      CHECK (receipt_json IS NULL OR jsonb_typeof(receipt_json) = 'object')`,
  ];
}
