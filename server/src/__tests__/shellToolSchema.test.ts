import { describe, expect, it } from 'vitest';

import { shellToolSchema } from '../agent/shellToolSchema.js';

describe('Shell snapshot execution schema', () => {
  it('uses one cwd field for workspace and snapshot execution', () => {
    expect(shellToolSchema.parse({ command: 'pnpm test', execution: 'snapshot', cwd: 'code/agent-saas' }))
      .toEqual({ command: 'pnpm test', execution: 'snapshot', cwd: 'code/agent-saas' });
    expect(shellToolSchema.parse({ command: 'git status', cwd: 'code/agent-saas' }))
      .toEqual({ command: 'git status', cwd: 'code/agent-saas' });
  });

  it('does not expose the retired snapshotCwd field', () => {
    const properties = (shellToolSchema.toJSONSchema() as { properties?: Record<string, unknown> }).properties;
    expect(properties).toHaveProperty('cwd');
    expect(properties).not.toHaveProperty('snapshotCwd');
  });
});
