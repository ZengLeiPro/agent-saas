import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import type { GithubAppInstallationTokenProvider, RuntimeIsolationAttestationProvider } from './runtimeContracts.js';
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
import { IntegrationPushCapabilityService } from '../taskboard/integrationPushCapability.js';
import { PostgresIntegrationPushCapabilityHost } from '../taskboard/integrationPushCapabilityPostgres.js';
import { IntegrationPushGateway, type IntegrationPushCredential } from '../taskboard/integrationPushGateway.js';
import { createGithubAppIntegrationPushTokenResolver } from '../taskboard/integrationPushService.js';
import { DefaultIntegrationV3ComposeExecutor } from '../taskboard/integrationV3ComposeExecutor.js';
import { IntegrationV3Worker } from '../taskboard/integrationV3Worker.js';
import { PostgresIntegrationV3ComposeHost, PostgresIntegrationV3WorkerHost } from '../taskboard/integrationV3WorkerPostgres.js';
import { canonicalGithubRepositoryUrl, isCanonicalGithubRepositoryRemote, type RepositoryProvider } from '../taskboard/repositoryProvider.js';
import { runSafeServerGit, runSafeServerGitOrThrow } from '../taskboard/safeServerGitRunner.js';
import { RepositoryProviderIntegrationEngineV3Adapter } from '../taskboard/repositoryRuntime.js';
import type {
  RepositoryWorkspaceGitCommand,
  RepositoryWorkspaceGitResult,
} from '../taskboard/repositoryWorkspaceSync.js';
import type { PgTaskboardStore } from '../taskboard/store.js';
import { serverLogger } from '../utils/logger.js';

export interface RuntimeTaskboardIntegrationV3 {
  stop(): Promise<void>;
  health(): Promise<{ enabled: true; healthy: boolean; workerActive: boolean; reason?: string }>;
}

interface StartRuntimeTaskboardIntegrationV3Options {
  store: PgTaskboardStore;
  executionCoordinator: TaskboardExecutionCoordinator;
  repositoryProvider: RepositoryProvider;
  processCwd: string;
  agentCwd: string;
  controlledMirrorRoot?: string;
  enabled: boolean;
  githubAppInstallationId?: number;
  runtimeIsolationAttestationProvider?: RuntimeIsolationAttestationProvider;
  resolveGithubToken?: (input: { tenantId: string; ownerUserId: string; repositoryId: string }) => Promise<IntegrationPushCredential | undefined>;
}

export function buildRuntimeTaskboardIntegrationV3Options(input: Omit<StartRuntimeTaskboardIntegrationV3Options,
  'controlledMirrorRoot'|'enabled'|'githubAppInstallationId'|'resolveGithubToken'> & {
  control?: { enabled: boolean; controlledMirrorRoot: string; githubAppInstallationId: number; githubTokenMode: 'github_app' };
  githubAppInstallationTokenProvider?: GithubAppInstallationTokenProvider;
}): StartRuntimeTaskboardIntegrationV3Options {
  const resolver = input.control && input.githubAppInstallationTokenProvider
    ? createGithubAppIntegrationPushTokenResolver({
      provider: input.githubAppInstallationTokenProvider,
      installationId: input.control.githubAppInstallationId,
      onError: (error) => serverLogger.warn(`Integration App credential resolve failed: ${error.message}`),
    })
    : undefined;
  return {
    ...input,
    enabled: input.control?.enabled === true,
    ...(input.control ? {
      controlledMirrorRoot: input.control.controlledMirrorRoot,
      githubAppInstallationId: input.control.githubAppInstallationId,
    } : {}),
    ...(resolver ? { resolveGithubToken: resolver } : {}),
  };
}

