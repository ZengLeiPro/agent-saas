import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgGovernanceMigrationRunner } from '../data/governance-schema/migrations.js';
import { PgOrgGroupAgentStore } from '../data/orgGroupAgents/store.js';
import { installBindingGenerationContract } from './helpers/bindingGenerationContract.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('组织群 binding 身份分代兼容与历史隔离', () => {
  const prefix = `bindgen_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgOrgGroupAgentStore;
  const oldIdentity = {
    profileId: 'corp-a:member-old',
    corpId: 'corp-a',
    dingtalkUserId: 'member-old',
    identityUpdatedAt: '2026-09-08T00:00:00.000Z',
  };
  const newIdentity = {
    profileId: 'corp-a:member-new',
    corpId: 'corp-a',
    dingtalkUserId: 'member-new',
    identityUpdatedAt: '2026-09-08T01:00:00.000Z',
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000 });
    await new PgGovernanceMigrationRunner(pool, prefix).run();
    await pool.query(`INSERT INTO ${prefix}_managed_agents
      (agent_id,tenant_id,kind,owner_user_id,status,revision,created_by,updated_by)
      VALUES ('agent-a','tenant-a','org_agent','admin','enabled',1,'admin','admin')`);
    await pool.query(
      `INSERT INTO ${prefix}_agent_dws_accounts
      (account_id,tenant_id,agent_id,display_name,login_id,corp_id,dingtalk_user_id,profile_id,
       identity_updated_at,status,event_policy_json,created_by,updated_by)
      VALUES ('account-a','tenant-a','agent-a','数字员工','employee-a',$1,$2,$3,$4,
       'active','{"kinds":["at_me"]}'::jsonb,'admin','admin')`,
      [
        oldIdentity.corpId,
        oldIdentity.dingtalkUserId,
        oldIdentity.profileId,
        oldIdentity.identityUpdatedAt,
      ],
    );
    store = new PgOrgGroupAgentStore(pool, prefix);
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname=current_schema()
       AND LEFT(tablename,LENGTH($1))=$1`,
      [prefix],
    );
    for (const row of tables.rows)
      await pool.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
    await pool.end();
  }, 30_000);

  it('V46 后旧 writer 的 ON CONFLICT inference 仍可执行并对异身份安全冲突', async () => {
    const binding = await store.ensureShadowBinding({
      tenantId: 'tenant-a',
      accountId: 'account-a',
      agentId: 'agent-a',
      conversationId: 'group-old-writer',
      channelKind: 'group',
      workspaceId: 'workspace-a',
      accountIdentity: oldIdentity,
    });
    const oldWriterSql = `INSERT INTO ${prefix}_org_agent_channel_bindings AS binding (
      binding_id,tenant_id,account_id,agent_id,conversation_id,channel_kind,activation_state,enabled,
      conversation_space_id,service_session_id,workspace_id,policy_json,effective_config_json,
      account_profile_id,account_corp_id,account_dingtalk_user_id,account_identity_updated_at
    ) VALUES ($1,'tenant-a','account-a','agent-a','group-old-writer','group','shadow',FALSE,
      $2,$3,'workspace-a','{}'::jsonb,'{}'::jsonb,$4,$5,$6,$7::timestamptz)
    ON CONFLICT (account_id,conversation_id) DO UPDATE SET updated_at=binding.updated_at
    WHERE binding.account_profile_id=EXCLUDED.account_profile_id
      AND binding.account_identity_updated_at=EXCLUDED.account_identity_updated_at
    RETURNING binding_id`;
    const same = await pool.query(oldWriterSql, [
      `legacy-${randomUUID()}`,
      `space-${randomUUID()}`,
      `session-${randomUUID()}`,
      oldIdentity.profileId,
      oldIdentity.corpId,
      oldIdentity.dingtalkUserId,
      oldIdentity.identityUpdatedAt,
    ]);
    expect(same.rows[0]?.binding_id).toBe(binding.bindingId);
    const stale = await pool.query(oldWriterSql, [
      `legacy-${randomUUID()}`,
      `space-${randomUUID()}`,
      `session-${randomUUID()}`,
      newIdentity.profileId,
      newIdentity.corpId,
      newIdentity.dingtalkUserId,
      newIdentity.identityUpdatedAt,
    ]);
    expect(stale.rowCount).toBe(0);
  });

  it('账号身份锁对 exact、legacy adopt 与 insert 三条路径统一拒绝旧快照', async () => {
    const exact = await store.ensureShadowBinding({
      tenantId: 'tenant-a',
      accountId: 'account-a',
      agentId: 'agent-a',
      conversationId: 'group-stale-exact',
      channelKind: 'group',
      workspaceId: 'workspace-a',
      accountIdentity: oldIdentity,
    });
    await pool.query(
      `INSERT INTO ${prefix}_org_agent_channel_bindings (
      binding_id,tenant_id,account_id,agent_id,conversation_id,channel_kind,activation_state,enabled,
      conversation_space_id,service_session_id,workspace_id,policy_json,effective_config_json,
      revision,created_at,updated_at)
      SELECT $1,tenant_id,account_id,agent_id,'group-stale-adopt',channel_kind,'shadow',FALSE,
        $2,$3,workspace_id,policy_json,effective_config_json,1,NOW(),NOW()
      FROM ${prefix}_org_agent_channel_bindings WHERE binding_id=$4`,
      [
        `legacy-${randomUUID()}`,
        `space-${randomUUID()}`,
        `session-${randomUUID()}`,
        exact.bindingId,
      ],
    );
    await pool.query(
      `UPDATE ${prefix}_agent_dws_accounts SET profile_id=$1,corp_id=$2,
      dingtalk_user_id=$3,identity_updated_at=$4 WHERE account_id='account-a'`,
      [
        newIdentity.profileId,
        newIdentity.corpId,
        newIdentity.dingtalkUserId,
        newIdentity.identityUpdatedAt,
      ],
    );
    const staleInput = (conversationId: string) => ({
      tenantId: 'tenant-a',
      accountId: 'account-a',
      agentId: 'agent-a',
      conversationId,
      channelKind: 'group' as const,
      workspaceId: 'workspace-a',
      accountIdentity: oldIdentity,
    });
    await expect(store.ensureShadowBinding(staleInput('group-stale-exact'))).rejects.toThrow(
      'ORG_AGENT_BINDING_ACCOUNT_IDENTITY_STALE',
    );
    await expect(store.ensureShadowBinding(staleInput('group-stale-adopt'))).rejects.toThrow(
      'ORG_AGENT_BINDING_ACCOUNT_IDENTITY_STALE',
    );
    await expect(store.ensureShadowBinding(staleInput('group-stale-insert'))).rejects.toThrow(
      'ORG_AGENT_BINDING_ACCOUNT_IDENTITY_STALE',
    );
    await pool.query(
      `UPDATE ${prefix}_agent_dws_accounts SET profile_id=$1,corp_id=$2,
      dingtalk_user_id=$3,identity_updated_at=$4 WHERE account_id='account-a'`,
      [
        oldIdentity.profileId,
        oldIdentity.corpId,
        oldIdentity.dingtalkUserId,
        oldIdentity.identityUpdatedAt,
      ],
    );
    await expect(
      store.ensureShadowBinding({
        ...staleInput('group-wrong-agent'),
        agentId: 'agent-forged',
        accountIdentity: oldIdentity,
      }),
    ).rejects.toThrow('ORG_AGENT_BINDING_ACCOUNT_IDENTITY_STALE');
  });

  it('换绑创建新 binding，当前列表与 workspace 不混入旧 WorkOrder 和记忆', async () => {
    const oldBinding = await store.ensureShadowBinding({
      tenantId: 'tenant-a',
      accountId: 'account-a',
      agentId: 'agent-a',
      conversationId: 'group-generation',
      channelKind: 'group',
      workspaceId: 'workspace-a',
      accountIdentity: oldIdentity,
    });
    const enabled = await store.updateBinding({
      tenantId: 'tenant-a',
      accountId: 'account-a',
      conversationId: 'group-generation',
      expectedRevision: oldBinding.revision,
      enabled: true,
      policy: oldBinding.policy,
      effectiveConfig: oldBinding.effectiveConfig,
    });
    const conversation = await store.getOrCreateWorkConversation({
      tenantId: 'tenant-a',
      bindingId: enabled.bindingId,
      rootKey: 'old-root',
    });
    const oldWork = await store.createWorkOrder({
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      bindingId: enabled.bindingId,
      workConversationId: conversation.workConversationId,
      idempotencyKey: 'old-work-key',
      title: '旧身份任务',
      visibility: 'conversation',
      createdByActor: {
        kind: 'external_user',
        provider: 'dingtalk',
        corpId: 'corp-a',
        openId: 'u-a',
        mappedUserId: 'user-a',
        assurance: 'mapped',
      },
      policySnapshot: { revision: enabled.revision },
      cancelPolicy: { mode: 'conversation' },
    });
    const oldMemory = await store.createMemory({
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      bindingId: enabled.bindingId,
      workConversationId: conversation.workConversationId,
      memoryScope: 'conversation',
      content: { fact: '旧身份事实' },
      provenance: { messageId: 'old-root' },
      policyRevision: enabled.revision,
    });
    await pool.query(
      `UPDATE ${prefix}_agent_dws_accounts SET profile_id=$1,corp_id=$2,
      dingtalk_user_id=$3,identity_updated_at=$4 WHERE account_id='account-a'`,
      [
        newIdentity.profileId,
        newIdentity.corpId,
        newIdentity.dingtalkUserId,
        newIdentity.identityUpdatedAt,
      ],
    );
    const rebindInput = {
      tenantId: 'tenant-a',
      accountId: 'account-a',
      agentId: 'agent-a',
      conversationId: 'group-generation',
      channelKind: 'group',
      workspaceId: 'workspace-a',
      accountIdentity: newIdentity,
    } as const;
    await expect(store.ensureShadowBinding(rebindInput)).rejects.toThrow(
      'ORG_AGENT_BINDING_GENERATION_CONTRACT_REQUIRED',
    );
    const unchanged = await pool.query(
      `SELECT conversation_id,retired_at FROM ${prefix}_org_agent_channel_bindings
       WHERE binding_id=$1`,
      [enabled.bindingId],
    );
    expect(unchanged.rows[0]).toMatchObject({
      retired_at: null,
      conversation_id: 'group-generation',
    });

    await installBindingGenerationContract(pool, prefix);
    const current = await store.ensureShadowBinding(rebindInput);
    expect(current.bindingId).not.toBe(enabled.bindingId);
    expect(
      (await store.listBindings('tenant-a', 'account-a')).map((item) => item.bindingId),
    ).toContain(current.bindingId);
    expect(
      (await store.listBindings('tenant-a', 'account-a')).map((item) => item.bindingId),
    ).not.toContain(enabled.bindingId);
    const currentWorkspace = await store.loadGroupWorkspace({
      tenantId: 'tenant-a',
      bindingIds: [current.bindingId],
      limitPerBinding: 20,
    });
    expect(currentWorkspace.workOrders.map((item) => item.workOrderId)).not.toContain(
      oldWork.workOrderId,
    );
    expect(currentWorkspace.memories.map((item) => item.memoryId)).not.toContain(
      oldMemory.memoryId,
    );
    const history = await store.loadGroupWorkspace({
      tenantId: 'tenant-a',
      bindingIds: [enabled.bindingId],
      limitPerBinding: 20,
    });
    expect(history.workOrders.map((item) => item.workOrderId)).toContain(oldWork.workOrderId);
    expect(history.memories.map((item) => item.memoryId)).toContain(oldMemory.memoryId);
  });

});
