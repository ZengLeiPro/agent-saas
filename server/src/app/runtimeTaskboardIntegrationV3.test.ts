import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  TaskBoardIntegrationCandidate,
  TaskBoardIntegrationCandidateRevision,
  TaskBoardRepositoryConfig,
} from '../../../shared/src/types/taskboard.js';
import {
  assertIntegrationV3FilesystemIsolation,
  buildRuntimeTaskboardIntegrationV3Options,
  configureRuntimeIntegrationV3RepositoryAccess,
  pathsOverlap,
  createRuntimeIntegrationV3CleanupHost,
  resolveIntegrationV3RepositoryPaths,
  resolveRuntimeIntegrationV3CleanupContext,
  startIntegrationV3ActivationRetry,
} from './runtimeTaskboardIntegrationV3.js';

const repository: TaskBoardRepositoryConfig = {
  provider: 'github', repositoryId: 'github:acme/widget', owner: 'acme', name: 'widget',
  baseBranch: 'main', allowForkPullRequest: false,
};
const roots: string[] = [];
const requestGuard = (request: { id: string; leaseId: string; kind: 'work'|'review'|'cleanup'|'workspace_sync'; candidateId: string; candidateRevision: number; payload: Record<string, unknown> }) => ({
  request,
  assertCurrent: vi.fn(async () => undefined),
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Integration v3 activation retry', () => {
  it('starts once after the initial activation failure recovers', async () => {
    vi.useFakeTimers();
    const check = vi.fn()
      .mockResolvedValueOnce({ healthy: false, reason: 'gateway_unhealthy' })
      .mockResolvedValue({ healthy: true });
    const start = vi.fn();
    const setReason = vi.fn();
    const activation = startIntegrationV3ActivationRetry({ check, start, setReason, retryIntervalMs: 100 });

    await activation.initialAttempt;
    expect(start).not.toHaveBeenCalled();
    expect(setReason).toHaveBeenLastCalledWith('gateway_unhealthy');

    await vi.advanceTimersByTimeAsync(100);
    expect(check).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(1);
    expect(activation.isActive()).toBe(true);
    expect(setReason).toHaveBeenLastCalledWith(undefined);

    await vi.advanceTimersByTimeAsync(500);
    expect(check).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending retry when stopped', async () => {
    vi.useFakeTimers();
    const check = vi.fn().mockResolvedValue({ healthy: false, reason: 'gateway_unhealthy' });
    const start = vi.fn();
    const setReason = vi.fn();
    const activation = startIntegrationV3ActivationRetry({ check, start, setReason, retryIntervalMs: 100 });

    await activation.initialAttempt;
    await activation.stop();
    await vi.advanceTimersByTimeAsync(500);

    expect(check).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(setReason).toHaveBeenLastCalledWith('stopped');
  });
});

describe('Integration v3 worker activation', () => {
  it('does not enumerate tenant repositories or credentials before starting the global worker', () => {
    const source = readFileSync(new URL('./runtimeTaskboardIntegrationV3.ts', import.meta.url), 'utf8');
    const activationBlock = source.slice(source.indexOf('const activation = startIntegrationV3ActivationRetry'), source.indexOf('const heartbeatReady'));
    expect(activationBlock).not.toContain('store.pool.query');
    expect(activationBlock).not.toContain('resolveGithubToken');
    expect(activationBlock).not.toContain('repositoryAccess');
  });
});

describe('Integration v3 board repository probe wiring', () => {
  it('combines repository-specific read with PAT push permission and full identity verification', async () => {
    let probe: ((input: { tenantId: string; ownerUserId: string; repository: TaskBoardRepositoryConfig }) => Promise<boolean>) | undefined;
    let reviewProvider: unknown;
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(JSON.stringify(
      String(url).includes('/git/ref/heads/main')
        ? { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40) } }
        : String(url).includes('/git/commits/')
          ? { sha: 'a'.repeat(40), tree: { sha: 'b'.repeat(40) } }
          : { id: 123, full_name: 'acme/widget', permissions: { push: true } },
    ), { status: 200 })));
    configureRuntimeIntegrationV3RepositoryAccess({
      store: {
        setIntegrationV3RepositoryProvider: (value: unknown) => { reviewProvider = value; },
        setIntegrationV3RepositoryProbe: (value: typeof probe) => { probe = value; },
      } as never,
      control: { enabled: true, githubTokenMode: 'personal_access_token' },
      resolvePersonalAccessToken: async () => 'pat',
    });
    await expect(probe?.({ tenantId: 'tenant-1', ownerUserId: 'owner-1', repository: {
      ...repository, repositoryId: 'github-id:123',
    } })).resolves.toBe(true);
    expect(reviewProvider).toBeDefined();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/git/ref/heads/main'), expect.any(Object));
  });
});

