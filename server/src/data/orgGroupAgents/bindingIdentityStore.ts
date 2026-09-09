import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import {
  DEFAULT_ORG_AGENT_CHANNEL_POLICY,
  DEFAULT_ORG_AGENT_EFFECTIVE_CONFIG,
  type OrgAgentChannelBinding,
  type OrgAgentChannelPolicy,
  type OrgAgentEffectiveConfig,
} from './types.js';
import { mapBinding, requiredRow, validateEffectiveConfig, validatePolicy } from './storeMappers.js';

export async function getCurrentIdentityBinding(pool: pg.Pool, table: string,
  tenantId: string, accountId: string, conversationId: string): Promise<OrgAgentChannelBinding | null> {
  assertTexts(tenantId, accountId, conversationId);
  const result = await pool.query(`SELECT * FROM ${table} WHERE tenant_id=$1 AND account_id=$2
    AND COALESCE(logical_conversation_id,conversation_id)=$3 AND retired_at IS NULL`,
  [tenantId, accountId, conversationId]);
  return result.rows[0] ? mapBinding(result.rows[0] as Record<string, unknown>) : null;
}

export async function getIdentityBindingById(pool: pg.Pool, table: string,
  tenantId: string, bindingId: string): Promise<OrgAgentChannelBinding | null> {
  assertTexts(tenantId, bindingId);
  const result = await pool.query(`SELECT * FROM ${table} WHERE tenant_id=$1 AND binding_id=$2`,
    [tenantId, bindingId]);
  return result.rows[0] ? mapBinding(result.rows[0] as Record<string, unknown>) : null;
}

export async function listCurrentIdentityBindings(pool: pg.Pool, table: string,
  tenantId: string, accountId: string): Promise<OrgAgentChannelBinding[]> {
  assertTexts(tenantId, accountId);
  const result = await pool.query(`SELECT * FROM ${table}
    WHERE tenant_id=$1 AND account_id=$2 AND retired_at IS NULL
    ORDER BY updated_at DESC,binding_id`, [tenantId, accountId]);
  return result.rows.map((row) => mapBinding(row as Record<string, unknown>));
}

export async function updateCurrentIdentityBinding(pool: pg.Pool, table: string, input: {
  tenantId: string; accountId: string; conversationId: string; expectedRevision: number;
  enabled: boolean; policy: OrgAgentChannelPolicy; effectiveConfig: OrgAgentEffectiveConfig;
}): Promise<OrgAgentChannelBinding> {
  assertTexts(input.tenantId, input.accountId, input.conversationId);
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
    throw new Error('ORG_AGENT_BINDING_INVALID');
  const policy = validatePolicy({ ...input.policy, enabled: input.enabled });
  const config = validateEffectiveConfig(input.effectiveConfig);
  const result = await pool.query(`UPDATE ${table}
    SET enabled=$4,activation_state=CASE WHEN $4 THEN 'active' ELSE 'disabled' END,
      policy_json=$5::jsonb,effective_config_json=$6::jsonb,revision=revision+1,updated_at=NOW()
    WHERE tenant_id=$1 AND account_id=$2
      AND COALESCE(logical_conversation_id,conversation_id)=$3 AND revision=$7
      AND retired_at IS NULL RETURNING *`, [input.tenantId, input.accountId,
    input.conversationId, input.enabled, JSON.stringify(policy), JSON.stringify(config),
    input.expectedRevision]);
  if (!result.rows[0]) throw new Error('ORG_AGENT_BINDING_VERSION_CONFLICT');
  return mapBinding(result.rows[0] as Record<string, unknown>);
}

export interface EnsureIdentityBoundShadowBindingInput {
  tenantId: string;
  accountId: string;
  agentId: string;
  conversationId: string;
  channelKind: 'group' | 'direct';
  workspaceId: string;
  accountIdentity: {
    profileId: string;
    corpId: string;
    dingtalkUserId: string;
    identityUpdatedAt: string;
  };
}

