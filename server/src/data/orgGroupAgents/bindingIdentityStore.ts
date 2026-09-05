import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import {
  DEFAULT_ORG_AGENT_CHANNEL_POLICY,
  DEFAULT_ORG_AGENT_EFFECTIVE_CONFIG,
  type OrgAgentChannelBinding,
} from './types.js';
import { mapBinding, requiredRow } from './storeMappers.js';

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
  const result = await pool.query(
    `INSERT INTO ${bindingsTable} AS binding (
      binding_id,tenant_id,account_id,agent_id,conversation_id,channel_kind,activation_state,enabled,
      conversation_space_id,service_session_id,workspace_id,policy_json,effective_config_json,
      account_profile_id,account_corp_id,account_dingtalk_user_id,account_identity_updated_at,
      revision,created_at,updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,'shadow',FALSE,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15::timestamptz,
      1,NOW(),NOW()
    )
    ON CONFLICT (account_id,conversation_id) DO UPDATE
    SET account_profile_id=COALESCE(binding.account_profile_id,EXCLUDED.account_profile_id),
        account_corp_id=COALESCE(binding.account_corp_id,EXCLUDED.account_corp_id),
        account_dingtalk_user_id=COALESCE(
          binding.account_dingtalk_user_id,EXCLUDED.account_dingtalk_user_id
        ),
        account_identity_updated_at=COALESCE(
          binding.account_identity_updated_at,EXCLUDED.account_identity_updated_at
        ),
        updated_at=binding.updated_at
    WHERE (
      binding.account_profile_id=EXCLUDED.account_profile_id
      AND binding.account_corp_id=EXCLUDED.account_corp_id
      AND binding.account_dingtalk_user_id=EXCLUDED.account_dingtalk_user_id
      AND binding.account_identity_updated_at=EXCLUDED.account_identity_updated_at
    ) OR (
      binding.account_profile_id IS NULL
      AND binding.account_corp_id IS NULL
      AND binding.account_dingtalk_user_id IS NULL
      AND binding.account_identity_updated_at IS NULL
      AND binding.created_at >= EXCLUDED.account_identity_updated_at
    )
    RETURNING binding.*`,
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
  // A conflicting binding from a prior account identity is never adopted by the new subject.
  if (!result.rows[0]) throw new Error('ORG_AGENT_BINDING_ACCOUNT_IDENTITY_CONFLICT');
  const binding = mapBinding(requiredRow(result.rows[0]));
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
