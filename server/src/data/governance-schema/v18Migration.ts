export interface GovernanceV18Tables {
  prefix: string;
  changeJobs: string;
  changeJobDomains: string;
  assignments: string;
  directoryGroups: string;
  directoryGroupMembers: string;
  memberships: string;
  oauthGrants: string;
  oauthApprovalRecords: string;
  nativeOAuthHandoffs: string;
}

export function governanceV18Statements(t: GovernanceV18Tables): string[] {
  const { prefix, changeJobs, changeJobDomains, assignments, directoryGroups, directoryGroupMembers, memberships,
    oauthGrants, oauthApprovalRecords, nativeOAuthHandoffs } = t;
  return [
    `ALTER TABLE ${changeJobDomains}
      ADD COLUMN IF NOT EXISTS unresolved_items_json JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `DO $$ DECLARE constraint_name TEXT; BEGIN
      SELECT conname INTO constraint_name FROM pg_constraint
      WHERE conrelid='${changeJobs}'::regclass AND contype='c'
        AND pg_get_constraintdef(oid) LIKE '%status%retry_wait%succeeded%failed%';
      IF constraint_name IS NOT NULL
        AND pg_get_constraintdef((SELECT oid FROM pg_constraint
          WHERE conrelid='${changeJobs}'::regclass AND conname=constraint_name)) NOT LIKE '%partial%'
      THEN
        EXECUTE format('ALTER TABLE ${changeJobs} DROP CONSTRAINT %I', constraint_name);
        ALTER TABLE ${changeJobs} ADD CONSTRAINT ${changeJobs}_status_check
          CHECK (status IN ('pending','running','retry_wait','succeeded','partial','failed'));
      END IF;
    END $$`,
    `DO $$ DECLARE constraint_name TEXT; BEGIN
      SELECT conname INTO constraint_name FROM pg_constraint
      WHERE conrelid='${assignments}'::regclass AND contype='c'
        AND pg_get_constraintdef(oid) LIKE '%resource_type%org_knowledge%';
      IF constraint_name IS NOT NULL
        AND pg_get_constraintdef((SELECT oid FROM pg_constraint
          WHERE conrelid='${assignments}'::regclass AND conname=constraint_name)) NOT LIKE '%connector%'
      THEN
        EXECUTE format('ALTER TABLE ${assignments} DROP CONSTRAINT %I', constraint_name);
        ALTER TABLE ${assignments} ADD CONSTRAINT ${assignments}_resource_type_check CHECK (
          resource_type IN ('org_agent','skill','credential','environment_template','org_knowledge','connector')
        );
      END IF;
    END $$`,
    `DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM ${changeJobs} WHERE status IN ('pending','running','retry_wait')
        GROUP BY tenant_id,job_type,target_type,target_id HAVING COUNT(*) > 1
      ) THEN RAISE EXCEPTION 'CHANGE_JOB_ACTIVE_TARGET_DUPLICATE'; END IF;
    END $$`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${changeJobs}_active_target_unique ON ${changeJobs}
      (tenant_id,job_type,target_type,target_id) WHERE status IN ('pending','running','retry_wait')`,
    `CREATE TABLE IF NOT EXISTS ${directoryGroups} (
      group_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, external_group_id TEXT,
      source TEXT NOT NULL CHECK (source IN ('dingtalk','governance')),
      display_name TEXT NOT NULL, parent_group_id TEXT, version BIGINT NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK (status IN ('active','disabled')),
      source_revision TEXT, projected_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id,source,external_group_id), UNIQUE (tenant_id,group_id),
      CHECK (parent_group_id IS NULL OR parent_group_id <> group_id),
      FOREIGN KEY (tenant_id,parent_group_id) REFERENCES ${directoryGroups}(tenant_id,group_id))`,
    `CREATE INDEX IF NOT EXISTS ${directoryGroups}_tenant_idx
      ON ${directoryGroups} (tenant_id,status,display_name,group_id)`,
    `CREATE OR REPLACE FUNCTION ${prefix}_assert_directory_group_acyclic() RETURNS TRIGGER AS $$
    DECLARE current_parent TEXT; BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id,0));
      SELECT parent_group_id INTO current_parent FROM ${directoryGroups}
        WHERE tenant_id=NEW.tenant_id AND group_id=NEW.group_id;
      IF NOT FOUND OR current_parent IS NULL THEN RETURN NEW; END IF;
      IF EXISTS (WITH RECURSIVE ancestors(group_id,parent_group_id,visited,cycle) AS (
        SELECT g.group_id,g.parent_group_id,ARRAY[g.group_id],g.group_id=NEW.group_id
          FROM ${directoryGroups} g WHERE g.tenant_id=NEW.tenant_id AND g.group_id=current_parent
        UNION ALL
        SELECT g.group_id,g.parent_group_id,a.visited||g.group_id,
          g.group_id=NEW.group_id OR g.group_id=ANY(a.visited)
          FROM ${directoryGroups} g JOIN ancestors a
            ON g.tenant_id=NEW.tenant_id AND g.group_id=a.parent_group_id WHERE NOT a.cycle
      ) SELECT 1 FROM ancestors WHERE cycle)
      THEN RAISE EXCEPTION 'DIRECTORY_GROUP_CYCLE' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`,
    `CREATE CONSTRAINT TRIGGER ${prefix}_directory_group_acyclic AFTER INSERT OR UPDATE
      ON ${directoryGroups} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION ${prefix}_assert_directory_group_acyclic()`,
    `CREATE TABLE IF NOT EXISTS ${directoryGroupMembers} (
      tenant_id TEXT NOT NULL, group_id TEXT NOT NULL, user_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('dingtalk','governance')), version BIGINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id,group_id,user_id), FOREIGN KEY (tenant_id,group_id)
        REFERENCES ${directoryGroups}(tenant_id,group_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id,user_id) REFERENCES ${memberships}(tenant_id,user_id) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS ${directoryGroupMembers}_user_idx
      ON ${directoryGroupMembers} (tenant_id,user_id,group_id)`,
    `CREATE TABLE IF NOT EXISTS ${oauthGrants} (
      grant_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      provider TEXT NOT NULL, connector_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('active','expired','revoked','error')),
      scope_summary_json JSONB NOT NULL DEFAULT '[]'::jsonb, approved_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, version BIGINT NOT NULL DEFAULT 1,
      revocation_stage TEXT CHECK (revocation_stage IS NULL OR revocation_stage IN
        ('local_blocked','provider_revoking','provider_revoked','local_finalized')),
      revocation_attempt INTEGER NOT NULL DEFAULT 0, revocation_next_retry_at TIMESTAMPTZ,
      revocation_last_error_code TEXT, revocation_requested_by TEXT, revocation_purpose TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (grant_id,tenant_id,subject_user_id),
      FOREIGN KEY (tenant_id,subject_user_id) REFERENCES ${memberships}(tenant_id,user_id))`,
    `CREATE INDEX IF NOT EXISTS ${oauthGrants}_subject_idx
      ON ${oauthGrants} (tenant_id,subject_user_id,status,provider,grant_id)`,
    `CREATE INDEX IF NOT EXISTS ${oauthGrants}_revocation_retry_idx
      ON ${oauthGrants} (revocation_next_retry_at,grant_id)
      WHERE revocation_stage IN ('local_blocked','provider_revoking','provider_revoked')`,
    `CREATE TABLE IF NOT EXISTS ${oauthApprovalRecords} (
      approval_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('approved','revoked','expired','refreshed')),
      scope_summary_json JSONB NOT NULL DEFAULT '[]'::jsonb, purpose TEXT NOT NULL,
      actor_user_id TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (grant_id,tenant_id,subject_user_id)
        REFERENCES ${oauthGrants}(grant_id,tenant_id,subject_user_id) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS ${oauthApprovalRecords}_grant_idx
      ON ${oauthApprovalRecords} (tenant_id,subject_user_id,grant_id,occurred_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${nativeOAuthHandoffs} (
      provider_state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
      connector_id TEXT NOT NULL, device_hash TEXT NOT NULL, request_expires_at TIMESTAMPTZ NOT NULL,
      code_hash TEXT UNIQUE, code_expires_at TIMESTAMPTZ,
      status TEXT CHECK (status IS NULL OR status IN ('succeeded','failed')), error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (tenant_id,user_id) REFERENCES ${memberships}(tenant_id,user_id) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS ${nativeOAuthHandoffs}_expiry_idx
      ON ${nativeOAuthHandoffs} (COALESCE(code_expires_at,request_expires_at))`,
  ];
}
