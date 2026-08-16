import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import type { SandboxRunnerFinalOutput } from './protocol.js';
import { executeSandboxRunnerInput } from './sandboxRunner.js';
import { snapshotAutoRoutingReason } from './snapshotAutoRouting.js';

const execFileAsync = promisify(execFile);

describe('automatic snapshot routing', () => {
  it.each([
    'pnpm test',
    'pnpm -F web exec vitest run src/components/BusinessStepFlow.test.tsx',
    'NODE_ENV=test pnpm -F web typecheck',
    'pnpm test && pnpm typecheck',
  ])('routes disposable validation away from the persistent workspace: %s', (command) => {
    expect(snapshotAutoRoutingReason(command, 'workspace')).toBe('snapshot_validation');
  });

  it.each([
    'pnpm install --offline --frozen-lockfile',
    'pnpm install --frozen-lockfile --filter web... --reporter=append-only',
    'npm ci --prefer-offline',
  ])('routes a deterministic dependency restore away from the persistent workspace: %s', (command) => {
    expect(snapshotAutoRoutingReason(command, 'workspace')).toBe('snapshot_dependency_restore');
  });

  it.each([
    'pnpm install lodash --frozen-lockfile',
    'pnpm add lodash',
    'pnpm install',
    'pnpm install --frozen-lockfile && git status',
    'pnpm build',
  ])('preserves ambiguous or persistent workspace mutations: %s', (command) => {
    expect(snapshotAutoRoutingReason(command, 'workspace')).toBeUndefined();
  });

  it('uses snapshot by default for build without overriding an explicit workspace build', () => {
    expect(snapshotAutoRoutingReason('pnpm build', undefined)).toBe('snapshot_validation');
    expect(snapshotAutoRoutingReason('pnpm build', 'workspace')).toBeUndefined();
    expect(snapshotAutoRoutingReason('pnpm test', 'snapshot')).toBeUndefined();
  });

  it('does not reclassify a mixed validation and workspace mutation as pure validation', () => {
    expect(snapshotAutoRoutingReason('pnpm test && git status', 'workspace')).toBeUndefined();
    expect(snapshotAutoRoutingReason('pnpm test && git commit -am done', 'workspace')).toBeUndefined();
  });

  it('executes an explicitly workspace-scoped frozen restore in a disposable snapshot', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapshot-auto-routing-workspace-'));
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'snapshot-auto-routing-runtime-'));
    const fakeBin = join(runtimeRoot, 'bin');
    try {
      await mkdir(fakeBin);
      await execFileAsync('git', ['init', '--quiet'], { cwd: workspaceRoot });
      await execFileAsync('git', ['config', 'user.email', 'snapshot-routing@example.test'], { cwd: workspaceRoot });
      await execFileAsync('git', ['config', 'user.name', 'Snapshot Routing Test'], { cwd: workspaceRoot });
      await writeFile(join(workspaceRoot, 'package.json'), '{"name":"snapshot-routing","private":true}\n');
      await writeFile(join(workspaceRoot, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
      await execFileAsync('git', ['add', 'package.json', 'pnpm-lock.yaml'], { cwd: workspaceRoot });
      await execFileAsync('git', ['commit', '--quiet', '-m', 'dependencies'], { cwd: workspaceRoot });
      await writeFile(join(fakeBin, 'pnpm'), [
        '#!/bin/sh',
        'set -eu',
        '[ "$PWD" != "$SOURCE_WORKSPACE" ]',
        'printf restored > snapshot-only.marker',
      ].join('\n'));
      await chmod(join(fakeBin, 'pnpm'), 0o755);

      let finalOutput: SandboxRunnerFinalOutput | undefined;
      await executeSandboxRunnerInput({
        toolName: 'Shell',
        input: {
          command: 'pnpm install --offline --frozen-lockfile',
          execution: 'workspace',
          cwd: '.',
        },
        invocationId: 'snapshot-auto-routing-integration',
        workspace: { id: 'workspace-1', sessionId: 'session-1', root: workspaceRoot },
        env: {
          ...(process.env as Record<string, string>),
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          SOURCE_WORKSPACE: workspaceRoot,
        },
      }, new AbortController().signal, (output) => {
        if (output.kind === 'final') finalOutput = output;
      }, { skipPythonEnv: true });

      expect(finalOutput?.response).toMatchObject({
        status: 'success',
        metadata: {
          executionRequested: 'workspace',
          executionUsed: 'snapshot',
          executionRoutingReason: 'snapshot_dependency_restore',
        },
      });
      await expect(readFile(join(workspaceRoot, 'snapshot-only.marker'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });
});
