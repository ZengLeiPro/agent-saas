import { describe, expect, it } from 'vitest';

import { runtimeSchedulerConfigSchema } from '../app/runtimeSchedulerConfigSchema.js';

describe('runtimeScheduler config schema', () => {
  it('accepts a non-negative foreground reserve', () => {
    expect(runtimeSchedulerConfigSchema.parse({ foregroundReservedRuns: 10 }).foregroundReservedRuns).toBe(10);
    expect(() => runtimeSchedulerConfigSchema.parse({ foregroundReservedRuns: -1 })).toThrow();
  });
});