describe('Integration v3 deployment preflight', () => {
  it('rejects enabled=false instead of accepting any boolean', () => {
    const workflow = readFileSync(new URL('../../../.github/workflows/integration-v3-preflight.yml', import.meta.url), 'utf8');
    expect(workflow).toContain("check('enabled_boolean', control.get('enabled') is True");
    expect(workflow).not.toContain("check('enabled_boolean', isinstance(control.get('enabled'), bool)");
  });
});

describe('buildRuntimeTaskboardIntegrationV3Options', () => {
  const base = {
    store: {} as any, executionCoordinator: {} as any, repositoryProvider: {} as any,
    processCwd: '/srv/app', agentCwd: '/srv/agent',
  };
  const control = {
    enabled: true, controlledMirrorRoot: '/srv/mirrors', githubAppInstallationId: 456,
    githubTokenMode: 'github_app' as const,
  };

  it('cannot turn a configuration boolean into runtime isolation evidence', () => {
    const built = buildRuntimeTaskboardIntegrationV3Options({ ...base, control });
    expect(built.enabled).toBe(true);
    expect(built.runtimeIsolationAttestationProvider).toBeUndefined();
    expect(built.resolveGithubToken).toBeUndefined();
  });

  it('does not use an independent probe as Integration Work admission before dispatch', () => {
    const source = readFileSync(new URL('./runtimeTaskboardIntegrationV3.ts', import.meta.url), 'utf8');
    const dispatchBlock = source.slice(source.indexOf('dispatchAgent:'), source.indexOf('syncWorkspace:', source.indexOf('dispatchAgent:')));
    expect(dispatchBlock).toContain('executionCoordinator.startIntegrationV3Execution');
    expect(dispatchBlock).not.toContain('.attest(');
    expect(dispatchBlock).not.toContain('validAttestation');
  });

  it('uses the existing PAT resolver without requiring an App installation', async () => {
    const personalAccessTokenResolver = vi.fn(async () => ({ token: 'pat', mode: 'personal_access_token' as const,
      repositoryId: 123, configuredRepositoryId: 'github:acme/widget',
      configuredRepositoryOwner: 'acme', configuredRepositoryName: 'widget' }));
    const built = buildRuntimeTaskboardIntegrationV3Options({
      ...base,
      control: { enabled: true, controlledMirrorRoot: '/srv/mirrors', githubTokenMode: 'personal_access_token' },
      personalAccessTokenResolver,
    });
    expect(built.githubAppInstallationId).toBeUndefined();
    expect(built.githubTokenMode).toBe('personal_access_token');
    expect(built.resolveGithubToken).toBe(personalAccessTokenResolver);
  });

  it('accepts only an injected App provider and preserves repository/installation binding', async () => {
    const built = buildRuntimeTaskboardIntegrationV3Options({
      ...base, control,
      githubAppInstallationTokenProvider: {
        getInstallationToken: async (input) => ({
          token: 'app-token', repositoryId: 'repositoryId' in input ? input.repositoryId : 123,
          installationId: input.installationId,
        }),
      },
    });
    await expect(built.resolveGithubToken?.({ tenantId: 't', ownerUserId: 'u', repositoryId: 'github-id:123', repositoryOwner: 'acme', repositoryName: 'widget' }))
      .resolves.toMatchObject({ mode: 'github_app', repositoryId: 123, installationId: 456 });
    await expect(built.resolveGithubToken?.({ tenantId: 't', ownerUserId: 'u', repositoryId: 'github:acme/widget', repositoryOwner: 'acme', repositoryName: 'widget' }))
      .resolves.toMatchObject({ mode: 'github_app', repositoryId: 123, installationId: 456 });
  });
});

