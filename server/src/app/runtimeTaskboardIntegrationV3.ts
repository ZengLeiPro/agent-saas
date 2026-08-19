import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import type { TaskboardExecutionCoordinator } from '../taskboard/executionService.js';
import { integrationCandidateTableNames } from '../taskboard/integrationCandidateSchema.js';
import { IntegrationEngineV3 } from '../taskboard/integrationEngineV3.js';
import {
  PostgresIntegrationEngineV3CandidateHost,
  PostgresIntegrationEngineV3FeatureHost,
  PostgresIntegrationEngineV3RequestHost,
  PostgresIntegrationProviderFenceHost,
  PostgresIntegrationProviderOperationStorage,
} from '../taskboard/integrationEngineV3Postgres.js';
import { IntegrationProviderOperationService } from '../taskboard/integrationProviderOperations.js';
import { DefaultIntegrationV3ComposeExecutor } from '../taskboard/integrationV3ComposeExecutor.js';
import { IntegrationV3Worker } from '../taskboard/integrationV3Worker.js';
import { PostgresIntegrationV3ComposeHost, PostgresIntegrationV3WorkerHost } from '../taskboard/integrationV3WorkerPostgres.js';
import type { RepositoryProvider } from '../taskboard/repositoryProvider.js';
import { RepositoryProviderIntegrationEngineV3Adapter } from '../taskboard/repositoryRuntime.js';
import type {
  RepositoryWorkspaceGitCommand,
  RepositoryWorkspaceGitResult,
} from '../taskboard/repositoryWorkspaceSync.js';
import type { PgTaskboardStore } from '../taskboard/store.js';
import { serverLogger } from '../utils/logger.js';

export interface RuntimeTaskboardIntegrationV3 {
  stop(): Promise<void>;
}

interface StartRuntimeTaskboardIntegrationV3Options {
  store: PgTaskboardStore;
  executionCoordinator: TaskboardExecutionCoordinator;
  repositoryProvider: RepositoryProvider;
  processCwd: string;
  agentCwd: string;
}

