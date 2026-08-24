import { describe, expect, it } from 'vitest';

import { parseAppConfig } from '../app/config.js';

const baseConfig = { agent: { cwd: '/tmp/agent' }, server: { port: 3200 } };

describe('runtime event retention config', () => {
  it('accepts bounded retention windows and requires execute watermarks', () => {
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
    expect(() => parseAppConfig({
      ...baseConfig,
      runtimeEventRetention: { executionMode: 'execute', legalDeleteThroughGlobalSequence: '100' },
    })).toThrow(/authorizationRef/);
    expect(() => parseAppConfig({
      ...baseConfig,
      runtimeEventRetention: { executionMode: 'execute', authorizationRef: 'CHG-198', legalDeleteThroughGlobalSequence: '0' },
    })).toThrow(/正数/);
  });
});
