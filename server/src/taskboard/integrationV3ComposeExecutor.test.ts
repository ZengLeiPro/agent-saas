import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardIntegrationCandidate } from '../../../shared/src/types/taskboard.js';
import { computeIntegrationSourceSetDigest } from './integrationCandidateDigest.js';
import { IntegrationPushCapabilityService } from './integrationPushCapability.js';
import { InMemoryIntegrationPushCapabilityHost } from './integrationPushCapabilityMemoryHost.js';
import { IntegrationPushGateway, type IntegrationPushGitRunner } from './integrationPushGateway.js';
import {
  IntegrationProviderOperationService,
  type IntegrationProviderOperationRecord,
  type IntegrationProviderOperationState,
  type IntegrationProviderOperationStorageHost,
} from './integrationProviderOperations.js';
import { DefaultIntegrationV3ComposeExecutor, IntegrationV3CandidateReloadRequiredError, IntegrationV3ComposeConflictError } from './integrationV3ComposeExecutor.js';
import type { IntegrationV3WorkerCurrent } from './integrationV3Worker.js';
import type { RepositoryProvider } from './repositoryProvider.js';

const run = promisify(execFile);
const exactRef = 'refs/heads/integration/integration-1';

class MemoryOperations implements IntegrationProviderOperationStorageHost {
  records = new Map<string, IntegrationProviderOperationRecord>();
  async getByOperationKey(key: string) { return this.records.get(key); }
  async insertPrepared(record: IntegrationProviderOperationRecord) {
    const winner = this.records.get(record.operationKey);
    if (winner) return winner;
    this.records.set(record.operationKey, record);
    return record;
  }
  async compareAndSet(input: { id: string; expectedState: IntegrationProviderOperationState; nextState: IntegrationProviderOperationState; patch: any }) {
    const record = [...this.records.values()].find((item) => item.id === input.id);
    if (!record || record.state !== input.expectedState) return undefined;
    const updated = { ...record, ...input.patch, state: input.nextState };
    this.records.set(updated.operationKey, updated);
    return updated;
  }
}

async function git(cwd: string, args: readonly string[], env?: Readonly<Record<string, string>>) {
  try {
    const result = await run('git', [...args], { cwd, env: { ...process.env, ...env } });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) {
    return { exitCode: Number(error.code) || 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message) };
  }
}

class ExactRemoteRunner implements IntegrationPushGitRunner {
  pushes = 0;
  constructor(private remoteOid: string) {}
  current() { return this.remoteOid; }
  async run(input: { cwd: string; args: string[]; env?: Record<string, string> }) {
    if (input.args[0] === 'ls-remote') return { stdout: `${this.remoteOid}\t${exactRef}\n` };
    if (input.args[0] === 'push') {
      this.pushes += 1;
      this.remoteOid = input.args.at(-1)!.split(':')[0]!;
      return { stdout: '' };
    }
    const result = await git(input.cwd, input.args, input.env);
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return { stdout: result.stdout };
  }
}

function candidate(baseOid: string): TaskBoardIntegrationCandidate {
  return {
    id: 'candidate-1', integrationTaskId: 'integration-1', repositoryId: 'github-id:123',
    baseBranch: 'main', branch: 'integration/integration-1', state: 'composing', currentRevision: 1,
    workRound: 0, version: 1, workflowEpoch: '4', laneEpoch: '3', policyRevision: 'policy-1',
    mergeMethod: 'squash', policySnapshot: {}, sourceSetDigest: 'seed',
    createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
  };
}

function current(value: TaskBoardIntegrationCandidate, baseOid: string, source: any, sources: any[] = [source]): Required<IntegrationV3WorkerCurrent> {
  const sourceSetDigest = computeIntegrationSourceSetDigest(sources);
  return {
    candidate: { ...value, sourceSetDigest },
    revision: {
      candidateId: value.id, revision: 1, digestVersion: 1, baseOid, headOid: source.frozenHeadOid,
      subjectKind: 'source_seed', compositionComplete: false, sourceSetDigest, subjectDigest: 'seed-subject',
      policySnapshotDigest: 'policy', policyRevision: 'policy-1', mergeMethod: 'squash', workRound: 0,
      createdAt: value.createdAt,
    },
  } as Required<IntegrationV3WorkerCurrent>;
}

