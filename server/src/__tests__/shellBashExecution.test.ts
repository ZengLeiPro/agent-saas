import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ServerLocalExecutionProvider } from '../agent/toolRuntime.js';

describe('ServerLocal Shell dialect', () => {
  it('supports Bash pipefail when Bash is available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-shell-bash-'));
    try {
      const response = await new ServerLocalExecutionProvider().execute({
        toolName: 'Shell',
        input: { command: 'set -o pipefail; false | true' },
        context: { workspace: { root, executionTarget: 'server-local' } },
      });
      expect(response).toMatchObject({ status: 'error', error: expect.stringContaining('command exited 1') });
      if (response.status === 'error') expect(response.error).not.toContain('Illegal option');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
