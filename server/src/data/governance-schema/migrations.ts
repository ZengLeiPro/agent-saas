import type pg from 'pg';
import { PLATFORM_TENANT_ID } from '../tenants/types.js';

export type GovernancePgPool = pg.Pool;

type GovernanceMigration = {
  version: number;
  statements: string[];
};

const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function governanceTablePrefix(value = 'runtime'): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Invalid PostgreSQL identifier: ${value}`);
  }
  return value;
}

function migrations(prefix: string): GovernanceMigration[] {
  const versions = `${prefix}_governance_schema_versions`;
  const audit = `${prefix}_governance_audit_events`;
  const memberships = `${prefix}_tenant_memberships`;
  const platformAdmins = `${prefix}_platform_admins`;
  const issues = `${prefix}_governance_migration_issues`;
  const entitlementSets = `${prefix}_tenant_entitlement_sets`;
  const entitlementScopes = `${prefix}_entitlement_resource_scopes`;
  const entitlementItems = `${prefix}_entitlement_resource_items`;
  const policies = `${prefix}_tenant_policies`;
  const assignmentSets = `${prefix}_resource_assignment_sets`;
  const assignments = `${prefix}_resource_assignments`;
  const preferences = `${prefix}_user_resource_preferences`;
  const runResolutionSnapshots = `${prefix}_run_resolution_snapshots`;
  const credentials = `${prefix}_credentials`;
  const connectorDefinitions = `${prefix}_connector_definitions`;
  const connectorVersions = `${prefix}_connector_definition_versions`;
  const executionProviders = `${prefix}_execution_providers`;
  const environmentTemplates = `${prefix}_environment_templates`;
  const environmentTemplateVersions = `${prefix}_environment_template_versions`;
  const resourceReferences = `${prefix}_resource_references`;
  const managedAgents = `${prefix}_managed_agents`;
  const managedAgentVersions = `${prefix}_managed_agent_versions`;
  const governedSkills = `${prefix}_governed_skills`;
  const governedSkillVersions = `${prefix}_governed_skill_versions`;
  const skillCandidates = `${prefix}_skill_candidates`;
  const changeJobs = `${prefix}_governance_change_jobs`;
  const changeJobDomains = `${prefix}_governance_change_job_domains`;
  const migrationControl = `${prefix}_governance_migration_control`;
  const migrationDomains = `${prefix}_governance_migration_domains`;
  const shadowDifferences = `${prefix}_governance_shadow_differences`;
  const contentAccessGrants = `${prefix}_content_access_grants`;
  const projectionOutbox = `${prefix}_governance_projection_outbox`;
  const environmentInstances = `${prefix}_environment_instances`;
  const guardrailEvents = `${prefix}_guardrail_events`;

  return [
    {
      version: 1,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${audit} (
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
        )`,
        `CREATE INDEX IF NOT EXISTS ${audit}_correlation_idx
          ON ${audit} (correlation_id, sequence)`,
        `CREATE INDEX IF NOT EXISTS ${audit}_target_idx
          ON ${audit} (target_tenant_id, target_type, target_id, occurred_at DESC)`,
      ],
    },
    {
      version: 2,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${memberships} (
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          persona TEXT NOT NULL CHECK (persona IN ('member', 'org_admin')),
          is_owner BOOLEAN NOT NULL DEFAULT FALSE,
          status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
          source TEXT NOT NULL CHECK (source IN ('legacy_projection', 'governance')),
          version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          PRIMARY KEY (tenant_id, user_id),
          UNIQUE (user_id),
          CHECK (NOT is_owner OR persona = 'org_admin')
        )`,
        `CREATE INDEX IF NOT EXISTS ${memberships}_tenant_status_idx
          ON ${memberships} (tenant_id, status, persona, is_owner)`,
        `CREATE TABLE IF NOT EXISTS ${platformAdmins} (
          user_id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
          source TEXT NOT NULL CHECK (source IN ('legacy_projection', 'governance')),
          version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS ${platformAdmins}_status_idx
          ON ${platformAdmins} (status)`,
        `CREATE TABLE IF NOT EXISTS ${issues} (
          issue_id TEXT PRIMARY KEY,
          issue_type TEXT NOT NULL,
          tenant_id TEXT,
          resource_type TEXT,
          resource_id TEXT,
          legacy_key TEXT,
          detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
          version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          resolved_at TIMESTAMPTZ,
          resolved_by TEXT
        )`,
        `CREATE UNIQUE INDEX IF NOT EXISTS ${issues}_open_identity_uidx
          ON ${issues} (
            issue_type,
            COALESCE(tenant_id, ''),
            COALESCE(resource_type, ''),
            COALESCE(resource_id, ''),
            COALESCE(legacy_key, '')
          ) WHERE status = 'open'`,
        `CREATE INDEX IF NOT EXISTS ${issues}_tenant_status_idx
          ON ${issues} (tenant_id, status, issue_type, created_at)`,
      ],
    },
    {
      version: 3,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${entitlementSets} (
          tenant_id TEXT PRIMARY KEY,
          source TEXT NOT NULL CHECK (source IN ('plan_default', 'platform_override', 'legacy_migrated')),
          status TEXT NOT NULL CHECK (status IN ('trial', 'active', 'suspended', 'expired')),
          effective_from TIMESTAMPTZ,
          effective_to TIMESTAMPTZ,
          limits_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          update_reason TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS ${entitlementSets}_status_idx
          ON ${entitlementSets} (status, effective_to)`,
        `CREATE TABLE IF NOT EXISTS ${entitlementScopes} (
          tenant_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('all', 'selected')),
          source TEXT NOT NULL CHECK (source IN ('legacy_projection', 'governance')),
          version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          PRIMARY KEY (tenant_id, resource_type)
        )`,
        `CREATE TABLE IF NOT EXISTS ${entitlementItems} (
          tenant_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('legacy_projection', 'governance')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          PRIMARY KEY (tenant_id, resource_type, resource_id),
          FOREIGN KEY (tenant_id, resource_type)
            REFERENCES ${entitlementScopes}(tenant_id, resource_type)
            ON DELETE CASCADE
        )`,
        `CREATE INDEX IF NOT EXISTS ${entitlementItems}_resource_idx
          ON ${entitlementItems} (resource_type, resource_id, tenant_id)`,
        `CREATE TABLE IF NOT EXISTS ${policies} (
          tenant_id TEXT NOT NULL,
          policy_key TEXT NOT NULL,
          value_json JSONB NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('legacy_projection', 'governance')),
          version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          PRIMARY KEY (tenant_id, policy_key)
        )`,
        `CREATE INDEX IF NOT EXISTS ${policies}_key_idx
          ON ${policies} (policy_key, tenant_id)`,
      ],
    },
    {
      version: 4,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${assignmentSets} (
          tenant_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('legacy_projection', 'governance')),
          version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          PRIMARY KEY (tenant_id, resource_type, resource_id)
        )`,
        `CREATE TABLE IF NOT EXISTS ${assignments} (
          assignment_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          resource_type TEXT NOT NULL CHECK (
            resource_type IN ('org_agent', 'skill', 'credential', 'environment_template', 'org_knowledge')
          ),
          resource_id TEXT NOT NULL,
          assignee_type TEXT NOT NULL CHECK (
            assignee_type IN ('everyone', 'user', 'directory_group', 'agent')
          ),
          assignee_id TEXT,
          effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
          origin TEXT NOT NULL CHECK (origin IN ('direct', 'migration', 'policy_default')),
          version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          FOREIGN KEY (tenant_id, resource_type, resource_id)
            REFERENCES ${assignmentSets}(tenant_id, resource_type, resource_id)
            ON DELETE CASCADE,
          CHECK (
            (assignee_type = 'everyone' AND assignee_id IS NULL)
            OR (assignee_type <> 'everyone' AND assignee_id IS NOT NULL AND assignee_id <> '')
          )
        )`,
        `CREATE UNIQUE INDEX IF NOT EXISTS ${assignments}_identity_uidx
          ON ${assignments} (
            tenant_id, resource_type, resource_id, assignee_type, COALESCE(assignee_id, '')
          )`,
        `CREATE INDEX IF NOT EXISTS ${assignments}_assignee_idx
          ON ${assignments} (tenant_id, assignee_type, assignee_id, resource_type)`,
        `CREATE TABLE IF NOT EXISTS ${preferences} (
          user_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          enabled BOOLEAN NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('legacy_projection', 'user')),
          version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, resource_type, resource_id)
        )`,
        `CREATE INDEX IF NOT EXISTS ${preferences}_resource_idx
          ON ${preferences} (resource_type, resource_id, user_id)`,
      ],
    },
    {
      version: 5,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${runResolutionSnapshots} (
          run_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          tenant_id TEXT,
          subject_type TEXT NOT NULL CHECK (subject_type IN ('human', 'service')),
          subject_id TEXT NOT NULL,
          access_decision_id TEXT NOT NULL,
          enforcement_mode TEXT NOT NULL CHECK (enforcement_mode IN ('shadow', 'enforce')),
          access_verdict TEXT NOT NULL CHECK (access_verdict IN ('allow', 'deny', 'conditional')),
          readiness_ready BOOLEAN NOT NULL,
          snapshot_digest TEXT NOT NULL,
          snapshot_json JSONB NOT NULL,
          snapshot_sequence BIGSERIAL UNIQUE NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS ${runResolutionSnapshots}_tenant_created_idx
          ON ${runResolutionSnapshots} (tenant_id, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS ${runResolutionSnapshots}_decision_idx
          ON ${runResolutionSnapshots} (access_decision_id)`,
      ],
    },
    {
      version: 6,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${credentials} (
          credential_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          connector_id TEXT,
          kind TEXT NOT NULL CHECK (kind IN ('org_shared', 'personal_grant', 'infrastructure')),
          owner_user_id TEXT,
          custodian_user_id TEXT,
          owner_username TEXT,
          alias TEXT,
          purpose TEXT NOT NULL,
          scope_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          status TEXT NOT NULL CHECK (
            status IN ('active', 'rotation_due', 'expired', 'suspended', 'revoked', 'validation_failed')
          ),
          generation BIGINT NOT NULL DEFAULT 1 CHECK (generation >= 1),
          secret_ref TEXT NOT NULL,
          expires_at TIMESTAMPTZ,
          last_validated_at TIMESTAMPTZ,
          source TEXT NOT NULL CHECK (source IN ('legacy_projection', 'governance')),
          version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          CHECK (kind <> 'personal_grant' OR owner_user_id IS NOT NULL),
          CHECK (kind <> 'org_shared' OR custodian_user_id IS NOT NULL)
        )`,
        `CREATE UNIQUE INDEX IF NOT EXISTS ${credentials}_secret_ref_uidx
          ON ${credentials} (secret_ref)`,
        `CREATE INDEX IF NOT EXISTS ${credentials}_owner_idx
          ON ${credentials} (tenant_id, owner_user_id, status)`,
        `CREATE INDEX IF NOT EXISTS ${credentials}_connector_idx
          ON ${credentials} (tenant_id, connector_id, status)`,
      ],
    },
    {
      version: 7,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${connectorDefinitions} (
          connector_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'disabled', 'retired')),
          current_version_id TEXT,
          auth_methods_json JSONB NOT NULL DEFAULT '[]'::jsonb,
          capability_schema_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS ${connectorVersions} (
          version_id TEXT PRIMARY KEY,
          connector_id TEXT NOT NULL REFERENCES ${connectorDefinitions}(connector_id),
          version_number BIGINT NOT NULL CHECK (version_number >= 1),
          definition_json JSONB NOT NULL,
          digest TEXT NOT NULL,
          published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          published_by TEXT NOT NULL,
          UNIQUE (connector_id, version_number),
          UNIQUE (connector_id, digest)
        )`,
        `ALTER TABLE ${connectorDefinitions}
          ADD CONSTRAINT ${connectorDefinitions}_current_version_fk
          FOREIGN KEY (current_version_id) REFERENCES ${connectorVersions}(version_id)
          DEFERRABLE INITIALLY DEFERRED`,
        `CREATE INDEX IF NOT EXISTS ${connectorDefinitions}_status_idx
          ON ${connectorDefinitions} (status, connector_id)`,
      ],
    },
    {
      version: 8,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${executionProviders} (
          provider_id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('enabled', 'draining', 'disabled')),
          endpoint_ref TEXT NOT NULL,
          network_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          infrastructure_credential_id TEXT,
          rollout_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS ${environmentTemplates} (
          template_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
          current_version_id TEXT,
          revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS ${environmentTemplateVersions} (
          version_id TEXT PRIMARY KEY,
          template_id TEXT NOT NULL REFERENCES ${environmentTemplates}(template_id),
          version_number BIGINT NOT NULL CHECK (version_number >= 1),
          recipe_json JSONB NOT NULL,
          digest TEXT NOT NULL,
          published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          published_by TEXT NOT NULL,
          UNIQUE (template_id, version_number),
          UNIQUE (template_id, digest)
        )`,
        `ALTER TABLE ${environmentTemplates}
          ADD CONSTRAINT ${environmentTemplates}_current_version_fk
          FOREIGN KEY (current_version_id) REFERENCES ${environmentTemplateVersions}(version_id)
          DEFERRABLE INITIALLY DEFERRED`,
        `CREATE TABLE IF NOT EXISTS ${resourceReferences} (
          reference_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_version TEXT,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          target_version TEXT,
          relation TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          UNIQUE (tenant_id, source_type, source_id, target_type, target_id, relation)
        )`,
        `CREATE INDEX IF NOT EXISTS ${resourceReferences}_target_idx
          ON ${resourceReferences} (target_type, target_id, tenant_id)`,
        `CREATE INDEX IF NOT EXISTS ${resourceReferences}_source_idx
          ON ${resourceReferences} (source_type, source_id)`,
      ],
    },
    {
      version: 9,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${managedAgents} (
          agent_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('org_agent', 'personal_agent', 'agent_template')),
          owner_user_id TEXT NOT NULL,
          template_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('draft', 'enabled', 'disabled', 'archived')),
          current_version_id TEXT,
          revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          archived_at TIMESTAMPTZ,
          archived_by TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS ${managedAgentVersions} (
          version_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES ${managedAgents}(agent_id),
          version_number BIGINT NOT NULL CHECK (version_number >= 1),
          definition_json JSONB NOT NULL,
          digest TEXT NOT NULL,
          published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          published_by TEXT NOT NULL,
          UNIQUE (agent_id, version_number),
          UNIQUE (agent_id, digest),
          UNIQUE (agent_id, version_id)
        )`,
        `ALTER TABLE ${managedAgents}
          ADD CONSTRAINT ${managedAgents}_current_version_fk
          FOREIGN KEY (agent_id, current_version_id) REFERENCES ${managedAgentVersions}(agent_id, version_id)
          DEFERRABLE INITIALLY DEFERRED`,
        `CREATE INDEX IF NOT EXISTS ${managedAgents}_tenant_status_idx
          ON ${managedAgents} (tenant_id, kind, status)`,
        `CREATE INDEX IF NOT EXISTS ${managedAgents}_owner_idx
          ON ${managedAgents} (owner_user_id, kind, status)`,
      ],
    },
    {
      version: 10,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${governedSkills} (
          skill_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('platform', 'tenant', 'personal')),
          owner_user_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
          current_version_id TEXT,
          revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          CHECK (scope <> 'personal' OR owner_user_id IS NOT NULL),
          UNIQUE (tenant_id, skill_id)
        )`,
        `CREATE TABLE IF NOT EXISTS ${governedSkillVersions} (
          version_id TEXT PRIMARY KEY,
          skill_id TEXT NOT NULL REFERENCES ${governedSkills}(skill_id),
          version_number BIGINT NOT NULL CHECK (version_number >= 1),
          definition_json JSONB NOT NULL,
          digest TEXT NOT NULL,
          source_candidate_id TEXT,
          published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          published_by TEXT NOT NULL,
          UNIQUE (skill_id, version_number),
          UNIQUE (skill_id, digest),
          UNIQUE (skill_id, version_id)
        )`,
        `CREATE TABLE IF NOT EXISTS ${skillCandidates} (
          candidate_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          target_skill_id TEXT NOT NULL,
          definition_json JSONB NOT NULL,
          digest TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'published')),
          revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
          submitted_at TIMESTAMPTZ,
          reviewed_at TIMESTAMPTZ,
          reviewed_by TEXT,
          review_reason TEXT,
          published_version_id TEXT REFERENCES ${governedSkillVersions}(version_id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          FOREIGN KEY (tenant_id, target_skill_id) REFERENCES ${governedSkills}(tenant_id, skill_id)
        )`,
        `ALTER TABLE ${governedSkills}
          ADD CONSTRAINT ${governedSkills}_current_version_fk
          FOREIGN KEY (skill_id, current_version_id) REFERENCES ${governedSkillVersions}(skill_id, version_id)
          DEFERRABLE INITIALLY DEFERRED`,
        `ALTER TABLE ${governedSkillVersions}
          ADD CONSTRAINT ${governedSkillVersions}_candidate_fk
          FOREIGN KEY (source_candidate_id) REFERENCES ${skillCandidates}(candidate_id)
          DEFERRABLE INITIALLY DEFERRED`,
        `CREATE INDEX IF NOT EXISTS ${governedSkills}_tenant_status_idx
          ON ${governedSkills} (tenant_id, scope, status)`,
        `CREATE INDEX IF NOT EXISTS ${skillCandidates}_review_queue_idx
          ON ${skillCandidates} (tenant_id, status, submitted_at)`,
        `CREATE INDEX IF NOT EXISTS ${skillCandidates}_owner_idx
          ON ${skillCandidates} (owner_user_id, status, updated_at)`,
      ],
    },
    {
      version: 11,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${changeJobs} (
          job_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          job_type TEXT NOT NULL CHECK (job_type IN ('tenant_delete', 'resource_retire', 'credential_revoke')),
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'retry_wait', 'succeeded', 'failed')),
          revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
          attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
          last_error_code TEXT,
          next_retry_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          completed_at TIMESTAMPTZ,
          UNIQUE (tenant_id, job_type, idempotency_key)
        )`,
        `CREATE TABLE IF NOT EXISTS ${changeJobDomains} (
          job_id TEXT NOT NULL REFERENCES ${changeJobs}(job_id),
          domain TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
          total_count BIGINT NOT NULL DEFAULT 0 CHECK (total_count >= 0),
          completed_count BIGINT NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
          failed_count BIGINT NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
          revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_error_code TEXT,
          PRIMARY KEY (job_id, domain),
          CHECK (completed_count + failed_count <= total_count)
        )`,
        `CREATE INDEX IF NOT EXISTS ${changeJobs}_claim_idx
          ON ${changeJobs} (status, next_retry_at, updated_at)`,
        `CREATE INDEX IF NOT EXISTS ${changeJobs}_tenant_idx
          ON ${changeJobs} (tenant_id, job_type, created_at)`,
      ],
    },
    {
      version: 12,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${migrationControl} (
          control_id TEXT PRIMARY KEY CHECK (control_id='global'),
          mode TEXT NOT NULL CHECK (mode IN ('shadow', 'enforce', 'rollback')),
          write_authority TEXT NOT NULL CHECK (write_authority IN ('legacy', 'dual', 'governance')),
          legacy_writes_sealed BOOLEAN NOT NULL DEFAULT FALSE,
          compatibility_projection_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          rollback_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          update_reason TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS ${migrationDomains} (
          domain TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('shadow', 'ready', 'enforced', 'rollback')),
          compared_count BIGINT NOT NULL DEFAULT 0 CHECK (compared_count >= 0),
          matched_count BIGINT NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
          difference_count BIGINT NOT NULL DEFAULT 0 CHECK (difference_count >= 0),
          unresolved_blocking_count BIGINT NOT NULL DEFAULT 0 CHECK (unresolved_blocking_count >= 0),
          revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
          last_compared_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          CHECK (matched_count + difference_count = compared_count)
        )`,
        `CREATE TABLE IF NOT EXISTS ${shadowDifferences} (
          difference_id TEXT PRIMARY KEY,
          domain TEXT NOT NULL REFERENCES ${migrationDomains}(domain),
          tenant_scope TEXT NOT NULL DEFAULT '',
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          category TEXT NOT NULL CHECK (category IN (
            'missing_legacy','missing_governance','value_mismatch','ambiguous_identity','comparison_error'
          )),
          legacy_digest TEXT,
          governance_digest TEXT,
          blocking BOOLEAN NOT NULL DEFAULT TRUE,
          status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'resolved')),
          first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          resolved_at TIMESTAMPTZ,
          resolved_by TEXT,
          resolution_reason TEXT,
          UNIQUE (domain, tenant_scope, resource_type, resource_id, category)
        )`,
        `CREATE INDEX IF NOT EXISTS ${shadowDifferences}_blocking_idx
          ON ${shadowDifferences} (status, blocking, domain, tenant_scope)`,
      ],
    },
    {
      version: 13,
      statements: [
        `ALTER TABLE ${changeJobs} DROP CONSTRAINT IF EXISTS ${changeJobs}_job_type_check`,
        `ALTER TABLE ${changeJobs} ADD CONSTRAINT ${changeJobs}_job_type_check
          CHECK (job_type IN ('tenant_delete', 'resource_retire', 'credential_revoke', 'user_offboarding'))`,
        `CREATE TABLE IF NOT EXISTS ${contentAccessGrants} (
          grant_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          subject_user_id TEXT NOT NULL,
          scopes TEXT[] NOT NULL,
          purpose TEXT NOT NULL,
          reason_code TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
          revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
          created_by TEXT NOT NULL,
          revoked_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (cardinality(scopes) > 0)
        )`,
        `CREATE INDEX IF NOT EXISTS ${contentAccessGrants}_authorize_idx
          ON ${contentAccessGrants} (tenant_id, subject_user_id, status, expires_at)`,
        `CREATE TABLE IF NOT EXISTS ${projectionOutbox} (
          outbox_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          projector TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          payload_json JSONB NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'retry_wait', 'succeeded', 'failed')),
          attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
          max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts >= 1),
          lease_fence BIGINT NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
          lease_owner TEXT,
          lease_expires_at TIMESTAMPTZ,
          next_attempt_at TIMESTAMPTZ,
          last_error_code TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ,
          UNIQUE (tenant_id, projector, idempotency_key)
        )`,
        `CREATE INDEX IF NOT EXISTS ${projectionOutbox}_claim_idx
          ON ${projectionOutbox} (status, next_attempt_at, lease_expires_at, created_at)`,
        `CREATE TABLE IF NOT EXISTS ${environmentInstances} (
          instance_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          provider_id TEXT NOT NULL REFERENCES ${executionProviders}(provider_id),
          template_id TEXT NOT NULL REFERENCES ${environmentTemplates}(template_id),
          template_version_id TEXT NOT NULL REFERENCES ${environmentTemplateVersions}(version_id),
          hand_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('provisioning', 'ready', 'unhealthy', 'draining', 'retired')),
          lease_expires_at TIMESTAMPTZ NOT NULL,
          revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
          recipe_digest TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (tenant_id, instance_id),
          UNIQUE (tenant_id, hand_id)
        )`,
        `CREATE INDEX IF NOT EXISTS ${environmentInstances}_lease_idx
          ON ${environmentInstances} (tenant_id, status, lease_expires_at)`,
        `DO $$ BEGIN
          IF to_regclass('${guardrailEvents}') IS NOT NULL THEN
            EXECUTE 'UPDATE ${guardrailEvents} SET message_text = ''[redacted:legacy]'' WHERE message_text NOT LIKE ''[redacted:%]''';
          END IF;
        END $$`,
      ],
    },
    {
      version: 14,
      statements: [
        `ALTER TABLE ${migrationDomains}
          ADD COLUMN IF NOT EXISTS last_batch_total BIGINT NOT NULL DEFAULT 0 CHECK (last_batch_total >= 0)`,
        `ALTER TABLE ${migrationDomains}
          ADD COLUMN IF NOT EXISTS last_batch_matched BIGINT NOT NULL DEFAULT 0 CHECK (last_batch_matched >= 0)`,
        `ALTER TABLE ${migrationDomains}
          ADD COLUMN IF NOT EXISTS last_batch_differences BIGINT NOT NULL DEFAULT 0 CHECK (last_batch_differences >= 0)`,
        `ALTER TABLE ${migrationDomains}
          ADD COLUMN IF NOT EXISTS last_batch_at TIMESTAMPTZ`,
      ],
    },
    {
      version: 15,
      statements: [
        `ALTER TABLE ${contentAccessGrants} ADD COLUMN IF NOT EXISTS target_type TEXT`,
        `ALTER TABLE ${contentAccessGrants} ADD COLUMN IF NOT EXISTS target_id TEXT`,
        `UPDATE ${contentAccessGrants}
          SET status='revoked',target_type='guardrail_collection',target_id=tenant_id
          WHERE target_type IS NULL OR target_id IS NULL`,
        `ALTER TABLE ${contentAccessGrants} ALTER COLUMN target_type SET NOT NULL`,
        `ALTER TABLE ${contentAccessGrants} ALTER COLUMN target_id SET NOT NULL`,
        `ALTER TABLE ${contentAccessGrants} DROP CONSTRAINT IF EXISTS ${contentAccessGrants}_target_type_check`,
        `ALTER TABLE ${contentAccessGrants} ADD CONSTRAINT ${contentAccessGrants}_target_type_check
          CHECK (target_type IN ('session','guardrail_collection'))`,
        `CREATE INDEX IF NOT EXISTS ${contentAccessGrants}_target_idx
          ON ${contentAccessGrants} (tenant_id,subject_user_id,target_type,target_id,status,expires_at)`,
      ],
    },
    {
      version: 16,
      statements: [
        `ALTER TABLE ${runResolutionSnapshots} ADD COLUMN IF NOT EXISTS snapshot_sequence BIGSERIAL`,
        `CREATE UNIQUE INDEX IF NOT EXISTS ${runResolutionSnapshots}_sequence_idx
          ON ${runResolutionSnapshots} (snapshot_sequence)`,
        `ALTER TABLE ${runResolutionSnapshots} DROP CONSTRAINT IF EXISTS ${runResolutionSnapshots}_pkey`,
        `ALTER TABLE ${runResolutionSnapshots} ADD PRIMARY KEY (run_id,snapshot_digest)`,
        `CREATE INDEX IF NOT EXISTS ${runResolutionSnapshots}_latest_idx ON ${runResolutionSnapshots} (run_id,snapshot_sequence DESC)`,
      ],
    },
    {
      version: 17,
      statements: [
        `DROP INDEX IF EXISTS ${runResolutionSnapshots}_latest_idx`,
        `CREATE INDEX ${runResolutionSnapshots}_latest_idx
          ON ${runResolutionSnapshots} (run_id,snapshot_sequence DESC)`,
        `DO $$ DECLARE c RECORD; BEGIN
          FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid='${migrationDomains}'::regclass
              AND contype='c'
              AND pg_get_constraintdef(oid) LIKE '%unresolved_blocking_count%difference_count%'
          LOOP EXECUTE format('ALTER TABLE ${migrationDomains} DROP CONSTRAINT %I', c.conname); END LOOP;
        END $$`,
        `CREATE OR REPLACE FUNCTION ${prefix}_enqueue_membership_projection() RETURNS trigger AS $$
        BEGIN
          INSERT INTO ${projectionOutbox} (
            outbox_id,tenant_id,projector,idempotency_key,payload_json,status,
            attempt,max_attempts,lease_fence,next_attempt_at,created_at,updated_at
          ) VALUES (
            'gpo-' || md5(clock_timestamp()::text || random()::text),
            NEW.tenant_id,'membership',NEW.user_id || ':' || NEW.version,
            jsonb_build_object('tenantId',NEW.tenant_id,'userId',NEW.user_id,'persona',NEW.persona,'status',NEW.status,'version',NEW.version),
            'pending',0,8,0,NOW(),NOW(),NOW()
          ) ON CONFLICT (tenant_id,projector,idempotency_key) DO NOTHING;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`,
        `DROP TRIGGER IF EXISTS ${prefix}_membership_projection_outbox ON ${memberships}`,
        `CREATE TRIGGER ${prefix}_membership_projection_outbox
          AFTER INSERT OR UPDATE ON ${memberships}
          FOR EACH ROW EXECUTE FUNCTION ${prefix}_enqueue_membership_projection()`,
        `CREATE OR REPLACE FUNCTION ${prefix}_enqueue_platform_admin_projection() RETURNS trigger AS $$
        BEGIN
          INSERT INTO ${projectionOutbox} (
            outbox_id,tenant_id,projector,idempotency_key,payload_json,status,
            attempt,max_attempts,lease_fence,next_attempt_at,created_at,updated_at
          ) VALUES (
            'gpo-' || md5(clock_timestamp()::text || random()::text),
            '${PLATFORM_TENANT_ID}','platform_admin',NEW.user_id || ':' || NEW.version,
            jsonb_build_object('tenantId','${PLATFORM_TENANT_ID}','userId',NEW.user_id,'version',NEW.version),
            'pending',0,8,0,NOW(),NOW(),NOW()
          ) ON CONFLICT (tenant_id,projector,idempotency_key) DO NOTHING;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`,
        `DROP TRIGGER IF EXISTS ${prefix}_platform_admin_projection_outbox ON ${platformAdmins}`,
        `CREATE TRIGGER ${prefix}_platform_admin_projection_outbox
          AFTER INSERT OR UPDATE ON ${platformAdmins}
          FOR EACH ROW EXECUTE FUNCTION ${prefix}_enqueue_platform_admin_projection()`,
        `CREATE OR REPLACE FUNCTION ${prefix}_enqueue_assignment_projection() RETURNS trigger AS $$
        BEGIN
          INSERT INTO ${projectionOutbox} (
            outbox_id,tenant_id,projector,idempotency_key,payload_json,status,
            attempt,max_attempts,lease_fence,next_attempt_at,created_at,updated_at
          ) VALUES (
            'gpo-' || md5(clock_timestamp()::text || random()::text),
            NEW.tenant_id,'assignment',NEW.resource_type || ':' || NEW.resource_id || ':' || NEW.version,
            jsonb_build_object('tenantId',NEW.tenant_id,'resourceType',NEW.resource_type,'resourceId',NEW.resource_id,'version',NEW.version),
            'pending',0,8,0,NOW(),NOW(),NOW()
          ) ON CONFLICT (tenant_id,projector,idempotency_key) DO NOTHING;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`,
        `DROP TRIGGER IF EXISTS ${prefix}_assignment_projection_outbox ON ${assignmentSets}`,
        `CREATE TRIGGER ${prefix}_assignment_projection_outbox
          AFTER INSERT OR UPDATE ON ${assignmentSets}
          FOR EACH ROW EXECUTE FUNCTION ${prefix}_enqueue_assignment_projection()`,
        `CREATE OR REPLACE FUNCTION ${prefix}_enqueue_assignment_row_delete_projection() RETURNS trigger AS $$
        DECLARE set_version BIGINT;
        BEGIN
          SELECT version INTO set_version FROM ${assignmentSets}
            WHERE tenant_id=OLD.tenant_id AND resource_type=OLD.resource_type AND resource_id=OLD.resource_id;
          IF set_version IS NULL THEN RETURN OLD; END IF;
          INSERT INTO ${projectionOutbox} (
            outbox_id,tenant_id,projector,idempotency_key,payload_json,status,
            attempt,max_attempts,lease_fence,next_attempt_at,created_at,updated_at
          ) VALUES (
            'gpo-' || md5(clock_timestamp()::text || random()::text),
            OLD.tenant_id,'assignment',OLD.resource_type || ':' || OLD.resource_id || ':delete:' || OLD.assignment_id,
            jsonb_build_object('tenantId',OLD.tenant_id,'resourceType',OLD.resource_type,'resourceId',OLD.resource_id,'version',set_version),
            'pending',0,8,0,NOW(),NOW(),NOW()
          ) ON CONFLICT (tenant_id,projector,idempotency_key) DO NOTHING;
          RETURN OLD;
        END $$ LANGUAGE plpgsql`,
        `DROP TRIGGER IF EXISTS ${prefix}_assignment_delete_projection_outbox ON ${assignments}`,
        `CREATE TRIGGER ${prefix}_assignment_delete_projection_outbox
          AFTER DELETE ON ${assignments}
          FOR EACH ROW EXECUTE FUNCTION ${prefix}_enqueue_assignment_row_delete_projection()`,
        `CREATE OR REPLACE FUNCTION ${prefix}_enqueue_preference_projection() RETURNS trigger AS $$
        DECLARE item RECORD; tenant_scope TEXT; item_version BIGINT;
        BEGIN
          item := CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
          SELECT tenant_id INTO tenant_scope FROM ${memberships} WHERE user_id=item.user_id;
          IF tenant_scope IS NULL THEN RETURN item; END IF;
          item_version := CASE WHEN TG_OP='DELETE' THEN item.version + 1 ELSE item.version END;
          INSERT INTO ${projectionOutbox} (
            outbox_id,tenant_id,projector,idempotency_key,payload_json,status,
            attempt,max_attempts,lease_fence,next_attempt_at,created_at,updated_at
          ) VALUES (
            'gpo-' || md5(clock_timestamp()::text || random()::text),
            tenant_scope,'preference',item.user_id || ':' || item.resource_type || ':' || item.resource_id || ':' || item_version,
            jsonb_build_object('tenantId',tenant_scope,'userId',item.user_id,'resourceType',item.resource_type,'resourceId',item.resource_id,'version',item_version),
            'pending',0,8,0,NOW(),NOW(),NOW()
          ) ON CONFLICT (tenant_id,projector,idempotency_key) DO NOTHING;
          RETURN item;
        END $$ LANGUAGE plpgsql`,
        `DROP TRIGGER IF EXISTS ${prefix}_preference_projection_outbox ON ${preferences}`,
        `CREATE TRIGGER ${prefix}_preference_projection_outbox
          AFTER INSERT OR UPDATE OR DELETE ON ${preferences}
          FOR EACH ROW EXECUTE FUNCTION ${prefix}_enqueue_preference_projection()`,
        `CREATE OR REPLACE FUNCTION ${prefix}_enqueue_tenant_settings_projection() RETURNS trigger AS $$
        DECLARE item RECORD; item_json JSONB; source_name TEXT; source_key TEXT; tenant_scope TEXT; item_version BIGINT;
        BEGIN
          item := CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
          item_json := to_jsonb(item);
          tenant_scope := item_json->>'tenant_id';
          item_version := (item_json->>'version')::BIGINT + CASE WHEN TG_OP='DELETE' THEN 1 ELSE 0 END;
          source_name := CASE
            WHEN TG_TABLE_NAME='${entitlementSets}' THEN 'entitlement'
            WHEN TG_TABLE_NAME='${entitlementScopes}' THEN 'scope'
            ELSE 'policy' END;
          source_key := CASE
            WHEN source_name='entitlement' THEN 'entitlement:' || item_version
            WHEN source_name='scope' THEN 'scope:' || (item_json->>'resource_type') || ':' || item_version
            ELSE 'policy:' || (item_json->>'policy_key') || ':' || item_version END;
          INSERT INTO ${projectionOutbox} (
            outbox_id,tenant_id,projector,idempotency_key,payload_json,status,
            attempt,max_attempts,lease_fence,next_attempt_at,created_at,updated_at
          ) VALUES (
            'gpo-' || md5(clock_timestamp()::text || random()::text),
            tenant_scope,'tenant_settings',source_key,
            jsonb_build_object('tenantId',tenant_scope,'source',source_name,'version',item_version),
            'pending',0,8,0,NOW(),NOW(),NOW()
          ) ON CONFLICT (tenant_id,projector,idempotency_key) DO NOTHING;
          RETURN item;
        END $$ LANGUAGE plpgsql`,
        `DROP TRIGGER IF EXISTS ${prefix}_entitlement_projection_outbox ON ${entitlementSets}`,
        `CREATE TRIGGER ${prefix}_entitlement_projection_outbox
          AFTER INSERT OR UPDATE ON ${entitlementSets}
          FOR EACH ROW EXECUTE FUNCTION ${prefix}_enqueue_tenant_settings_projection()`,
        `DROP TRIGGER IF EXISTS ${prefix}_scope_projection_outbox ON ${entitlementScopes}`,
        `CREATE TRIGGER ${prefix}_scope_projection_outbox
          AFTER INSERT OR UPDATE OR DELETE ON ${entitlementScopes}
          FOR EACH ROW EXECUTE FUNCTION ${prefix}_enqueue_tenant_settings_projection()`,
        `DROP TRIGGER IF EXISTS ${prefix}_policy_projection_outbox ON ${policies}`,
        `CREATE TRIGGER ${prefix}_policy_projection_outbox
          AFTER INSERT OR UPDATE OR DELETE ON ${policies}
          FOR EACH ROW EXECUTE FUNCTION ${prefix}_enqueue_tenant_settings_projection()`,
      ],
    },
  ];
}

export class PgGovernanceMigrationRunner {
  readonly schemaVersionsTable: string;
  readonly prefix: string;

  constructor(private readonly pool: GovernancePgPool, tablePrefix?: string) {
    this.prefix = governanceTablePrefix(tablePrefix);
    this.schemaVersionsTable = `${this.prefix}_governance_schema_versions`;
  }

  async run(): Promise<void> {
    const client = await this.pool.connect();
    const lockKey = `${this.schemaVersionsTable}:migrate`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schemaVersionsTable} (
          version INTEGER PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      const appliedResult = await client.query<{ version: number }>(
        `SELECT version FROM ${this.schemaVersionsTable} ORDER BY version`,
      );
      const applied = new Set(appliedResult.rows.map(row => Number(row.version)));

      for (const migration of migrations(this.prefix)) {
        if (applied.has(migration.version)) continue;
        await client.query('BEGIN');
        try {
          for (const statement of migration.statements) {
            await client.query(statement);
          }
          await client.query(
            `INSERT INTO ${this.schemaVersionsTable} (version) VALUES ($1)`,
            [migration.version],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }
}
