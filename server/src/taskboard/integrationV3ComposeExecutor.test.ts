import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import type { TaskBoardIntegrationCandidate } from '../../../shared/src/types/taskboard.js';
import { IntegrationPushCapabilityService } from './integrationPushCapability.js';
import { InMemoryIntegrationPushCapabilityHost } from './integrationPushCapabilityMemoryHost.js';
import { IntegrationPushGateway, type IntegrationPushGitRunner } from './integrationPushGateway.js';
import {
  IntegrationProviderOperationService,
  type IntegrationProviderOperationRecord,
  type IntegrationProviderOperationState,
  type IntegrationProviderOperationStorageHost,
} from './integrationProviderOperations.js';
import { DefaultIntegrationV3ComposeExecutor, IntegrationV3CandidateReloadRequiredError } from './integrationV3ComposeExecutor.js';
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

function current(value: TaskBoardIntegrationCandidate, baseOid: string, source: any): Required<IntegrationV3WorkerCurrent> {
  return {
    candidate: value,
    revision: {
      candidateId: value.id, revision: 1, digestVersion: 1, baseOid, headOid: source.frozenHeadOid,
      subjectKind: 'source_seed', sourceSetDigest: 'seed', subjectDigest: 'seed-subject',
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
        resolveRepository: async () => ({ worktreePath, remoteUrl: 'https://github.com/org/repo.git' }),
        resolveGithubToken: async () => ({ token: 'secret', mode: 'github_app', repositoryId: 123, installationId: 456 }),
        githubAppInstallationId: 456, operationService, runner,
      });
      let bound: string | undefined;
      const host = {
        resolveContext: async () => ({
          repository: { provider: 'github', repositoryId: 'github-id:123', owner: 'org', name: 'repo', baseBranch: 'main', allowForkPullRequest: false } as const,
          credentialOwnerId: 'owner-1', tenantId: 'tenant-1', repositoryPath, worktreePath, sources: [source],
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
      const provider = {
        ensureIntegrationBranch: async () => ({ oid: runner.current(), treeOid: await treeOf(runner.current()) }),
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
      const remoteAfterFirst = runner.current();
      const secondCandidate = { ...firstCandidate, providerPullRequestId: '77', version: 2 };
      const result = await composer.compose(current(secondCandidate, baseOid, source));
      expect(result.headOid).toBe(remoteAfterFirst);
      expect(runner.pushes).toBe(1);
      expect(storage.records.size).toBe(1);
      expect([...storage.records.values()][0]).toMatchObject({ state: 'succeeded', receipt: { newOid: remoteAfterFirst } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
