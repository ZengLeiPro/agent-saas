import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
  RepositoryWorkspaceSyncError,
  syncCandidateRevisionObjects,
  syncRepositoryWorkspace,
  withRepositoryScopeLock,
  type RepositoryWorkspaceGitCommand,
  type RepositoryWorkspaceGitResult,
  type RepositoryWorkspaceSyncHost,
  type RepositoryWorkspaceSyncLock,
} from './repositoryWorkspaceSync.js';

const exec = promisify(execFile);
const REPOSITORY = '/srv/cache/acme-widget';
const WORKTREE = '/srv/cache/worktrees/acme-widget/integration-42';
const WORKTREE_PARENT = '/srv/cache/worktrees/acme-widget';
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
  env?: Readonly<Record<string, string>>;
  result?: Partial<RepositoryWorkspaceGitResult>;
};

class ScriptedHost implements RepositoryWorkspaceSyncHost {
  readonly commands: RepositoryWorkspaceGitCommand[] = [];
  readonly locks: RepositoryWorkspaceSyncLock[] = [];
  private readonly ownedPaths = new Set<string>();
  private readonly ownedHeads = new Map<string, string>();
  private mutationStarted = false;

  constructor(private readonly steps: Step[]) {}

  async withRepositoryBranchLock<T>(lock: RepositoryWorkspaceSyncLock, operation: () => Promise<T>): Promise<T> {
    this.locks.push(lock);
    return operation();
  }

  async validateServerOwnedRepository(_repositoryPath: string): Promise<void> {}
  async realpath(path: string): Promise<string> { return path; }
  async lstat(path: string) {
    if (this.ownedPaths.has(path) || path === WORKTREE_PARENT) return { isSymbolicLink: () => false };
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  }
  async stat(path: string) {
    if (path !== WORKTREE_PARENT) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { uid: process.getuid?.() ?? 0, mode: 0o700, isDirectory: () => true };
  }

