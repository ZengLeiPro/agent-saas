import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IntegrationPushCapabilityService, type IntegrationPushCapabilityBinding } from './integrationPushCapability.js';
import { InMemoryIntegrationPushCapabilityHost } from './integrationPushCapabilityMemoryHost.js';
import { IntegrationPushGateway, type IntegrationPushGitRunner } from './integrationPushGateway.js';
import {
  IntegrationProviderOperationService,
  type IntegrationProviderOperationRecord,
  type IntegrationProviderOperationState,
  type IntegrationProviderOperationStorageHost,
} from './integrationProviderOperations.js';

const execFileAsync = promisify(execFile);
const TOKEN = 'provider-token-never-visible';
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class Operations implements IntegrationProviderOperationStorageHost {
  records = new Map<string, IntegrationProviderOperationRecord>();
  async getByOperationKey(key: string) { return this.records.get(key); }
  async insertPrepared(record: IntegrationProviderOperationRecord) {
    const current = this.records.get(record.operationKey);
    if (current) return current;
    this.records.set(record.operationKey, record);
    return record;
  }
  async compareAndSet(input: {
    id: string; expectedState: IntegrationProviderOperationState;
    nextState: IntegrationProviderOperationState; patch: Partial<IntegrationProviderOperationRecord>;
  }) {
    const current = [...this.records.values()].find((record) => record.id === input.id);
    if (!current || current.state !== input.expectedState) return undefined;
    const next = { ...current, ...input.patch, state: input.nextState };
    this.records.set(next.operationKey, next);
    return next;
  }
}

class RealObjectFakeRemoteRunner implements IntegrationPushGitRunner {
  calls: Array<{ cwd: string; args: string[]; env?: Record<string, string> }> = [];
  pushCwd?: string;
  constructor(private readonly oldOid: string, private readonly ref: string) {}
  async run(input: { cwd: string; args: string[]; env?: Record<string, string> }): Promise<{ stdout: string }> {
    this.calls.push(input);
    if (input.args[0] === '--version') return { stdout: 'git version 2.45.0\n' };
    if (input.args[0] === 'ls-remote') return { stdout: `${this.oldOid}\t${this.ref}\n` };
    if (input.args[0] === 'push') { this.pushCwd = input.cwd; return { stdout: '' }; }
    const result = await execFileAsync('git', input.args, {
      cwd: input.cwd,
      env: {
        PATH: process.env.PATH, HOME: input.cwd,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      },
    });
    return { stdout: result.stdout };
  }
}

async function sourceRepository() {
  const root = await mkdtemp(join(tmpdir(), 'work-push-source-'));
  roots.push(root);
  const git = async (args: string[]) => (await execFileAsync('git', args, {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: root,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Work Agent', GIT_AUTHOR_EMAIL: 'agent@example.invalid',
      GIT_COMMITTER_NAME: 'Work Agent', GIT_COMMITTER_EMAIL: 'agent@example.invalid',
    },
  })).stdout.trim();
  await git(['init']);
  await writeFile(join(root, 'work.txt'), 'base\n');
  await git(['add', 'work.txt']);
  await git(['commit', '-m', 'base']);
  const oldOid = await git(['rev-parse', 'HEAD']);
  await writeFile(join(root, 'work.txt'), 'candidate\n');
  await git(['commit', '-am', 'candidate']);
  return { root, oldOid, newOid: await git(['rev-parse', 'HEAD']) };
}

async function fixture(resolveCredential = true) {
  const source = await sourceRepository();
  const ref = 'refs/heads/integration/task-1';
  const binding: IntegrationPushCapabilityBinding = {
    tenantId: 'tenant-1', repositoryId: 'github-id:123', integrationTaskId: 'task-1',
    candidateId: 'candidate-1', revision: 2, executionId: 'execution-1', exactRef: ref,
    expectedOldOid: source.oldOid, laneEpoch: 3, workflowEpoch: 4,
  };
  const capabilityService = new IntegrationPushCapabilityService(new InMemoryIntegrationPushCapabilityHost());
  const operations = new Operations();
  const runner = new RealObjectFakeRemoteRunner(source.oldOid, ref);
  const target = { binding, ownerUserId: 'owner-1' };
  const gateway = new IntegrationPushGateway({
    enabled: true, allowedWorktreeRoots: [source.root], capabilityService,
    resolveTarget: async (input) => input.executionId === binding.executionId
      && input.candidateId === binding.candidateId ? target : undefined,
    resolveExecutionTarget: async (input) => input.executionId === binding.executionId ? target : undefined,
    resolveRepository: async () => ({
      worktreePath: source.root, remoteUrl: 'https://github.com/org/repo.git',
      repositoryOwner: 'org', repositoryName: 'repo',
    }),
    resolveGithubToken: async () => resolveCredential ? {
      token: TOKEN, mode: 'github_app', repositoryId: 123,
      configuredRepositoryId: binding.repositoryId,
      configuredRepositoryOwner: 'org', configuredRepositoryName: 'repo', installationId: 456,
    } : undefined,
    githubAppInstallationId: 456,
    operationService: new IntegrationProviderOperationService(operations, { assertCurrent: async () => undefined }),
    runner,
  });
  return { source, binding, capabilityService, operations, runner, gateway };
}

describe('IntegrationPushGateway.pushWorkspaceCommit', () => {
  it('pushes a real direct-parent commit from a self-contained temporary bare repository', async () => {
    const f = await fixture();
    const result = await f.gateway.pushWorkspaceCommit({
      tenantId: f.binding.tenantId, requesterUserId: 'owner-1', executionId: f.binding.executionId,
      workspaceRoot: f.source.root, commitOid: f.source.newOid,
    });
    expect(result).toEqual({ pushed: true, candidateId: f.binding.candidateId, commitOid: f.source.newOid });
    expect(f.runner.calls.find((call) => call.args[0] === 'push')?.args).toEqual([
      'push', `--force-with-lease=${f.binding.exactRef}:${f.source.oldOid}`, '--',
      'https://github.com/org/repo.git', `${f.source.newOid}:${f.binding.exactRef}`,
    ]);
    expect(JSON.stringify(f.runner.calls.map((call) => call.args))).not.toContain(TOKEN);
    expect([...f.operations.records.values()][0]).toMatchObject({
      state: 'succeeded', kind: 'push_ref', expected: { oldOid: f.source.oldOid, newOid: f.source.newOid },
    });
    await expect(access(f.runner.pushCwd!)).rejects.toThrow();
  });

  it('revokes the server-only capability on deterministic failure', async () => {
    const f = await fixture(false);
    const issue = f.capabilityService.issue.bind(f.capabilityService);
    let bearer = '';
    vi.spyOn(f.capabilityService, 'issue').mockImplementation(async (input) => {
      const issued = await issue(input); bearer = issued.token; return issued;
    });
    await expect(f.gateway.pushWorkspaceCommit({
      tenantId: f.binding.tenantId, requesterUserId: 'owner-1', executionId: f.binding.executionId,
      workspaceRoot: f.source.root, commitOid: f.source.newOid,
    })).rejects.toMatchObject({ code: 'credential_unavailable' });
    expect(bearer).not.toBe('');
    await expect(f.capabilityService.verify(bearer)).rejects.toMatchObject({ code: 'revoked' });
  });
});
