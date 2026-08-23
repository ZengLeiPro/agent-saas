import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { executeSandboxRunnerInput } from './sandboxRunner.js';
import {
  mapWithConcurrency,
  MAX_VALIDATION_CONCURRENCY,
  planSnapshotValidationChain,
} from './snapshotValidationChain.js';

const execFileAsync = promisify(execFile);

describe('snapshot validation chain planning', () => {
  it('splits the production validation shape and caps concurrency at four', () => {
    expect(planSnapshotValidationChain([
      'pnpm -F acs-orchestrator test',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build',
      'pnpm check:ratchets',
    ].join(' && '))).toEqual({
      commands: [
        'pnpm -F acs-orchestrator test',
        'pnpm typecheck',
        'pnpm test',
        'pnpm build',
        'pnpm check:ratchets',
      ],
      maxConcurrency: MAX_VALIDATION_CONCURRENCY,
    });
  });

  it('does not split && inside a quoted test argument', () => {
    expect(planSnapshotValidationChain('pnpm test -- --grep "one && two" && pnpm build')).toEqual({
      commands: ['pnpm test -- --grep "one && two"', 'pnpm build'],
      maxConcurrency: 2,
    });
  });

  it.each([
    'pnpm test',
    'pnpm test && git status',
    'pnpm test && pnpm lint --fix',
    'pnpm test && pnpm vitest --watch=false',
    'pnpm test:e2e && pnpm build',
    'vitest && pnpm build',
    'vite dev && pnpm test',
    'turbo deploy && pnpm test',
    'pnpm test | tee test.log && pnpm build',
    'pnpm test > test.log && pnpm build',
    'export NODE_ENV=test && pnpm test && pnpm build',
    'pnpm test && echo $(date)',
  ])('keeps unsafe or stateful shell semantics unchanged: %s', (command) => {
    expect(planSnapshotValidationChain(command)).toBeUndefined();
  });

  it('accepts direct read-only validation tools but rejects prettier writes', () => {
    expect(planSnapshotValidationChain('npx vitest run && tsc --noEmit')).toEqual({
      commands: ['npx vitest run', 'tsc --noEmit'],
      maxConcurrency: 2,
    });
    expect(planSnapshotValidationChain('prettier --check . && pnpm test')).toBeDefined();
    expect(planSnapshotValidationChain('prettier --write . && pnpm test')).toBeUndefined();
  });

  it('accepts static env assignments, a safe shell prelude and newline-separated validations', () => {
    expect(planSnapshotValidationChain('set -euo pipefail\nNODE_ENV=test pnpm test\npnpm typecheck')).toEqual({
      commands: ['NODE_ENV=test pnpm test', 'pnpm typecheck'],
      maxConcurrency: 2,
    });
  });

  it('refuses oversized chains instead of creating an unbounded batch', () => {
    expect(planSnapshotValidationChain(Array.from({ length: 9 }, () => 'pnpm test').join(' && ')))
      .toBeUndefined();
  });
});

describe('validation concurrency scheduler', () => {
  it('never exceeds the requested concurrency and preserves result order', async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const started: number[] = [];
    const run = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      started.push(value);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return `result-${value}`;
    });

    await waitUntil(() => started.length === 2);
    expect(peak).toBe(2);
    releases.shift()?.();
    await waitUntil(() => started.length === 3);
    releases.shift()?.();
    await waitUntil(() => started.length === 4);
    releases.shift()?.();
    await waitUntil(() => started.length === 5);
    while (releases.length > 0) releases.shift()?.();

    await expect(run).resolves.toEqual([
      'result-0',
      'result-1',
      'result-2',
      'result-3',
      'result-4',
    ]);
    expect(peak).toBe(2);
  });
});

describe('snapshot validation chain execution', () => {
  it('runs recognized validation commands in independent snapshots and returns one combined result', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapshot-validation-workspace-'));
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'snapshot-validation-runtime-'));
    const fakeBin = join(runtimeRoot, 'bin');
    const executionLog = join(runtimeRoot, 'executions.log');
    try {
      await mkdir(fakeBin);
      await execFileAsync('git', ['init', '--quiet'], { cwd: workspaceRoot });
      await execFileAsync('git', ['config', 'user.email', 'validation@example.test'], { cwd: workspaceRoot });
      await execFileAsync('git', ['config', 'user.name', 'Validation Test'], { cwd: workspaceRoot });
      await writeFile(join(workspaceRoot, 'tracked.txt'), 'snapshot\n');
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: workspaceRoot });
      await execFileAsync('git', ['commit', '--quiet', '-m', 'validation'], { cwd: workspaceRoot });
      const fakeValidationTool = [
        '#!/bin/sh',
        'set -eu',
        'name=$(basename "$0")',
        'printf "%s-ready\\n" "$name"',
        'printf "%s\\n" "$name" >> "$VALIDATION_EXECUTION_LOG"',
      ].join('\n');
      for (const tool of ['vitest', 'tsc']) {
        const path = join(fakeBin, tool);
        await writeFile(path, fakeValidationTool);
        await chmod(path, 0o755);
      }

      const outputs: Array<{ kind: string; chunk?: { type: string; response?: unknown } }> = [];
      await executeSandboxRunnerInput({
        toolName: 'Shell',
        input: {
          command: 'vitest run && tsc --noEmit',
          execution: 'snapshot',
          cwd: '.',
          timeoutMs: 5_000,
        },
        invocationId: 'validation-integration',
        workspace: { id: 'workspace-1', sessionId: 'session-1', root: workspaceRoot },
        stream: true,
        env: {
          ...(process.env as Record<string, string>),
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          VALIDATION_EXECUTION_LOG: executionLog,
        },
      }, new AbortController().signal, (output) => outputs.push(output), { skipPythonEnv: true });

      const completed = outputs.find((output) => output.kind === 'chunk' && output.chunk?.type === 'completed');
      expect(completed?.chunk?.response).toMatchObject({
        status: 'success',
        metadata: {
          executionUsed: 'snapshot',
          validationChainSplit: true,
          validationChainCommandCount: 2,
          validationChainMaxConcurrency: 2,
        },
      });
      expect((await readFile(executionLog, 'utf8')).trim().split('\n').sort()).toEqual(['tsc', 'vitest']);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 20_000);
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition not reached');
}
