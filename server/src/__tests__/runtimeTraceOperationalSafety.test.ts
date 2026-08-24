import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

import { createRuntimeTraceRouter, sanitizeEfficiencyOperationalErrors } from '../routes/runtimeTrace.js';
import type { RuntimeTraceRouterOptions } from '../routes/runtimeTrace.js';
import { RuntimeEfficiencyQuery, type EfficiencyReport, type RecentRunSummary } from '../runtime/efficiencyQuery.js';
import type { RunRecord } from '../runtime/runStore.js';
import type { JwtPayload } from '../auth/types.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const RUN_ID = 'run-trace-operational-safety';
const ORG_ADMIN: JwtPayload = {
  sub: 'admin-2', username: 'org-admin', role: 'admin', tenantId: 'kaiyan',
};
const RUN_RECORD: RunRecord = {
  runId: RUN_ID,
  sessionId: SESSION_ID,
  userId: 'user-1',
  tenantId: 'kaiyan',
  status: 'failed',
  model: 'gpt-5.5',
  channel: 'web',
  requestedAt: '2026-07-03T01:00:00.000Z',
  startedAt: '2026-07-03T01:00:01.000Z',
  updatedAt: '2026-07-03T01:05:00.000Z',
  failedAt: '2026-07-03T01:05:00.000Z',
  executionTarget: 'server-local',
  workspaceId: 'ws-1',
  metadata: {},
};
const EMPTY_REPORT: EfficiencyReport = {
  range: { from: '2026-06-26T00:00:00.000Z', to: '2026-07-03T00:00:00.000Z', days: 7, bounds: '[from,to)' },
  tenantId: 'kaiyan',
  statistics: {
    version: 'runtime-runs-requested-at-v1', source: 'runtime_runs', identity: 'run_id', initiatedAt: 'requested_at',
    dataAsOf: '2026-07-03T00:00:00.000Z', completionDefinition: 'completed / initiated',
    longRunningDefinition: 'non_terminal_started_for_24h',
  },
  outcome: { totalRuns: 0, success: 0, error: 0, interrupted: 0, nonTerminal: 0, completionRate: null, errorReasons: [] },
  tools: { byTool: [], handFailures: 0 },
  cost: { totalCostYuan: 0, byModel: [], perRun: { p50: null, p90: null, p99: null }, failedRunsCostYuan: 0, cacheHitRate: null },
  longTail: { slowestRuns: [], longRunningRuns: [], mostTurns: [] },
  approvals: { count: 0, resolvedCount: 0, waitP50Ms: null, waitP90Ms: null, byTool: [] },
  waste: {
    duplicateToolCalls: { affectedRuns: 0, totalDuplicateCalls: 0, topOffenders: [] },
    repeatedFileReads: { affectedRuns: 0, topFiles: [] },
    unmodifiedRetries: { count: 0, byTool: [] },
  },
};

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

class MockPool {
  readonly calls: Array<{ text: string; params?: unknown[] }> = [];
  constructor(private readonly rowsByMarker: Record<string, Array<Record<string, unknown>>>) {}

  async query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.calls.push({ text, params });
    for (const [marker, rows] of Object.entries(this.rowsByMarker)) {
      if (text.includes(`eff:${marker}`)) return { rows };
    }
    return { rows: [] };
  }
}

function makeQuery(pool: MockPool): RuntimeEfficiencyQuery {
  return new RuntimeEfficiencyQuery({
    pool,
    eventsTable: 'runtime_events',
    runsTable: 'runtime_runs',
    billingUsageEventsTable: 'runtime_billing_usage_events',
  });
}

