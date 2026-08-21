import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ServerLocalExecutionProvider, type WorkspaceRef } from '../agent/toolRuntime.js';

function workspace(root: string): WorkspaceRef {
  return {
    root,
    userId: 'admin-1',
    username: 'admin',
    sessionId: 'session-1',
    executionTarget: 'server-local',
  };
}

describe('ServerLocalExecutionProvider shell timeout', () => {
  it('waits for shell close and persists captured output on timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-shell-timeout-'));
    try {
      const provider = new ServerLocalExecutionProvider();
      const response = await provider.execute({
        toolName: 'Shell',
        input: { command: "printf 'before-timeout'; sleep 10", timeoutMs: 100 },
        context: { workspace: workspace(root), invocationId: 'local-timeout-test' },
      });

      expect(response.status).toBe('error');
      if (response.status === 'error') {
        expect(response.error).toContain('Shell timed out after 100ms');
        expect(response.error).toContain('before-timeout');
        expect(response.metadata).toMatchObject({ timedOut: true, stdoutBytes: 14 });
        const outputFiles = response.metadata?.outputFiles as Array<{ path: string }> | undefined;
        expect(outputFiles).toHaveLength(1);
        expect(await readFile(join(root, outputFiles![0]!.path), 'utf-8')).toBe('before-timeout');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
