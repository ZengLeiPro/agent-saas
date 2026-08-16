import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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

  it('fails closed outside a Git root', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapshot-non-git-'));
    try {
      await expect(prepareSnapshotExecution({
        workspaceRoot,
        command: 'true',
        signal: new AbortController().signal,
        env: process.env as Record<string, string>,
      })).rejects.toThrow('命令未执行：git_repository_not_found');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('preserves a nested repository path for commands that start with cd', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapshot-nested-workspace-'));
    const repositoryRoot = join(workspaceRoot, 'code', 'agent-saas');
    try {
      await mkdir(repositoryRoot, { recursive: true });
      await initRepository(repositoryRoot);
      await writeFile(join(repositoryRoot, 'tracked.txt'), 'nested\n');
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repositoryRoot });
      await execFileAsync('git', ['commit', '--quiet', '-m', 'nested'], { cwd: repositoryRoot });

      const lease = await prepareSnapshotExecution({
        workspaceRoot,
        command: 'cd code/agent-saas && printf ok',
        signal: new AbortController().signal,
        env: process.env as Record<string, string>,
      });
      expect(lease.metadata).toMatchObject({
        used: 'snapshot',
        repositoryPath: 'code/agent-saas',
        sourceCwd: '.',
      });
      await expect(readFile(join(lease.root, 'code', 'agent-saas', 'tracked.txt'), 'utf8')).resolves.toBe('nested\n');
      await lease.cleanup();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('uses cwd as the command cwd for a nested repository', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapshot-explicit-cwd-'));
    const repositoryRoot = join(workspaceRoot, 'code', 'agent-saas');
    try {
      await mkdir(repositoryRoot, { recursive: true });
      await initRepository(repositoryRoot);
      await writeFile(join(repositoryRoot, 'tracked.txt'), 'explicit\n');
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repositoryRoot });
      await execFileAsync('git', ['commit', '--quiet', '-m', 'explicit'], { cwd: repositoryRoot });

      const lease = await prepareSnapshotExecution({
        workspaceRoot,
        cwd: 'code/agent-saas',
        command: 'printf ok',
        signal: new AbortController().signal,
        env: process.env as Record<string, string>,
      });
      expect(lease.metadata).toMatchObject({
        used: 'snapshot',
        repositoryPath: 'code/agent-saas',
        sourceCwd: 'code/agent-saas',
      });
      await expect(readFile(join(lease.root, 'tracked.txt'), 'utf8')).resolves.toBe('explicit\n');
      await lease.cleanup();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rebuilds a corrupt mirror before materializing the next snapshot', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapshot-mirror-heal-'));
    try {
      await initRepository(workspaceRoot);
      await writeFile(join(workspaceRoot, 'tracked.txt'), 'healthy\n');
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: workspaceRoot });
      await execFileAsync('git', ['commit', '--quiet', '-m', 'mirror'], { cwd: workspaceRoot });

      const first = await prepareSnapshotExecution({
        workspaceRoot,
        command: 'true',
        signal: new AbortController().signal,
        env: process.env as Record<string, string>,
      });
      await first.cleanup();
      const key = createHash('sha256').update(await realpath(workspaceRoot)).digest('hex').slice(0, 16);
      await rm(join('/tmp/ky-agent-execution', key, 'mirror.git', 'objects'), { recursive: true, force: true });

      const healed = await prepareSnapshotExecution({
        workspaceRoot,
        command: 'true',
        signal: new AbortController().signal,
        env: process.env as Record<string, string>,
      });
      expect(healed.metadata.used).toBe('snapshot');
      await expect(readFile(join(healed.root, 'tracked.txt'), 'utf8')).resolves.toBe('healthy\n');
      await healed.cleanup();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('materializes a local-only commit created after the mirror cache already exists', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapshot-mirror-advance-'));
    try {
      await initRepository(workspaceRoot);
      await writeFile(join(workspaceRoot, 'first.txt'), 'first\n');
      await execFileAsync('git', ['add', 'first.txt'], { cwd: workspaceRoot });
      await execFileAsync('git', ['commit', '--quiet', '-m', 'first'], { cwd: workspaceRoot });
      const first = await prepareSnapshotExecution({
        workspaceRoot,
        command: 'true',
        signal: new AbortController().signal,
        env: process.env as Record<string, string>,
      });
      await first.cleanup();

      await writeFile(join(workspaceRoot, 'second.txt'), 'second\n');
      await execFileAsync('git', ['add', 'second.txt'], { cwd: workspaceRoot });
      await execFileAsync('git', ['commit', '--quiet', '-m', 'second'], { cwd: workspaceRoot });
      const second = await prepareSnapshotExecution({
        workspaceRoot,
        command: 'true',
        signal: new AbortController().signal,
        env: process.env as Record<string, string>,
      });
      await expect(readFile(join(second.root, 'second.txt'), 'utf8')).resolves.toBe('second\n');
      await second.cleanup();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('does not overlay an untracked dependency tree renamed after an interrupted install', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapshot-incomplete-dependencies-'));
    try {
      await initRepository(workspaceRoot);
      await writeFile(join(workspaceRoot, 'tracked.txt'), 'tracked\n');
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: workspaceRoot });
      await execFileAsync('git', ['commit', '--quiet', '-m', 'tracked'], { cwd: workspaceRoot });
      await mkdir(join(workspaceRoot, 'server', 'node_modules.incomplete', 'package'), { recursive: true });
      await writeFile(join(workspaceRoot, 'server', 'node_modules.incomplete', 'package', 'index.js'), 'generated\n');
      await writeFile(join(workspaceRoot, 'kept.txt'), 'untracked source\n');

      const lease = await prepareSnapshotExecution({
        workspaceRoot,
        command: 'true',
        signal: new AbortController().signal,
        env: process.env as Record<string, string>,
      });
      expect(lease.metadata.dirtyFileCount).toBe(1);
      await expect(readFile(join(lease.root, 'kept.txt'), 'utf8')).resolves.toBe('untracked source\n');
      await expect(readFile(
        join(lease.root, 'server', 'node_modules.incomplete', 'package', 'index.js'),
        'utf8',
      )).rejects.toThrow();
      await lease.cleanup();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('does not prepare node_modules for a lightweight snapshot command', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapshot-lightweight-'));
    const fakeBin = join(workspaceRoot, 'fake-bin');
    const counterPath = join(workspaceRoot, 'install-count.txt');
    try {
      await initRepository(workspaceRoot);
      await mkdir(fakeBin);
      const fakePnpm = join(fakeBin, 'pnpm');
      await writeFile(fakePnpm, '#!/bin/sh\nprintf install >> "$COUNTER_PATH"\n');
      await chmod(fakePnpm, 0o755);
      await writeFile(join(workspaceRoot, 'package.json'), '{"name":"snapshot-light-test","private":true}\n');
      await writeFile(join(workspaceRoot, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
      await execFileAsync('git', ['add', 'package.json', 'pnpm-lock.yaml'], { cwd: workspaceRoot });
      await execFileAsync('git', ['commit', '--quiet', '-m', 'dependencies'], { cwd: workspaceRoot });

      const lease = await prepareSnapshotExecution({
        workspaceRoot,
        command: 'rg -n package.json .',
        signal: new AbortController().signal,
        env: {
          ...(process.env as Record<string, string>),
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          COUNTER_PATH: counterPath,
        },
      });
      expect(lease.metadata.dependencyMs).toBe(0);
      await expect(readFile(counterPath, 'utf8')).rejects.toThrow();
      await lease.cleanup();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('singleflights dependency preparation and reuses the prepared node_modules tree', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapshot-dependency-cache-'));
    const fakeBin = join(workspaceRoot, 'fake-bin');
    const counterPath = join(workspaceRoot, 'install-count.txt');
    try {
      await initRepository(workspaceRoot);
      await mkdir(fakeBin);
      const fakePnpm = join(fakeBin, 'pnpm');
      await writeFile(fakePnpm, [
        '#!/bin/sh',
        'mkdir -p node_modules/.bin',
        'printf "#!/bin/sh\\nprintf ready" > node_modules/.bin/snapshot-probe',
        'chmod +x node_modules/.bin/snapshot-probe',
        'printf "install\\n" >> "$COUNTER_PATH"',
      ].join('\n'));
      await chmod(fakePnpm, 0o755);
      await writeFile(join(workspaceRoot, 'package.json'), '{"name":"snapshot-cache-test","private":true}\n');
      await writeFile(join(workspaceRoot, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
      await execFileAsync('git', ['add', 'package.json', 'pnpm-lock.yaml'], { cwd: workspaceRoot });
      await execFileAsync('git', ['commit', '--quiet', '-m', 'dependencies'], { cwd: workspaceRoot });
      const env = {
        ...(process.env as Record<string, string>),
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        COUNTER_PATH: counterPath,
      };

      const leases = await Promise.all([1, 2].map(() => prepareSnapshotExecution({
        workspaceRoot,
        command: 'pnpm test',
        signal: new AbortController().signal,
        env,
      })));
      expect((await readFile(counterPath, 'utf8')).trim().split('\n')).toHaveLength(1);
      expect(leases.map((lease) => lease.metadata.dependencyCacheHit).sort()).toEqual([false, true]);
      for (const lease of leases) {
        await expect(readFile(join(lease.root, 'node_modules', '.bin', 'snapshot-probe'), 'utf8'))
          .resolves.toContain('ready');
        await lease.cleanup();
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

async function initRepository(root: string): Promise<void> {
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'snapshot@example.test'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Snapshot Test'], { cwd: root });
}
