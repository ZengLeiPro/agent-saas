import { describe, expect, it } from 'vitest';

import { resolveSandboxWorkloadDescriptor } from '../runtime/runtimeHandRegistration.js';

describe('resolveSandboxWorkloadDescriptor immutable workload precedence', () => {
  it.each([
    {
      name: 'existing 定版不可被显式 memory 重分类',
      existing: { kind: 'interactive' as const },
      requested: { kind: 'memory' as const },
      replay: { kind: 'cron' as const },
      toolProfile: 'memory_consolidate',
      expected: { kind: 'interactive' as const },
    },
    {
      name: '新请求优先于 replay 来源',
      existing: undefined,
      requested: { kind: 'cron' as const },
      replay: { kind: 'interactive' as const },
      toolProfile: undefined,
      expected: { kind: 'cron' as const },
    },
    {
      name: 'memory tool profile 是创建请求并优先于 replay 来源',
      existing: undefined,
      requested: undefined,
      replay: { kind: 'interactive' as const },
      toolProfile: 'memory_consolidate',
      expected: { kind: 'memory' as const },
    },
    {
      name: '无 existing/requested 时沿用 replay',
      existing: undefined,
      requested: undefined,
      replay: { kind: 'taskboard' as const, purpose: 'review' as const },
      toolProfile: undefined,
      expected: { kind: 'taskboard' as const, purpose: 'review' as const },
    },
  ])('$name', ({ existing, replay, requested, toolProfile, expected }) => {
    expect(resolveSandboxWorkloadDescriptor(existing, replay, requested, toolProfile, 'web')).toEqual(expected);
  });

  it('新 L2 dispatch 显式请求 memory 时覆盖普通来源 replay workload', () => {
    expect(resolveSandboxWorkloadDescriptor(
      undefined,
      { kind: 'interactive' },
      { kind: 'memory' },
      undefined,
      'web',
    )).toEqual({ kind: 'memory' });
  });

  it('无已有、请求或 replay 时按 channel fallback', () => {
    expect(resolveSandboxWorkloadDescriptor(undefined, undefined, undefined, undefined, 'cron'))
      .toEqual({ kind: 'cron' });
  });
});