describe('DefaultIntegrationV3ComposeExecutor push replay', () => {
  it('runs real composer + gateway + operation memory host for push, PR bind, reload and a no-write second compose', async () => {
    const root = await mkdtemp(join(tmpdir(), 'integration-compose-two-round-'));
    const repositoryPath = join(root, 'repository');
    const worktreePath = join(root, 'integration-worktree');
    await mkdir(repositoryPath);
    try {
      expect((await git(repositoryPath, ['init', '-b', 'main'])).exitCode).toBe(0);
      await git(repositoryPath, ['config', 'user.name', 'Test']);
      await git(repositoryPath, ['config', 'user.email', 'test@example.com']);
      await writeFile(join(repositoryPath, 'base.txt'), 'base\n');
      await git(repositoryPath, ['add', '.']); await git(repositoryPath, ['commit', '-m', 'base']);
      const baseOid = (await git(repositoryPath, ['rev-parse', 'HEAD'])).stdout.trim();
      await git(repositoryPath, ['checkout', '-b', 'delivery']);
      await writeFile(join(repositoryPath, 'delivery.txt'), 'delivery\n');
      await git(repositoryPath, ['add', '.']); await git(repositoryPath, ['commit', '-m', 'delivery']);
      const sourceHead = (await git(repositoryPath, ['rev-parse', 'HEAD'])).stdout.trim();
      await git(repositoryPath, ['update-ref', 'refs/pull/11/head', sourceHead]);
      await git(repositoryPath, ['checkout', 'main']);

      const source = {
        candidateId: 'candidate-1', revision: 1, order: 0, integrationSourceId: 'source-1',
        deliveryTaskId: 'delivery-1', deliveryTaskVersion: 1, repositoryId: 'github-id:123',
        providerPullRequestId: '11', frozenHeadOid: sourceHead, frozenBaseOid: baseOid,
        reviewedSubjectDigest: 'reviewed', reviewExecutionId: 'review-1', reviewReceiptDigest: 'receipt',
        requirementDigest: 'requirement', createdAt: '2026-08-19T00:00:00.000Z',
      };
      const storage = new MemoryOperations();
      const operationService = new IntegrationProviderOperationService(storage, { assertCurrent: async () => undefined });
      const runner = new ExactRemoteRunner(baseOid);
      const gateway = new IntegrationPushGateway({
        enabled: true, allowedWorktreeRoots: [root],
        capabilityService: new IntegrationPushCapabilityService(new InMemoryIntegrationPushCapabilityHost()),
        resolveTarget: async () => undefined,
        resolveRepository: async () => ({
          worktreePath, remoteUrl: 'https://github.com/org/repo.git', repositoryOwner: 'org', repositoryName: 'repo',
        }),
        resolveGithubToken: async () => ({
          token: 'secret', mode: 'github_app', repositoryId: 123, configuredRepositoryId: 'github-id:123',
          configuredRepositoryOwner: 'org', configuredRepositoryName: 'repo', installationId: 456,
        }),
        githubAppInstallationId: 456, operationService, runner,
      });
      let bound: string | undefined;
      const host = {
        resolveContext: async () => ({
          repository: { provider: 'github', repositoryId: 'github-id:123', owner: 'org', name: 'repo', baseBranch: 'main', allowForkPullRequest: false } as const,
          credentialOwnerId: 'owner-1', tenantId: 'tenant-1', repositoryPath, worktreePath, sources: [source],
          trustedIntegrationBranchOids: ['f'.repeat(40)],
        }),
        withRepositoryBranchLock: async <T>(_lock: unknown, action: () => Promise<T>) => action(),
        validateServerOwnedRepository: async () => undefined,
        runGit: async (command: { cwd: string; args: readonly string[]; env?: Readonly<Record<string, string>> }) => {
          const args = [...command.args];
          const remoteIndex = args.indexOf('https://github.com/org/repo.git');
          if (remoteIndex >= 0) args[remoteIndex] = repositoryPath;
          return git(command.cwd, args, command.env);
        },
        pushIntegrationHead: async (input: any) => gateway.pushExact({
          tenantId: 'tenant-1', ownerUserId: 'owner-1', repositoryId: 'github-id:123',
          integrationTaskId: input.integrationTaskId, candidateId: input.candidateId, revision: input.revision,
          exactRef, expectedOldOid: input.expectedOldOid, newOid: input.headOid,
          fence: { workflowEpoch: input.workflowEpoch, laneEpoch: input.laneEpoch,
            candidateId: input.candidateId, candidateRevision: input.revision, executionId: 'compose-1' },
        }),
        bindPullRequest: async (_id: string, _version: number, providerPullRequestId: string) => { bound = providerPullRequestId; },
      };
      const treeOf = async (oid: string) => (await git(repositoryPath, ['rev-parse', `${oid}^{tree}`])).stdout.trim();
      const ensureIntegrationBranch = vi.fn(async (_repository: unknown, _input: { trustedExistingOids?: string[] }) => (
        { oid: runner.current(), treeOid: await treeOf(runner.current()) }
      ));
      const provider = {
        ensureIntegrationBranch,
        getReference: async (_repository: unknown, ref: string) => {
          const oid = ref === 'main' ? baseOid : runner.current();
          return { oid, treeOid: await treeOf(oid) };
        },
        ensureIntegrationPullRequest: async () => ({ providerPullRequestId: '77' }),
      } as unknown as RepositoryProvider;
      const composer = new DefaultIntegrationV3ComposeExecutor(host, provider);
      const firstCandidate = candidate(baseOid);
      try {
        await composer.compose(current(firstCandidate, baseOid, source));
        throw new Error('expected reload');
      } catch (error: any) {
        if (!(error instanceof IntegrationV3CandidateReloadRequiredError)) {
          throw new Error(`unexpected compose error: ${error.message}; code=${error.code}; stderr=${error.command?.args?.join(' ')}`);
        }
      }
      expect(bound).toBe('77');
      expect(ensureIntegrationBranch.mock.calls[0]?.[1]).toMatchObject({ trustedExistingOids: ['f'.repeat(40)] });
      const remoteAfterFirst = runner.current();
      bound = undefined;
      try {
        await composer.compose(current(firstCandidate, baseOid, source));
        throw new Error('expected reload');
      } catch (error: any) {
        if (!(error instanceof IntegrationV3CandidateReloadRequiredError)) {
          throw new Error(`unexpected pre-bind replay error: ${error.message}; code=${error.code}; stderr=${error.command?.args?.join(' ')}`);
        }
      }
      expect(bound).toBe('77');
      const secondCandidate = { ...firstCandidate, providerPullRequestId: '77', version: 2 };
      const result = await composer.compose(current(secondCandidate, baseOid, source));
      expect(ensureIntegrationBranch.mock.calls[2]?.[1]).toMatchObject({ existingRequired: true,
        trustedExistingOids: ['f'.repeat(40)] });
      expect(result.headOid).toBe(remoteAfterFirst);
      expect(runner.pushes).toBe(1);
      expect(storage.records.size).toBe(1);
      expect([...storage.records.values()][0]).toMatchObject({ state: 'succeeded', receipt: { newOid: remoteAfterFirst } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an incomplete frozen source context before Git or provider writes', async () => {
    const source = {
      candidateId: 'candidate-1', revision: 1, order: 0, integrationSourceId: 'source-1',
      deliveryTaskId: 'delivery-1', deliveryTaskVersion: 1, repositoryId: 'github-id:123',
      providerPullRequestId: '11', frozenHeadOid: 'b'.repeat(40), frozenBaseOid: 'a'.repeat(40),
      reviewedSubjectDigest: 'reviewed', reviewExecutionId: 'review-1', reviewReceiptDigest: 'receipt',
      requirementDigest: 'requirement', createdAt: '2026-08-19T00:00:00.000Z',
    };
    const allSources = [source, { ...source, order: 1, integrationSourceId: 'source-2', providerPullRequestId: '12' }];
    const provider = {
      ensureIntegrationBranch: vi.fn(), ensureIntegrationPullRequest: vi.fn(), getReference: vi.fn(),
    } as unknown as RepositoryProvider;
    const runGit = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const composer = new DefaultIntegrationV3ComposeExecutor({
      resolveContext: async () => ({
        repository: { provider: 'github', repositoryId: 'github-id:123', owner: 'org', name: 'repo', baseBranch: 'main', allowForkPullRequest: false },
        credentialOwnerId: 'owner-1', tenantId: 'tenant-1', repositoryPath: '/repo', worktreePath: '/missing', sources: [source],
      }),
      withRepositoryBranchLock: async <T>(_lock: unknown, action: () => Promise<T>) => action(),
      validateServerOwnedRepository: async () => undefined, runGit,
      pushIntegrationHead: vi.fn(), bindPullRequest: vi.fn(),
    }, provider);

    await expect(composer.compose(current(candidate('a'.repeat(40)), 'a'.repeat(40), source, allSources)))
      .rejects.toThrow('complete frozen source set');
    expect(runGit).not.toHaveBeenCalled();
    expect(provider.ensureIntegrationBranch).not.toHaveBeenCalled();
  });

  it('publishes a deterministic incomplete subject before dispatching conflict remediation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'integration-compose-conflict-'));
    const repositoryPath = join(root, 'repository');
    const worktreePath = join(root, 'integration-worktree');
    await mkdir(repositoryPath);
    try {
      await git(repositoryPath, ['init', '-b', 'main']);
      await git(repositoryPath, ['config', 'user.name', 'Test']);
      await git(repositoryPath, ['config', 'user.email', 'test@example.com']);
      await writeFile(join(repositoryPath, 'conflict.txt'), 'base\n');
      await git(repositoryPath, ['add', '.']); await git(repositoryPath, ['commit', '-m', 'base']);
      const sourceBase = (await git(repositoryPath, ['rev-parse', 'HEAD'])).stdout.trim();
      await git(repositoryPath, ['checkout', '-b', 'source-one']);
      await writeFile(join(repositoryPath, 'success.txt'), 'source-one\n');
      await git(repositoryPath, ['add', '.']); await git(repositoryPath, ['commit', '-m', 'source one']);
      const sourceOneHead = (await git(repositoryPath, ['rev-parse', 'HEAD'])).stdout.trim();
      await git(repositoryPath, ['update-ref', 'refs/pull/11/head', sourceOneHead]);
      await git(repositoryPath, ['checkout', '-b', 'source-two', sourceBase]);
      await writeFile(join(repositoryPath, 'conflict.txt'), 'source-two\n');
      await git(repositoryPath, ['add', '.']); await git(repositoryPath, ['commit', '-m', 'source two']);
      const sourceTwoHead = (await git(repositoryPath, ['rev-parse', 'HEAD'])).stdout.trim();
      await git(repositoryPath, ['update-ref', 'refs/pull/12/head', sourceTwoHead]);
      await git(repositoryPath, ['checkout', 'main']);
      await writeFile(join(repositoryPath, 'conflict.txt'), 'main\n');
      await git(repositoryPath, ['add', '.']); await git(repositoryPath, ['commit', '-m', 'main diverged']);
      const mainOid = (await git(repositoryPath, ['rev-parse', 'HEAD'])).stdout.trim();
      const sources = [
        { order: 0, integrationSourceId: 'source-1', deliveryTaskId: 'delivery-1', providerPullRequestId: '11', frozenHeadOid: sourceOneHead },
        { order: 1, integrationSourceId: 'source-2', deliveryTaskId: 'delivery-2', providerPullRequestId: '12', frozenHeadOid: sourceTwoHead },
      ].map((source) => ({
        candidateId: 'candidate-1', revision: 1, deliveryTaskVersion: 1, repositoryId: 'github-id:123',
        frozenBaseOid: sourceBase, reviewedSubjectDigest: `reviewed-${source.order}`,
        reviewExecutionId: `review-${source.order}`, reviewReceiptDigest: `receipt-${source.order}`,
        requirementDigest: `requirement-${source.order}`, createdAt: '2026-08-19T00:00:00.000Z', ...source,
      }));
      let remoteOid = mainOid;
      let bound: string | undefined;
      const runGit = async (command: { cwd: string; args: readonly string[]; env?: Readonly<Record<string, string>> }) => {
        const args = [...command.args];
        const remoteIndex = args.indexOf('https://github.com/org/repo.git');
        if (remoteIndex >= 0) args[remoteIndex] = repositoryPath;
        return git(command.cwd, args, command.env);
      };
      const treeOf = async (oid: string) => (await git(repositoryPath, ['rev-parse', `${oid}^{tree}`])).stdout.trim();
      const host = {
        resolveContext: async () => ({
          repository: { provider: 'github', repositoryId: 'github-id:123', owner: 'org', name: 'repo', baseBranch: 'main', allowForkPullRequest: false } as const,
          credentialOwnerId: 'owner-1', tenantId: 'tenant-1', repositoryPath, worktreePath, sources,
        }),
        withRepositoryBranchLock: async <T>(_lock: unknown, action: () => Promise<T>) => action(),
        validateServerOwnedRepository: async () => undefined, runGit,
        pushIntegrationHead: async (input: { headOid: string }) => { remoteOid = input.headOid; },
        bindPullRequest: async (_id: string, _version: number, id: string) => { bound = id; },
      };
      const provider = {
        ensureIntegrationBranch: async () => ({ oid: remoteOid, treeOid: await treeOf(remoteOid) }),
        ensureIntegrationPullRequest: async () => ({ providerPullRequestId: '77' }),
        getReference: async (_repository: unknown, ref: string) => {
          const oid = ref === 'main' ? mainOid : remoteOid;
          return { oid, treeOid: await treeOf(oid) };
        },
      } as unknown as RepositoryProvider;
      const composer = new DefaultIntegrationV3ComposeExecutor(host, provider);
      const seed = current(candidate(sourceBase), sourceBase, sources[0], sources);
      await expect(composer.compose(seed)).rejects.toBeInstanceOf(IntegrationV3CandidateReloadRequiredError);
      expect(bound).toBe('77');
      const boundCandidate = { ...seed.candidate, providerPullRequestId: '77', version: 2 };
      const failure = await composer.compose({ ...seed, candidate: boundCandidate }).catch((error) => error);
      expect(failure).toBeInstanceOf(IntegrationV3ComposeConflictError);
      expect(failure.revision).toMatchObject({
        baseOid: mainOid, headOid: remoteOid, compositionComplete: false,
        sources: [expect.objectContaining({ integrationSourceId: 'source-1' }), expect.objectContaining({ integrationSourceId: 'source-2' })],
      });
      expect((await git(repositoryPath, ['show', `${remoteOid}:success.txt`])).stdout).toBe('source-one\n');
      expect((await git(repositoryPath, ['show', `${remoteOid}:conflict.txt`])).stdout).toBe('main\n');
      expect((await git(repositoryPath, ['rev-parse', `${remoteOid}^`])).stdout.trim()).toBe(mainOid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Integration v3 work completion gate', () => {
  it('does not inspect or promote a changed remote head without a bound ready work execution', async () => {
    const provider = { getReference: vi.fn() } as unknown as RepositoryProvider;
    const composer = new DefaultIntegrationV3ComposeExecutor({
      resolveContext: async () => ({
        repository: { provider: 'github', repositoryId: 'github-id:123', owner: 'org', name: 'repo', baseBranch: 'main', allowForkPullRequest: false },
        credentialOwnerId: 'owner-1', tenantId: 'tenant-1', repositoryPath: '/repo', worktreePath: '/worktree', sources: [],
      }),
      withRepositoryBranchLock: async <T>(_lock: unknown, action: () => Promise<T>) => action(),
      validateServerOwnedRepository: async () => undefined,
      runGit: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      bindPullRequest: async () => undefined,
    }, provider);
    const value = candidate('a'.repeat(40));
    value.providerPullRequestId = '77';
    const result = await composer.refreshAfterWork(current(value, 'a'.repeat(40), {
      candidateId: 'candidate-1', revision: 1, order: 0, integrationSourceId: 'source-1', deliveryTaskId: 'delivery-1',
      deliveryTaskVersion: 1, repositoryId: 'github-id:123', providerPullRequestId: '11', frozenHeadOid: 'b'.repeat(40),
      frozenBaseOid: 'a'.repeat(40), reviewedSubjectDigest: 'reviewed', reviewExecutionId: 'review-1',
      reviewReceiptDigest: 'receipt', requirementDigest: 'requirement', createdAt: '2026-08-19T00:00:00.000Z',
    }));
    expect(result).toBeUndefined();
    expect(provider.getReference).not.toHaveBeenCalled();
  });
});

describe('Integration v3 ready work subject convergence', () => {
  const oldHead = '1'.repeat(40);
  const newHead = '2'.repeat(40);
  const oldBase = '3'.repeat(40);
  const newBase = '4'.repeat(40);
  const oldTree = '5'.repeat(40);
  const newTree = '6'.repeat(40);

  function fixture(input: { remoteHead?: string; remoteBase?: string; remoteTree?: string; receipt?: Record<string, unknown> | null } = {}) {
    const value = candidate(oldBase);
    value.state = 'working';
    value.providerPullRequestId = '77';
    const source = {
      candidateId: value.id, revision: 1, order: 0, integrationSourceId: 'source-1',
      deliveryTaskId: 'delivery-1', deliveryTaskVersion: 1, repositoryId: value.repositoryId,
      providerPullRequestId: '11', frozenHeadOid: oldHead, frozenBaseOid: oldBase,
      reviewedSubjectDigest: 'reviewed', reviewExecutionId: 'review-1', reviewReceiptDigest: 'receipt',
      requirementDigest: 'requirement', createdAt: value.createdAt,
    };
    const loaded = current(value, oldBase, source);
    loaded.revision.treeOid = oldTree;
    loaded.revision.compositionComplete = true;
    const workPushReceipt = input.receipt === null ? undefined : {
      executionId: 'work-1', candidateId: value.id, candidateRevision: 1,
      workflowEpoch: '4', laneEpoch: '3', ref: `refs/heads/${value.branch}`,
      oldOid: oldHead, newOid: input.remoteHead ?? oldHead,
      ...input.receipt,
    };
    const provider = {
      getReference: vi.fn(async (_repository: unknown, ref: string) => ref === value.branch
        ? { oid: input.remoteHead ?? oldHead, treeOid: input.remoteTree ?? (input.remoteHead === newHead ? newTree : oldTree) }
        : { oid: input.remoteBase ?? oldBase, treeOid: 'base-tree' }),
    } as unknown as RepositoryProvider;
    const composer = new DefaultIntegrationV3ComposeExecutor({
      resolveContext: async () => ({
        repository: { provider: 'github', repositoryId: value.repositoryId, owner: 'org', name: 'repo', baseBranch: 'main', allowForkPullRequest: false },
        credentialOwnerId: 'owner-1', tenantId: 'tenant-1', repositoryPath: '/repo', worktreePath: '/worktree',
        sources: [source], workExecutionId: 'work-1', ...(workPushReceipt ? { workPushReceipt } : {}),
      }),
      withRepositoryBranchLock: async <T>(_lock: unknown, action: () => Promise<T>) => action(),
      validateServerOwnedRepository: async () => undefined,
      runGit: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      bindPullRequest: async () => undefined,
    }, provider);
    return { composer, loaded };
  }

  it('refreshes the revision when ready work keeps the head but the base advances', async () => {
    const { composer, loaded } = fixture({ remoteBase: newBase });
    await expect(composer.refreshAfterWork(loaded)).resolves.toMatchObject({
      baseOid: newBase, headOid: oldHead, treeOid: oldTree, workExecutionId: 'work-1',
    });
  });

  it('rejects an incomplete composition even when only the base advances', async () => {
    const { composer, loaded } = fixture({ remoteBase: newBase });
    loaded.revision.compositionComplete = false;
    await expect(composer.refreshAfterWork(loaded)).rejects.toThrow('requires an exact succeeded work push');
  });

  it('rejects an empty-commit push that leaves an incomplete composition tree unchanged', async () => {
    const { composer, loaded } = fixture({ remoteHead: newHead, remoteTree: oldTree });
    loaded.revision.compositionComplete = false;
    await expect(composer.refreshAfterWork(loaded)).rejects.toThrow('did not change the candidate tree');
  });

  it('rejects a ready work result that changes neither head nor base', async () => {
    const { composer, loaded } = fixture();
    await expect(composer.refreshAfterWork(loaded)).rejects.toMatchObject({ name: 'IntegrationV3InvalidWorkResultError' });
  });

  it('refreshes a changed head only with the exact succeeded work push receipt', async () => {
    const { composer, loaded } = fixture({ remoteHead: newHead, remoteBase: newBase });
    await expect(composer.refreshAfterWork(loaded)).resolves.toMatchObject({
      baseOid: newBase, headOid: newHead, treeOid: newTree, workExecutionId: 'work-1',
    });
  });

  it.each([
    ['missing', null],
    ['wrong execution', { executionId: 'work-other' }],
    ['wrong candidate', { candidateId: 'candidate-other' }],
    ['wrong revision', { candidateRevision: 2 }],
    ['wrong ref', { ref: 'refs/heads/integration/other' }],
    ['wrong old OID', { oldOid: '7'.repeat(40) }],
    ['wrong new OID', { newOid: '8'.repeat(40) }],
    ['wrong workflow epoch', { workflowEpoch: '5' }],
    ['wrong lane epoch', { laneEpoch: '5' }],
  ])('rejects a changed head with %s push receipt', async (_name, receipt) => {
    const { composer, loaded } = fixture({ remoteHead: newHead, receipt });
    await expect(composer.refreshAfterWork(loaded)).rejects.toMatchObject({ name: 'IntegrationV3InvalidWorkResultError' });
  });
});
