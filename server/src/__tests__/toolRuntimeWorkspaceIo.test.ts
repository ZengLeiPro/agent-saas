import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { ServerLocalExecutionProvider, type WorkspaceRef } from '../agent/toolRuntime.js';
import type { ToolInvocationStreamChunk } from '../runtime/handProtocol.js';

function workspace(root: string): WorkspaceRef {
  return {
    root,
    userId: 'admin-1',
    username: 'admin',
    sessionId: 'session-1',
    executionTarget: 'server-local',
  };
}

describe('ServerLocalExecutionProvider workspace I/O hardening', () => {
  it('recovers Read paths with Unicode spaces and normalization variants', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-read-recovery-'));
    try {
      await writeFile(join(root, 'daily report.txt'), 'space recovered', 'utf8');
      await writeFile(join(root, 'café.txt'), 'unicode recovered', 'utf8');
      const provider = new ServerLocalExecutionProvider();

      const spaceResponse = await provider.execute({
        toolName: 'Read',
        input: { path: 'daily\u202Freport.txt' },
        context: { workspace: workspace(root) },
      });
      expect(spaceResponse).toMatchObject({
        status: 'success',
        content: 'space recovered',
        metadata: { path: 'daily report.txt', pathRecovered: true },
      });

      const unicodeResponse = await provider.execute({
        toolName: 'Read',
        input: { path: 'café.txt'.normalize('NFD') },
        context: { workspace: workspace(root) },
      });
      expect(unicodeResponse).toMatchObject({
        status: 'success',
        content: 'unicode recovered',
        metadata: { path: 'café.txt', pathRecovered: true },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('atomically replaces Write targets and preserves their mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-write-atomic-'));
    try {
      const target = join(root, 'notes.txt');
      await writeFile(target, 'before', 'utf8');
      await chmod(target, 0o600);
      const before = await stat(target);
      const provider = new ServerLocalExecutionProvider();

      const response = await provider.execute({
        toolName: 'Write',
        input: { path: 'notes.txt', content: 'after' },
        context: { workspace: workspace(root) },
      });
      const after = await stat(target);

      expect(response.status).toBe('success');
      expect(await readFile(target, 'utf8')).toBe('after');
      expect(after.ino).not.toBe(before.ino);
      expect(after.mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executes streaming read-only rg directly without shell startup scripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-shell-direct-stream-'));
    const marker = join(root, 'shell-started');
    try {
      const rgPath = join(root, 'rg');
      const bashEnv = join(root, 'bash-env.sh');
      await writeFile(rgPath, '#!/bin/sh\nprintf "direct rg\\n"\n', 'utf8');
      await chmod(rgPath, 0o755);
      await writeFile(bashEnv, `/usr/bin/touch ${JSON.stringify(marker)}\n`, 'utf8');
      const provider = new ServerLocalExecutionProvider({
        envBuilder: () => ({ PATH: root }),
      });
      const chunks: ToolInvocationStreamChunk[] = [];
      for await (const chunk of provider.executeStream({
        toolName: 'Shell',
        input: { command: 'rg --no-config -n needle .' },
        context: {
          workspace: workspace(root),
          env: { BASH_ENV: bashEnv },
        },
      }))
        chunks.push(chunk);

      expect(chunks.at(-1)).toMatchObject({ type: 'completed', response: { status: 'success' } });
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
