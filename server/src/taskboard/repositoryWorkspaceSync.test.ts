import { describe, expect, it, vi } from 'vitest';

import {
  RepositoryWorkspaceSyncError,
  syncRepositoryWorkspace,
  type RepositoryWorkspaceGitCommand,
  type RepositoryWorkspaceGitResult,
  type RepositoryWorkspaceSyncHost,
  type RepositoryWorkspaceSyncLock,
} from './repositoryWorkspaceSync.js';

const REPOSITORY = '/srv/cache/acme-widget';
const WORKTREE = '/srv/cache/worktrees/acme-widget/integration-42';
const MAIN_OID = '1'.repeat(40);
const REMOTE_OID = '2'.repeat(40);
const INTEGRATION_OID = '3'.repeat(40);
const input = {
  repositoryPath: REPOSITORY,
  worktreePath: WORKTREE,
  baseBranch: 'main',
  integrationBranch: 'integration/42',
  controlledRemoteUrl: 'https://github.com/acme/widget.git',
};

type Step = {
  cwd: string;
  args: readonly string[];
  result?: Partial<RepositoryWorkspaceGitResult>;
};

class ScriptedHost implements RepositoryWorkspaceSyncHost {
  readonly commands: RepositoryWorkspaceGitCommand[] = [];
  readonly locks: RepositoryWorkspaceSyncLock[] = [];

  constructor(private readonly steps: Step[]) {}

  async withRepositoryBranchLock<T>(lock: RepositoryWorkspaceSyncLock, operation: () => Promise<T>): Promise<T> {
    this.locks.push(lock);
    return operation();
  }

  async validateServerOwnedRepository(_repositoryPath: string): Promise<void> {}

  async runGit(command: RepositoryWorkspaceGitCommand): Promise<RepositoryWorkspaceGitResult> {
    this.commands.push(command);
    const step = this.steps.shift();
    expect(command).toEqual(step && { cwd: step.cwd, args: step.args });
    if (!step) throw new Error('Unexpected Git command');
    return { exitCode: 0, stdout: '', stderr: '', ...step.result };
  }

  assertConsumed(): void {
    expect(this.steps).toEqual([]);
  }
}

const fetchStep = (): Step => ({ cwd: REPOSITORY, args: [
  'fetch', '--no-tags', '--prune', '--', input.controlledRemoteUrl,
  '+refs/heads/main:refs/remotes/origin/main',
] });
const remoteOidStep = (): Step => ({
  cwd: REPOSITORY,
  args: ['rev-parse', '--verify', 'refs/remotes/origin/main'],
  result: { stdout: `${REMOTE_OID}\n` },
});
const listStep = (records: string): Step => ({
  cwd: REPOSITORY,
  args: ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain'],
  result: { stdout: records },
});
const mainRecord = (head = MAIN_OID): string => worktreeRecord(REPOSITORY, head, 'main');
const integrationRecord = (head = INTEGRATION_OID): string => worktreeRecord(WORKTREE, head, 'integration/42');

function worktreeRecord(path: string, head: string, branch: string): string {
  return `worktree ${path}\nHEAD ${head}\nbranch refs/heads/${branch}\n`;
}

function statusStep(path: string, stdout = ''): Step {
  return { cwd: path, args: ['status', '--porcelain=v1', '--untracked-files=all'], result: { stdout } };
}

function ancestorStep(ancestor: string, descendant: string, yes: boolean): Step {
  return {
    cwd: REPOSITORY,
    args: ['merge-base', '--is-ancestor', ancestor, descendant],
    result: { exitCode: yes ? 0 : 1 },
  };
}

