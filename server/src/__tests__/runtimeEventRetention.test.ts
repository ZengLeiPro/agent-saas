import { describe, expect, it, vi } from 'vitest';

import { RuntimeEventRetention } from '../runtime/runtimeEventRetention.js';

type RetentionCategory =
  | 'tool-delta'
  | 'tool-stream-summary'
  | 'model-diagnostics'
  | 'model-request-finished'
  | 'hand-events';

class FakePool {
  billingWatermark = '0';
  maxGlobalSequence = '0';
  deleteBatches: Partial<Record<RetentionCategory, number[]>> = {};
  categoryParams: Partial<Record<RetentionCategory, unknown[][]>> = {};
  queries: string[] = [];

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
      const calls = this.categoryParams[category] ?? [];
      calls.push(params ?? []);
      this.categoryParams[category] = calls;
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
    expect(info).toHaveBeenCalledWith('RuntimeEventRetention started: interval=10m batchLimit=10000');
    enabled.stop();
  });

  it('bounds every delete by the current billing watermark instead of requiring a moving target catch-up', async () => {
    const pool = new FakePool();
    pool.billingWatermark = '10';
    pool.maxGlobalSequence = '11';
    const retention = createRetention(pool);

    const result = await retention.runOnce();

    expect(result.billingWatermark).toBe('10');
    expect(result.maxGlobalSequence).toBe('11');
    expect(pool.categoryParams['tool-delta']?.[0]?.[1]).toBe('10');
    expect(pool.categoryParams['tool-stream-summary']?.[0]?.[0]).toBe('10');
    expect(pool.categoryParams['model-diagnostics']?.[0]?.[1]).toBe('10');
    expect(pool.categoryParams['model-request-finished']?.[0]?.[0]).toBe('10');
    expect(pool.categoryParams['hand-events']?.[0]?.[1]).toBe('10');
  });

  it('only deletes tool deltas after both terminal invocation and durable tool_result with a 10 minute grace', async () => {
    const pool = new FakePool();
    pool.billingWatermark = '99';
    pool.maxGlobalSequence = '99';
    const retention = createRetention(pool);

    await retention.runOnce();

    const sql = pool.queries.find((query) => query.includes('retention:tool-delta')) ?? '';
    expect(sql).toContain("invocation.status IN ('completed', 'failed', 'cancelled')");
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
      'tool-stream-summary': [3],
      'model-diagnostics': [4],
      'model-request-finished': [5],
      'hand-events': [6],
    };
    const retention = createRetention(pool, { batchLimit: 2 });

    const result = await retention.runOnce();

    expect(result.deleted).toBe(21);
    expect(result.deletedByCategory).toEqual({
      'tool-delta': 3,
      'tool-stream-summary': 3,
      'model-diagnostics': 4,
      'model-request-finished': 5,
      'hand-events': 6,
    });
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
    logger: { warn: vi.fn(), info: vi.fn() },
    ...overrides,
  });
}

function retentionCategory(text: string): RetentionCategory | undefined {
  const match = text.match(/\/\* retention:([^ ]+) \*\//);
  return match?.[1] as RetentionCategory | undefined;
}