describe('runtime trace 任务口径与脱敏', () => {
  let server: Server | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (server) await stopServer(server);
    server = null;
  });

  it('组织管理员可见的 runtime 内容与错误不泄露绝对路径，且 diagnosticId 可关联服务端日志', async () => {
    const sensitiveReason = 'failed at /workspace/releases/abcdef123456/server.js\n    at execute (/srv/app.js:10:2)';
    const diagnosticLogger = { error: vi.fn() };
    const options: RuntimeTraceRouterOptions = {
      logger: diagnosticLogger,
      runStore: { get: async () => ({ ...RUN_RECORD, statusReason: sensitiveReason }) },
      eventStore: { listByRun: async () => [] },
      billingStore: { listUsageEvents: async () => [] },
      getTenantPolicy: async () => ({ showCost: false }),
      efficiencyQuery: {
        listRecentRuns: async () => [{
          runId: RUN_ID, sessionId: SESSION_ID, tenantId: 'kaiyan', userId: 'user-1',
          status: 'failed', statusReason: sensitiveReason, model: 'gpt-5.5', channel: 'web',
          requestedAt: RUN_RECORD.requestedAt, startedAt: '2026-07-03T01:00:01.000Z',
          completedAt: null, failedAt: RUN_RECORD.failedAt!, cancelledAt: null, durationMs: 299_000,
        } satisfies RecentRunSummary],
        getEfficiency: async () => ({
          ...EMPTY_REPORT,
          outcome: {
            ...EMPTY_REPORT.outcome,
            totalRuns: 1,
            error: 1,
            errorReasons: [{ reason: sensitiveReason, count: 1, sampleRunId: RUN_ID }],
          },
        }),
      },
    };
    const app = express();
    app.use((req, _res, next) => { req.user = ORG_ADMIN; next(); });
    app.use('/api/admin/runtime/trace', createRuntimeTraceRouter(options));
    const baseUrl = await new Promise<string>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server!.address();
        resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`);
      });
    });

    const trace = await (await fetch(`${baseUrl}/api/admin/runtime/trace/runs/${RUN_ID}/events`)).json();
    expect(trace.run).toMatchObject({
      statusReason: '执行失败（详细错误已隐藏）', errorCode: 'RUNTIME_RUN_FAILED', diagnosticId: expect.stringMatching(/^diag_/),
    });
    const recent = await (await fetch(`${baseUrl}/api/admin/runtime/trace/recent-runs`)).json();
    expect(recent.runs[0]).toMatchObject({
      statusReason: '执行失败（详细错误已隐藏）', errorCode: 'RUNTIME_RUN_FAILED', diagnosticId: expect.stringMatching(/^diag_/),
    });
    expect(diagnosticLogger.error).toHaveBeenCalledWith(expect.stringContaining(`[${trace.run.diagnosticId}] RUNTIME_RUN_FAILED`));
    expect(diagnosticLogger.error).toHaveBeenCalledWith(expect.stringContaining(`[${recent.runs[0].diagnosticId}] RUNTIME_RUN_FAILED`));
    const efficiency = await (await fetch(`${baseUrl}/api/admin/runtime/trace/efficiency`)).json();
    expect(efficiency.outcome.errorReasons).toEqual([{
      reason: '执行失败（详细错误已隐藏）', count: 1, sampleRunId: RUN_ID,
    }]);
    expect(JSON.stringify({ trace, recent, efficiency })).not.toMatch(/\/workspace|abcdef123456|at execute/);
  });

  it('失败原因统一走公共净化并合并安全文案', () => {
    const sanitized = sanitizeEfficiencyOperationalErrors({
      ...EMPTY_REPORT,
      outcome: {
        ...EMPTY_REPORT.outcome,
        errorReasons: [
          { reason: '/workspace/releases/abcdef123456/server.js: failed\n at execute', count: 2, sampleRunId: 'r1' },
          { reason: '/srv/app/current/server.js: failed\n stack trace', count: 1, sampleRunId: 'r2' },
        ],
      },
    });
    expect(sanitized.outcome.errorReasons).toEqual([{
      reason: '执行失败（详细错误已隐藏）', count: 3, sampleRunId: 'r1',
    }]);
    expect(JSON.stringify(sanitized)).not.toMatch(/\/workspace|\/srv|abcdef123456|stack trace/);
  });

  it('7 天任务健康在跨日边界使用固定 [from,to)，重复 run_finished 事件不进入权威口径', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T00:05:00.000Z'));
    const pool = new MockPool({
      outcome: [
        { status: 'completed', count: '1' },
        { status: 'failed', count: '1' },
        { status: 'running', count: '1' },
      ],
      error_reasons: [{ reason: '/workspace/releases/abcdef123456/server.js\n at run', count: '1', sample_run_id: 'r-failed' }],
    });
    const report = await makeQuery(pool).getEfficiency({ days: 7, tenantId: 'kaiyan' });

    expect(report.range).toEqual({
      from: '2026-08-07T00:05:00.000Z', to: '2026-08-14T00:05:00.000Z', days: 7, bounds: '[from,to)',
    });
    expect(report.statistics.dataAsOf).toBe(report.range.to);
    expect(report.outcome).toMatchObject({ totalRuns: 3, success: 1, error: 1, nonTerminal: 1, completionRate: 0.3333 });

    const taskHealthCalls = pool.calls.filter((call) => /eff:(outcome|error_reasons|slowest_runs|long_running_runs)/.test(call.text));
    expect(taskHealthCalls).toHaveLength(4);
    for (const call of taskHealthCalls) {
      expect(call.params?.slice(0, 3)).toEqual([
        '2026-08-07T00:05:00.000Z', 'kaiyan', '2026-08-14T00:05:00.000Z',
      ]);
      if (call.text.includes('eff:long_running_runs')) {
        expect(call.params?.[3]).toBe('2026-08-14T00:05:00.000Z');
      } else {
        expect(call.params).toHaveLength(3);
      }
      expect(call.text).toContain('requested_at >= $1::timestamptz');
      expect(call.text).toContain('requested_at < $3::timestamptz');
      expect(call.text).not.toContain('run_finished');
      expect(call.text).not.toContain('updated_at');
    }
    expect(pool.calls.find((call) => call.text.includes('eff:outcome'))?.text).toContain('COUNT(DISTINCT run_id)');
  });
});
