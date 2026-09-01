import { describe, expect, it } from 'vitest';

import { resolveSandboxWorkloadDescriptor } from '../runtime/runtimeHandRegistration.js';

describe('resolveSandboxWorkloadDescriptor workload precedence', () => {
  it.each([
    { kind: 'interactive' as const },
    { kind: 'taskboard' as const, taskKind: 'delivery' as const, purpose: 'work' as const },
  ])('memory consolidation 不继承来源 workload：$kind', (source) => {
    expect(resolveSandboxWorkloadDescriptor(undefined, source, { kind: 'memory' }, 'memory_consolidate', 'web'))
      .toEqual({ kind: 'memory' });
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

  it('普通 resume 仍保留既有 workload', () => {
    expect(resolveSandboxWorkloadDescriptor({ kind: 'taskboard', purpose: 'review' }, undefined, undefined, undefined, 'web'))
      .toEqual({ kind: 'taskboard', purpose: 'review' });
  });
});
