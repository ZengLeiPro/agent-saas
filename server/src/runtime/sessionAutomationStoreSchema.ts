import type pg from 'pg';

/** Tenant-scoped durable automation control and attribution tables. */
export interface SessionAutomationTables {
  automations: string; specs: string; commands: string; wakeups: string; outbox: string;
  executions: string; evaluations: string; events: string; consumers: string; poison: string;
  cancellations: string; usage: string; preparedDispatchAttempts: string; providerAttempts: string;
  budgetReservations: string; budgetSettlements: string; interactions: string; backgroundResources: string;
  reconciliationReceipts: string;
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
    cancellations: `${p}_session_automation_cancel_outbox`, usage: `${p}_session_automation_usage`,
    preparedDispatchAttempts: `${p}_session_automation_prepared_dispatch_attempts`,
    providerAttempts: `${p}_session_automation_provider_attempts`,
    budgetReservations: `${p}_session_automation_budget_reservations`,
    budgetSettlements: `${p}_session_automation_budget_settlements`,
    interactions: `${p}_session_automation_interactions`,
    backgroundResources: `${p}_session_automation_background_resources`,
    reconciliationReceipts: `${p}_session_automation_reconciliation_receipts`,
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
`ALTER TABLE ${t.automations} ADD COLUMN IF NOT EXISTS limit_hit_reason TEXT`,
`ALTER TABLE ${t.automations} ADD COLUMN IF NOT EXISTS limit_hit_at TIMESTAMPTZ`,
`DO $$ BEGIN
 IF EXISTS (
   SELECT 1 FROM pg_constraint WHERE conrelid='${t.automations}'::regclass
    AND conname='${t.automations}_status_check'
    AND position('reconcile_required' in pg_get_constraintdef(oid))=0
 ) THEN ALTER TABLE ${t.automations} DROP CONSTRAINT ${t.automations}_status_check; END IF;
 IF NOT EXISTS (
   SELECT 1 FROM pg_constraint WHERE conrelid='${t.automations}'::regclass
    AND conname='${t.automations}_status_check'
 ) THEN
   ALTER TABLE ${t.automations} ADD CONSTRAINT ${t.automations}_status_check
    CHECK(status IN ('active','paused','blocked','completing','cancelling','completed','cancelled','failed','expired','reconcile_required')) NOT VALID;
   ALTER TABLE ${t.automations} VALIDATE CONSTRAINT ${t.automations}_status_check;
 END IF;
END $$`,
`CREATE UNIQUE INDEX IF NOT EXISTS ${tablePrefix}_automation_one_live_per_session_v2 ON ${t.automations}(tenant_id,session_id) WHERE status IN ('active','paused','blocked','completing','cancelling','reconcile_required')`,
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
`CREATE TABLE IF NOT EXISTS ${t.cancellations} (
 cancellation_id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, automation_id UUID NOT NULL,
 run_id TEXT NOT NULL, requested_generation BIGINT NOT NULL, reason TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','completed','dead')),
 attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 lease_token UUID, lease_expires_at TIMESTAMPTZ, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,run_id), FOREIGN KEY(tenant_id,session_id,automation_id) REFERENCES ${t.automations}(tenant_id,session_id,automation_id)
)`,
`CREATE INDEX IF NOT EXISTS ${tablePrefix}_automation_cancel_due ON ${t.cancellations}(next_attempt_at,created_at) WHERE state IN ('pending','claimed')`,
`CREATE TABLE IF NOT EXISTS ${t.usage} (
 usage_id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, automation_id UUID NOT NULL,
 execution_id UUID, source_key TEXT NOT NULL, source_kind TEXT NOT NULL,
 turns BIGINT NOT NULL DEFAULT 0, tokens BIGINT NOT NULL DEFAULT 0, credits NUMERIC(20,6) NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(tenant_id,automation_id,source_key),
 FOREIGN KEY(tenant_id,session_id,automation_id) REFERENCES ${t.automations}(tenant_id,session_id,automation_id)
)`,
`CREATE INDEX IF NOT EXISTS ${tablePrefix}_automation_usage_total ON ${t.usage}(tenant_id,automation_id)`,
`CREATE TABLE IF NOT EXISTS ${t.executions} (
 execution_id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, automation_id UUID NOT NULL, incarnation_id UUID NOT NULL,
 generation BIGINT NOT NULL, spec_version BIGINT NOT NULL, outbox_id UUID NOT NULL UNIQUE, run_id TEXT NOT NULL, state TEXT NOT NULL,
 terminal_status TEXT, progress_fingerprint TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,session_id,run_id), FOREIGN KEY(outbox_id) REFERENCES ${t.outbox}(outbox_id),
 FOREIGN KEY(tenant_id,session_id,automation_id) REFERENCES ${t.automations}(tenant_id,session_id,automation_id)
)`,
`ALTER TABLE ${t.executions} DROP CONSTRAINT IF EXISTS ${t.executions}_tenant_id_session_id_run_id_fkey`,
`CREATE UNIQUE INDEX IF NOT EXISTS ${tablePrefix}_automation_execution_lineage ON ${t.executions}(tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id)`,
`CREATE TABLE IF NOT EXISTS ${t.preparedDispatchAttempts} (
 prepared_dispatch_attempt_id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, automation_id UUID NOT NULL,
 incarnation_id UUID NOT NULL, generation BIGINT NOT NULL, execution_id UUID NOT NULL, run_id TEXT NOT NULL,
 outbox_id UUID NOT NULL, idempotency_key TEXT NOT NULL, request_payload JSONB NOT NULL,
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','dispatched','completed','result_unknown','reconcile')),
 version BIGINT NOT NULL DEFAULT 1 CHECK(version > 0), lease_token UUID, lease_expires_at TIMESTAMPTZ,
 last_error TEXT, prepared_at TIMESTAMPTZ NOT NULL DEFAULT now(), dispatched_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,idempotency_key), UNIQUE(prepared_dispatch_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id),
 FOREIGN KEY(tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id)
   REFERENCES ${t.executions}(tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(outbox_id) REFERENCES ${t.outbox}(outbox_id) DEFERRABLE INITIALLY DEFERRED
)`,
`CREATE INDEX IF NOT EXISTS ${tablePrefix}_prepared_dispatch_claim ON ${t.preparedDispatchAttempts}(state,lease_expires_at,prepared_at) WHERE state IN ('prepared','result_unknown','reconcile')`,
`CREATE TABLE IF NOT EXISTS ${t.providerAttempts} (
 provider_attempt_id UUID PRIMARY KEY, prepared_dispatch_attempt_id UUID NOT NULL, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, automation_id UUID NOT NULL,
 incarnation_id UUID NOT NULL, generation BIGINT NOT NULL, execution_id UUID NOT NULL, run_id TEXT NOT NULL,
 provider TEXT NOT NULL, operation TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_payload JSONB NOT NULL,
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','dispatched','completed','result_unknown','reconcile')),
 version BIGINT NOT NULL DEFAULT 1 CHECK(version > 0), lease_token UUID, lease_expires_at TIMESTAMPTZ,
 provider_request_id TEXT, result_payload JSONB, last_error TEXT, prepared_at TIMESTAMPTZ NOT NULL DEFAULT now(), dispatched_at TIMESTAMPTZ,
 completed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,provider,idempotency_key), UNIQUE(provider_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id),
 FOREIGN KEY(prepared_dispatch_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id)
   REFERENCES ${t.preparedDispatchAttempts}(prepared_dispatch_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id)
   REFERENCES ${t.executions}(tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id) DEFERRABLE INITIALLY DEFERRED
)`,
`CREATE INDEX IF NOT EXISTS ${tablePrefix}_provider_attempt_claim ON ${t.providerAttempts}(state,lease_expires_at,prepared_at) WHERE state IN ('prepared','result_unknown','reconcile')`,
`CREATE TABLE IF NOT EXISTS ${t.budgetReservations} (
 reservation_id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, automation_id UUID NOT NULL, incarnation_id UUID NOT NULL,
 generation BIGINT NOT NULL, execution_id UUID NOT NULL, run_id TEXT NOT NULL, budget_kind TEXT NOT NULL,
 amount NUMERIC(20,6) NOT NULL CHECK(amount >= 0), unit TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','released','result_unknown','reconcile')),
 version BIGINT NOT NULL DEFAULT 1 CHECK(version > 0), reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,idempotency_key), UNIQUE(reservation_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id),
 FOREIGN KEY(tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id)
   REFERENCES ${t.executions}(tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id) DEFERRABLE INITIALLY DEFERRED
)`,
`CREATE TABLE IF NOT EXISTS ${t.budgetSettlements} (
 settlement_id UUID PRIMARY KEY, reservation_id UUID NOT NULL, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, automation_id UUID NOT NULL,
 incarnation_id UUID NOT NULL, generation BIGINT NOT NULL, execution_id UUID NOT NULL, run_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, amount NUMERIC(20,6) NOT NULL CHECK(amount >= 0), outcome TEXT NOT NULL CHECK(outcome IN ('charged','released','result_unknown','reconcile')),
 provider_receipt JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(tenant_id,idempotency_key),
 FOREIGN KEY(reservation_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id)
   REFERENCES ${t.budgetReservations}(reservation_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id) DEFERRABLE INITIALLY DEFERRED
)`,
`CREATE TABLE IF NOT EXISTS ${t.interactions} (
 interaction_id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, automation_id UUID NOT NULL, incarnation_id UUID NOT NULL,
 generation BIGINT NOT NULL, execution_id UUID NOT NULL, run_id TEXT NOT NULL, interaction_key TEXT NOT NULL, interaction_kind TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','active','completed','result_unknown','reconcile')),
 request_payload JSONB NOT NULL, response_payload JSONB, version BIGINT NOT NULL DEFAULT 1 CHECK(version > 0), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,interaction_key), FOREIGN KEY(tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id)
   REFERENCES ${t.executions}(tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id) DEFERRABLE INITIALLY DEFERRED
)`,
`CREATE TABLE IF NOT EXISTS ${t.backgroundResources} (
 background_resource_id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, automation_id UUID NOT NULL, incarnation_id UUID NOT NULL,
 generation BIGINT NOT NULL, execution_id UUID NOT NULL, run_id TEXT NOT NULL, resource_kind TEXT NOT NULL, resource_key TEXT NOT NULL,
 provider_resource_id TEXT, state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','active','release_pending','released','result_unknown','reconcile')),
 metadata JSONB NOT NULL DEFAULT '{}'::jsonb, version BIGINT NOT NULL DEFAULT 1 CHECK(version > 0), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,resource_kind,resource_key), FOREIGN KEY(tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id)
   REFERENCES ${t.executions}(tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id) DEFERRABLE INITIALLY DEFERRED
)`,
`CREATE TABLE IF NOT EXISTS ${t.reconciliationReceipts} (
 reconciliation_receipt_id UUID PRIMARY KEY, provider_attempt_id UUID NOT NULL, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, automation_id UUID NOT NULL,
 incarnation_id UUID NOT NULL, generation BIGINT NOT NULL, execution_id UUID NOT NULL, run_id TEXT NOT NULL, receipt_key TEXT NOT NULL,
 observed_state TEXT NOT NULL CHECK(observed_state IN ('completed','not_found','still_running','ambiguous')),
 receipt_payload JSONB NOT NULL, observed_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(tenant_id,receipt_key),
 FOREIGN KEY(provider_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id)
   REFERENCES ${t.providerAttempts}(provider_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id) DEFERRABLE INITIALLY DEFERRED
)`,
`CREATE INDEX IF NOT EXISTS ${tablePrefix}_reconciliation_receipts_attempt ON ${t.reconciliationReceipts}(provider_attempt_id,observed_at DESC)`,
`CREATE TABLE IF NOT EXISTS ${t.evaluations} (
 evaluation_id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, automation_id UUID NOT NULL, execution_id UUID NOT NULL,
 incarnation_id UUID NOT NULL, generation BIGINT NOT NULL, spec_version BIGINT NOT NULL, decision_epoch BIGINT NOT NULL,
 evidence JSONB NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','result_unknown','met','continue','blocked','unverifiable','dead')),
 decision JSONB, lease_token UUID, lease_expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,automation_id,generation,decision_epoch), FOREIGN KEY(execution_id) REFERENCES ${t.executions}(execution_id)
)`,
`CREATE TABLE IF NOT EXISTS ${t.events} (
 automation_event_id UUID PRIMARY KEY, event_sequence BIGSERIAL NOT NULL, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, automation_id UUID NOT NULL,
 generation BIGINT NOT NULL, spec_version BIGINT NOT NULL, control_version BIGINT NOT NULL, projection_version BIGINT NOT NULL,
 event_type TEXT NOT NULL, event_payload JSONB NOT NULL, command_id TEXT, run_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,session_id,automation_id) REFERENCES ${t.automations}(tenant_id,session_id,automation_id)
)`,
`ALTER TABLE ${t.events} ADD COLUMN IF NOT EXISTS event_sequence BIGSERIAL`,
`CREATE UNIQUE INDEX IF NOT EXISTS ${tablePrefix}_automation_events_sequence ON ${t.events}(event_sequence)`,
`CREATE INDEX IF NOT EXISTS ${tablePrefix}_automation_events_stream ON ${t.events}(tenant_id,session_id,event_sequence)`,
`CREATE TABLE IF NOT EXISTS ${t.consumers} (consumer_name TEXT PRIMARY KEY, last_global_sequence BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`ALTER TABLE ${t.evaluations} DROP CONSTRAINT IF EXISTS ${tablePrefix}_session_automation_evaluations_state_check`,
`ALTER TABLE ${t.evaluations} ADD CONSTRAINT ${tablePrefix}_session_automation_evaluations_state_check CHECK(state IN ('pending','claimed','result_unknown','met','continue','blocked','unverifiable','dead'))`,
`CREATE TABLE IF NOT EXISTS ${t.poison} (consumer_name TEXT NOT NULL, global_sequence BIGINT NOT NULL, event_json JSONB NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, last_error TEXT NOT NULL, quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(consumer_name,global_sequence))`,
  ];
}
export async function applySessionAutomationSchema(client: pg.PoolClient, tablePrefix = 'runtime', runsTable = `${tablePrefix}_runs`): Promise<void> {
  for (const statement of buildSessionAutomationSchema(tablePrefix, runsTable)) await client.query(statement);
}
