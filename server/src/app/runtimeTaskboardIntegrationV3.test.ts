import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  TaskBoardIntegrationCandidate,
  TaskBoardIntegrationCandidateRevision,
  TaskBoardRepositoryConfig,
} from '../../../shared/src/types/taskboard.js';
import {
  buildRuntimeTaskboardIntegrationV3Options,
  createRuntimeIntegrationV3CleanupHost,
  resolveIntegrationV3RepositoryPaths,
} from './runtimeTaskboardIntegrationV3.js';

const repository: TaskBoardRepositoryConfig = {
  provider: 'github', repositoryId: 'github:acme/widget', owner: 'acme', name: 'widget',
  baseBranch: 'main', allowForkPullRequest: false,
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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

  it('accepts only an injected App provider and preserves repository/installation binding', async () => {
    const built = buildRuntimeTaskboardIntegrationV3Options({
      ...base, control,
      githubAppInstallationTokenProvider: {
        getInstallationToken: async ({ repositoryId, installationId }) => ({
          token: 'app-token', repositoryId, installationId,
        }),
      },
    });
    await expect(built.resolveGithubToken?.({ tenantId: 't', ownerUserId: 'u', repositoryId: 'github-id:123' }))
      .resolves.toMatchObject({ mode: 'github_app', repositoryId: 123, installationId: 456 });
    await expect(built.resolveGithubToken?.({ tenantId: 't', ownerUserId: 'u', repositoryId: 'github:acme/widget' }))
      .resolves.toBeUndefined();
  });
});

describe('resolveIntegrationV3RepositoryPaths', () => {
  it('uses only a server-owned controlled mirror and never an Agent checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'integration-v3-runtime-')); roots.push(root);
    const mirrorRoot = join(root, 'mirrors');
    const repositoryPath = createRepository(join(mirrorRoot, 'github_acme_widget'), 'https://github.com/acme/widget.git');
    createRepository(join(root, 'agent/projects/widget'), 'https://github.com/acme/widget.git');
    await expect(resolveIntegrationV3RepositoryPaths(repository, 'candidate-1', {
      processCwd: root, agentCwd: join(root, 'agent'), controlledMirrorRoot: mirrorRoot,
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
    await expect(resolveIntegrationV3RepositoryPaths(repository, 'candidate-2', {
      processCwd: root, agentCwd: join(root, 'agent'), controlledMirrorRoot: mirrorRoot,
    })).resolves.toBeUndefined();
  });

  it('rejects a mirror with a group/world-writable Git common-dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'integration-v3-runtime-')); roots.push(root);
    const mirrorRoot = join(root, 'mirrors');
    const repositoryPath = createRepository(join(mirrorRoot, 'github_acme_widget'), 'https://github.com/acme/widget.git');
    chmodSync(join(repositoryPath, '.git'), 0o777);
    await expect(resolveIntegrationV3RepositoryPaths(repository, 'candidate-corrupt', {
      processCwd: root, agentCwd: join(root, 'agent'), controlledMirrorRoot: mirrorRoot,
    })).resolves.toBeUndefined();
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
      withRepositoryBranchLock: async (_lock, operation) => operation(),
      runGit,
    });
    const request = {
      id: 'cleanup-1', leaseId: 'lease-1', kind: 'cleanup' as const,
      candidateId: candidate.id, candidateRevision: 1, payload: { reason: 'candidate_merged' },
    };

    const receipt = await cleanup(request);
    expect(revoked).toEqual(['cap-1', 'cap-2']);
    expect(fenceCapabilities).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', repositoryId: candidate.repositoryId,
      integrationTaskId: candidate.integrationTaskId, candidateId: candidate.id,
      revision: 1, laneEpoch: 9, workflowEpoch: 3, enabled: false,
    }), 'candidate_merged');
    expect(receipt).toMatchObject({ outcome: 'succeeded', actions: [
      { action: 'revoke_capabilities', status: 'succeeded' },
      { action: 'fence_capabilities', status: 'succeeded' },
      { action: 'remove_candidate_worktree', status: 'succeeded', target: worktreePath },
      { action: 'source_pull_request', status: 'skipped', target: '101', reason: expect.stringContaining('does not authorize') },
      { action: 'source_pull_request', status: 'skipped', target: '102', reason: expect.stringContaining('does not authorize') },
    ] });
    expect(runGit.mock.calls.map(([command]) => command.args)).toEqual([
      ['status', '--porcelain=v1', '--untracked-files=all'],
      ['worktree', 'remove', '--', worktreePath],
    ]);

    firstAttempt = false;
    const retried = await cleanup({ ...request, leaseId: 'lease-2' });
    expect(retried).toMatchObject({ outcome: 'succeeded', actions: expect.arrayContaining([
      { action: 'remove_candidate_worktree', status: 'skipped', target: worktreePath, reason: 'candidate worktree is already absent' },
    ]) });
    expect(runGit).toHaveBeenCalledTimes(2);
  });

  it('fails closed with action receipts when capability revoke and worktree inspection fail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'integration-v3-cleanup-host-fail-')); roots.push(root);
    const mirrorRoot = join(root, 'mirrors');
    const repositoryPath = join(mirrorRoot, 'github_acme_widget');
    const worktreePath = join(mirrorRoot, '.worktrees', 'candidate-1');
    mkdirSync(repositoryPath, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    const candidate = cleanupCandidate();
    const cleanup = createRuntimeIntegrationV3CleanupHost({
      controlledMirrorRoot: mirrorRoot,
      loadCurrent: async () => ({ candidate, revision: cleanupRevision() }),
      resolveContext: async () => ({ repositoryPath, worktreePath, tenantId: 'tenant-1', credentialOwnerId: 'owner-1', sources: [] }),
      findActiveCapabilityIds: async () => ['cap-fail'],
      revokeCapability: async () => { throw new Error('database unavailable'); },
      fenceCapabilities: async () => 0,
      withRepositoryBranchLock: async (_lock, operation) => operation(),
      runGit: async () => ({ exitCode: 0, stdout: ' M dirty.ts\n', stderr: '' }),
    });
    const receipt = await cleanup({
      id: 'cleanup-2', leaseId: 'lease-1', kind: 'cleanup', candidateId: candidate.id,
      candidateRevision: 1, payload: {},
    });
    expect(receipt).toMatchObject({ outcome: 'failed', actions: expect.arrayContaining([
      expect.objectContaining({ action: 'revoke_capabilities', status: 'failed', error: expect.stringContaining('Failed to revoke 1') }),
      expect.objectContaining({ action: 'fence_capabilities', status: 'succeeded' }),
      expect.objectContaining({ action: 'remove_candidate_worktree', status: 'failed', error: expect.stringContaining('dirty') }),
    ]) });
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
    sourceSetDigest: 'sources', subjectDigest: 'subject', policySnapshotDigest: 'policy', policyRevision: 'policy-1',
    mergeMethod: 'squash', workRound: 0, createdAt: '2026-08-19T00:00:00.000Z',
  };
}

function createRepository(path: string, origin: string): string {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: path });
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: path });
  return path;
}