export function startRuntimeTaskboardIntegrationV3(
  options: StartRuntimeTaskboardIntegrationV3Options,
): RuntimeTaskboardIntegrationV3 {
  const { store, executionCoordinator, repositoryProvider, processCwd, agentCwd } = options;
  const tables = integrationCandidateTableNames(store.integrationSourcesTable);
  const pgOptions = {
    pool: store.pool,
    tasksTable: store.tasksTable,
    integrationSourcesTable: store.integrationSourcesTable,
    integrationLanesTable: store.integrationLanesTable,
    candidatesTable: tables.candidatesTable,
    revisionsTable: tables.revisionsTable,
    providerOperationsTable: tables.providerOperationsTable,
    requestsOutboxTable: tables.requestsOutboxTable,
  };

  let composeHost: PostgresIntegrationV3ComposeHost;
  const workerHost = new PostgresIntegrationV3WorkerHost({
    ...pgOptions,
    sourceSnapshotsTable: tables.sourceSnapshotsTable,
    boardsTable: store.boardsTable,
    executionsTable: store.executionsTable,
    dispatchAgent: ({ identity, taskId, expectedVersion, purpose }) => executionCoordinator
      .startExecution(identity, taskId, { expectedVersion, purpose })
      .then(() => undefined),
    syncWorkspace: async (request) => {
      const current = await workerHost.loadCurrent(request.candidateId);
      if (!current.revision) throw new Error('Workspace sync requires a current candidate revision');
      const context = await composeHost.resolveContext({ candidate: current.candidate, revision: current.revision });
      await (await import('../taskboard/repositoryWorkspaceSync.js')).syncRepositoryWorkspace(composeHost, {
        repositoryPath: context.repositoryPath,
        worktreePath: context.worktreePath,
        baseBranch: current.candidate.baseBranch,
        integrationBranch: current.candidate.branch,
      });
    },
    // Branch deletion and source PR closure remain fail-closed/no-op because policy currently freezes deleteRemoteBranch=false.
    cleanup: async () => undefined,
    logger: serverLogger.child('IntegrationV3Worker'),
  });

  composeHost = new PostgresIntegrationV3ComposeHost({
    pool: store.pool,
    candidatesTable: tables.candidatesTable,
    sourceSnapshotsTable: tables.sourceSnapshotsTable,
    tasksTable: store.tasksTable,
    boardsTable: store.boardsTable,
    executionsTable: store.executionsTable,
    resolvePaths: (repository, candidateId) => resolveIntegrationV3RepositoryPaths(
      repository,
      candidateId,
      { processCwd, agentCwd },
    ),
    runGit,
    // Exact push gateway is intentionally not guessed here. Without registration compose fails closed before a write.
  });

  const candidateHost = new PostgresIntegrationEngineV3CandidateHost(pgOptions);
  const operationStorage = new PostgresIntegrationProviderOperationStorage({
    pool: store.pool,
    providerOperationsTable: tables.providerOperationsTable,
  });
  const operationService = new IntegrationProviderOperationService(
    operationStorage,
    new PostgresIntegrationProviderFenceHost(pgOptions),
  );
  const requestHost = new PostgresIntegrationEngineV3RequestHost(pgOptions);
  const featureHost = new PostgresIntegrationEngineV3FeatureHost(pgOptions);
  const providerAdapter = new RepositoryProviderIntegrationEngineV3Adapter(repositoryProvider);
  const worker = new IntegrationV3Worker({
    host: workerHost,
    composer: new DefaultIntegrationV3ComposeExecutor(composeHost, repositoryProvider),
    engineFor: async (current) => {
      const context = await workerHost.resolveEngineContext(current.candidate.id);
      return new IntegrationEngineV3({
        candidates: candidateHost,
        providerOperations: operationService,
        provider: providerAdapter,
        features: featureHost,
        requests: requestHost,
        credentialOwnerId: context.credentialOwnerId,
        resolveRepository: async (repositoryId) => context.repository.repositoryId === repositoryId
          ? context.repository
          : undefined,
      });
    },
  });
  worker.start();
  return worker;
}

interface RepositoryPathRoots {
  processCwd: string;
  agentCwd: string;
}

export async function resolveIntegrationV3RepositoryPaths(
  repository: TaskBoardRepositoryConfig,
  candidateId: string,
  roots: RepositoryPathRoots,
): Promise<{ repositoryPath: string; worktreePath: string } | undefined> {
  const candidates = [
    roots.processCwd,
    resolve(roots.agentCwd, 'projects', repository.name),
    resolve(roots.agentCwd, repository.name),
  ];
  for (const repositoryPath of candidates) {
    if (!existsSync(join(repositoryPath, '.git'))) continue;
    try {
      const remoteUrl = await execGit(repositoryPath, ['remote', 'get-url', 'origin']);
      const normalized = remoteUrl.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
      if (!normalized.endsWith(`github.com/${repository.owner}/${repository.name}`)) continue;
      return {
        repositoryPath,
        worktreePath: resolve(dirname(repositoryPath), '.integration-v3-worktrees', candidateId),
      };
    } catch {
      // Try the next trusted root.
    }
  }
  return undefined;
}

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveResult, reject) => execFile(
    'git',
    args,
    { cwd },
    (error, stdout) => error ? reject(error) : resolveResult(stdout.trim()),
  ));
}

function runGit(command: RepositoryWorkspaceGitCommand): Promise<RepositoryWorkspaceGitResult> {
  return new Promise((resolveResult) => execFile(
    'git',
    [...command.args],
    { cwd: command.cwd, env: { ...process.env, ...command.env }, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout, stderr) => resolveResult({
      exitCode: error && typeof error === 'object' && 'code' in error && typeof error.code === 'number'
        ? error.code
        : error ? 1 : 0,
      stdout,
      stderr,
    }),
  ));
}
