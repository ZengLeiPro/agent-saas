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
  failCategoryOnCall: Partial<Record<RetentionCategory, number>> = {};
  categoryCalls: Partial<Record<RetentionCategory, number>> = {};

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
      const callNo = (this.categoryCalls[category] ?? 0) + 1;
      this.categoryCalls[category] = callNo;
      if (this.failCategoryOnce === category || this.failCategoryOnCall[category] === callNo) {
        this.failCategoryOnce = undefined;
        delete this.failCategoryOnCall[category];
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

  it('does not start scheduled retention unless explicitly enabled', async () => {
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

    await disabledByDefault.start();
    expect(info).not.toHaveBeenCalled();

    const enabled = new RuntimeEventRetention({ ...baseOptions, enabled: true });
    await enabled.start();
    expect(info).toHaveBeenCalledWith(
      'RuntimeEventRetention started: mode=dry-run interval=10m batchLimit=10000 maxBatchesPerCategory=10 legalWatermark=0',
    );
    enabled.stop();
  });

  it.each([
    { fromMode: 'dry-run' as const, toMode: 'execute' as const, fromInterval: 10, toInterval: 30 },
    { fromMode: 'execute' as const, toMode: 'dry-run' as const, fromInterval: 30, toInterval: 5 },
  ])('records current startup truth before arming a $toMode timer after a $fromMode restart', async ({
    fromMode,
    toMode,
    fromInterval,
    toInterval,
  }) => {
    const pool = new FakePool();
    const previousSnapshots: any[] = [];
    const previous = new RuntimeEventRetention({
      pool: pool as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      enabled: true,
      executionMode: fromMode,
      sweepIntervalMinutes: fromInterval,
      legalDeleteThroughGlobalSequence: '100',
      authorizationRef: 'CHG-test',
      statusRecorder: async (snapshot) => { previousSnapshots.push(snapshot); },
    });
    await previous.start();
    expect(previousSnapshots).toEqual([expect.objectContaining({
      state: 'scheduled',
      mode: fromMode,
      sweepIntervalMinutes: fromInterval,
      nextScheduledAt: expect.any(String),
      authority: { writerId: expect.any(String), claim: true },
    })]);
    previous.stop();

    const currentSnapshots: any[] = [];
    const beforeStart = Date.now();
    const current = new RuntimeEventRetention({
      pool: pool as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      enabled: true,
      executionMode: toMode,
      sweepIntervalMinutes: toInterval,
      legalDeleteThroughGlobalSequence: '100',
      authorizationRef: 'CHG-test',
      statusRecorder: async (snapshot) => { currentSnapshots.push(snapshot); },
    });
    await current.start();

    expect(currentSnapshots).toEqual([expect.objectContaining({
      state: 'scheduled',
      mode: toMode,
      sweepIntervalMinutes: toInterval,
      lastStartedAt: null,
      lastCompletedAt: null,
      nextScheduledAt: expect.any(String),
      authority: { writerId: expect.any(String), claim: true },
    })]);
    expect(currentSnapshots[0].authority.writerId).not.toBe(previousSnapshots[0].authority.writerId);
    const scheduledMs = Date.parse(currentSnapshots[0].nextScheduledAt);
    expect(scheduledMs).toBeGreaterThanOrEqual(beforeStart + toInterval * 60_000);
    expect(scheduledMs).toBeLessThanOrEqual(Date.now() + toInterval * 60_000);

    await current.runOnce();
    expect(currentSnapshots.map((snapshot) => snapshot.state)).toEqual([
      'scheduled',
      'running',
      toMode === 'execute' ? 'execute_succeeded' : 'dry_run_succeeded',
    ]);
    expect(currentSnapshots.at(-1)).toMatchObject({
      mode: toMode,
      sweepIntervalMinutes: toInterval,
      nextScheduledAt: currentSnapshots[0].nextScheduledAt,
    });
    current.stop();
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

  it('records a blocked snapshot from the enabled worker startup path without querying events', async () => {
    const pool = new FakePool();
    const snapshots: any[] = [];
    const warn = vi.fn();
    const retention = new RuntimeEventRetention({
      pool: pool as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      enabled: true,
      executionMode: 'execute',
      legalDeleteThroughGlobalSequence: '100',
      statusRecorder: async (snapshot) => { snapshots.push(snapshot); },
      logger: { warn },
    });

    await retention.start();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ state: 'blocked', errorCategory: 'authorization_missing' });
    expect(snapshots[0].nextScheduledAt).toEqual(expect.any(String));
    expect(pool.queries).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith('RuntimeEventRetention configuration blocked: category=authorization_missing');
    retention.stop();
  });

  it('supports explicit startup retry without arming the sweep timer', async () => {
    const pool = new FakePool();
    const snapshots: any[] = [];
    const warn = vi.fn();
    const info = vi.fn();
    let persistenceAvailable = false;
    const retention = new RuntimeEventRetention({
      pool: pool as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      enabled: true,
      statusRecorder: async (snapshot) => {
        if (!persistenceAvailable) throw new Error('sensitive database failure');
        snapshots.push(snapshot);
      },
      logger: { warn, info },
    });

    await retention.start();
    expect(snapshots).toHaveLength(0);
    expect(retention.isStatusPersistenceAvailable()).toBe(false);
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('RuntimeEventRetention status persistence failed');
    expect(warn).toHaveBeenCalledWith('RuntimeEventRetention startup not scheduled: status persistence unavailable');

    persistenceAvailable = true;
    await retention.start();
    expect(snapshots).toEqual([expect.objectContaining({ state: 'scheduled', nextScheduledAt: expect.any(String) })]);
    expect(retention.isStatusPersistenceAvailable()).toBe(true);
    expect(info).toHaveBeenCalledOnce();
    retention.stop();
  });

  it('fails dedicated worker startup when status authority cannot be established', async () => {
    const retention = new RuntimeEventRetention({
      pool: new FakePool() as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      enabled: true,
      startupFailureMode: 'throw',
      statusRecorder: async () => { throw new Error('db down'); },
      logger: { warn: vi.fn() },
    });

    await expect(retention.start()).rejects.toThrow(
      'runtime-worker failed to establish RuntimeEventRetention status authority',
    );
    expect(retention.isStatusPersistenceAvailable()).toBe(false);
    retention.stop();
  });

  it('retries status-only startup for the all role and stops retrying after recovery', async () => {
    vi.useFakeTimers();
    const snapshots: any[] = [];
    let persistenceAvailable = false;
    const retention = new RuntimeEventRetention({
      pool: new FakePool() as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      enabled: true,
      startupFailureMode: 'retry',
      statusRecorder: async (snapshot) => {
        if (!persistenceAvailable) throw new Error('db down');
        snapshots.push(snapshot);
      },
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    try {
      await retention.start();
      expect(retention.isStatusPersistenceAvailable()).toBe(false);
      expect(vi.getTimerCount()).toBe(1);

      persistenceAvailable = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(snapshots).toEqual([
        expect.objectContaining({ state: 'scheduled', nextScheduledAt: expect.any(String) }),
      ]);
      expect(retention.isStatusPersistenceAvailable()).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      retention.stop();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  it.each([
    ['旧 startup 成功不得覆盖新失败', true, false, false],
    ['旧失败不得覆盖新成功', false, true, true],
  ])('%s', async (_label, firstSucceeds, secondSucceeds, expectedAvailable) => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let recorderCalls = 0;
    const retention = new RuntimeEventRetention({
      pool: new FakePool() as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      enabled: true,
      statusRecorder: async () => {
        recorderCalls += 1;
        if (recorderCalls === 1) {
          markFirstEntered();
          await firstCanFinish;
          if (!firstSucceeds) throw new Error('old generation failed');
        } else if (!secondSucceeds) {
          throw new Error('current generation failed');
        }
      },
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    try {
      const firstStart = retention.start();
      await firstEntered;
      retention.stop();
      const secondStart = retention.start();
      releaseFirst();
      await firstStart;
      await secondStart;

      expect(retention.isStatusPersistenceAvailable()).toBe(expectedAvailable);
      expect(vi.getTimerCount()).toBe(expectedAvailable ? 1 : 0);
    } finally {
      retention.stop();
      vi.useRealTimers();
    }
  });

  it('serializes restart after an in-flight sweep and preserves Store write order', async () => {
    vi.useFakeTimers();
    let releaseRunning!: () => void;
    let markRunningEntered!: () => void;
    const runningEntered = new Promise<void>((resolve) => { markRunningEntered = resolve; });
    const runningCanFinish = new Promise<void>((resolve) => { releaseRunning = resolve; });
    const states: string[] = [];
    const retention = new RuntimeEventRetention({
      pool: new FakePool() as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      enabled: true,
      statusRecorder: async (snapshot) => {
        states.push(snapshot.state);
        if (snapshot.state === 'running') {
          markRunningEntered();
          await runningCanFinish;
        }
      },
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    try {
      await retention.start();
      const sweep = retention.runOnce();
      await runningEntered;
      retention.stop();
      expect(retention.isStatusPersistenceAvailable()).toBe(false);
      let restarted = false;
      const restart = retention.start().then(() => { restarted = true; });
      await Promise.resolve();
      expect(restarted).toBe(false);

      releaseRunning();
      await sweep;
      await restart;
      expect(retention.isStatusPersistenceAvailable()).toBe(true);
      expect(states).toEqual(['scheduled', 'running', 'scheduled']);
    } finally {
      retention.stop();
      vi.useRealTimers();
    }
  });

  it('never arms execute scheduling without a status recorder', async () => {
    vi.useFakeTimers();
    const retention = new RuntimeEventRetention({
      pool: new FakePool() as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      enabled: true,
      executionMode: 'execute',
      legalDeleteThroughGlobalSequence: '100',
      authorizationRef: 'CHG-test',
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    try {
      await retention.start();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      retention.stop();
      vi.useRealTimers();
    }
  });

  it('waits for in-flight startup persistence before quiesce completes', async () => {
    let releaseStartup!: () => void;
    let markStartupEntered!: () => void;
    const startupEntered = new Promise<void>((resolve) => { markStartupEntered = resolve; });
    const startupCanFinish = new Promise<void>((resolve) => { releaseStartup = resolve; });
    const retention = new RuntimeEventRetention({
      pool: new FakePool() as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      enabled: true,
      statusRecorder: async () => {
        markStartupEntered();
        await startupCanFinish;
      },
    });
    const startup = retention.start();
    await startupEntered;
    let quiesced = false;
    const quiesce = retention.quiesce().then(() => { quiesced = true; });
    await Promise.resolve();
    expect(quiesced).toBe(false);

    releaseStartup();
    await startup;
    await quiesce;
    expect(retention.isStatusPersistenceAvailable()).toBe(false);
  });

  it('does not leave a hidden timer when successful stop and restart overlap startup persistence', async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let recorderCalls = 0;
    const info = vi.fn();
    const retention = new RuntimeEventRetention({
      pool: new FakePool() as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      enabled: true,
      statusRecorder: async () => {
        recorderCalls += 1;
        if (recorderCalls === 1) {
          markFirstEntered();
          await firstCanFinish;
        }
      },
      logger: { info },
    });
    try {
      const firstStart = retention.start();
      await firstEntered;
      retention.stop();
      const secondStart = retention.start();
      releaseFirst();
      await firstStart;
      await secondStart;

      expect(recorderCalls).toBe(2);
      expect(info).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      retention.stop();
      vi.useRealTimers();
    }
  });

  it('blocks an enabled execute run before querying EventStore when running status persistence fails', async () => {
    const pool = new FakePool();
    let persistenceAvailable = true;
    const retention = new RuntimeEventRetention({
      pool: pool as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      enabled: true,
      executionMode: 'execute',
      legalDeleteThroughGlobalSequence: '100',
      authorizationRef: 'CHG-test',
      statusRecorder: async () => {
        if (!persistenceAvailable) throw new Error('sensitive database failure');
      },
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    await retention.start();
    persistenceAvailable = false;
    await expect(retention.runOnce()).rejects.toThrow(/状态持久化不可用/);
    expect(pool.queries).toHaveLength(0);
    retention.stop();
  });

  it('waits for an old in-flight sweep and arms only the restarted schedule', async () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    const query = pool.query.bind(pool);
    let releaseBilling!: () => void;
    let markBillingEntered!: () => void;
    const billingEntered = new Promise<void>((resolve) => { markBillingEntered = resolve; });
    const billingCanFinish = new Promise<void>((resolve) => { releaseBilling = resolve; });
    let delayBilling = true;
    pool.query = async (text: string, params?: unknown[]) => {
      if (delayBilling && text.includes('FROM runtime_billing_projection_state')) {
        delayBilling = false;
        markBillingEntered();
        await billingCanFinish;
      }
      return query(text, params);
    };
    const retention = new RuntimeEventRetention({
      pool: pool as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      enabled: true,
      sweepIntervalMinutes: 1,
      statusRecorder: async () => undefined,
    });
    try {
      await retention.start();
      vi.advanceTimersByTime(60_000);
      await billingEntered;
      retention.stop();
      const restart = retention.start();
      releaseBilling();
      await restart;
      await Promise.resolve();
      await Promise.resolve();

      expect(vi.getTimerCount()).toBe(1);
    } finally {
      retention.stop();
      vi.useRealTimers();
    }
  });

  it('explicitly reclaims one fenced writer across enabled dry-run snapshots', async () => {
    const pool = new FakePool();
    const snapshots: any[] = [];
    const retention = new RuntimeEventRetention({
      pool: pool as any,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state', enabled: true,
      statusRecorder: async (snapshot) => { snapshots.push(snapshot); },
    });

    await retention.runOnce();
    expect(snapshots.map((snapshot) => snapshot.state)).toEqual(['running', 'dry_run_succeeded']);
    expect(snapshots.map((snapshot) => snapshot.authority)).toEqual([
      { writerId: expect.any(String), claim: false }, { writerId: expect.any(String), claim: false },
    ]);
    expect(snapshots[0].authority.writerId).toBe(snapshots[1].authority.writerId);
    expect(snapshots.at(-1)).toMatchObject({
      schemaVersion: 1,
      mode: 'dry-run',
      errorCategory: null,
      watermarks: { legal: '0', billing: '0', effectiveDeleteThrough: '0' },
    });
    expect(snapshots.at(-1).lastSuccessAt).toBeTruthy();
    await retention.reassertStatusAuthority(true);
    expect(snapshots.at(-1)).toMatchObject({ state: 'dry_run_succeeded',
      authority: { writerId: snapshots[0].authority.writerId, claim: true } });

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

  it('retains committed batches when the same category fails later, then records recovery', async () => {
    const pool = new FakePool();
    pool.billingWatermark = '99';
    pool.maxGlobalSequence = '99';
    pool.deleteBatches['tool-delta'] = [2, 1];
    pool.failCategoryOnCall['tool-delta'] = 2;
    const snapshots: any[] = [];
    const retention = createRetention(pool, {
      batchLimit: 2,
      statusRecorder: async (snapshot) => { snapshots.push(snapshot); },
    });

    await expect(retention.runOnce()).rejects.toThrow('sensitive SQL failure');
    expect(snapshots.at(-1)).toMatchObject({
      state: 'failed', errorCategory: 'partial_failure',
      categories: { 'tool-delta': { eligible: 2, deleted: 2 } },
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