describe('resolveIntegrationV3RepositoryPaths', () => {
  it('uses only a server-owned controlled mirror and never an Agent checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'integration-v3-runtime-')); roots.push(root);
    const mirrorRoot = join(root, 'mirrors');
    const repositoryPath = createRepository(join(mirrorRoot, 'github_acme_widget'), 'https://github.com/acme/widget.git');
    createRepository(join(root, 'agent/projects/widget'), 'https://github.com/acme/widget.git');
    mkdirSync(join(root, 'process'));
    await expect(resolveIntegrationV3RepositoryPaths(repository, 'candidate-1', {
      processCwd: join(root, 'process'), agentCwd: join(root, 'agent'), controlledMirrorRoot: mirrorRoot,
    })).resolves.toEqual({
      repositoryPath, worktreePath: resolve(mirrorRoot, '.worktrees', 'candidate-1'),
    });
  });

  it.each([
    'https://evil.example/path/github.com/acme/widget',
    'https://github.com.evil.example/acme/widget.git',
    'https://github.com:443/acme/widget.git?x=1',
    'https://user@github.com/acme/widget.git',
  ])('strictly rejects spoofed remote %s', async (origin) => {
    const root = mkdtempSync(join(tmpdir(), 'integration-v3-runtime-')); roots.push(root);
    const mirrorRoot = join(root, 'mirrors');
    createRepository(join(mirrorRoot, 'github_acme_widget'), origin);
    mkdirSync(join(root, 'process')); mkdirSync(join(root, 'agent'));
    await expect(resolveIntegrationV3RepositoryPaths(repository, 'candidate-2', {
      processCwd: join(root, 'process'), agentCwd: join(root, 'agent'), controlledMirrorRoot: mirrorRoot,
    })).resolves.toBeUndefined();
  });

  it('rejects a mirror with a group/world-writable Git common-dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'integration-v3-runtime-')); roots.push(root);
    const mirrorRoot = join(root, 'mirrors');
    const repositoryPath = createRepository(join(mirrorRoot, 'github_acme_widget'), 'https://github.com/acme/widget.git');
    chmodSync(join(repositoryPath, '.git'), 0o777);
    mkdirSync(join(root, 'process')); mkdirSync(join(root, 'agent'));
    await expect(resolveIntegrationV3RepositoryPaths(repository, 'candidate-corrupt', {
      processCwd: join(root, 'process'), agentCwd: join(root, 'agent'), controlledMirrorRoot: mirrorRoot,
    })).resolves.toBeUndefined();
  });

  it('rejects controlled mirror containment and realpath aliases with processCwd or agentCwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'integration-v3-runtime-overlap-')); roots.push(root);
    const processCwd = join(root, 'process');
    const mirrorRoot = join(processCwd, 'mirrors');
    const agentCwd = join(root, 'agent');
    mkdirSync(agentCwd, { recursive: true });
    createRepository(join(mirrorRoot, 'github_acme_widget'), 'https://github.com/acme/widget.git');
    await expect(resolveIntegrationV3RepositoryPaths(repository, 'candidate-overlap', {
      processCwd, agentCwd, controlledMirrorRoot: mirrorRoot,
    })).resolves.toBeUndefined();

    const isolatedProcess = join(root, 'isolated-process');
    const mirrorAlias = join(root, 'mirror-alias');
    mkdirSync(isolatedProcess);
    symlinkSync(mirrorRoot, mirrorAlias);
    await expect(resolveIntegrationV3RepositoryPaths(repository, 'candidate-alias', {
      processCwd: isolatedProcess, agentCwd: mirrorAlias, controlledMirrorRoot: mirrorRoot,
    })).resolves.toBeUndefined();
  });

  it('treats filesystem root, equal paths, parents, and children as overlaps without prefix false positives', () => {
    expect(pathsOverlap('/', '/srv/integration-mirrors')).toBe(true);
    expect(pathsOverlap('/srv/integration-mirrors', '/')).toBe(true);
    expect(pathsOverlap('/srv/integration-mirrors', '/srv/integration-mirrors')).toBe(true);
    expect(pathsOverlap('/srv/integration-mirrors', '/srv/integration-mirrors/repository')).toBe(true);
    expect(pathsOverlap('/srv/integration-mirrors', '/srv/integration-mirrors-old')).toBe(false);
    expect(() => assertIntegrationV3FilesystemIsolation({
      processCwd: '/tmp', agentCwd: '/var', controlledMirrorRoot: '/',
    })).toThrow('filesystem root');
  });

  it('fails closed when no controlled mirror capability is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'integration-v3-runtime-')); roots.push(root);
    createRepository(join(root, 'agent/projects/widget'), 'https://github.com/acme/widget.git');
    await expect(resolveIntegrationV3RepositoryPaths(repository, 'candidate-3', {
      processCwd: root, agentCwd: join(root, 'agent'),
    })).resolves.toBeUndefined();
  });
});

