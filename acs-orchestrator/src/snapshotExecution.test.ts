import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { prepareSnapshotExecution } from './snapshotExecution.js';

const execFileAsync = promisify(execFile);

describe('snapshot execution', () => {
  it('materializes committed, dirty and untracked files on ephemeral storage', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapshot-workspace-'));
    try {
      await execFileAsync('git', ['init', '--quiet'], { cwd: workspaceRoot });
      await execFileAsync('git', ['config', 'user.email', 'snapshot@example.test'], { cwd: workspaceRoot });
      await execFileAsync('git', ['config', 'user.name', 'Snapshot Test'], { cwd: workspaceRoot });
      await writeFile(join(workspaceRoot, 'tracked.txt'), 'committed\n');
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: workspaceRoot });
      await execFileAsync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: workspaceRoot });
      await writeFile(join(workspaceRoot, 'tracked.txt'), 'dirty\n');
      await writeFile(join(workspaceRoot, 'untracked.txt'), 'untracked\n');

      const lease = await prepareSnapshotExecution({
        workspaceRoot,
        command: 'true',
        signal: new AbortController().signal,
        env: process.env as Record<string, string>,
      });
      expect(lease.metadata).toMatchObject({ used: 'snapshot', dirtyFileCount: 2 });
      await expect(readFile(join(lease.root, 'tracked.txt'), 'utf8')).resolves.toBe('dirty\n');
      await expect(readFile(join(lease.root, 'untracked.txt'), 'utf8')).resolves.toBe('untracked\n');
      await mkdir(join(lease.root, 'tmp', 'tool-results'), { recursive: true });
      await writeFile(join(lease.root, 'tmp', 'tool-results', 'result.txt'), 'full output\n');
      await lease.cleanup();
      await expect(readFile(join(workspaceRoot, 'tmp', 'tool-results', 'result.txt'), 'utf8'))
        .resolves.toBe('full output\n');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('falls back to the persistent workspace outside a Git root', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapshot-non-git-'));
    try {
      const lease = await prepareSnapshotExecution({
        workspaceRoot,
        command: 'true',
        signal: new AbortController().signal,
        env: process.env as Record<string, string>,
      });
      expect(lease.root).toBe(workspaceRoot);
      expect(lease.metadata).toMatchObject({ used: 'workspace' });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