export function startRuntimeTaskboardIntegrationV3(
  options: StartRuntimeTaskboardIntegrationV3Options,
): RuntimeTaskboardIntegrationV3 {
  const { store, executionCoordinator, repositoryProvider, processCwd, agentCwd } = options;
  const tables = integrationCandidateTableNames(store.integrationSourcesTable);
  const pgOptions = {
    pool: store.pool,
    tasksTable: store.tasksTable,
    executionsTable: store.executionsTable,
    integrationSourcesTable: store.integrationSourcesTable,
    integrationLanesTable: store.integrationLanesTable,
    candidatesTable: tables.candidatesTable,
    revisionsTable: tables.revisionsTable,
    providerOperationsTable: tables.providerOperationsTable,
    requestsOutboxTable: tables.requestsOutboxTable,
  };

  const candidateHost = new PostgresIntegrationEngineV3CandidateHost(pgOptions);
  const operationStorage = new PostgresIntegrationProviderOperationStorage({
    pool: store.pool, providerOperationsTable: tables.providerOperationsTable,
  });
  const operationService = new IntegrationProviderOperationService(
    operationStorage, new PostgresIntegrationProviderFenceHost(pgOptions),
  );
  const capabilityHost = new PostgresIntegrationPushCapabilityHost({
    pool: store.pool,
    capabilitiesTable: `${store.executionsTable}_integration_push_capabilities`,
    fencesTable: `${store.executionsTable}_integration_push_fences`,
    boardsTable: store.boardsTable, tasksTable: store.tasksTable, executionsTable: store.executionsTable,
    candidatesTable: tables.candidatesTable, revisionsTable: tables.revisionsTable,
  });
  const capabilityService = new IntegrationPushCapabilityService(capabilityHost);
  const pushGateway = new IntegrationPushGateway({
    enabled: options.enabled === true
      && !!options.runtimeIsolationAttestationProvider
      && !!options.resolveGithubToken
      && Number.isSafeInteger(options.githubAppInstallationId),
    allowedWorktreeRoots: options.controlledMirrorRoot ? [options.controlledMirrorRoot] : [],
    githubAppInstallationId: options.githubAppInstallationId,
    capabilityService,
    resolveTarget: (input) => capabilityHost.resolveTarget(input),
    resolveRepository: async (input) => {
      if (!options.controlledMirrorRoot) return undefined;
      const result = await store.pool.query(
        `SELECT repository FROM ${store.boardsTable} WHERE tenant_id=$1 AND owner_user_id=$2 AND repository->>'repositoryId'=$3 LIMIT 1`,
        [input.tenantId, input.ownerUserId, input.repositoryId],
      );
      const repository = result.rows[0]?.repository as TaskBoardRepositoryConfig | string | undefined;
      const parsed = typeof repository === 'string' ? JSON.parse(repository) as TaskBoardRepositoryConfig : repository;
      if (!parsed) return undefined;
      const paths = await resolveIntegrationV3RepositoryPaths(parsed, input.candidateId, {
        processCwd, agentCwd, controlledMirrorRoot: options.controlledMirrorRoot,
      });
      return paths ? { worktreePath: paths.worktreePath, remoteUrl: canonicalGithubRepositoryUrl(parsed) } : undefined;
    },
    resolveGithubToken: options.resolveGithubToken ?? (async () => undefined),
    operationService,
  });
  let composeHost: PostgresIntegrationV3ComposeHost;
  const workerHost = new PostgresIntegrationV3WorkerHost({
    ...pgOptions,
    sourceSnapshotsTable: tables.sourceSnapshotsTable,
    boardsTable: store.boardsTable,
    executionsTable: store.executionsTable,
    dispatchAgent: async ({ identity, taskId, expectedVersion, purpose }) => {
      const attestation = await options.runtimeIsolationAttestationProvider?.attest({
        admission: 'integration_v3_work', tenantId: identity.tenantId, taskId,
      });
      if (!validAttestation(attestation)) throw new Error('Integration v3 work admission requires runtime isolation attestation');
      await executionCoordinator.startExecution(identity, taskId, { expectedVersion, purpose });
    },
    syncWorkspace: async (request) => {
      const current = await workerHost.loadCurrent(request.candidateId);
      if (!current.revision) throw new Error('Workspace sync requires a current candidate revision');
      const context = await composeHost.resolveContext({ candidate: current.candidate, revision: current.revision });
      await (await import('../taskboard/repositoryWorkspaceSync.js')).syncRepositoryWorkspace(composeHost, {
        repositoryPath: context.repositoryPath,
        worktreePath: context.worktreePath,
        baseBranch: current.candidate.baseBranch,
        integrationBranch: current.candidate.branch,
        controlledRemoteUrl: canonicalGithubRepositoryUrl(context.repository),
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
      { processCwd, agentCwd, ...(options.controlledMirrorRoot ? { controlledMirrorRoot: options.controlledMirrorRoot } : {}) },
    ),
    runGit,
    validateServerOwnedRepository: createServerOwnedRepositoryValidator(options.controlledMirrorRoot),
    pushIntegrationHead: async (input) => pushGateway.pushExact({
      tenantId: input.context.tenantId, ownerUserId: input.context.credentialOwnerId,
      repositoryId: input.context.repository.repositoryId, integrationTaskId: input.integrationTaskId,
      candidateId: input.candidateId, revision: input.revision,
      exactRef: `refs/heads/${input.branch}`, expectedOldOid: input.expectedOldOid, newOid: input.headOid,
      fence: {
        workflowEpoch: input.workflowEpoch, laneEpoch: input.laneEpoch,
        candidateId: input.candidateId, candidateRevision: input.revision,
        executionId: input.context.workExecutionId ?? `compose:${input.candidateId}:r${input.revision}`,
      },
    }),
  });
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
  let stopped = false;
  let workerActive = false;
  let activationReason: string | undefined;
  const activation = Promise.all([
    pushGateway.health(),
    options.runtimeIsolationAttestationProvider?.attest({ admission: 'integration_v3_worker' }),
  ]).then(([health, attestation]) => {
    if (stopped) activationReason = 'stopped';
    else if (!health.healthy) activationReason = health.reason ?? 'gateway_unhealthy';
    else if (!validAttestation(attestation)) activationReason = 'runtime_isolation_attestation_unavailable';
    else { worker.start(); workerActive = true; }
    if (activationReason) serverLogger.warn(`Integration v3 worker disabled: ${activationReason}`);
  }).catch((error) => {
    activationReason = 'worker_activation_failed';
    serverLogger.warn(`Integration v3 worker disabled: ${error instanceof Error ? error.message : String(error)}`);
  });
  return {
    async health() {
      await activation;
      const gateway = await pushGateway.health();
      const healthy = gateway.healthy && workerActive && !stopped;
      return {
        enabled: true as const,
        healthy,
        workerActive,
        ...(!healthy ? { reason: activationReason ?? gateway.reason ?? 'worker_inactive' } : {}),
      };
    },
    async stop() {
      stopped = true;
      await activation;
      await worker.stop();
      workerActive = false;
    },
  };
}

function createServerOwnedRepositoryValidator(controlledMirrorRoot: string | undefined) {
  return async (repositoryPath: string): Promise<void> => {
    if (!controlledMirrorRoot) throw new Error('controlled mirror root is unavailable');
    const root = realpathSync(controlledMirrorRoot);
    const repository = realpathSync(repositoryPath);
    if (repository !== root && !repository.startsWith(`${root}/`)) throw new Error('repository escapes controlled mirror root');
    const commonDirOutput = await runSafeServerGitOrThrow(repository, ['rev-parse', '--git-common-dir']);
    const commonDir = realpathSync(resolve(repository, commonDirOutput));
    if (commonDir !== repository && !commonDir.startsWith(`${repository}/`)) throw new Error('Git common-dir escapes server mirror');
    for (const path of [repository, commonDir]) {
      const info = statSync(path);
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('mirror owner mismatch');
      if ((info.mode & 0o022) !== 0) throw new Error('mirror is group/world writable');
    }
  };
}

interface RepositoryPathRoots {
  processCwd: string;
  agentCwd: string;
  /** Server-owned mirror root. Production v3 must set this; Agent project roots are never trusted. */
  controlledMirrorRoot?: string;
}

export async function resolveIntegrationV3RepositoryPaths(
  repository: TaskBoardRepositoryConfig,
  candidateId: string,
  roots: RepositoryPathRoots,
): Promise<{ repositoryPath: string; worktreePath: string } | undefined> {
  // Never consume an Agent checkout/common-dir. A deployment must provision a
  // server-owned mirror root that is not mounted writable into Agent runtimes.
  if (!roots.controlledMirrorRoot) return undefined;
  const repositoryPath = resolve(roots.controlledMirrorRoot, repository.repositoryId.replace(/[^A-Za-z0-9._-]/g, '_'));
  if (!existsSync(join(repositoryPath, '.git'))) return undefined;
  try {
    const repositoryStat = statSync(repositoryPath);
    if (typeof process.getuid === 'function' && repositoryStat.uid !== process.getuid()) return undefined;
    if ((repositoryStat.mode & 0o022) !== 0) return undefined;
    await createServerOwnedRepositoryValidator(roots.controlledMirrorRoot)(repositoryPath);
    const remoteUrl = await execGit(repositoryPath, ['remote', 'get-url', 'origin']);
    if (!isCanonicalGithubRepositoryRemote(remoteUrl, repository)) return undefined;
    return {
      repositoryPath,
      worktreePath: resolve(roots.controlledMirrorRoot, '.worktrees', candidateId),
    };
  } catch { return undefined; }
}

function execGit(cwd: string, args: string[]): Promise<string> {
  return runSafeServerGitOrThrow(cwd, args);
}

function runGit(command: RepositoryWorkspaceGitCommand): Promise<RepositoryWorkspaceGitResult> {
  return runSafeServerGit(command);
}

function validAttestation(value: unknown): value is {
  runtimeAdapterId: string; isolationBoundaryId: string; issuedAt: string;
} {
  if (!value || typeof value !== 'object') return false;
  const evidence = value as Record<string, unknown>;
  return typeof evidence.runtimeAdapterId === 'string' && evidence.runtimeAdapterId.length > 0
    && typeof evidence.isolationBoundaryId === 'string' && evidence.isolationBoundaryId.length > 0
    && typeof evidence.issuedAt === 'string' && Number.isFinite(Date.parse(evidence.issuedAt));
}
