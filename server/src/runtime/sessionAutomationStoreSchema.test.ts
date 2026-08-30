import {describe,expect,it} from 'vitest'; // schema migration contract coverage
import {buildSessionAutomationSchema,sessionAutomationTables} from './sessionAutomationStoreSchema.js';

describe('session automation PG schema',()=>{
  it('maps the configured runtime prefix and all durable components',()=>{
    const t=sessionAutomationTables('agent_runtime');
    expect(t).toEqual({
      automations:'agent_runtime_session_automations',specs:'agent_runtime_session_automation_specs',commands:'agent_runtime_session_automation_commands',wakeups:'agent_runtime_session_automation_wakeups',outbox:'agent_runtime_session_automation_dispatch_outbox',executions:'agent_runtime_session_automation_executions',evaluations:'agent_runtime_session_automation_evaluations',events:'agent_runtime_session_automation_events',consumers:'agent_runtime_session_automation_consumers',poison:'agent_runtime_session_automation_terminal_poison',cancellations:'agent_runtime_session_automation_cancel_outbox',usage:'agent_runtime_session_automation_usage',
      preparedDispatchAttempts:'agent_runtime_session_automation_prepared_dispatch_attempts',providerAttempts:'agent_runtime_session_automation_provider_attempts',budgetReservations:'agent_runtime_session_automation_budget_reservations',budgetSettlements:'agent_runtime_session_automation_budget_settlements',interactions:'agent_runtime_session_automation_interactions',backgroundResources:'agent_runtime_session_automation_background_resources',reconciliationReceipts:'agent_runtime_session_automation_reconciliation_receipts',lifecycleWork:'agent_runtime_session_automation_lifecycle_work',completionAllowances:'agent_runtime_session_automation_completion_allowances',
    });
    const sql=buildSessionAutomationSchema('agent_runtime','prod_runtime_runs').join('\n');
    for(const table of Object.values(t))expect(sql).toContain(table);
    expect(sql).toContain('one_live_per_session');expect(sql).toContain('one_open_dispatch');expect(sql).toContain('result_unknown');expect(sql).not.toContain('<p>');
  });
  it('defines complete lineage, idempotency and deferred ledger constraints',()=>{
    const t=sessionAutomationTables('ledger');const sql=buildSessionAutomationSchema('ledger','ledger_runs').join('\n');
    for(const table of [t.preparedDispatchAttempts,t.providerAttempts,t.budgetReservations,t.budgetSettlements,t.interactions,t.backgroundResources,t.reconciliationReceipts,t.lifecycleWork])expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    expect(sql.match(/tenant_id TEXT NOT NULL/g)?.length).toBeGreaterThanOrEqual(17);
    expect(sql.match(/incarnation_id UUID NOT NULL/g)?.length).toBeGreaterThanOrEqual(10);
    expect(sql.match(/DEFERRABLE INITIALLY DEFERRED/g)?.length).toBeGreaterThanOrEqual(9);
    expect(sql).toContain("CHECK(state IN ('prepared','dispatched','completed','cancelled','result_unknown','reconcile'))");
    expect(sql).toContain('automation_execution_lineage');
    expect(sql).toContain('UNIQUE(tenant_id,provider,idempotency_key)');
    expect(sql).toContain('UNIQUE(tenant_id,receipt_key)');
    expect(sql).toContain(`ALTER TABLE ${t.outbox} ADD COLUMN IF NOT EXISTS updated_at`);
    expect(sql).toContain(`ALTER TABLE ${t.lifecycleWork} ADD COLUMN IF NOT EXISTS next_attempt_at`);
    expect(sql).toContain("CHECK(state IN ('pending','claimed','waiting','completed','result_unknown','dead'))");
  });
  it('rejects identifier injection',()=>{expect(()=>sessionAutomationTables('runtime;drop table x')).toThrow();expect(()=>buildSessionAutomationSchema('runtime','x;drop')).toThrow();});
});
