import { describe, expect, it, vi } from 'vitest';

import {
  IntegrationV3KillSwitch,
  assertIntegrationV3DestructiveActionAllowed,
  collectIntegrationV3Metrics,
  evaluateIntegrationV3Health,
} from './integrationV3Observability.js';
import type { IntegrationV3RepairTables } from './integrationV3Repair.js';

const tables: IntegrationV3RepairTables = {
  tasks: 'tasks', executions: 'execs', lanes: 'lanes', candidates: 'candidates',
  providerOperations: 'operations', requestsOutbox: 'outbox',
};

describe('integration v3 observability and release gate', () => {
  it('publishes required metrics, including explicit budget placeholders', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{
      unknown_count: 2, unknown_age_ms: '700000', stale_lane_count: 1,
      stale_outbox_count: 3, outbox_age_ms: '800000', cleanup_failure_count: 1,
      active_v2_count: 4, active_v3_count: 5,
    }] })) } as any;
    const metrics = await collectIntegrationV3Metrics(db, tables, async () => ({ enabled: false, healthy: false, reason: 'disabled' }));
    expect(metrics).toMatchObject({
      unknownOperationCount: 2, oldestUnknownOperationAgeMs: 700000, staleLaneCount: 1,
      staleOutboxCount: 3, oldestOutboxAgeMs: 800000, cleanupFailureCount: 1,
      gatewayDisabled: true, activeV2Count: 4, activeV3Count: 5,
      costBudgetUsed: null, costBudgetLimit: null, workRoundBudgetUsed: null, workRoundBudgetLimit: null,
    });
    expect(evaluateIntegrationV3Health(metrics)).toMatchObject({
      status: 'degraded', releaseReady: false,
      reasons: expect.arrayContaining(['unknown_operation_too_old', 'stale_integration_lane', 'cleanup_failure', 'gateway_disabled']),
    });
  });

  it('enforces global and repository kill switches fail closed', () => {
    const switches = new IntegrationV3KillSwitch({ globalEnabled: false });
    expect(switches.check('repo')).toEqual({ enabled: false, scope: 'global' });
    switches.setGlobalEnabled(true);
    switches.setRepositoryEnabled('repo', false);
    expect(() => switches.assertEnabled('repo')).toThrow(/repository kill switch/);
    expect(switches.check('other')).toEqual({ enabled: true });
  });

  it('blocks archive/delete while irreversible or queued v3 state remains', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{
      id: 'candidate-1', integration_task_id: 'task-1', state: 'merged', provider_work: true, outbox_work: false,
    }] })) } as any;
    await expect(assertIntegrationV3DestructiveActionAllowed(db, tables, { taskId: 'task-1' }))
      .rejects.toMatchObject({ code: 'TASKBOARD_INTEGRATION_V3_ACTIVE', taskId: 'task-1' });
  });

  it('fails metrics collection rather than emitting a healthy partial snapshot', async () => {
    const db = { query: vi.fn(async () => { throw new Error('injected db outage'); }) } as any;
    await expect(collectIntegrationV3Metrics(db, tables)).rejects.toThrow('injected db outage');
  });
});