  async runGit(command: RepositoryWorkspaceGitCommand): Promise<RepositoryWorkspaceGitResult> {
    this.commands.push(command);
    const expected = this.steps[0];
    const expectedCommand = expected && { cwd: expected.cwd, args: expected.args, ...(expected.env ? { env: expected.env } : {}) };
    const matchesExpected = expectedCommand && JSON.stringify(command) === JSON.stringify(expectedCommand);
    if (!this.mutationStarted && command.cwd === REPOSITORY && !matchesExpected) {
      if (command.args[0] === 'rev-parse' && command.args[1] === '--verify' && command.args[2] === 'HEAD') {
        return { exitCode: 0, stdout: `${this.ownedHeads.get(REPOSITORY) ?? MAIN_OID}\n`, stderr: '' };
      }
      if (command.args[0] === 'symbolic-ref') return { exitCode: 0, stdout: 'refs/heads/main\n', stderr: '' };
      if (command.args[0] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
      if (command.args[0] === 'rev-parse' && command.args[1] === '--git-dir') return { exitCode: 0, stdout: `${REPOSITORY}/.git\n`, stderr: '' };
      if (command.args[0] === 'rev-parse' && command.args[1] === '--git-common-dir') return { exitCode: 0, stdout: `${REPOSITORY}/.git\n`, stderr: '' };
    }
    const step = this.steps.shift();
    expect(command).toEqual(step && { cwd: step.cwd, args: step.args, ...(step.env ? { env: step.env } : {}) });
    if (!step) throw new Error('Unexpected Git command');
    const result = { exitCode: 0, stdout: '', stderr: '', ...step.result };
    if (command.args[0] === 'worktree' && command.args[1] === 'list') {
      const records = result.stdout.split(/\n\n/);
      for (const record of records) {
        const path = record.match(/^worktree (.+)$/m)?.[1];
        const head = record.match(/^HEAD ([0-9a-f]+)$/m)?.[1];
        if (path) this.ownedPaths.add(path);
        if (path && head) this.ownedHeads.set(path, head);
      }
    }
    if (command.args[0] === 'fetch') this.mutationStarted = true;
    return result;
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
const readOnlyEnv = { GIT_OPTIONAL_LOCKS: '0' } as const;
const listStep = (records: string): Step => ({
  cwd: REPOSITORY,
  args: ['worktree', 'list', '--porcelain'],
  env: readOnlyEnv,
  result: { stdout: records },
});
const mainRecord = (head = MAIN_OID): string => worktreeRecord(REPOSITORY, head, 'main');
const integrationRecord = (head = INTEGRATION_OID): string => worktreeRecord(WORKTREE, head, 'integration/42');

function worktreeRecord(path: string, head: string, branch: string): string {
  return `worktree ${path}\nHEAD ${head}\nbranch refs/heads/${branch}\n`;
}

function statusStep(path: string, stdout = ''): Step {
  return { cwd: path, args: ['status', '--porcelain=v1', '--untracked-files=all'], env: readOnlyEnv, result: { stdout } };
}

function ownershipSteps(head = INTEGRATION_OID): Step[] {
  return [
    { cwd: WORKTREE, args: ['rev-parse', '--verify', 'HEAD'], env: readOnlyEnv, result: { stdout: `${head}\n` } },
    { cwd: WORKTREE, args: ['symbolic-ref', '-q', 'HEAD'], env: readOnlyEnv, result: { stdout: 'refs/heads/integration/42\n' } },
    statusStep(WORKTREE),
    { cwd: WORKTREE, args: ['rev-parse', '--git-dir'], env: readOnlyEnv, result: { stdout: `${REPOSITORY}/.git/worktrees/integration-42\n` } },
    { cwd: WORKTREE, args: ['rev-parse', '--git-common-dir'], env: readOnlyEnv, result: { stdout: `${REPOSITORY}/.git\n` } },
  ];
}

function shallowStep(shallow = false): Step {
  return {
    cwd: REPOSITORY,
    args: ['rev-parse', '--is-shallow-repository'],
    result: { stdout: `${shallow}\n` },
  };
}

function ancestorStep(ancestor: string, descendant: string, yes: boolean): Step {
  return {
    cwd: REPOSITORY,
    args: ['merge-base', '--is-ancestor', ancestor, descendant],
    result: { exitCode: yes ? 0 : 1 },
  };
}

describe('syncCandidateRevisionObjects', () => {
  const candidate = {
    repositoryPath: REPOSITORY,
    integrationBranch: 'integration/task-1',
    baseBranch: 'main',
    controlledRemoteUrl: input.controlledRemoteUrl,
    candidateId: 'candidate-1',
    candidateRevision: 2,
    providerPullRequestId: '108',
    expectedBaseOid: MAIN_OID,
    expectedHeadOid: INTEGRATION_OID,
    expectedTreeOid: REMOTE_OID,
  };
  const candidateRef = 'refs/ky-integration-v3/candidates/candidate-1/r2/head';

  it('verifies exact Provider refs when an advanced base and PR head have diverged', async () => {
    const host = new ScriptedHost([
      shallowStep(),
      { cwd: REPOSITORY, args: [
        'fetch', '--no-tags', '--', input.controlledRemoteUrl,
        '+refs/heads/main:refs/remotes/origin/main',
        `+refs/pull/108/head:${candidateRef}`,
      ] },
      { cwd: REPOSITORY, args: ['rev-parse', '--verify', candidateRef], result: { stdout: `${INTEGRATION_OID}\n` } },
      { cwd: REPOSITORY, args: ['rev-parse', '--verify', `${MAIN_OID}^{commit}`], result: { stdout: `${MAIN_OID}\n` } },
      { cwd: REPOSITORY, args: ['rev-parse', '--verify', `${INTEGRATION_OID}^{tree}`], result: { stdout: `${REMOTE_OID}\n` } },
      ancestorStep(MAIN_OID, 'refs/remotes/origin/main', true),
    ]);

    await expect(syncCandidateRevisionObjects(host, candidate)).resolves.toEqual({
      repositoryPath: REPOSITORY,
      baseOid: MAIN_OID,
      headOid: INTEGRATION_OID,
      treeOid: REMOTE_OID,
    });
    host.assertConsumed();
  });

  it('unshallows the controlled mirror before exporting candidate connectivity', async () => {
    const host = new ScriptedHost([
      shallowStep(true),
      { cwd: REPOSITORY, args: [
        'fetch', '--no-tags', '--unshallow', '--', input.controlledRemoteUrl,
        '+refs/heads/main:refs/remotes/origin/main',
        `+refs/pull/108/head:${candidateRef}`,
      ] },
      { cwd: REPOSITORY, args: ['rev-parse', '--verify', candidateRef], result: { stdout: `${INTEGRATION_OID}\n` } },
      { cwd: REPOSITORY, args: ['rev-parse', '--verify', `${MAIN_OID}^{commit}`], result: { stdout: `${MAIN_OID}\n` } },
      { cwd: REPOSITORY, args: ['rev-parse', '--verify', `${INTEGRATION_OID}^{tree}`], result: { stdout: `${REMOTE_OID}\n` } },
      ancestorStep(MAIN_OID, 'refs/remotes/origin/main', true),
    ]);

    await expect(syncCandidateRevisionObjects(host, candidate)).resolves.toMatchObject({ headOid: INTEGRATION_OID });
    host.assertConsumed();
  });

  it('identifies a controlled fetch timeout instead of reporting an opaque Git exit', async () => {
    const host = new ScriptedHost([
      shallowStep(),
      {
      cwd: REPOSITORY,
      args: [
        'fetch', '--no-tags', '--', input.controlledRemoteUrl,
        '+refs/heads/main:refs/remotes/origin/main',
        `+refs/pull/108/head:${candidateRef}`,
      ],
      env: { GIT_ASKPASS: 'secret' },
      result: { exitCode: 1, stderr: 'Git command timed out after 120000ms' },
    }]);

    const error = await syncCandidateRevisionObjects(host, {
      ...candidate,
      fetchEnvironment: { GIT_ASKPASS: 'secret' },
    }).catch((cause) => cause);
    expect(error).toMatchObject({
      code: 'GIT_COMMAND_FAILED',
      message: 'Git fetch failed: Git command timed out after 120000ms',
      command: { cwd: REPOSITORY, args: host.commands[1]!.args },
    });
    expect(error.command).not.toHaveProperty('env');
    host.assertConsumed();
  });

  it('fails closed when the frozen base is no longer reachable from authoritative main', async () => {
    const host = new ScriptedHost([
      shallowStep(),
      { cwd: REPOSITORY, args: [
        'fetch', '--no-tags', '--', input.controlledRemoteUrl,
        '+refs/heads/main:refs/remotes/origin/main',
        `+refs/pull/108/head:${candidateRef}`,
      ] },
      { cwd: REPOSITORY, args: ['rev-parse', '--verify', candidateRef], result: { stdout: `${INTEGRATION_OID}\n` } },
      { cwd: REPOSITORY, args: ['rev-parse', '--verify', `${MAIN_OID}^{commit}`], result: { stdout: `${MAIN_OID}\n` } },
      { cwd: REPOSITORY, args: ['rev-parse', '--verify', `${INTEGRATION_OID}^{tree}`], result: { stdout: `${REMOTE_OID}\n` } },
      ancestorStep(MAIN_OID, 'refs/remotes/origin/main', false),
    ]);

    await expect(syncCandidateRevisionObjects(host, candidate)).rejects.toMatchObject({ code: 'WORKTREE_DIVERGED' });
    host.assertConsumed();
  });

  it('fails closed when the Integration PR head drifted', async () => {
    const host = new ScriptedHost([
      shallowStep(),
      { cwd: REPOSITORY, args: [
        'fetch', '--no-tags', '--', input.controlledRemoteUrl,
        '+refs/heads/main:refs/remotes/origin/main',
        `+refs/pull/108/head:${candidateRef}`,
      ] },
      { cwd: REPOSITORY, args: ['rev-parse', '--verify', candidateRef], result: { stdout: `${'5'.repeat(40)}\n` } },
    ]);

    await expect(syncCandidateRevisionObjects(host, candidate)).rejects.toMatchObject({ code: 'WORKTREE_DIVERGED' });
    host.assertConsumed();
  });
});

describe('syncRepositoryWorkspace', () => {
  it('fetches origin, fast-forwards a clean behind main, and creates a new integration worktree', async () => {
    const host = new ScriptedHost([
      listStep(mainRecord()),

      fetchStep(),

      remoteOidStep(),
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
        args: ['worktree', 'add', '-b', 'integration/42', '--no-track', '--', WORKTREE, 'refs/remotes/origin/main'],
      },
      listStep(`${mainRecord(REMOTE_OID)}\n${integrationRecord(REMOTE_OID)}`),
      ...ownershipSteps(REMOTE_OID),
    ]);

    await expect(syncRepositoryWorkspace(host, input)).resolves.toMatchObject({
      baseOid: REMOTE_OID,
      localBase: 'fast_forwarded',
      integrationWorktree: 'created',
    });
    expect(host.locks).toEqual([{ repositoryPath: REPOSITORY, branch: '*' }]);
    host.assertConsumed();
  });

  it('fails closed when post-create Git ownership does not expose the exact worktree', async () => {
    const host = new ScriptedHost([
      listStep(mainRecord()), fetchStep(), remoteOidStep(), statusStep(REPOSITORY),
      ancestorStep('refs/heads/main', 'refs/remotes/origin/main', true),
      ancestorStep('refs/remotes/origin/main', 'refs/heads/main', false),
      { cwd: REPOSITORY, args: ['merge', '--ff-only', 'refs/remotes/origin/main'] },
      { cwd: REPOSITORY, args: ['show-ref', '--verify', '--quiet', 'refs/heads/integration/42'], result: { exitCode: 1 } },
      { cwd: REPOSITORY, args: ['worktree', 'add', '-b', 'integration/42', '--no-track', '--', WORKTREE, 'refs/remotes/origin/main'] },
      listStep(mainRecord(REMOTE_OID)),
    ]);

    await expect(syncRepositoryWorkspace(host, input)).rejects.toMatchObject({ code: 'WORKTREE_UNKNOWN' });
    expect(host.commands.some((command) => command.args[0] === 'worktree' && command.args[1] === 'add')).toBe(true);
    host.assertConsumed();
  });

  it('fetches and verifies frozen PR heads before deterministic compose', async () => {
    const frozenHeadOid = '4'.repeat(40);
    const frozenRef = 'refs/ky-integration-v3/source-heads/pr-74';
    const host = new ScriptedHost([
      listStep(`${mainRecord(REMOTE_OID)}\n${integrationRecord(REMOTE_OID)}`),
      ...ownershipSteps(REMOTE_OID),
      { cwd: REPOSITORY, args: [
        'fetch', '--no-tags', '--prune', '--', input.controlledRemoteUrl,
        '+refs/heads/main:refs/remotes/origin/main',
        `+refs/pull/74/head:${frozenRef}`,
      ] },
      {
        cwd: REPOSITORY,
        args: ['rev-parse', '--verify', frozenRef],
        result: { stdout: `${frozenHeadOid}\n` },
      },
      remoteOidStep(),
      statusStep(REPOSITORY),
      ancestorStep('refs/heads/main', 'refs/remotes/origin/main', true),
      ancestorStep('refs/remotes/origin/main', 'refs/heads/main', true),
      statusStep(WORKTREE),
      ancestorStep('refs/heads/integration/42', 'refs/remotes/origin/main', true),
      ancestorStep('refs/remotes/origin/main', 'refs/heads/integration/42', true),
    ]);

    await expect(syncRepositoryWorkspace(host, {
      ...input,
      frozenPullRequestHeads: [{ providerPullRequestId: '74', expectedHeadOid: frozenHeadOid }],
    })).resolves.toMatchObject({ integrationWorktree: 'current' });
    host.assertConsumed();
  });

  it('fails closed when a frozen PR ref no longer matches its reviewed head', async () => {
    const expectedHeadOid = '4'.repeat(40);
    const actualHeadOid = '5'.repeat(40);
    const frozenRef = 'refs/ky-integration-v3/source-heads/pr-74';
    const host = new ScriptedHost([
      listStep(mainRecord()),
      { cwd: REPOSITORY, args: [
        'fetch', '--no-tags', '--prune', '--', input.controlledRemoteUrl,
        '+refs/heads/main:refs/remotes/origin/main',
        `+refs/pull/74/head:${frozenRef}`,
      ] },
      {
        cwd: REPOSITORY,
        args: ['rev-parse', '--verify', frozenRef],
        result: { stdout: `${actualHeadOid}\n` },
      },
    ]);

    await expect(syncRepositoryWorkspace(host, {
      ...input,
      frozenPullRequestHeads: [{ providerPullRequestId: '74', expectedHeadOid }],
    })).rejects.toMatchObject({ code: 'WORKTREE_DIVERGED' });
    host.assertConsumed();
  });

  it('fails closed on a dirty main with evidence and zero Git writes', async () => {
    const host = new ScriptedHost([
      listStep(mainRecord()), statusStep(REPOSITORY, ' M src/index.ts\n'),
    ]);

    const error = await syncRepositoryWorkspace(host, input).catch((cause) => cause);
    expect(error).toMatchObject({
      code: 'WORKTREE_DIRTY',
      evidence: {
        worktreePath: REPOSITORY,
        expectedBranch: 'refs/heads/main',
        statusPorcelain: ' M src/index.ts\n',
        commonDir: `${REPOSITORY}/.git`,
      },
    });
    expect(host.commands.flatMap((command) => command.args)).not.toContain('fetch');
    expect(host.commands.flatMap((command) => command.args)).not.toContain('reset');
    host.assertConsumed();
  });

  it('fails closed when local main has commits not present on origin/main', async () => {
    const host = new ScriptedHost([
      listStep(mainRecord()),

      fetchStep(),

      remoteOidStep(),
      statusStep(REPOSITORY),
      ancestorStep('refs/heads/main', 'refs/remotes/origin/main', false),
    ]);

    await expect(syncRepositoryWorkspace(host, input)).rejects.toMatchObject({ code: 'WORKTREE_DIVERGED' });
    expect(host.commands.some((command) => command.args.includes('merge'))).toBe(false);
    host.assertConsumed();
  });

  it('stops immediately and reports a structured fetch failure', async () => {
    const host = new ScriptedHost([
      listStep(mainRecord()),
      { ...fetchStep(), result: { exitCode: 128, stderr: 'remote unavailable' } },
    ]);

    await expect(syncRepositoryWorkspace(host, input)).rejects.toMatchObject({
      code: 'GIT_COMMAND_FAILED',
      command: { cwd: REPOSITORY, args: fetchStep().args },
    });
    expect(host.commands).toHaveLength(7);
    expect(host.commands.at(-1)).toMatchObject({ args: fetchStep().args });
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
      realpath: async (path) => path,
      lstat: async () => ({ isSymbolicLink: () => false }),
      stat: async () => ({ uid: process.getuid?.() ?? 0, mode: 0o700, isDirectory: () => true }),
      runGit: vi.fn(async ({ cwd, args }: RepositoryWorkspaceGitCommand) => {
        if (args[0] === 'worktree' && args[1] === 'list') return ok(`${mainRecord(REMOTE_OID)}\n${integrationRecord(REMOTE_OID)}`);
        if (args[0] === 'symbolic-ref') return ok(cwd === REPOSITORY ? 'refs/heads/main\n' : 'refs/heads/integration/42\n');
        if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
          return ok(cwd === REPOSITORY ? `${REPOSITORY}/.git\n` : `${REPOSITORY}/.git/worktrees/integration-42\n`);
        }
        if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return ok(`${REPOSITORY}/.git\n`);
        if (args[0] === 'rev-parse') return ok(`${REMOTE_OID}\n`);
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
      { repositoryPath: REPOSITORY, branch: '*' },
      { repositoryPath: REPOSITORY, branch: '*' },
    ]);
  });

  it('maps repository path aliases to one canonical repository-wide lock identity', async () => {
    const locks: RepositoryWorkspaceSyncLock[] = [];
    const host = {
      resolveRepositoryLockScope: vi.fn(async () => '/srv/cache/acme-widget/.git'),
      withRepositoryBranchLock: async <T>(lock: RepositoryWorkspaceSyncLock, operation: () => Promise<T>) => {
        locks.push(lock);
        return operation();
      },
    } as unknown as RepositoryWorkspaceSyncHost;

    await withRepositoryScopeLock(host, '/srv/cache/alias-a', async () => undefined);
    await withRepositoryScopeLock(host, '/srv/cache/alias-b', async () => undefined);

    expect(host.resolveRepositoryLockScope).toHaveBeenCalledTimes(2);
    expect(locks).toEqual([
      { repositoryPath: '/srv/cache/acme-widget/.git', branch: '*' },
      { repositoryPath: '/srv/cache/acme-widget/.git', branch: '*' },
    ]);
  });

  it('checks the request mutation guard after ownership admission and before fetch', async () => {
    const host = new ScriptedHost([listStep(mainRecord())]);
    const guard = vi.fn(async () => { throw new Error('request lease lost'); });

    await expect(syncRepositoryWorkspace(host, input, guard)).rejects.toThrow('request lease lost');
    expect(guard).toHaveBeenCalledOnce();
    expect(host.commands[0]).toEqual({ cwd: REPOSITORY, args: ['worktree', 'list', '--porcelain'], env: readOnlyEnv });
    expect(host.commands.flatMap((command) => command.args)).not.toContain('fetch');
    host.assertConsumed();
  });

  it.each([
    ['symbolic Git-owned path', `${mainRecord()}\n${integrationRecord()}`, true],
    ['foreign existing directory', mainRecord(), false],
  ])('rejects a %s before fetch with zero Git writes', async (_label, records, symbolic) => {
    const host = new ScriptedHost([listStep(records)]);
    vi.spyOn(host, 'lstat').mockResolvedValue({ isSymbolicLink: () => symbolic });

    await expect(syncRepositoryWorkspace(host, input)).rejects.toMatchObject({ code: 'WORKTREE_UNKNOWN' });
    expect(host.commands).toEqual([{ cwd: REPOSITORY, args: ['worktree', 'list', '--porcelain'], env: readOnlyEnv }]);
    host.assertConsumed();
  });

  it('rejects a symlinked controlled worktree parent before fetch', async () => {
    const host = new ScriptedHost([listStep(mainRecord())]);
    vi.spyOn(host, 'lstat').mockImplementation(async (path: string) => {
      if (path === WORKTREE) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (path === WORKTREE_PARENT) return { isSymbolicLink: () => true };
      return { isSymbolicLink: () => false };
    });

    await expect(syncRepositoryWorkspace(host, input)).rejects.toMatchObject({ code: 'WORKTREE_UNKNOWN' });
    expect(host.commands.flatMap((command) => command.args)).not.toContain('fetch');
    host.assertConsumed();
  });

  it.each([
    ['foreign owner', (process.getuid?.() ?? 0) + 1, 0o700],
    ['group-writable mode', process.getuid?.() ?? 0, 0o720],
  ])('rejects a controlled worktree parent with unsafe %s before fetch', async (_case, uid, mode) => {
    const host = new ScriptedHost([listStep(mainRecord())]);
    vi.spyOn(host, 'stat').mockResolvedValue({ uid, mode, isDirectory: () => true });

    await expect(syncRepositoryWorkspace(host, input)).rejects.toMatchObject({ code: 'WORKTREE_UNKNOWN' });
    expect(host.commands.flatMap((command) => command.args)).not.toContain('fetch');
    host.assertConsumed();
  });

  it('rejects an existing Git-owned worktree under an unsafe parent before fetch', async () => {
    const host = new ScriptedHost([listStep(`${mainRecord()}\n${integrationRecord()}`)]);
    vi.spyOn(host, 'stat').mockResolvedValue({
      uid: process.getuid?.() ?? 0,
      mode: 0o720,
      isDirectory: () => true,
    });

    await expect(syncRepositoryWorkspace(host, input)).rejects.toMatchObject({ code: 'WORKTREE_UNKNOWN' });
    expect(host.commands.flatMap((command) => command.args)).not.toContain('fetch');
    host.assertConsumed();
  });

  it('redacts credential-shaped values from durable raw porcelain evidence', async () => {
    const secrets = ['github_pat_11AA_secretvalue', 'ghs_serverinstallationtoken', 'url-password'];
    const raw = `worktree ${WORKTREE}\nHEAD ${INTEGRATION_OID}\nunknown token=${secrets[0]} bearer=${secrets[1]} https://user:${secrets[2]}@github.com/acme/widget.git\n`;
    const host = new ScriptedHost([listStep(raw)]);

    const error = await syncRepositoryWorkspace(host, input).catch((cause) => cause);
    expect(error).toMatchObject({ code: 'WORKTREE_UNKNOWN' });
    expect(error.evidence.porcelainRecord).toContain('[REDACTED]');
    for (const secret of secrets) expect(error.evidence.porcelainRecord).not.toContain(secret);
    host.assertConsumed();
  });

  it('refreshes an existing clean integration worktree with ff-only', async () => {
    const host = new ScriptedHost([
      listStep(`${mainRecord(REMOTE_OID)}\n${integrationRecord()}`),
      ...ownershipSteps(),

      fetchStep(),

      remoteOidStep(),
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
    expect(host.commands.filter((command) => command.args[0] === 'worktree' && command.args[1] !== 'list')).toEqual([]);
    host.assertConsumed();
  });

  it('resets a clean deterministic compose worktree when the authoritative base advanced', async () => {
    const host = new ScriptedHost([
      listStep(`${mainRecord(REMOTE_OID)}\n${integrationRecord()}`),
      ...ownershipSteps(),

      fetchStep(),

      remoteOidStep(),
      statusStep(REPOSITORY),
      ancestorStep('refs/heads/main', 'refs/remotes/origin/main', true),
      ancestorStep('refs/remotes/origin/main', 'refs/heads/main', true),
      statusStep(WORKTREE),
      { cwd: WORKTREE, args: ['reset', '--hard', 'refs/remotes/origin/main'] },
    ]);

    await expect(syncRepositoryWorkspace(host, {
      ...input,
      integrationWorktreeMode: 'reset_to_base',
    })).resolves.toMatchObject({
      localBase: 'current',
      integrationWorktree: 'reset_to_base',
    });
    host.assertConsumed();
  });

  it('persists bounded raw porcelain for a branchless ownership record with zero Git writes', async () => {
    const branchless = `worktree ${WORKTREE}\nHEAD ${INTEGRATION_OID}`;
    const raw = `${mainRecord()}\n${branchless}\n`;
    const host = new ScriptedHost([listStep(raw)]);

    const error = await syncRepositoryWorkspace(host, input).catch((cause) => cause);
    expect(error).toMatchObject({
      code: 'WORKTREE_UNKNOWN',
      evidence: {
        repositoryPath: REPOSITORY,
        worktreePath: WORKTREE,
        expectedBranch: 'refs/heads/integration/42',
        porcelainRecord: branchless,
      },
    });
    expect(host.commands).toEqual([{ cwd: REPOSITORY, args: ['worktree', 'list', '--porcelain'], env: readOnlyEnv }]);
    host.assertConsumed();
  });

  it('persists bounded raw porcelain for malformed worktree output with zero Git writes', async () => {
    const raw = `worktree ${WORKTREE}\nbranch refs/heads/integration/42\nunknown ${'x'.repeat(9_000)}\n`;
    const host = new ScriptedHost([listStep(raw)]);

    const error = await syncRepositoryWorkspace(host, input).catch((cause) => cause);
    expect(error).toMatchObject({
      code: 'WORKTREE_UNKNOWN',
      evidence: {
        repositoryPath: REPOSITORY,
        worktreePath: WORKTREE,
        expectedBranch: 'refs/heads/integration/42',
        porcelainRecord: raw.slice(0, 8_192),
      },
    });
    expect(error.evidence.porcelainRecord).toHaveLength(8_192);
    expect(host.commands).toEqual([{ cwd: REPOSITORY, args: ['worktree', 'list', '--porcelain'], env: readOnlyEnv }]);
    host.assertConsumed();
  });

  it('rejects a real detached worktree with complete evidence and zero Git writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'integration-v3-ownership-'));
    const repositoryPath = join(root, 'repository');
    const worktreePath = join(root, 'candidate-worktree');
    const commands: RepositoryWorkspaceGitCommand[] = [];
    const actualGit = async (cwd: string, args: readonly string[]) => {
      try {
        const result = await exec('git', [...args], { cwd });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error: any) {
        return { exitCode: Number(error.code) || 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message) };
      }
    };
    try {
      await exec('git', ['init', '-b', 'main', repositoryPath]);
      await exec('git', ['config', 'user.name', 'Test'], { cwd: repositoryPath });
      await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: repositoryPath });
      await writeFile(join(repositoryPath, 'base.txt'), 'base\n');
      await exec('git', ['add', '.'], { cwd: repositoryPath });
      await exec('git', ['commit', '-m', 'base'], { cwd: repositoryPath });
      await exec('git', ['worktree', 'add', '-b', 'integration/real', worktreePath], { cwd: repositoryPath });
      await exec('git', ['checkout', '--detach'], { cwd: worktreePath });
      const branchOid = (await exec('git', ['rev-parse', 'refs/heads/integration/real'], { cwd: repositoryPath })).stdout.trim();
      const host: RepositoryWorkspaceSyncHost = {
        withRepositoryBranchLock: async (_lock, operation) => operation(),
        validateServerOwnedRepository: async () => undefined,
        runGit: async (command) => {
          commands.push(command);
          return actualGit(command.cwd, command.args);
        },
      };
      const error = await syncRepositoryWorkspace(host, {
        repositoryPath,
        worktreePath,
        baseBranch: 'main',
        integrationBranch: 'integration/real',
        controlledRemoteUrl: 'https://github.com/acme/widget.git',
        integrationWorktreeMode: 'reset_to_base',
      }).catch((cause) => cause);
      expect(error).toMatchObject({
        code: 'WORKTREE_UNKNOWN',
        evidence: {
          repositoryPath, worktreePath, headOid: branchOid, detached: true,
          porcelainRecord: expect.stringContaining('detached'), statusPorcelain: '',
          gitDir: expect.stringContaining('/worktrees/'), commonDir: expect.stringContaining('/.git'),
        },
      });
      const writes = commands.filter(({ args }) => (
        ['fetch', 'reset', 'merge', 'cherry-pick', 'commit-tree', 'write-tree'].includes(args[0] ?? '')
        || (args[0] === 'worktree' && args[1] !== 'list')
      ));
      expect(writes).toEqual([]);
      await expect(exec('git', ['rev-parse', 'refs/heads/integration/real'], { cwd: repositoryPath }))
        .resolves.toMatchObject({ stdout: `${branchOid}\n` });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
