import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { SandboxRunnerFinalOutput } from './protocol.js';
import { executeSandboxRunnerInput } from './sandboxRunner.js';
import { snapshotWorkspaceRoutingReason } from './shellExecutionRouting.js';

describe('snapshot workspace routing classification', () => {
  it('routes the production git fetch plus ls-remote shape to the persistent workspace', () => {
    expect(snapshotWorkspaceRoutingReason(
      "git -C code/agent fetch --prune origin && git -C code/agent ls-remote --symref origin HEAD | sed -n '1p'",
    )).toBe('workspace_git_remote_refresh');
  });

  it.each([
    'git status',
    'git -C code/agent branch --show-current',
    'rg -n snapshot acs-orchestrator/src',
    'find code/agent -type f | wc -l',
    'pwd && du -sh code/agent',
  ])('routes static workspace inspection: %s', (command) => {
    expect(snapshotWorkspaceRoutingReason(command)).toBe('workspace_inspection');
  });

  it.each([
    'git -C code/agent fetch origin main:main',
    'git -C code/agent pull --rebase',
    'git -C code/agent reset --hard origin/main',
    'git branch --list -D old-branch',
    'git config --show-origin --unset user.email',
    'git status && pnpm test',
    'find code/agent -type f -delete',
    'rg --pre "sh -c mutate" pattern .',
    'git status > status.txt',
    'git status && echo $(date)',
    'git -C ../outside status',
  ])('keeps ambiguous, dynamic, or mutating commands on their requested execution path: %s', (command) => {
    expect(snapshotWorkspaceRoutingReason(command)).toBeUndefined();
  });
});

describe('snapshot workspace routing execution', () => {
  it('executes the reported production shape once in workspace without preparing a git snapshot', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'snapshot-routing-workspace-'));
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'snapshot-routing-runtime-'));
    const fakeBin = join(runtimeRoot, 'bin');
    try {
      await mkdir(join(workspaceRoot, 'code', 'agent'), { recursive: true });
      await mkdir(fakeBin);
      const fakeGit = join(fakeBin, 'git');
      await writeFile(fakeGit, [
        '#!/bin/sh',
        'set -eu',
        'case "$*" in',
        '  "-C code/agent fetch --prune origin") exit 0 ;;',
        '  "-C code/agent ls-remote --symref origin HEAD") printf "ref: refs/heads/main\\tHEAD\\n" ;;',
        '  *) printf "unexpected git args: %s\\n" "$*" >&2; exit 64 ;;',
        'esac',
      ].join('\n'));
      await chmod(fakeGit, 0o755);

      let finalOutput: SandboxRunnerFinalOutput | undefined;
      await executeSandboxRunnerInput({
        toolName: 'Shell',
        input: {
          command: "git -C code/agent fetch --prune origin && git -C code/agent ls-remote --symref origin HEAD | sed -n '1p'",
          mode: 'foreground',
          timeoutMs: 180_000,
          execution: 'snapshot',
          cwd: '.',
        },
        invocationId: 'snapshot-routing-integration',
        workspace: { id: 'workspace-1', sessionId: 'session-1', root: workspaceRoot },
        env: {
          ...(process.env as Record<string, string>),
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        },
      }, new AbortController().signal, (output) => {
        if (output.kind === 'final') finalOutput = output;
      }, { skipPythonEnv: true });

      expect(finalOutput?.response).toMatchObject({
        status: 'success',
        metadata: {
          executionRequested: 'snapshot',
          executionUsed: 'workspace',
          executionRoutingReason: 'workspace_git_remote_refresh',
        },
      });
      if (finalOutput?.response.status !== 'success') throw new Error('expected successful routed response');
      expect(finalOutput.response.content).toContain('ref: refs/heads/main');
      expect(finalOutput.response.content).toContain('Git 远端引用刷新需要保留结果');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });
});
