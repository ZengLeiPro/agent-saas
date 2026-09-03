export function governanceV36OrgGroupAgentStatements(prefix: string): string[] {
  const inbox = `${prefix}_agent_dws_event_inbox`;
  const bindings = `${prefix}_org_agent_channel_bindings`;
  const conversations = `${prefix}_org_agent_work_conversations`;
  const deliveries = `${prefix}_agent_dws_delivery_intents`;
  const workOrders = `${prefix}_org_agent_work_orders`;
  const attempts = `${prefix}_org_agent_work_attempts`;
  const memories = `${prefix}_org_agent_memories`;
  const accounts = `${prefix}_agent_dws_accounts`;
  const managedAgents = `${prefix}_managed_agents`;
  return [
    `CREATE TABLE IF NOT EXISTS ${bindings} (
      binding_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      FOREIGN KEY (tenant_id,account_id) REFERENCES ${accounts}(tenant_id,account_id),
      FOREIGN KEY (tenant_id,agent_id) REFERENCES ${managedAgents}(tenant_id,agent_id),
      conversation_id TEXT NOT NULL,
      channel_kind TEXT NOT NULL CHECK (channel_kind IN ('group','direct')),
      activation_state TEXT NOT NULL DEFAULT 'shadow' CHECK (activation_state IN ('shadow','active','disabled')),
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      conversation_space_id TEXT NOT NULL,
      service_session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      effective_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (account_id,conversation_id),
      UNIQUE (tenant_id,binding_id),
      UNIQUE (tenant_id,binding_id,agent_id),
      UNIQUE (tenant_id,binding_id,agent_id,conversation_space_id,account_id,conversation_id),
      UNIQUE (service_session_id),
      CHECK (jsonb_typeof(policy_json)='object' AND octet_length(policy_json::text)<=65536),
      CHECK (jsonb_typeof(effective_config_json)='object' AND octet_length(effective_config_json::text)<=262144)
    )`,
    `CREATE INDEX IF NOT EXISTS ${bindings}_tenant_agent_idx
      ON ${bindings}(tenant_id,agent_id,updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${conversations} (
      work_conversation_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      FOREIGN KEY (tenant_id,binding_id) REFERENCES ${bindings}(tenant_id,binding_id),
      root_key TEXT NOT NULL,
      root_message_id TEXT,
      session_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','closed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (binding_id,root_key),
      UNIQUE (tenant_id,work_conversation_id),
      UNIQUE (tenant_id,work_conversation_id,binding_id),
      UNIQUE (session_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${conversations}_binding_updated_idx
      ON ${conversations}(binding_id,updated_at DESC)`,
    `ALTER TABLE ${inbox} ADD COLUMN IF NOT EXISTS external_actor_ref_json JSONB`,
    `ALTER TABLE ${inbox} ADD COLUMN IF NOT EXISTS conversation_space_id TEXT`,
    `ALTER TABLE ${inbox} ADD COLUMN IF NOT EXISTS work_conversation_id TEXT`,
    `ALTER TABLE ${inbox} ADD COLUMN IF NOT EXISTS channel_policy_revision BIGINT`,
    `ALTER TABLE ${inbox} ADD CONSTRAINT ${inbox}_external_actor_object_chk
      CHECK (external_actor_ref_json IS NULL OR (jsonb_typeof(external_actor_ref_json)='object'
        AND octet_length(external_actor_ref_json::text)<=65536)) NOT VALID`,
    `CREATE TABLE IF NOT EXISTS ${deliveries} (
      delivery_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      inbox_id TEXT REFERENCES ${inbox}(inbox_id),
      account_id TEXT NOT NULL,
      FOREIGN KEY (tenant_id,account_id) REFERENCES ${accounts}(tenant_id,account_id),
      conversation_id TEXT NOT NULL,
      agent_id TEXT,
      binding_id TEXT,
      conversation_space_id TEXT,
      work_conversation_id TEXT,
      policy_revision BIGINT,
      visibility TEXT CHECK (visibility IS NULL OR visibility IN ('conversation','requester_only','public_notice')),
      source_work_order_id TEXT,
      source_attempt_id TEXT,
      FOREIGN KEY (tenant_id,binding_id,agent_id,conversation_space_id,account_id,conversation_id)
        REFERENCES ${bindings}(tenant_id,binding_id,agent_id,conversation_space_id,account_id,conversation_id),
      FOREIGN KEY (tenant_id,work_conversation_id,binding_id)
        REFERENCES ${conversations}(tenant_id,work_conversation_id,binding_id),
      source TEXT NOT NULL CHECK (source IN ('command','background_completion','system')),
      delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('front_reply','access_rejection','task_completion','system_notice','needs_input')),
      disposition TEXT NOT NULL CHECK (disposition IN ('replied','rejected','ignored','unrouteable')),
      delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending','sending','sent','unknown','dead_letter')),
      destination_json JSONB NOT NULL,
      content TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      provider_receipt_json JSONB,
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      lease_owner TEXT,
      lease_fence BIGINT NOT NULL DEFAULT 0,
      lease_expires_at TIMESTAMPTZ,
      last_attempt_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
      ,CHECK (jsonb_typeof(destination_json)='object' AND octet_length(destination_json::text)<=65536)
      ,CHECK (provider_receipt_json IS NULL OR (jsonb_typeof(provider_receipt_json)='object' AND octet_length(provider_receipt_json::text)<=65536))
      ,CHECK ((agent_id IS NULL AND binding_id IS NULL AND conversation_space_id IS NULL
          AND work_conversation_id IS NULL AND policy_revision IS NULL AND visibility IS NULL)
        OR (agent_id IS NOT NULL AND binding_id IS NOT NULL AND conversation_space_id IS NOT NULL
          AND work_conversation_id IS NOT NULL AND policy_revision IS NOT NULL AND visibility IS NOT NULL))
      ,CHECK ((source_work_order_id IS NULL AND source_attempt_id IS NULL)
        OR (source_work_order_id IS NOT NULL AND source_attempt_id IS NOT NULL))
    )`,
    `CREATE INDEX IF NOT EXISTS ${deliveries}_claim_idx
      ON ${deliveries}(delivery_state,created_at) WHERE delivery_state IN ('pending','sending')`,
    `CREATE INDEX IF NOT EXISTS ${deliveries}_inbox_idx ON ${deliveries}(inbox_id,created_at)`,
    `CREATE TABLE IF NOT EXISTS ${workOrders} (
      work_order_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      work_conversation_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      FOREIGN KEY (tenant_id,binding_id,agent_id) REFERENCES ${bindings}(tenant_id,binding_id,agent_id),
      FOREIGN KEY (tenant_id,work_conversation_id,binding_id)
        REFERENCES ${conversations}(tenant_id,work_conversation_id,binding_id),
      idempotency_key TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','running','waiting_input','paused','completed','failed','cancelled')),
      current_attempt_no INTEGER NOT NULL DEFAULT 0 CHECK (current_attempt_no >= 0),
      visibility TEXT NOT NULL CHECK (visibility IN ('conversation','requester_only')),
      created_by_actor_json JSONB NOT NULL,
      policy_snapshot_json JSONB NOT NULL,
      cancel_policy_json JSONB NOT NULL,
      result_envelope_json JSONB,
      version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      UNIQUE (tenant_id,work_order_id),
      UNIQUE (tenant_id,idempotency_key),
      CHECK (jsonb_typeof(created_by_actor_json)='object' AND octet_length(created_by_actor_json::text)<=65536),
      CHECK (jsonb_typeof(policy_snapshot_json)='object' AND octet_length(policy_snapshot_json::text)<=262144),
      CHECK (jsonb_typeof(cancel_policy_json)='object' AND octet_length(cancel_policy_json::text)<=65536),
      CHECK (result_envelope_json IS NULL OR (jsonb_typeof(result_envelope_json)='object' AND octet_length(result_envelope_json::text)<=1048576))
    )`,
    `CREATE INDEX IF NOT EXISTS ${workOrders}_conversation_idx
      ON ${workOrders}(work_conversation_id,updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${attempts} (
      attempt_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      work_order_id TEXT NOT NULL,
      FOREIGN KEY (tenant_id,work_order_id) REFERENCES ${workOrders}(tenant_id,work_order_id),
      attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
      runtime_run_id TEXT NOT NULL,
      parent_attempt_id TEXT REFERENCES ${attempts}(attempt_id),
      status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
      task_workspace_id TEXT NOT NULL,
      sandbox_scope_id TEXT NOT NULL,
      mount_sub_path TEXT NOT NULL,
      shared_read_only_sub_path TEXT NOT NULL,
      publish_state TEXT NOT NULL DEFAULT 'pending' CHECK (publish_state IN ('pending','published','conflict','rejected')),
      checkpoint_json JSONB,
      artifact_manifest_json JSONB,
      result_envelope_json JSONB,
      failure TEXT,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (work_order_id,attempt_no),
      UNIQUE (runtime_run_id),
      UNIQUE (tenant_id,attempt_id),
      UNIQUE (tenant_id,work_order_id,attempt_id),
      CHECK (checkpoint_json IS NULL OR (jsonb_typeof(checkpoint_json)='object' AND octet_length(checkpoint_json::text)<=1048576)),
      CHECK (artifact_manifest_json IS NULL OR (jsonb_typeof(artifact_manifest_json)='object' AND octet_length(artifact_manifest_json::text)<=1048576)),
      CHECK (result_envelope_json IS NULL OR (jsonb_typeof(result_envelope_json)='object' AND octet_length(result_envelope_json::text)<=1048576))
    )`,
    `ALTER TABLE ${deliveries} ADD CONSTRAINT ${prefix}_dwsd_work_fk
      FOREIGN KEY (tenant_id,source_work_order_id) REFERENCES ${workOrders}(tenant_id,work_order_id) NOT VALID`,
    `ALTER TABLE ${deliveries} ADD CONSTRAINT ${prefix}_dwsd_attempt_fk
      FOREIGN KEY (tenant_id,source_work_order_id,source_attempt_id)
        REFERENCES ${attempts}(tenant_id,work_order_id,attempt_id) NOT VALID`,
    `CREATE TABLE IF NOT EXISTS ${memories} (
      memory_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      binding_id TEXT,
      work_conversation_id TEXT,
      work_order_id TEXT,
      FOREIGN KEY (tenant_id,agent_id) REFERENCES ${managedAgents}(tenant_id,agent_id),
      FOREIGN KEY (tenant_id,binding_id,agent_id) REFERENCES ${bindings}(tenant_id,binding_id,agent_id),
      FOREIGN KEY (tenant_id,work_conversation_id,binding_id)
        REFERENCES ${conversations}(tenant_id,work_conversation_id,binding_id),
      FOREIGN KEY (tenant_id,work_order_id) REFERENCES ${workOrders}(tenant_id,work_order_id),
      memory_scope TEXT NOT NULL CHECK (memory_scope IN ('agent','conversation','task_checkpoint')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','deleted')),
      content_json JSONB NOT NULL,
      provenance_json JSONB NOT NULL,
      promoted_by TEXT,
      promotion_reason TEXT,
      policy_revision BIGINT NOT NULL CHECK (policy_revision >= 1),
      version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ
      ,CHECK (jsonb_typeof(content_json)='object' AND octet_length(content_json::text)<=1048576)
      ,CHECK (jsonb_typeof(provenance_json)='object' AND octet_length(provenance_json::text)<=262144)
      ,CHECK (memory_scope<>'agent' OR (promoted_by IS NOT NULL AND promotion_reason IS NOT NULL))
      ,CHECK (memory_scope<>'conversation' OR (binding_id IS NOT NULL AND work_conversation_id IS NOT NULL))
      ,CHECK (memory_scope<>'task_checkpoint' OR work_order_id IS NOT NULL)
    )`,
    `CREATE INDEX IF NOT EXISTS ${memories}_scope_idx
      ON ${memories}(tenant_id,agent_id,memory_scope,status,updated_at DESC)`,
  ];
}
