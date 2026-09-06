import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  GOVERNANCE_SCHEMA_VERSION,
  governanceMigrationVersions,
  PgGovernanceMigrationRunner,
} from '../data/governance-schema/migrations.js';
import { governanceV22Statements } from '../data/governance-schema/v22Migration.js';
import { governanceV23Statements } from '../data/governance-schema/v23Migration.js';
import { governanceV34Statements } from '../data/governance-schema/v34Migration.js';
import { governanceV36OrgGroupAgentStatements } from '../data/governance-schema/v36OrgGroupAgentMigration.js';
import { governanceV37DeliveryAttemptPhaseStatements } from '../data/governance-schema/v37DeliveryAttemptPhaseMigration.js';
import { governanceV39OrgGroupBindingIdentityStatements } from '../data/governance-schema/v39OrgGroupBindingIdentityMigration.js';
import { governanceV40DwsDeliveryAccountIdentityStatements } from '../data/governance-schema/v40DwsDeliveryAccountIdentityMigration.js';

describe('Governance schema migration SQL fixtures', () => {
  it('V22 在约束前确定性回填 V18 org_memory 的空名称与状态，且名称不引用正文', () => {
    const legacy = {
      tenantId: 'tenant-a',
      resourceId: 'memory-1',
      resourceName: null,
      resourceStatus: null,
      body: '不得进入展示名称的组织记忆正文',
    };
    const statements = governanceV22Statements({
      assignmentSets: 'safe_resource_assignment_sets',
      assignments: 'safe_resource_assignments',
    });
    const sql = statements.join('\n');
    const statusBackfill = statements.findIndex(statement => statement.includes("SET resource_status='enabled'"));
    const statusNotNull = statements.findIndex(statement => statement.includes('ALTER COLUMN resource_status SET NOT NULL'));
    const nameBackfill = statements.findIndex(statement => statement.includes("SET resource_name='Migrated org memory '"));
    const metadataConstraint = statements.findIndex(statement => statement.includes('ADD CONSTRAINT safe_resource_assignment_sets_org_memory_metadata_check'));

    expect(statusBackfill).toBeGreaterThanOrEqual(0);
    expect(statusBackfill).toBeLessThan(statusNotNull);
    expect(nameBackfill).toBeGreaterThanOrEqual(0);
    expect(nameBackfill).toBeLessThan(metadataConstraint);
    expect(sql).toContain("WHERE resource_status IS NULL");
    expect(sql).toContain("NULLIF(BTRIM(resource_name),'') IS NULL");
    expect(sql).toContain("MD5(tenant_id || ':' || resource_id)");
    expect(sql).not.toContain('body');
    expect(sql).not.toContain(legacy.body);

    const fixtureName = `Migrated org memory ${createHash('md5')
      .update(`${legacy.tenantId}:${legacy.resourceId}`)
      .digest('hex')
      .slice(0, 12)}`;
    expect(fixtureName).toMatch(/^Migrated org memory [0-9a-f]{12}$/);
    expect(fixtureName).not.toContain(legacy.resourceId);
  });

  it('V23+ ledger DDL 可从 V22 幂等升级，并保留 tenant-scoped 唯一键', async () => {
    const statements = governanceV23Statements({ credentialCommits: 'safe_credential_commits' });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS safe_credential_commits');
    expect(statements[0]).toContain('PRIMARY KEY (tenant_id,operation,idempotency_key)');
    expect(statements[0]).toContain('UNIQUE (tenant_id,operation,nonce_digest)');

    const applied = new Set(Array.from({ length: 22 }, (_, index) => index + 1));
    const queries: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const query = async (sql: string, params?: readonly unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT version FROM')) {
        return { rows: [...applied].map(version => ({ version })), rowCount: applied.size };
      }
      if (sql.includes('INSERT INTO safe_governance_schema_versions')) {
        applied.add(Number(params?.[0]));
      }
      return { rows: [], rowCount: 0 };
    };
    const pool = { connect: async () => ({ query, release: () => undefined }) };
    const runner = new PgGovernanceMigrationRunner(pool as never, 'safe');

    await runner.run();
    await runner.run();

    expect(applied.has(23)).toBe(true);
    expect(applied.has(24)).toBe(true);
    expect(applied.has(25)).toBe(true);
    expect(applied.has(26)).toBe(true);
    expect(applied.has(32)).toBe(true);
    expect(applied.has(33)).toBe(true);
    expect(applied.has(34)).toBe(true);
    const insertedVersions = queries
      .filter(item => item.sql.includes('INSERT INTO safe_governance_schema_versions'))
      .map(item => Number(item.params?.[0]));
    expect(queries.filter(item => item.sql === 'BEGIN')).toHaveLength(insertedVersions.length);
    expect(insertedVersions).toEqual(
      governanceMigrationVersions().filter((version) => version > 22),
    );
    expect(queries.some(item => item.sql.includes("'dws_delegation'"))).toBe(true);
    expect(queries.filter(item => item.sql.includes('CREATE TABLE IF NOT EXISTS safe_credential_commits'))).toHaveLength(1);
    expect(queries.filter(item => item.sql.includes('CREATE TABLE IF NOT EXISTS safe_context_sources'))).toHaveLength(1);
    expect(queries.filter(item => item.sql.includes('CREATE TABLE IF NOT EXISTS safe_context_entities'))).toHaveLength(1);
    expect(queries.filter(item => item.sql.includes('safe_c26_links_contract_ck'))).toHaveLength(1);
    expect(queries.filter(item => item.sql.includes('CREATE TABLE IF NOT EXISTS safe_context_retention_receipts')))
      .toHaveLength(2);
    expect(queries.filter(item => item.sql.includes('INSERT INTO safe_governance_schema_versions')))
      .toEqual(insertedVersions.map(version => expect.objectContaining({ params: [version] })));
    expect(() => new PgGovernanceMigrationRunner(pool as never, 'unsafe-prefix')).toThrow('Invalid PostgreSQL identifier');
  });

  it('V34 把历史组织 selector 升级为账号 selector，无法修复的活动账号 fail closed', () => {
    const statements = governanceV34Statements('safe');
    const sql = statements.join('\n');
    expect(sql).toContain("profile_id=BTRIM(account.corp_id) || ':' || BTRIM(account.dingtalk_user_id)");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS identity_updated_at TIMESTAMPTZ');
    expect(sql).toContain("to_regclass('safe_agent_dws_auth_sessions')");
    expect(sql).toContain('SET identity_updated_at=connected.completed_at');
    expect(sql).toContain("connected.status='connected'");
    expect(sql).toContain('other_connected.session_id<>connected.session_id');
    expect(sql).toContain('later_attempt.session_id<>connected.session_id');
    expect(sql).toContain('later_attempt.created_at>=connected.created_at');
    expect(sql.match(/account.status IN \('active','paused'\)/g)).toHaveLength(3);
    expect(sql).toContain('SET identity_updated_at=updated_at WHERE identity_updated_at IS NULL');
    expect(sql).not.toContain('revision<=3');
    const inboxPin = statements.find(statement => statement.includes('UPDATE safe_agent_dws_event_inbox AS inbox'));
    expect(inboxPin).toContain("inbox.state IN ('pending','processing','retry_wait','reply_pending')");
    expect(inboxPin).toContain('account.identity_updated_at <= inbox.created_at');
    expect(inboxPin).not.toContain('runtime_run.requested_at');
    const completionPin = statements.find(statement => statement.includes('UPDATE safe_runs AS runtime_run'));
    expect(completionPin).toContain("runtime_run.metadata,'{dwsCompletionRoute}'");
    expect(completionPin).toContain("NOT (runtime_run.metadata->'dwsCompletionRoute' ? 'profileId')");
    expect(completionPin).toContain("NOT (runtime_run.metadata->'dwsCompletionRoute' ? 'corpId')");
    expect(completionPin).toContain("NOT (runtime_run.metadata->'dwsCompletionRoute' ? 'dingtalkUserId')");
    expect(completionPin).toContain("parent_run.run_id=runtime_run.metadata->>'parentRunId'");
    expect(completionPin).toContain("parent_run.channel='dingtalk'");
    expect(completionPin).toContain('account.identity_updated_at <= parent_run.requested_at');
    expect(completionPin).not.toContain('account.identity_updated_at <= runtime_run.requested_at');
    expect(completionPin).not.toContain('inbox.created_at');
    expect(sql).toContain("corp_id=BTRIM(SPLIT_PART(account.profile_id,':',1))");
    expect(sql).toContain('AND NOT EXISTS');
    expect(sql).toContain('UPDATE safe_context_sources AS source');
    expect(sql).toContain("source.kind='dws' AND source.status='active'");
    expect(sql).toContain('account.account_id=source.config_json->>\'accountId\'');
    expect(sql).toContain('BTRIM(account.profile_id)<>BTRIM(account.corp_id)');
    expect(sql).toContain('UPDATE safe_context_collections AS collection');
    expect(sql).toContain('UPDATE safe_context_sync_partitions AS sync_partition');
    expect(sql).toContain('lease_fence=lease_fence+1');
    expect(sql).toContain("sync_partition.status='syncing'");
    expect(sql).toContain('BTRIM(account.profile_id)=BTRIM(account.corp_id)');
    expect(sql).toContain("runtime_status='stopped',runtime_lease_owner=NULL,runtime_lease_expires_at=NULL");
    expect(sql).toContain("SET status='disabled',revision=revision+1,updated_at=NOW()");
    expect(sql).toContain("OR BTRIM(account.corp_id)=BTRIM(SPLIT_PART(account.profile_id,':',1))");
    expect(sql).toContain("status='error',runtime_status='error'");
    expect(sql).toContain('dws_profile_identity_reauthorization_required');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS safe_adws_active_identity_ck');
    expect(sql).toContain('ADD CONSTRAINT safe_adws_active_identity_ck CHECK');
    expect(sql).toContain("status<>'active' OR");

    const interrupted = statements.find(statement =>
      statement.includes("last_error='authorization_interrupted_by_upgrade'"));
    expect(interrupted).toContain("WHERE status='authorizing'");
    expect(interrupted).toContain("runtime_lease_owner=NULL,runtime_lease_expires_at=NULL");
    expect(interrupted).toContain('revision=revision+1,updated_at=NOW()');
    expect(interrupted).toContain("updated_by='system:dws-authorizing-v34'");
    expect(interrupted).not.toContain('profile_id=');
    expect(interrupted).not.toContain('corp_id=');
    expect(interrupted).not.toContain('dingtalk_user_id=');
    expect(sql).toContain("to_regclass('safe_agent_dws_auth_sessions')");
    expect(sql).toContain("error_code='authorization_interrupted_by_upgrade'");
    expect(sql).toContain('authorization_url=NULL,user_code=NULL');
    expect(sql).toContain("auth_session.status IN ('starting','awaiting_user')");
    expect(sql).toContain("account.status = 'authorizing'");
    expect(sql.match(/account\.status<>'authorizing'/g)).toHaveLength(3);
  });

  it('旧生产 V28 账本下，V31 在 ALTER 前先幂等创建 retention 表', async () => {
    const applied = new Set(Array.from({ length: 28 }, (_, index) => index + 1));
    const queries: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const query = async (sql: string, params?: readonly unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT version FROM')) {
        return { rows: [...applied].map(version => ({ version })), rowCount: applied.size };
      }
      if (sql.includes('INSERT INTO safe_governance_schema_versions')) {
        applied.add(Number(params?.[0]));
      }
      return { rows: [], rowCount: 0 };
    };
    const pool = { connect: async () => ({ query, release: () => undefined }) };

    await new PgGovernanceMigrationRunner(pool as never, 'safe').run();

    const createIndex = queries.findIndex(item =>
      item.sql.includes('CREATE TABLE IF NOT EXISTS safe_context_retention_receipts'));
    const alterIndex = queries.findIndex(item =>
      item.sql.includes('ALTER TABLE safe_context_retention_receipts ADD COLUMN'));
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(alterIndex).toBeGreaterThan(createIndex);
    expect([...applied].sort((a, b) => a - b)).toEqual(
      governanceMigrationVersions(),
    );
  });

  it('V36 仅做 expand，并为群绑定、投递、WorkOrder、attempt 与记忆建立租户复合约束', () => {
    const sql = governanceV36OrgGroupAgentStatements('safe').join('\n');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS safe_org_agent_channel_bindings');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS safe_agent_dws_delivery_intents');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS safe_org_agent_work_orders');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS safe_org_agent_work_attempts');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS safe_org_agent_memories');
    expect(sql).toContain('FOREIGN KEY (tenant_id,binding_id,agent_id,conversation_space_id,account_id,conversation_id)');
    expect(sql).toContain('UNIQUE (tenant_id,attempt_id)');
    expect(sql).toContain('ADD CONSTRAINT safe_dwsd_work_fk');
    expect(sql).toContain('ADD CONSTRAINT safe_dwsd_attempt_fk');
    expect(sql).toContain('NOT VALID');
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b/i);
  });

  it('V37 对旧 writer 保持 unknown-safe，并且只做 expand', () => {
    const sql = governanceV37DeliveryAttemptPhaseStatements('safe').join('\n');
    expect(sql).toContain("provider_attempt_phase TEXT\n      NOT NULL DEFAULT 'legacy_unknown'");
    expect(sql).toContain("'legacy_unknown','before_provider','provider_started'");
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b/i);
  });

  it('V39 expand 群 binding 的账号身份快照且只回填当前身份纪元', () => {
    const sql = governanceV39OrgGroupBindingIdentityStatements('safe').join('\n');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS account_profile_id TEXT');
    expect(sql).toContain('binding.created_at >= account.identity_updated_at');
    expect(sql).toContain("account.profile_id=account.corp_id || ':' || account.dingtalk_user_id");
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b/i);
  });

  it('V40 仅 expand durable delivery 的账号身份纪元且不回填 legacy', () => {
    const sql = governanceV40DwsDeliveryAccountIdentityStatements('safe').join('\n');
    expect(sql).toContain('ALTER TABLE safe_agent_dws_delivery_intents');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS account_profile_id TEXT');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS account_identity_updated_at TIMESTAMPTZ');
    expect(sql).toContain('CONSTRAINT safe_adws_di_identity_ck');
    expect(sql).toContain('account_profile_id IS NULL AND account_corp_id IS NULL');
    expect(sql).toContain('account_profile_id IS NOT NULL AND account_corp_id IS NOT NULL');
    expect(sql).not.toContain('UPDATE safe_agent_dws_delivery_intents');
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b/i);
  });
});
