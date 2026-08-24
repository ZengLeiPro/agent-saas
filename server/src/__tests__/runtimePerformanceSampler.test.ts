import { describe, expect, it, vi } from 'vitest';

import {
  RuntimePerformanceSampler,
  parseCgroupIo,
  parseKeyValueNumbers,
  parsePressure,
  runtimePerformanceSamplerEnabled,
  runtimePerformanceSamplerIntervalMs,
} from '../runtime/runtimePerformanceSampler.js';

describe('RuntimePerformanceSampler parsers', () => {
  it('parses cgroup key-value metrics', () => {
    expect(parseKeyValueNumbers('anon 123\nfile 456\nmax nope\n')).toEqual({
      anon: 123,
      file: 456,
    });
  });

  it('parses PSI some/full windows', () => {
    expect(parsePressure([
      'some avg10=1.25 avg60=2.5 avg300=3.75 total=12345',
      'full avg10=0.10 avg60=0.20 avg300=0.30 total=456',
    ].join('\n'))).toEqual({
      someAvg10: 1.25,
      someAvg60: 2.5,
      someAvg300: 3.75,
      someTotalMicros: 12345,
      fullAvg10: 0.1,
      fullAvg60: 0.2,
      fullAvg300: 0.3,
      fullTotalMicros: 456,
    });
  });

  it('aggregates cgroup IO across devices', () => {
    expect(parseCgroupIo([
      '8:0 rbytes=100 wbytes=200 rios=3 wios=4',
      '8:16 rbytes=10 wbytes=20 rios=1 wios=2',
    ].join('\n'))).toEqual({
      readBytes: 110,
      writeBytes: 220,
      readOperations: 4,
      writeOperations: 6,
    });
  });
});

describe('RuntimePerformanceSampler configuration', () => {
  it('defaults on, accepts explicit off and clamps short intervals', () => {
    expect(runtimePerformanceSamplerEnabled({})).toBe(true);
    expect(runtimePerformanceSamplerEnabled({ AGENT_SAAS_RUNTIME_PERF_ENABLED: 'false' })).toBe(false);
    expect(runtimePerformanceSamplerIntervalMs({ AGENT_SAAS_RUNTIME_PERF_INTERVAL_MS: '100' })).toBe(1_000);
    expect(runtimePerformanceSamplerIntervalMs({ AGENT_SAAS_RUNTIME_PERF_INTERVAL_MS: '5000' })).toBe(5_000);
  });

  it('emits a structured process/workload sample', async () => {
    const info = vi.fn();
    const sampler = new RuntimePerformanceSampler({
      getWorkloadSnapshot: async () => ({
      scheduler: {
        maxConcurrentRuns: 16,
        foregroundReservedRuns: 4,
        executionEnabled: true,
          inFlightRuns: 2,
          inFlightBackgroundRuns: 1,
          oldestInFlightAgeMs: 500,
          byRunClass: { foreground: 1, background_agent: 1 },
          byChannel: { web: 2 },
          byExecutionTarget: { 'server-container': 2 },
          byModel: { test: 2 },
        },
        activeRuns: {
          pending: 3,
          running: 2,
          waitingApproval: 0,
          waitingUser: 0,
          waitingHand: 0,
          blocking: 2,
          total: 5,
        },
      }),
      logger: { info, warn: vi.fn() },
    });

    const sample = await sampler.sampleOnce();

    expect(sample).toMatchObject({
      schemaVersion: 1,
      process: {
        pid: process.pid,
        rssBytes: expect.any(Number),
        heapUsedBytes: expect.any(Number),
        eventLoopDelayP95Ms: expect.any(Number),
      },
      workload: {
        scheduler: { inFlightRuns: 2, maxConcurrentRuns: 16 },
        activeRuns: { pending: 3, running: 2 },
      },
    });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('[RuntimePerf] {'));
    sampler.stop();
  });
});
