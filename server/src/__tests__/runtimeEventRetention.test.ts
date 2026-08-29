import { describe, expect, it, vi } from 'vitest';

import { RuntimeEventRetention } from '../runtime/runtimeEventRetention.js';

type RetentionCategory =
  | 'tool-delta'
  | 'assistant-stream'
  | 'tool-stream-summary'
  | 'model-diagnostics'
  | 'model-request-finished'
  | 'hand-events';

class FakePool {
  billingWatermark = '0';
  maxGlobalSequence = '0';
  deleteBatches: Partial<Record<RetentionCategory, number[]>> = {};
  dryRunCandidates: Partial<Record<RetentionCategory, number>> = {};
  categoryParams: Partial<Record<RetentionCategory, unknown[][]>> = {};
  queries: string[] = [];
  failCategoryOnce?: RetentionCategory;

  async query(text: string, params?: unknown[]) {
    this.queries.push(text);
    if (text.includes('FROM runtime_billing_projection_state')) {
      return { rows: [{ last_global_sequence: this.billingWatermark }] };
    }
    if (text.includes('MAX(global_sequence)')) {
      return { rows: [{ max_global_sequence: this.maxGlobalSequence }] };
    }
    const category = retentionCategory(text);
    if (category) {
      if (this.failCategoryOnce === category) {
        this.failCategoryOnce = undefined;
        throw new Error('sensitive SQL failure');
      }
      const calls = this.categoryParams[category] ?? [];
      calls.push(params ?? []);
      this.categoryParams[category] = calls;
      if (text.includes('SELECT COUNT(*)::text AS eligible FROM candidates')) {
        return { rows: [{ eligible: String(this.dryRunCandidates[category] ?? 0) }], rowCount: 1 };
      }
      return { rows: [], rowCount: this.deleteBatches[category]?.shift() ?? 0 };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe('RuntimeEventRetention', () => {
  it('does not start scheduled retention unless explicitly enabled', () => {
    const pool = new FakePool();
    const info = vi.fn();
    const baseOptions = {
      pool: pool as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      logger: { warn: vi.fn(), info },
    };
    const disabledByDefault = new RuntimeEventRetention(baseOptions);

    disabledByDefault.start();
    expect(info).not.toHaveBeenCalled();

    const enabled = new RuntimeEventRetention({ ...baseOptions, enabled: true });
    enabled.start();
    expect(info).toHaveBeenCalledWith(
      'RuntimeEventRetention started: mode=dry-run interval=10m batchLimit=10000 maxBatchesPerCategory=10 legalWatermark=0',
    );
    enabled.stop();
  });

  it('defaults runOnce to read-only dry-run and reports the next bounded batch', async () => {
    const pool = new FakePool();
    pool.billingWatermark = '80';
    pool.maxGlobalSequence = '100';
    pool.dryRunCandidates['tool-delta'] = 7;
    const project = vi.fn();
    const retention = new RuntimeEventRetention({
      pool: pool as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      legalDeleteThroughGlobalSequence: '75',
      projectBillingRuntimeEvents: project,
    });

    const result = await retention.runOnce();

    expect(result).toMatchObject({
      mode: 'dry-run',
      deleted: 0,
      legalWatermark: '75',
      billingWatermark: '80',
      effectiveDeleteThrough: '75',
    });
    expect(result.eligibleByCategory['tool-delta']).toBe(7);
    expect(project).not.toHaveBeenCalled();
    expect(pool.queries.some((query) => /DELETE FROM runtime_events/.test(query))).toBe(false);
  });

  it('records stable blocked states when execute gates fail at run time', async () => {
    const pool = new FakePool();
    const snapshots: any[] = [];
    const options = {
      pool: pool as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      executionMode: 'execute' as const,
      statusRecorder: async (snapshot: unknown) => { snapshots.push(snapshot); },
    };

    const missingAuthorization = new RuntimeEventRetention(options);
    await expect(missingAuthorization.runOnce()).rejects.toThrow(/缺少授权/);
    expect(snapshots.at(-1)).toMatchObject({ state: 'blocked', errorCategory: 'authorization_missing' });
    expect(JSON.stringify(snapshots.at(-1))).not.toContain('authorizationRef');

    const invalidWatermark = new RuntimeEventRetention({ ...options, authorizationRef: 'CHG-1' });
    await expect(invalidWatermark.runOnce()).rejects.toThrow(/watermark 无效/);
    expect(snapshots.at(-1)).toMatchObject({ state: 'blocked', errorCategory: 'legal_watermark_invalid' });
  });

  it('records running and successful dry-run snapshots without failing on recorder errors', async () => {
    const pool = new FakePool();
    const snapshots: any[] = [];
    const retention = new RuntimeEventRetention({
      pool: pool as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      statusRecorder: async (snapshot) => { snapshots.push(snapshot); },
    });

    await retention.runOnce();
    expect(snapshots.map((snapshot) => snapshot.state)).toEqual(['running', 'dry_run_succeeded']);
    expect(snapshots.at(-1)).toMatchObject({
      schemaVersion: 1,
      mode: 'dry-run',
      errorCategory: null,
      watermarks: { legal: '0', billing: '0', effectiveDeleteThrough: '0' },
    });
    expect(snapshots.at(-1).lastSuccessAt).toBeTruthy();

    const warn = vi.fn();
    const recorderFailure = new RuntimeEventRetention({
      pool: pool as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      statusRecorder: async () => { throw new Error('secret database message'); },
      logger: { warn },
    });
    await expect(recorderFailure.runOnce()).resolves.toBeTruthy();
    expect(warn).toHaveBeenCalledWith('RuntimeEventRetention status persistence failed');
  });

  it('bounds every delete by both legal and billing watermarks instead of requiring a moving target catch-up', async () => {
    const pool = new FakePool();
    pool.billingWatermark = '10';
    pool.maxGlobalSequence = '11';
    const retention = createRetention(pool);

    const result = await retention.runOnce();

    expect(result.billingWatermark).toBe('10');
    expect(result.legalWatermark).toBe('999999999999');
    expect(result.effectiveDeleteThrough).toBe('10');
    expect(result.maxGlobalSequence).toBe('11');
    expect(pool.categoryParams['tool-delta']?.[0]?.[1]).toBe('10');
    expect(pool.categoryParams['assistant-stream']?.[0]?.[0]).toBe('10');
    expect(pool.categoryParams['tool-stream-summary']?.[0]?.[0]).toBe('10');
    expect(pool.categoryParams['model-diagnostics']?.[0]?.[1]).toBe('10');
    expect(pool.categoryParams['model-request-finished']?.[0]?.[0]).toBe('10');
    expect(pool.categoryParams['hand-events']?.[0]?.[1]).toBe('10');
  });

  it('requires same-tenant invocation and result so colliding invocation/toolCall IDs cannot delete another tenant delta', async () => {
    const pool = new FakePool();
    pool.billingWatermark = '99';
    pool.maxGlobalSequence = '99';
    const retention = createRetention(pool);

    await retention.runOnce();

    const sql = pool.queries.find((query) => query.includes('retention:tool-delta')) ?? '';
    expect(sql).toContain('ON invocation.tenant_id = e.tenant_id');
    expect(sql).toContain("AND invocation.invocation_id = e.event_json->>'invocationId'");
    expect(sql).toContain("invocation.status IN ('completed', 'failed', 'cancelled')");
    expect(sql).toContain('WHERE result.tenant_id = e.tenant_id');
    expect(sql).toContain("result.event_type = 'tool_result'");
    expect(sql).toContain("result.event_json ? 'toolCallId'");
    expect(sql).toContain("result.event_json->>'toolCallId' = e.event_json->>'toolCallId'");
    expect(sql).toContain('FOR UPDATE OF e SKIP LOCKED');
    expect(pool.categoryParams['tool-delta']?.[0]).toEqual([
      ['tool_output_delta', 'tool_progress'],
      '99',
      10,
      10_000,
    ]);
  });

  it('requires a same-tenant run_finished so colliding session/run IDs cannot delete another tenant stream', async () => {
    const pool = new FakePool();
    pool.billingWatermark = '99';
    pool.maxGlobalSequence = '99';
    const retention = createRetention(pool);

    await retention.runOnce();

    const sql = pool.queries.find((query) => query.includes('retention:assistant-stream')) ?? '';
    expect(sql).toContain("e.event_type = 'assistant_stream_event'");
    expect(sql).toContain('WHERE terminal.tenant_id = e.tenant_id');
    expect(sql).toContain('terminal.session_id = e.session_id');
    expect(sql).toContain('terminal.run_id IS NOT DISTINCT FROM e.run_id');
    expect(sql).toContain("terminal.event_type = 'run_finished'");
    expect(sql).toContain('FOR UPDATE OF e SKIP LOCKED');
    expect(pool.categoryParams['assistant-stream']?.[0]).toEqual(['99', 10, 10_000]);
  });

  it('applies separate summary and model diagnostic TTLs without archive or manual vacuum', async () => {
    const pool = new FakePool();
    pool.billingWatermark = '99';
    pool.maxGlobalSequence = '99';
    const retention = createRetention(pool);

    await retention.runOnce();

    expect(pool.categoryParams['tool-stream-summary']?.[0]).toEqual(['99', 24, 7, 10_000]);
    expect(pool.categoryParams['model-diagnostics']?.[0]).toEqual([
      ['model_request_started', 'model_request_checkpoint'],
      '99',
      7,
      10_000,
    ]);
    expect(pool.categoryParams['model-request-finished']?.[0]).toEqual(['99', 30, 10_000]);
    const sql = pool.queries.join('\n');
    expect(sql).not.toContain('VACUUM');
    expect(sql).not.toContain('archive');
  });

  it('deletes atomic batches until a partial batch and reports each category', async () => {
    const pool = new FakePool();
    pool.billingWatermark = '99';
    pool.maxGlobalSequence = '99';
    pool.deleteBatches = {
      'tool-delta': [2, 1],
      'assistant-stream': [2],
      'tool-stream-summary': [3],
      'model-diagnostics': [4],
      'model-request-finished': [5],
      'hand-events': [6],
    };
    const retention = createRetention(pool, { batchLimit: 2 });

    const result = await retention.runOnce();

    expect(result.deleted).toBe(23);
    expect(result.deletedByCategory).toEqual({
      'tool-delta': 3,
      'assistant-stream': 2,
      'tool-stream-summary': 3,
      'model-diagnostics': 4,
      'model-request-finished': 5,
      'hand-events': 6,
    });
    expect(pool.categoryParams['tool-delta']).toHaveLength(2);
  });

  it('records partial failure and a later recovery without persisting error messages', async () => {
    const pool = new FakePool();
    pool.billingWatermark = '99';
    pool.maxGlobalSequence = '99';
    pool.deleteBatches['tool-delta'] = [1, 1];
    pool.failCategoryOnce = 'assistant-stream';
    const snapshots: any[] = [];
    const retention = createRetention(pool, {
      statusRecorder: async (snapshot) => { snapshots.push(snapshot); },
    });

    await expect(retention.runOnce()).rejects.toThrow('sensitive SQL failure');
    expect(snapshots.at(-1)).toMatchObject({
      state: 'failed', errorCategory: 'partial_failure',
      categories: { 'tool-delta': { eligible: 1, deleted: 1 } },
    });
    expect(JSON.stringify(snapshots.at(-1))).not.toContain('sensitive SQL failure');

    await expect(retention.runOnce()).resolves.toMatchObject({ mode: 'execute' });
    expect(snapshots.at(-1)).toMatchObject({ state: 'execute_succeeded', errorCategory: null });
    expect(snapshots.at(-1).lastSuccessAt).toBeTruthy();
  });

  it('caps each category per run even when every delete returns a full batch', async () => {
    const pool = new FakePool();
    pool.billingWatermark = '99';
    pool.maxGlobalSequence = '99';
    pool.deleteBatches['tool-delta'] = [2, 2, 1];
    const retention = createRetention(pool, { batchLimit: 2, maxBatchesPerCategory: 2 });

    const result = await retention.runOnce();

    expect(result.deletedByCategory['tool-delta']).toBe(4);
    expect(pool.categoryParams['tool-delta']).toHaveLength(2);
  });

  it('advances billing projection when possible before fixing the cleanup watermark', async () => {
    const pool = new FakePool();
    pool.billingWatermark = '10';
    pool.maxGlobalSequence = '20';
    const project = vi.fn(async () => {
      pool.billingWatermark = '20';
      return { lastProjectedSequence: 20 };
    });
    const retention = createRetention(pool, { projectBillingRuntimeEvents: project });

    const result = await retention.runOnce();

    expect(project).toHaveBeenCalledWith(10_000);
    expect(result.billingWatermark).toBe('20');
    expect(pool.categoryParams['tool-delta']?.[0]?.[1]).toBe('20');
  });
});

function createRetention(
  pool: FakePool,
  overrides: Partial<ConstructorParameters<typeof RuntimeEventRetention>[0]> = {},
): RuntimeEventRetention {
  return new RuntimeEventRetention({
    pool: pool as any,
    eventsTable: 'runtime_events',
    toolInvocationsTable: 'runtime_tool_invocations',
    billingProjectionStateTable: 'runtime_billing_projection_state',
    executionMode: 'execute',
    legalDeleteThroughGlobalSequence: '999999999999',
    authorizationRef: 'CHG-test',
    logger: { warn: vi.fn(), info: vi.fn() },
    ...overrides,
  });
}

function retentionCategory(text: string): RetentionCategory | undefined {
  const match = text.match(/\/\* retention:([^ ]+) \*\//);
  return match?.[1] as RetentionCategory | undefined;
}