describe('syncRepositoryWorkspace', () => {
  it('fetches origin, fast-forwards a clean behind main, and creates a new integration worktree', async () => {
    const host = new ScriptedHost([
      fetchStep(),
      remoteOidStep(),
      listStep(mainRecord()),
      statusStep(REPOSITORY),
      ancestorStep('refs/heads/main', 'refs/remotes/origin/main', true),
      ancestorStep('refs/remotes/origin/main', 'refs/heads/main', false),
      { cwd: REPOSITORY, args: ['merge', '--ff-only', 'refs/remotes/origin/main'] },
      {
        cwd: REPOSITORY,
        args: ['show-ref', '--verify', '--quiet', 'refs/heads/integration/42'],
        result: { exitCode: 1 },
      },
      {
        cwd: REPOSITORY,
        args: ['worktree', 'add', '-b', 'integration/42', '--', WORKTREE, 'refs/remotes/origin/main'],
      },
    ]);

    await expect(syncRepositoryWorkspace(host, input)).resolves.toMatchObject({
      baseOid: REMOTE_OID,
      localBase: 'fast_forwarded',
      integrationWorktree: 'created',
    });
    expect(host.locks).toEqual([{ repositoryPath: REPOSITORY, branch: 'integration/42' }]);
    host.assertConsumed();
  });

  it('fails closed on a dirty main without merge, reset, delete, or worktree mutation', async () => {
    const host = new ScriptedHost([
      fetchStep(), remoteOidStep(), listStep(mainRecord()), statusStep(REPOSITORY, ' M src/index.ts\n'),
    ]);

    await expect(syncRepositoryWorkspace(host, input)).rejects.toMatchObject({ code: 'WORKTREE_DIRTY' });
    expect(host.commands.flatMap((command) => command.args)).not.toContain('reset');
    expect(host.commands.flatMap((command) => command.args)).not.toContain('remove');
    host.assertConsumed();
  });

  it('fails closed when local main has commits not present on origin/main', async () => {
    const host = new ScriptedHost([
      fetchStep(),
      remoteOidStep(),
      listStep(mainRecord()),
      statusStep(REPOSITORY),
      ancestorStep('refs/heads/main', 'refs/remotes/origin/main', false),
    ]);

    await expect(syncRepositoryWorkspace(host, input)).rejects.toMatchObject({ code: 'WORKTREE_DIVERGED' });
    expect(host.commands.some((command) => command.args.includes('merge'))).toBe(false);
    host.assertConsumed();
  });

  it('stops immediately and reports a structured fetch failure', async () => {
    const host = new ScriptedHost([
      { ...fetchStep(), result: { exitCode: 128, stderr: 'remote unavailable' } },
    ]);

    await expect(syncRepositoryWorkspace(host, input)).rejects.toMatchObject({
      code: 'GIT_COMMAND_FAILED',
      command: { cwd: REPOSITORY, args: fetchStep().args },
    });
    expect(host.commands).toHaveLength(1);
    host.assertConsumed();
  });

  it('serializes concurrent syncs through the repository and integration branch host lock', async () => {
    let active = 0;
    let maxActive = 0;
    let tail = Promise.resolve();
    const locks: RepositoryWorkspaceSyncLock[] = [];
    const host: RepositoryWorkspaceSyncHost = {
      async withRepositoryBranchLock<T>(lock: RepositoryWorkspaceSyncLock, operation: () => Promise<T>): Promise<T> {
        locks.push(lock);
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return await operation();
        } finally {
          active -= 1;
          release();
        }
      },
      validateServerOwnedRepository: vi.fn(async () => undefined),
      runGit: vi.fn(async ({ args }: RepositoryWorkspaceGitCommand) => {
        if (args[0] === 'rev-parse') return ok(`${REMOTE_OID}\n`);
        if (args[0] === '-c') return ok(`${mainRecord(REMOTE_OID)}\n${integrationRecord(REMOTE_OID)}`);
        if (args[0] === 'merge-base') return ok();
        return ok();
      }),
    };

    const [first, second] = await Promise.all([
      syncRepositoryWorkspace(host, input),
      syncRepositoryWorkspace(host, input),
    ]);

    expect(first.integrationWorktree).toBe('current');
    expect(second.integrationWorktree).toBe('current');
    expect(maxActive).toBe(1);
    expect(locks).toEqual([
      { repositoryPath: REPOSITORY, branch: 'integration/42' },
      { repositoryPath: REPOSITORY, branch: 'integration/42' },
    ]);
  });

  it('refreshes an existing clean integration worktree with ff-only', async () => {
    const host = new ScriptedHost([
      fetchStep(),
      remoteOidStep(),
      listStep(`${mainRecord(REMOTE_OID)}\n${integrationRecord()}`),
      statusStep(REPOSITORY),
      ancestorStep('refs/heads/main', 'refs/remotes/origin/main', true),
      ancestorStep('refs/remotes/origin/main', 'refs/heads/main', true),
      statusStep(WORKTREE),
      ancestorStep('refs/heads/integration/42', 'refs/remotes/origin/main', true),
      ancestorStep('refs/remotes/origin/main', 'refs/heads/integration/42', false),
      { cwd: WORKTREE, args: ['merge', '--ff-only', 'refs/remotes/origin/main'] },
    ]);

    await expect(syncRepositoryWorkspace(host, input)).resolves.toMatchObject({
      localBase: 'current',
      integrationWorktree: 'fast_forwarded',
    });
    expect(host.commands.filter((command) => command.args[0] === 'worktree')).toEqual([]);
    host.assertConsumed();
  });

  it('rejects unsafe refs and non-normalized paths before taking a lock or running Git', async () => {
    const host = new ScriptedHost([]);

    await expect(syncRepositoryWorkspace(host, { ...input, integrationBranch: '--upload-pack=oops' }))
      .rejects.toBeInstanceOf(RepositoryWorkspaceSyncError);
    await expect(syncRepositoryWorkspace(host, { ...input, worktreePath: '/srv/cache/../escape' }))
      .rejects.toMatchObject({ code: 'INVALID_PATH' });
    expect(host.locks).toEqual([]);
    expect(host.commands).toEqual([]);
  });
});

function ok(stdout = ''): RepositoryWorkspaceGitResult {
  return { exitCode: 0, stdout, stderr: '' };
}