describe('production Integration v3 cleanup host', () => {
  it('reconstructs cleanup ownership and deterministic paths after the local mirror is already absent', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('SELECT b.tenant_id')
      ? { rows: [{ tenant_id: 'tenant-1', owner_user_id: 'owner-1' }] }
      : { rows: [{ provider_pull_request_id: '101' }, { provider_pull_request_id: '102' }] });
    const context = await resolveRuntimeIntegrationV3CleanupContext({
      pool: { query }, candidatesTable: 'candidates', tasksTable: 'tasks', boardsTable: 'boards',
      sourceSnapshotsTable: 'snapshots', controlledMirrorRoot: '/srv/integration-v3',
    }, { candidate: cleanupCandidate(), revision: cleanupRevision() });
    expect(context).toEqual({
      repositoryPath: '/srv/integration-v3/github_acme_widget',
      worktreePath: '/srv/integration-v3/.worktrees/candidate-1',
      tenantId: 'tenant-1', credentialOwnerId: 'owner-1',
      sources: [{ providerPullRequestId: '101' }, { providerPullRequestId: '102' }],
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('revokes and fences capabilities, safely removes the server worktree, and explicitly skips source PRs by frozen policy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'integration-v3-cleanup-host-')); roots.push(root);
    const mirrorRoot = join(root, 'mirrors');
    const repositoryPath = join(mirrorRoot, 'github_acme_widget');
    const worktreePath = join(mirrorRoot, '.worktrees', 'candidate-1');
    mkdirSync(repositoryPath, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    const candidate = cleanupCandidate();
    const revision = cleanupRevision();
    const revoked: string[] = [];
    const fenceCapabilities = vi.fn(async () => 2);
    const runGit = vi.fn(async (command: { cwd: string; args: readonly string[] }) => {
      if (command.args[0] === 'worktree') rmSync(worktreePath, { recursive: true, force: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    let firstAttempt = true;
    const cleanup = createRuntimeIntegrationV3CleanupHost({
      controlledMirrorRoot: mirrorRoot,
      loadCurrent: async () => ({ candidate, revision }),
      resolveContext: async () => ({
        repositoryPath, worktreePath, tenantId: 'tenant-1', credentialOwnerId: 'owner-1',
        sources: [{ providerPullRequestId: '101' }, { providerPullRequestId: '102' }],
      }),
      findActiveCapabilityIds: async () => firstAttempt ? ['cap-1', 'cap-2'] : [],
      revokeCapability: async (id) => { revoked.push(id); },
      fenceCapabilities,
      terminalizePreparedOperations: async () => 1,
      withRepositoryBranchLock: async (_lock, operation) => operation(),
      runGit,
    });
    const request = {
      id: 'cleanup-1', leaseId: 'lease-1', kind: 'cleanup' as const,
      candidateId: candidate.id, candidateRevision: 1, payload: { reason: 'candidate_merged' },
    };

    const receipt = await cleanup(request, requestGuard(request));
    expect(revoked).toEqual(['cap-1', 'cap-2']);
    expect(fenceCapabilities).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', repositoryId: candidate.repositoryId,
      integrationTaskId: candidate.integrationTaskId, candidateId: candidate.id,
      revision: 1, laneEpoch: 9, workflowEpoch: 3, enabled: false,
    }), 'candidate_merged');
    expect(receipt).toMatchObject({ outcome: 'succeeded', actions: [
      { action: 'revoke_capabilities', status: 'succeeded' },
      { action: 'fence_capabilities', status: 'succeeded' },
      { action: 'terminalize_prepared_operations', status: 'succeeded', target: '1' },
      { action: 'remove_candidate_worktree', status: 'succeeded', target: worktreePath },
      { action: 'source_pull_request', status: 'skipped', target: '101', reason: expect.stringContaining('does not authorize') },
      { action: 'source_pull_request', status: 'skipped', target: '102', reason: expect.stringContaining('does not authorize') },
    ] });
    expect(runGit.mock.calls.map(([command]) => command.args)).toEqual([
      ['status', '--porcelain=v1', '--untracked-files=all'],
      ['worktree', 'remove', '--', worktreePath],
    ]);

    firstAttempt = false;
    const retryRequest = { ...request, leaseId: 'lease-2' };
    const retried = await cleanup(retryRequest, requestGuard(retryRequest));
    expect(retried).toMatchObject({ outcome: 'succeeded', actions: expect.arrayContaining([
      { action: 'remove_candidate_worktree', status: 'skipped', target: worktreePath, reason: 'candidate worktree is already absent' },
    ]) });
    expect(runGit).toHaveBeenCalledTimes(2);
  });

  it('fails closed without deleting the worktree when a cleanup safety barrier fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'integration-v3-cleanup-host-fail-')); roots.push(root);
    const mirrorRoot = join(root, 'mirrors');
    const repositoryPath = join(mirrorRoot, 'github_acme_widget');
    const worktreePath = join(mirrorRoot, '.worktrees', 'candidate-1');
    mkdirSync(repositoryPath, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    const candidate = cleanupCandidate();
    const runGit = vi.fn(async () => ({ exitCode: 0, stdout: ' M dirty.ts\n', stderr: '' }));
    const cleanup = createRuntimeIntegrationV3CleanupHost({
      controlledMirrorRoot: mirrorRoot,
      loadCurrent: async () => ({ candidate, revision: cleanupRevision() }),
      resolveContext: async () => ({ repositoryPath, worktreePath, tenantId: 'tenant-1', credentialOwnerId: 'owner-1', sources: [] }),
      findActiveCapabilityIds: async () => ['cap-fail'],
      revokeCapability: async () => { throw new Error('database unavailable'); },
      fenceCapabilities: async () => 0,
      terminalizePreparedOperations: async () => { throw new Error('prepared operation remained active'); },
      withRepositoryBranchLock: async (_lock, operation) => operation(),
      runGit,
    });
    const failedRequest = {
      id: 'cleanup-2', leaseId: 'lease-1', kind: 'cleanup' as const, candidateId: candidate.id,
      candidateRevision: 1, payload: {},
    };
    const receipt = await cleanup(failedRequest, requestGuard(failedRequest));
    expect(receipt).toMatchObject({ outcome: 'failed', actions: expect.arrayContaining([
      expect.objectContaining({ action: 'revoke_capabilities', status: 'failed', error: expect.stringContaining('Failed to revoke 1') }),
      expect.objectContaining({ action: 'fence_capabilities', status: 'succeeded' }),
      expect.objectContaining({ action: 'terminalize_prepared_operations', status: 'failed', error: expect.stringContaining('remained active') }),
      expect.objectContaining({ action: 'remove_candidate_worktree', status: 'skipped', reason: expect.stringContaining('safety barrier') }),
    ]) });
    expect(runGit).not.toHaveBeenCalled();
  });
});

function cleanupCandidate(): TaskBoardIntegrationCandidate {
  return {
    id: 'candidate-1', integrationTaskId: 'integration-task-1', repositoryId: repository.repositoryId,
    baseBranch: 'main', branch: 'integration/candidate-1', state: 'merged', currentRevision: 1,
    workRound: 0, version: 2, workflowEpoch: '3', laneEpoch: '9', policyRevision: 'policy-1',
    mergeMethod: 'squash', policySnapshot: { execution: { deleteRemoteBranch: false } },
    createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
  };
}

function cleanupRevision(): TaskBoardIntegrationCandidateRevision {
  return {
    candidateId: 'candidate-1', revision: 1, digestVersion: 1, baseOid: 'base', headOid: 'head', treeOid: 'tree',
    compositionComplete: true, sourceSetDigest: 'sources', subjectDigest: 'subject', policySnapshotDigest: 'policy', policyRevision: 'policy-1',
    mergeMethod: 'squash', workRound: 0, createdAt: '2026-08-19T00:00:00.000Z',
  };
}

function createRepository(path: string, origin: string): string {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: path });
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: path });
  return path;
}
