import { describe, expect, it, vi } from 'vitest';

import {
  IntegrationV3KillSwitch,
  assertIntegrationV3DestructiveActionAllowed,
  collectIntegrationV3Metrics,
  createRuntimeIntegrationV3HealthProvider,
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
    const metricsSql = String(db.query.mock.calls[0]![0]);
    expect(metricsSql).toContain('clock_timestamp()-min(updated_at)');
    expect(metricsSql).not.toContain('clock_timestamp()-min(created_at)');
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

  it('reports failed candidates without weakening infrastructure release gates', () => {
    const metrics = {
      capturedAt: new Date().toISOString(),
      unknownOperationCount: 0, oldestUnknownOperationAgeMs: null,
      staleLaneCount: 0, staleOutboxCount: 0, oldestOutboxAgeMs: null,
      cleanupFailureCount: 0, activeFailedCandidateCount: 1,
      gatewayDisabled: false, gatewayHealthy: true,
      activeV2Count: 0, activeV3Count: 1,
      costBudgetUsed: null, costBudgetLimit: null,
      workRoundBudgetUsed: null, workRoundBudgetLimit: null,
    };
    expect(evaluateIntegrationV3Health(metrics)).toMatchObject({
      status: 'degraded', releaseReady: true, reasons: ['active_failed_candidate'],
    });
    expect(evaluateIntegrationV3Health({ ...metrics, gatewayHealthy: false })).toMatchObject({
      status: 'degraded', releaseReady: false,
      reasons: ['active_failed_candidate', 'gateway_unhealthy'],
    });
  });

  it('fails readiness when the control plane is disabled while durable v3 work remains', async () => {
    const db = { query: vi.fn(async (sql: string) => sql.includes('AS count')
      ? { rows: [{ count: 1 }] }
      : { rows: [{ unknown_count: 0, stale_lane_count: 0, stale_outbox_count: 0,
          cleanup_failure_count: 0, active_failed_candidate_count: 0, active_v2_count: 0, active_v3_count: 1 }] }) } as any;
    const health = createRuntimeIntegrationV3HealthProvider(false, {
      pool: db, tasksTable: 'tasks', executionsTable: 'execs', integrationLanesTable: 'lanes',
      integrationSourcesTable: 'integration_sources',
    }, () => undefined);
    await expect(health()).resolves.toMatchObject({
      status: 'degraded', releaseReady: false,
      reasons: ['control_plane_disabled_with_durable_v3_work'],
    });
    expect(String(db.query.mock.calls[0]![0])).toContain("status IN ('pending','processing','failed')");
    expect(String(db.query.mock.calls[0]![0])).toContain("state IN ('executing','unknown')");
  });

  it('keeps disabled v3 not applicable when no active candidate exists', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ count: 0 }] })) } as any;
    const health = createRuntimeIntegrationV3HealthProvider(false, {
      pool: db, tasksTable: 'tasks', executionsTable: 'execs', integrationLanesTable: 'lanes',
      integrationSourcesTable: 'integration_sources',
    }, () => undefined);
    await expect(health()).resolves.toEqual({ status: 'not_applicable', releaseReady: true, reasons: [] });
  });

  it('makes ws-only ready when a fresh compatible independent worker is healthy and metrics pass', async () => {
    const db = { query: vi.fn(async (sql: string) => sql.includes('ORDER BY ((status=\'healthy\')')
      ? { rows: [{ status: 'healthy', compatible: true, fresh: true }] }
      : { rows: [{ unknown_count: 0, unknown_age_ms: null, stale_lane_count: 0, stale_outbox_count: 0,
          outbox_age_ms: null, cleanup_failure_count: 0, active_failed_candidate_count: 0,
          active_v2_count: 0, active_v3_count: 0 }] }) } as any;
    const health = createRuntimeIntegrationV3HealthProvider(true, {
      pool: db, tasksTable: 'tasks', executionsTable: 'execs', integrationLanesTable: 'lanes',
      integrationSourcesTable: 'integration_sources',
    }, () => undefined, 'ws-only');
    await expect(health()).resolves.toMatchObject({ status: 'ok', releaseReady: true, reasons: [] });
  });

  it('keeps ws-only closed when the independent worker heartbeat is missing', async () => {
    const db = { query: vi.fn(async (sql: string) => sql.includes('ORDER BY ((status=\'healthy\')')
      ? { rows: [] }
      : { rows: [{ unknown_count: 0, stale_lane_count: 0, stale_outbox_count: 0,
          cleanup_failure_count: 0, active_failed_candidate_count: 0, active_v2_count: 0, active_v3_count: 0 }] }) } as any;
    const health = createRuntimeIntegrationV3HealthProvider(true, {
      pool: db, tasksTable: 'tasks', executionsTable: 'execs', integrationLanesTable: 'lanes',
      integrationSourcesTable: 'integration_sources',
    }, () => undefined, 'ws-only');
    await expect(health()).resolves.toMatchObject({ status: 'degraded', releaseReady: false, reasons: ['gateway_unhealthy'],
      metrics: { gatewayReason: 'worker_heartbeat_missing' } });
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
