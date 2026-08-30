import type pg from 'pg';

export interface SessionAutomationTables {
  automations: string; specs: string; commands: string; wakeups: string; outbox: string;
  executions: string; evaluations: string; events: string; consumers: string; poison: string;
}
export function sessionAutomationTables(tablePrefix = 'runtime'): SessionAutomationTables {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tablePrefix)) throw new Error(`非法 PG tablePrefix: ${tablePrefix}`);
  const p = tablePrefix;
  return {
    automations: `${p}_session_automations`, specs: `${p}_session_automation_specs`,
    commands: `${p}_session_automation_commands`, wakeups: `${p}_session_automation_wakeups`,
    outbox: `${p}_session_automation_dispatch_outbox`, executions: `${p}_session_automation_executions`,
    evaluations: `${p}_session_automation_evaluations`, events: `${p}_session_automation_events`,
    consumers: `${p}_session_automation_consumers`, poison: `${p}_session_automation_terminal_poison`,
  };
}
export function buildSessionAutomationSchema(tablePrefix = 'runtime', runsTable = `${tablePrefix}_runs`): string[] {
  const t = sessionAutomationTables(tablePrefix);
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(runsTable)) throw new Error(`非法 PG runsTable: ${runsTable}`);
  return [
`CREATE TABLE IF NOT EXISTS ${t.automations} (
 automation_id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
 incarnation_id UUID NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('loop','goal')), mode TEXT NOT NULL CHECK(mode IN ('fixed','adaptive','goal')),
 status TEXT NOT NULL CHECK(status IN ('active','paused','blocked','completing','cancelling','completed','cancelled','failed','expired','reconcile_required')),
 phase TEXT NOT NULL DEFAULT 'idle' CHECK(phase IN ('idle','waiting','dispatching','running','evaluating','terminal')),
 generation BIGINT NOT NULL DEFAULT 1, spec_version BIGINT NOT NULL DEFAULT 1, control_version BIGINT NOT NULL DEFAULT 1,
 projection_version BIGINT NOT NULL DEFAULT 1, continuation_epoch BIGINT NOT NULL DEFAULT 0,
 run_count INTEGER NOT NULL DEFAULT 0, no_progress_count INTEGER NOT NULL DEFAULT 0, last_progress_fingerprint TEXT,
 active_run_id TEXT, next_wakeup_at TIMESTAMPTZ, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,session_id,automation_id), UNIQUE(tenant_id,session_id,incarnation_id)
)`,
`CREATE UNIQUE INDEX IF NOT EXISTS ${tablePrefix}_automation_one_live_per_session ON ${t.automations}(tenant_id,session_id) WHERE status IN ('active','paused','blocked','completing','cancelling','reconcile_required')`,
`CREATE TABLE IF NOT EXISTS ${t.specs} (
 automation_id UUID NOT NULL, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, spec_version BIGINT NOT NULL,
 spec_digest TEXT NOT NULL, spec JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(automation_id,spec_version),
 FOREIGN KEY(tenant_id,session_id,automation_id) REFERENCES ${t.automations}(tenant_id,session_id,automation_id)
)`,
`CREATE TABLE IF NOT EXISTS ${t.commands} (
 tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL, session_id TEXT NOT NULL,
 command_digest TEXT NOT NULL, automation_id UUID, response JSONB, state TEXT NOT NULL DEFAULT 'committed', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,owner_user_id,client_message_id)
)`,
`CREATE TABLE IF NOT EXISTS ${t.wakeups} (
 wakeup_id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, automation_id UUID NOT NULL, incarnation_id UUID NOT NULL,
 generation BIGINT NOT NULL, spec_version BIGINT NOT NULL, continuation_epoch BIGINT NOT NULL, trigger_key TEXT NOT NULL,
 due_at TIMESTAMPTZ NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','consumed','superseded','dead')),
 lease_token UUID, lease_expires_at TIMESTAMPTZ, attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,automation_id,trigger_key), FOREIGN KEY(tenant_id,session_id,automation_id) REFERENCES ${t.automations}(tenant_id,session_id,automation_id)
)`,
`CREATE INDEX IF NOT EXISTS ${tablePrefix}_automation_wakeups_due ON ${t.wakeups}(due_at,created_at) WHERE state IN ('pending','claimed')`,
`CREATE TABLE IF NOT EXISTS ${t.outbox} (
 outbox_id UUID PRIMARY KEY, wakeup_id UUID NOT NULL, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, automation_id UUID NOT NULL,
 incarnation_id UUID NOT NULL, generation BIGINT NOT NULL, spec_version BIGINT NOT NULL, continuation_epoch BIGINT NOT NULL,
 trigger_key TEXT NOT NULL, target_run_id TEXT NOT NULL, payload JSONB NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatching','dispatched','completed','dead')),
 attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), lease_token UUID, lease_expires_at TIMESTAMPTZ, last_error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(tenant_id,session_id,target_run_id), UNIQUE(tenant_id,wakeup_id),
 FOREIGN KEY(wakeup_id) REFERENCES ${t.wakeups}(wakeup_id), FOREIGN KEY(tenant_id,session_id,automation_id) REFERENCES ${t.automations}(tenant_id,session_id,automation_id)
)`,
`CREATE UNIQUE INDEX IF NOT EXISTS ${tablePrefix}_automation_one_open_dispatch ON ${t.outbox}(tenant_id,automation_id,generation) WHERE state IN ('pending','dispatching','dispatched')`,
`CREATE TABLE IF NOT EXISTS ${t.executions} (
 execution_id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, automation_id UUID NOT NULL, incarnation_id UUID NOT NULL,
 generation BIGINT NOT NULL, spec_version BIGINT NOT NULL, outbox_id UUID NOT NULL UNIQUE, run_id TEXT NOT NULL, state TEXT NOT NULL,
 terminal_status TEXT, progress_fingerprint TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,session_id,run_id), FOREIGN KEY(outbox_id) REFERENCES ${t.outbox}(outbox_id),
 FOREIGN KEY(tenant_id,session_id,automation_id) REFERENCES ${t.automations}(tenant_id,session_id,automation_id),
 FOREIGN KEY(tenant_id,session_id,run_id) REFERENCES ${runsTable}(tenant_id,session_id,run_id)
)`,
`CREATE TABLE IF NOT EXISTS ${t.evaluations} (
 evaluation_id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, automation_id UUID NOT NULL, execution_id UUID NOT NULL,
 incarnation_id UUID NOT NULL, generation BIGINT NOT NULL, spec_version BIGINT NOT NULL, decision_epoch BIGINT NOT NULL,
 evidence JSONB NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','result_unknown','met','continue','blocked','unverifiable','dead')),
 decision JSONB, lease_token UUID, lease_expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,automation_id,generation,decision_epoch), FOREIGN KEY(execution_id) REFERENCES ${t.executions}(execution_id)
)`,
`CREATE TABLE IF NOT EXISTS ${t.events} (
 automation_event_id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, automation_id UUID NOT NULL,
 generation BIGINT NOT NULL, spec_version BIGINT NOT NULL, control_version BIGINT NOT NULL, projection_version BIGINT NOT NULL,
 event_type TEXT NOT NULL, event_payload JSONB NOT NULL, command_id TEXT, run_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,session_id,automation_id) REFERENCES ${t.automations}(tenant_id,session_id,automation_id)
)`,
`CREATE INDEX IF NOT EXISTS ${tablePrefix}_automation_events_stream ON ${t.events}(tenant_id,session_id,created_at,automation_event_id)`,
`CREATE TABLE IF NOT EXISTS ${t.consumers} (consumer_name TEXT PRIMARY KEY, last_global_sequence BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`ALTER TABLE ${t.evaluations} DROP CONSTRAINT IF EXISTS ${tablePrefix}_session_automation_evaluations_state_check`,
`ALTER TABLE ${t.evaluations} ADD CONSTRAINT ${tablePrefix}_session_automation_evaluations_state_check CHECK(state IN ('pending','claimed','result_unknown','met','continue','blocked','unverifiable','dead'))`,
`CREATE TABLE IF NOT EXISTS ${t.poison} (consumer_name TEXT NOT NULL, global_sequence BIGINT NOT NULL, event_json JSONB NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, last_error TEXT NOT NULL, quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(consumer_name,global_sequence))`,
  ];
}
export async function applySessionAutomationSchema(client: pg.PoolClient, tablePrefix = 'runtime', runsTable = `${tablePrefix}_runs`): Promise<void> {
  for (const statement of buildSessionAutomationSchema(tablePrefix, runsTable)) await client.query(statement);
}
