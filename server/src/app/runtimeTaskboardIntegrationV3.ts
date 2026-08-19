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
import {
  IntegrationV3Worker,
  type IntegrationV3CleanupReceipt,
  type IntegrationV3RequestLease,
  type IntegrationV3WorkerCurrent,
} from '../taskboard/integrationV3Worker.js';
import {
  executeIntegrationV3Cleanup,
  PostgresIntegrationV3ComposeHost,
  PostgresIntegrationV3WorkerHost,
} from '../taskboard/integrationV3WorkerPostgres.js';
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

export interface RuntimeIntegrationV3CleanupHostOptions {
  controlledMirrorRoot?: string;
  loadCurrent(candidateId: string): Promise<IntegrationV3WorkerCurrent>;
  resolveContext(current: Required<IntegrationV3WorkerCurrent>): Promise<{
    repositoryPath: string;
    worktreePath: string;
    tenantId: string;
    credentialOwnerId: string;
    sources: Array<{ providerPullRequestId: string }>;
  }>;
  findActiveCapabilityIds(candidateId: string): Promise<string[]>;
  revokeCapability(capabilityId: string, reason: string): Promise<void>;
  fenceCapabilities(input: {
    tenantId: string;
    repositoryId: string;
    integrationTaskId: string;
    candidateId: string;
    revision: number;
    laneEpoch: number;
    workflowEpoch: number;
    enabled: false;
  }, reason: string): Promise<number>;
  withRepositoryBranchLock<T>(
    lock: { repositoryPath: string; branch: string }, operation: () => Promise<T>,
  ): Promise<T>;
  runGit(command: RepositoryWorkspaceGitCommand): Promise<RepositoryWorkspaceGitResult>;
}

/** Production cleanup host wiring. Frozen v3 policy has no source-PR mutation switch, so every source is explicitly receipted as skipped. */
export function createRuntimeIntegrationV3CleanupHost(
  options: RuntimeIntegrationV3CleanupHostOptions,
): (request: IntegrationV3RequestLease) => Promise<IntegrationV3CleanupReceipt> {
  return async (request) => {
    if (!options.controlledMirrorRoot) throw new Error('Controlled mirror root is unavailable for cleanup');
    const current = await options.loadCurrent(request.candidateId);
    if (!current.revision || current.candidate.currentRevision !== request.candidateRevision) {
      throw new Error('Cleanup candidate revision fence is stale');
    }
    const laneEpoch = strictEpoch(current.candidate.laneEpoch, 'lane');
    const workflowEpoch = strictEpoch(current.candidate.workflowEpoch, 'workflow');
    const context = await options.resolveContext({ candidate: current.candidate, revision: current.revision });
    const reason = typeof request.payload.reason === 'string' && request.payload.reason
      ? request.payload.reason
      : `candidate_${current.candidate.state}`;
    return executeIntegrationV3Cleanup({
      candidateId: current.candidate.id,
      repositoryPath: context.repositoryPath,
      worktreePath: context.worktreePath,
      controlledWorktreeRoot: resolve(options.controlledMirrorRoot, '.worktrees'),
      branch: current.candidate.branch,
      sourcePullRequests: context.sources.map((source) => ({
        id: source.providerPullRequestId,
        action: 'skip' as const,
        policyReason: 'frozen integration policy does not authorize source pull request mutation',
      })),
      withRepositoryBranchLock: options.withRepositoryBranchLock,
      runGit: options.runGit,
      revokeCapabilities: async () => {
        const ids = await options.findActiveCapabilityIds(current.candidate.id);
        const results = await Promise.allSettled(ids.map((id) => options.revokeCapability(id, reason)));
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) throw new Error(`Failed to revoke ${failures.length} integration push capability(s)`);
      },
      fenceCapabilities: async () => {
        await options.fenceCapabilities({
          tenantId: context.tenantId,
          repositoryId: current.candidate.repositoryId,
          integrationTaskId: current.candidate.integrationTaskId,
          candidateId: current.candidate.id,
          revision: current.candidate.currentRevision,
          laneEpoch,
          workflowEpoch,
          enabled: false,
        }, reason);
      },
      applySourcePullRequest: async () => {
        throw new Error('Frozen integration policy does not authorize source pull request mutation');
      },
    });
  };
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
  const capabilityHostOptions = {
    pool: store.pool,
    capabilitiesTable: `${store.executionsTable}_integration_push_capabilities`,
    fencesTable: `${store.executionsTable}_integration_push_fences`,
    boardsTable: store.boardsTable, tasksTable: store.tasksTable, executionsTable: store.executionsTable,
    candidatesTable: tables.candidatesTable, revisionsTable: tables.revisionsTable,
  };
  const capabilityHost = new PostgresIntegrationPushCapabilityHost(capabilityHostOptions);
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
  const workerHost: PostgresIntegrationV3WorkerHost = new PostgresIntegrationV3WorkerHost({
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
    cleanup: createRuntimeIntegrationV3CleanupHost({
      controlledMirrorRoot: options.controlledMirrorRoot,
      loadCurrent: (candidateId) => workerHost.loadCurrent(candidateId),
      resolveContext: (current) => composeHost.resolveContext(current),
      findActiveCapabilityIds: async (candidateId) => {
        const result = await store.pool.query(
          `SELECT id FROM ${capabilityHostOptions.capabilitiesTable} WHERE candidate_id=$1 AND status='active' ORDER BY id`,
          [candidateId],
        );
        return result.rows.map((row) => String(row.id));
      },
      revokeCapability: (capabilityId, reason) => capabilityService.revoke(capabilityId, reason),
      fenceCapabilities: (fence, reason) => capabilityService.fence(fence, reason),
      withRepositoryBranchLock: (lock, operation) => composeHost.withRepositoryBranchLock(lock, operation),
      runGit,
    }),
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

function strictEpoch(value: string, label: string): number {
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error(`Cleanup ${label} epoch is invalid`);
  return epoch;
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
