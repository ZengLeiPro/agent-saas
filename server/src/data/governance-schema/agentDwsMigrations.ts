interface GovernanceMigrationSpec {
  version: number;
  statements: string[];
}

export function agentDwsMigrations(prefix: string): GovernanceMigrationSpec[] {
  const managedAgents = `${prefix}_managed_agents`;
  const agentDwsAccounts = `${prefix}_agent_dws_accounts`;
  const agentDwsEventInbox = `${prefix}_agent_dws_event_inbox`;
  const agentDwsConversationBindings = `${prefix}_agent_dws_conversation_bindings`;

  return [
    {
      version: 19,
      statements: [
        `CREATE UNIQUE INDEX IF NOT EXISTS ${managedAgents}_tenant_agent_unique_idx
          ON ${managedAgents} (tenant_id, agent_id)`,
        `CREATE TABLE IF NOT EXISTS ${agentDwsAccounts} (
          account_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          FOREIGN KEY (tenant_id, agent_id) REFERENCES ${managedAgents}(tenant_id, agent_id),
          display_name TEXT NOT NULL,
          login_id TEXT NOT NULL,
          corp_id TEXT,
          corp_name TEXT,
          dingtalk_user_id TEXT,
          dingtalk_user_name TEXT,
          profile_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('draft','authorizing','active','paused','error')),
          runtime_status TEXT NOT NULL DEFAULT 'stopped'
            CHECK (runtime_status IN ('stopped','starting','ready','error')),
          event_policy_json JSONB NOT NULL DEFAULT '{"kinds":["at_me","all_direct"]}'::jsonb
            CHECK (COALESCE(event_policy_json->'kinds','null'::jsonb) IN (
              '["at_me"]'::jsonb,
              '["all_direct"]'::jsonb,
              '["at_me","all_direct"]'::jsonb,
              '["all_direct","at_me"]'::jsonb
            )),
          runtime_lease_owner TEXT,
          runtime_lease_expires_at TIMESTAMPTZ,
          last_event_at TIMESTAMPTZ,
          last_error TEXT,
          revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT NOT NULL,
          UNIQUE (tenant_id, agent_id),
          UNIQUE (tenant_id, login_id),
          UNIQUE (tenant_id, corp_id, dingtalk_user_id)
        )`,
        `CREATE INDEX IF NOT EXISTS ${agentDwsAccounts}_tenant_status_idx
          ON ${agentDwsAccounts} (tenant_id, status, updated_at DESC)`,
        `CREATE INDEX IF NOT EXISTS ${agentDwsAccounts}_runtime_idx
          ON ${agentDwsAccounts} (status, runtime_status)`,
        `CREATE INDEX IF NOT EXISTS ${agentDwsAccounts}_lease_idx
          ON ${agentDwsAccounts} (runtime_lease_expires_at)
          WHERE runtime_lease_owner IS NOT NULL`,
      ],
    },
    {
      version: 20,
      statements: [
        `CREATE UNIQUE INDEX IF NOT EXISTS ${agentDwsAccounts}_tenant_account_unique_idx
          ON ${agentDwsAccounts} (tenant_id,account_id)`,
        `CREATE TABLE IF NOT EXISTS ${agentDwsEventInbox} (
          inbox_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          FOREIGN KEY (tenant_id,account_id)
            REFERENCES ${agentDwsAccounts}(tenant_id,account_id) ON DELETE CASCADE,
          event_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          message_id TEXT,
          sender_open_dingtalk_id TEXT,
          content TEXT NOT NULL,
          event_timestamp TIMESTAMPTZ,
          payload_json JSONB NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending' CHECK (
            state IN ('pending','processing','retry_wait','reply_pending','completed','dead_letter')
          ),
          session_id TEXT,
          run_id TEXT,
          response_text TEXT,
          reply_started_at TIMESTAMPTZ,
          attempt BIGINT NOT NULL DEFAULT 0 CHECK (attempt >= 0),
          max_attempts BIGINT NOT NULL DEFAULT 8 CHECK (max_attempts >= 1),
          lease_owner TEXT,
          lease_fence BIGINT NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
          lease_expires_at TIMESTAMPTZ,
          next_attempt_at TIMESTAMPTZ,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ,
          UNIQUE (account_id,event_id),
          CHECK (jsonb_typeof(payload_json) = 'object'),
          CHECK (octet_length(payload_json::text) <= 262144)
        )`,
        `CREATE INDEX IF NOT EXISTS ${agentDwsEventInbox}_claim_idx
          ON ${agentDwsEventInbox} (
            state,next_attempt_at,COALESCE(event_timestamp,created_at),created_at,inbox_id
          )
          WHERE state IN ('pending','processing','retry_wait','reply_pending')`,
        `CREATE INDEX IF NOT EXISTS ${agentDwsEventInbox}_account_conversation_idx
          ON ${agentDwsEventInbox} (account_id,conversation_id,state,lease_expires_at,created_at)`,
        `CREATE TABLE IF NOT EXISTS ${agentDwsConversationBindings} (
          binding_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          FOREIGN KEY (tenant_id,account_id)
            REFERENCES ${agentDwsAccounts}(tenant_id,account_id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (account_id,conversation_id),
          UNIQUE (session_id)
        )`,
        `CREATE INDEX IF NOT EXISTS ${agentDwsConversationBindings}_tenant_idx
          ON ${agentDwsConversationBindings} (tenant_id,updated_at DESC)`,
      ],
    },
  ];
}
