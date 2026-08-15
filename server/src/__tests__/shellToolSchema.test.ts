import { describe, expect, it } from 'vitest';

import { shellToolSchema } from '../agent/shellToolSchema.js';

describe('Shell snapshot execution schema', () => {
  it('accepts the optional snapshot execution mode', () => {
    expect(shellToolSchema.parse({ command: 'pnpm test', execution: 'snapshot', snapshotCwd: 'code/agent-saas' }))
      .toEqual({ command: 'pnpm test', execution: 'snapshot', snapshotCwd: 'code/agent-saas' });
  });

  it('rejects snapshotCwd without snapshot execution', () => {
    expect(() => shellToolSchema.parse({ command: 'pnpm test', snapshotCwd: 'code/agent-saas' }))
      .toThrow(/snapshotCwd/);
  });
});
