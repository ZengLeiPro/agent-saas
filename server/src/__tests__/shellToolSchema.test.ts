import { describe, expect, it } from 'vitest';

import { shellToolSchema } from '../agent/shellToolSchema.js';

describe('Shell snapshot execution schema', () => {
  it('accepts the optional snapshot execution mode', () => {
    expect(shellToolSchema.parse({ command: 'pnpm test', execution: 'snapshot' }))
      .toEqual({ command: 'pnpm test', execution: 'snapshot' });
  });
});