export async function ensureIdentityBoundShadowBinding(
  pool: pg.Pool,
  bindingsTable: string,
  accountsTable: string,
  deliveriesTable: string,
  input: EnsureIdentityBoundShadowBindingInput,
): Promise<OrgAgentChannelBinding> {
  assertTexts(
    input.tenantId,
    input.accountId,
    input.agentId,
    input.conversationId,
    input.workspaceId,
    input.accountIdentity.profileId,
    input.accountIdentity.corpId,
    input.accountIdentity.dingtalkUserId,
    input.accountIdentity.identityUpdatedAt,
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
      [JSON.stringify([input.tenantId, input.accountId, input.conversationId])],
    );
    const accountResult = await client.query(
      `SELECT agent_id,profile_id,corp_id,dingtalk_user_id,identity_updated_at
       FROM ${accountsTable} WHERE tenant_id=$1 AND account_id=$2 AND status='active'
       FOR UPDATE`,
      [input.tenantId, input.accountId],
    );
    const account = accountResult.rows[0] as Record<string, unknown> | undefined;
    if (!account
      || account.agent_id !== input.agentId
      || account.profile_id !== input.accountIdentity.profileId
      || account.corp_id !== input.accountIdentity.corpId
      || account.dingtalk_user_id !== input.accountIdentity.dingtalkUserId
      || Date.parse(String(account.identity_updated_at ?? ''))
        !== Date.parse(input.accountIdentity.identityUpdatedAt)) {
      throw new Error('ORG_AGENT_BINDING_ACCOUNT_IDENTITY_STALE');
    }
    const existing = await client.query(
      `SELECT * FROM ${bindingsTable}
       WHERE tenant_id=$1 AND account_id=$2
         AND COALESCE(logical_conversation_id,conversation_id)=$3 AND retired_at IS NULL
       FOR UPDATE`,
      [input.tenantId, input.accountId, input.conversationId],
    );
    const current = existing.rows[0] as Record<string, unknown> | undefined;
    if (current) {
      const binding = mapBinding(current);
      const exactIdentity = binding.accountIdentity
        && binding.accountIdentity.profileId === input.accountIdentity.profileId
        && binding.accountIdentity.corpId === input.accountIdentity.corpId
        && binding.accountIdentity.dingtalkUserId === input.accountIdentity.dingtalkUserId
        && Date.parse(binding.accountIdentity.identityUpdatedAt)
          === Date.parse(input.accountIdentity.identityUpdatedAt);
      const adoptableLegacy = !binding.accountIdentity
        && Date.parse(binding.createdAt) >= Date.parse(input.accountIdentity.identityUpdatedAt);
      if (exactIdentity) {
        const scoped = assertBindingScope(binding, input);
        await client.query('COMMIT');
        return scoped;
      }
      if (adoptableLegacy) {
        const adopted = await client.query(
          `UPDATE ${bindingsTable} SET account_profile_id=$4,account_corp_id=$5,
             account_dingtalk_user_id=$6,account_identity_updated_at=$7::timestamptz
           WHERE tenant_id=$1 AND account_id=$2
             AND COALESCE(logical_conversation_id,conversation_id)=$3 AND retired_at IS NULL
           RETURNING *`,
          [input.tenantId, input.accountId, input.conversationId, input.accountIdentity.profileId,
            input.accountIdentity.corpId, input.accountIdentity.dingtalkUserId,
            input.accountIdentity.identityUpdatedAt],
        );
        const scoped = assertBindingScope(mapBinding(requiredRow(adopted.rows[0])), input);
        await client.query('COMMIT');
        return scoped;
      }
      const authorized = await client.query(
        `SELECT 1 FROM ${accountsTable} WHERE tenant_id=$1 AND account_id=$2
          AND status='active' AND profile_id=$3 AND corp_id=$4 AND dingtalk_user_id=$5
          AND identity_updated_at=$6::timestamptz`,
        [input.tenantId, input.accountId, input.accountIdentity.profileId,
          input.accountIdentity.corpId, input.accountIdentity.dingtalkUserId,
          input.accountIdentity.identityUpdatedAt],
      );
      if (!authorized.rows[0]) throw new Error('ORG_AGENT_BINDING_ACCOUNT_IDENTITY_CONFLICT');
      await assertBindingGenerationContract(client, bindingsTable, deliveriesTable);
      await client.query(
        `UPDATE ${bindingsTable}
         SET logical_conversation_id=COALESCE(logical_conversation_id,conversation_id),
             conversation_id=conversation_id || '#retired#' || binding_id,
             retired_at=NOW(),enabled=FALSE,activation_state='disabled',updated_at=NOW()
         WHERE binding_id=$1 AND retired_at IS NULL`,
        [binding.bindingId],
      );
    }
    const result = await client.query(
      `INSERT INTO ${bindingsTable} (
      binding_id,tenant_id,account_id,agent_id,conversation_id,channel_kind,activation_state,enabled,
      conversation_space_id,service_session_id,workspace_id,policy_json,effective_config_json,
      account_profile_id,account_corp_id,account_dingtalk_user_id,account_identity_updated_at,
      revision,created_at,updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,'shadow',FALSE,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15::timestamptz,
      1,NOW(),NOW()
    )
    RETURNING *`,
    [
      `oacb-${randomUUID()}`,
      input.tenantId,
      input.accountId,
      input.agentId,
      input.conversationId,
      input.channelKind,
      `space-${randomUUID()}`,
      `agent-dws-service-${randomUUID()}`,
      input.workspaceId,
      JSON.stringify(DEFAULT_ORG_AGENT_CHANNEL_POLICY),
      JSON.stringify(DEFAULT_ORG_AGENT_EFFECTIVE_CONFIG),
      input.accountIdentity.profileId,
      input.accountIdentity.corpId,
      input.accountIdentity.dingtalkUserId,
      input.accountIdentity.identityUpdatedAt,
    ],
    );
    const binding = assertBindingScope(mapBinding(requiredRow(result.rows[0])), input);
    await client.query('COMMIT');
    return binding;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function assertBindingGenerationContract(
  client: pg.PoolClient,
  bindingsTable: string,
  deliveriesTable: string,
): Promise<void> {
  const result = await client.query<{ ready: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid=$1::regclass AND confrelid=$2::regclass
        AND contype='f' AND convalidated AND confupdtype='c'
        AND pg_get_constraintdef(oid) LIKE
          'FOREIGN KEY (tenant_id, binding_id, agent_id, conversation_space_id, account_id, conversation_id)%'
    ) AS ready`,
    [deliveriesTable, bindingsTable],
  );
  if (result.rows[0]?.ready !== true)
    throw new Error('ORG_AGENT_BINDING_GENERATION_CONTRACT_REQUIRED');
}

function assertBindingScope(
  binding: OrgAgentChannelBinding,
  input: EnsureIdentityBoundShadowBindingInput,
): OrgAgentChannelBinding {
  if (
    binding.tenantId !== input.tenantId
    || binding.agentId !== input.agentId
    || binding.channelKind !== input.channelKind
    || binding.workspaceId !== input.workspaceId
    || !binding.accountIdentity
    || binding.accountIdentity.profileId !== input.accountIdentity.profileId
    || binding.accountIdentity.corpId !== input.accountIdentity.corpId
    || binding.accountIdentity.dingtalkUserId !== input.accountIdentity.dingtalkUserId
    || Date.parse(binding.accountIdentity.identityUpdatedAt)
      !== Date.parse(input.accountIdentity.identityUpdatedAt)
  ) {
    throw new Error('ORG_AGENT_BINDING_IDENTITY_CONFLICT');
  }
  return binding;
}

function assertTexts(...values: string[]): void {
  if (values.some((value) => !value.trim())) throw new Error('ORG_AGENT_REQUIRED_IDENTITY_MISSING');
}
