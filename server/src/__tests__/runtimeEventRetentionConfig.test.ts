import { describe, expect, it, vi } from 'vitest';

import { parseAppConfig } from '../app/config.js';
import { retentionWorkerOptions } from '../app/runtimeEventRetentionConfig.js';
import { RuntimeEventRetention } from '../runtime/runtimeEventRetention.js';

const baseConfig = { agent: { cwd: '/tmp/agent' }, server: { port: 3200 } };

describe('runtime event retention config', () => {
  it('accepts bounded retention windows and leaves execute gate failures observable at worker startup', () => {
    const config = parseAppConfig({
      ...baseConfig,
      runtimeEventRetention: {
        enabled: true,
        executionMode: 'execute',
        legalDeleteThroughGlobalSequence: '12345678901234567890',
        authorizationRef: 'CHG-198',
        sweepIntervalMinutes: 10,
        batchLimit: 10_000,
        terminalDeltaGraceMinutes: 10,
        successfulSummaryRetentionHours: 24,
        failedSummaryRetentionDays: 7,
        modelDiagnosticRetentionDays: 7,
        modelRequestFinishedRetentionDays: 30,
        handEventRetentionDays: 30,
      },
    });
    expect(config.runtimeEventRetention).toMatchObject({
      enabled: true,
      executionMode: 'execute',
      legalDeleteThroughGlobalSequence: '12345678901234567890',
      authorizationRef: 'CHG-198',
      modelDiagnosticRetentionDays: 7,
      modelRequestFinishedRetentionDays: 30,
    });
    expect(() => parseAppConfig({
      ...baseConfig,
      runtimeEventRetention: { modelDiagnosticRetentionDays: 30, modelRequestFinishedRetentionDays: 7 },
    })).toThrow(/不得短于/);
    expect(parseAppConfig({
      ...baseConfig,
      runtimeEventRetention: { enabled: true, executionMode: 'execute', legalDeleteThroughGlobalSequence: '100' },
    }).runtimeEventRetention).toMatchObject({ enabled: true, executionMode: 'execute' });
    expect(parseAppConfig({
      ...baseConfig,
      runtimeEventRetention: { enabled: true, executionMode: 'execute', authorizationRef: 'CHG-198', legalDeleteThroughGlobalSequence: '0' },
    }).runtimeEventRetention).toMatchObject({ enabled: true, legalDeleteThroughGlobalSequence: '0' });
  });

  it('records a fail-closed blocked snapshot through parsed app config and worker options', async () => {
    const config = parseAppConfig({
      ...baseConfig,
      runtimeEventRetention: {
        enabled: true,
        executionMode: 'execute',
        legalDeleteThroughGlobalSequence: '100',
      },
    });
    const snapshots: unknown[] = [];
    const query = vi.fn();
    const worker = new RuntimeEventRetention({
      pool: { query } as never,
      eventsTable: 'runtime_events',
      toolInvocationsTable: 'runtime_tool_invocations',
      billingProjectionStateTable: 'runtime_billing_projection_state',
      ...retentionWorkerOptions(config.runtimeEventRetention),
      statusRecorder: (snapshot) => { snapshots.push(snapshot); },
    });

    await worker.start();

    expect(snapshots).toEqual([expect.objectContaining({ state: 'blocked', errorCategory: 'authorization_missing' })]);
    expect(query).not.toHaveBeenCalled();
    worker.stop();
  });

  it('normalizes PostgreSQL tablePrefix to the unquoted identifier form', () => {
    const config = parseAppConfig({
      ...baseConfig,
      runtimeEventStore: { backend: 'pg', connectionString: 'postgres://example/test', tablePrefix: 'Agent_Runtime' },
    });

    expect(config.runtimeEventStore).toMatchObject({ tablePrefix: 'agent_runtime' });
  });
});
