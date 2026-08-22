import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import type { GithubAppInstallationTokenProvider, RuntimeIsolationAttestationProvider } from './runtimeContracts.js';
import type { TaskboardExecutionCoordinator } from '../taskboard/executionService.js';
import {
  createIntegrationV3ActivationHeartbeat,
  INTEGRATION_V3_ACTIVATION_HEARTBEAT_MS,
  PostgresIntegrationV3ActivationStore,
} from '../taskboard/integrationV3ActivationStore.js';
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
import { credentialMatchesRepository, IntegrationPushGateway, type IntegrationPushCredential } from '../taskboard/integrationPushGateway.js';
import { withIntegrationGitAskpass } from '../taskboard/integrationGitAskpass.js';
import { ControlledTaskboardIntegrationPushService, createGithubAppIntegrationPushTokenResolver, createPersonalAccessTokenIntegrationPushTokenResolver } from '../taskboard/integrationPushService.js';
import type { TaskboardIntegrationPushService } from '../taskboard/types.js';
import { DefaultIntegrationV3ComposeExecutor, type IntegrationV3ComposeContext } from '../taskboard/integrationV3ComposeExecutor.js';
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
import { provisionIntegrationV3RepositoryMirror } from '../taskboard/integrationV3RepositoryProvisioning.js';
import { runSafeServerGit, runSafeServerGitOrThrow } from '../taskboard/safeServerGitRunner.js';
import { createIntegrationV3GithubAppRepositoryProvider, RepositoryProviderIntegrationEngineV3Adapter } from '../taskboard/repositoryRuntime.js';
import {
  syncCandidateRevisionObjects,
  syncRepositoryWorkspace,
  type RepositoryWorkspaceGitCommand,
  type RepositoryWorkspaceGitResult,
} from '../taskboard/repositoryWorkspaceSync.js';
import type { PgTaskboardStore } from '../taskboard/store.js';
import { materializeCandidateObjects } from '../taskboard/workspaceCommitMaterializer.js';
import { serverLogger } from '../utils/logger.js';
import { resolveUserCwd } from '../workspace/resolver.js';

export interface RuntimeTaskboardIntegrationV3 {
  readonly integrationPush: TaskboardIntegrationPushService;
  stop(): Promise<void>;
  health(): Promise<{ enabled: true; healthy: boolean; workerActive: boolean; reason?: string }>;
}

export function startIntegrationV3ActivationRetry(input: {
  check(): Promise<{ healthy: boolean; reason?: string }>;
  start(): void;
  setReason(reason: string | undefined): void;
  onError?(error: unknown): void;
  retryIntervalMs?: number;
}) {
  let stopped = false;
  let active = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  const run = (): Promise<void> => {
    if (stopped || active) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = input.check().then((health) => {
      if (stopped) input.setReason('stopped');
      else if (!health.healthy) input.setReason(health.reason ?? 'worker_activation_failed');
      else {
        input.start();
        active = true;
        input.setReason(undefined);
      }
    }).catch((error) => {
      if (!stopped) {
        input.setReason('worker_activation_failed');
        input.onError?.(error);
      }
    }).finally(() => {
      inFlight = undefined;
      if (!stopped && !active) {
        timer = setTimeout(() => { void run(); }, input.retryIntervalMs ?? INTEGRATION_V3_ACTIVATION_HEARTBEAT_MS);
        timer.unref();
      }
    });
    return inFlight;
  };
  const initialAttempt = run();
  return {
    initialAttempt,
    isActive: () => active,
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
      input.setReason('stopped');
    },
  };
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
export async function resolveRuntimeIntegrationV3CleanupContext(
  options: {
    pool: { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
    candidatesTable: string;
    tasksTable: string;
    boardsTable: string;
    sourceSnapshotsTable: string;
    controlledMirrorRoot: string;
  },
  current: Required<IntegrationV3WorkerCurrent>,
): Promise<Awaited<ReturnType<RuntimeIntegrationV3CleanupHostOptions['resolveContext']>>> {
  const [owner, snapshots] = await Promise.all([
    options.pool.query(
      `SELECT b.tenant_id,b.owner_user_id FROM ${options.candidatesTable} c
        JOIN ${options.tasksTable} t ON t.id=c.integration_task_id
        JOIN ${options.boardsTable} b ON b.id=t.board_id WHERE c.id=$1`,
      [current.candidate.id],
    ),
    options.pool.query(
      `SELECT provider_pull_request_id FROM ${options.sourceSnapshotsTable}
        WHERE candidate_id=$1 AND revision=$2 ORDER BY source_order`,
      [current.candidate.id, current.candidate.currentRevision],
    ),
  ]);
  const row = owner.rows[0];
  if (!row) throw new Error('Cleanup candidate owner context is unavailable');
  return {
    repositoryPath: resolve(options.controlledMirrorRoot, current.candidate.repositoryId.replace(/[^A-Za-z0-9._-]/g, '_')),
    worktreePath: resolve(options.controlledMirrorRoot, '.worktrees', current.candidate.id),
    tenantId: String(row.tenant_id),
    credentialOwnerId: String(row.owner_user_id),
    sources: snapshots.rows.map((snapshot) => ({ providerPullRequestId: String(snapshot.provider_pull_request_id) })),
  };
}

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
  processRole?: 'all' | 'runtime-worker';
  releaseIdentity?: string;
  githubTokenMode?: 'github_app' | 'personal_access_token';
  githubAppInstallationId?: number;
  runtimeIsolationAttestationProvider?: RuntimeIsolationAttestationProvider;
  resolveGithubToken?: (input: {
    tenantId: string; ownerUserId: string; repositoryId: string; repositoryOwner: string; repositoryName: string;
  }) => Promise<IntegrationPushCredential | undefined>;
}

export function configureRuntimeIntegrationV3RepositoryAccess(input: {
  store?: PgTaskboardStore;
  taskboardRepositoryProvider?: RepositoryProvider;
  control?: { enabled: boolean; githubTokenMode: 'github_app'|'personal_access_token'; githubAppInstallationId?: number };
  githubAppInstallationTokenProvider?: GithubAppInstallationTokenProvider;
  resolvePersonalAccessToken(input: { tenantId: string; ownerUserId: string }): Promise<string | undefined>;
}) {
  const personalAccessTokenResolver = createPersonalAccessTokenIntegrationPushTokenResolver({
    resolveToken: input.resolvePersonalAccessToken,
    onError: (error) => serverLogger.warn(`Integration PAT repository probe failed: ${error.message}`),
  });
  const appTokenResolver = input.githubAppInstallationTokenProvider && input.control?.githubAppInstallationId
    ? createGithubAppIntegrationPushTokenResolver({
      provider: input.githubAppInstallationTokenProvider,
      installationId: input.control.githubAppInstallationId,
      onError: (error) => serverLogger.warn(`Integration App repository probe failed: ${error.message}`),
    }) : undefined;
  const repositoryProvider = input.control?.enabled !== true ? undefined
    : input.control.githubTokenMode === 'personal_access_token' ? input.taskboardRepositoryProvider
      : input.githubAppInstallationTokenProvider && input.control.githubAppInstallationId
        ? createIntegrationV3GithubAppRepositoryProvider({
          tokenProvider: input.githubAppInstallationTokenProvider, installationId: input.control.githubAppInstallationId,
        }) : undefined;
  const credentialResolver = input.control?.githubTokenMode === 'personal_access_token' ? personalAccessTokenResolver : appTokenResolver;
  if (input.control?.enabled && input.store) input.store.setIntegrationV3RepositoryProbe(async ({ tenantId, ownerUserId, repository }) => {
    if (!repositoryProvider?.getReference || !credentialResolver || !repository.baseBranch) return false;
    await repositoryProvider.getReference(repository, repository.baseBranch, ownerUserId);
    return !!await credentialResolver({ tenantId, ownerUserId, repositoryId: repository.repositoryId,
      repositoryOwner: repository.owner, repositoryName: repository.name });
  });
  return { repositoryProvider, personalAccessTokenResolver };
}

export function buildRuntimeTaskboardIntegrationV3Options(input: Omit<StartRuntimeTaskboardIntegrationV3Options,
  'controlledMirrorRoot'|'enabled'|'githubTokenMode'|'githubAppInstallationId'|'resolveGithubToken'> & {
  control?: { enabled: boolean; controlledMirrorRoot: string; githubAppInstallationId?: number; githubTokenMode: 'github_app'|'personal_access_token' };
  githubAppInstallationTokenProvider?: GithubAppInstallationTokenProvider;
  personalAccessTokenResolver?: StartRuntimeTaskboardIntegrationV3Options['resolveGithubToken'];
}): StartRuntimeTaskboardIntegrationV3Options {
  const resolver = input.control?.githubTokenMode === 'personal_access_token'
    ? input.personalAccessTokenResolver
    : input.control?.githubAppInstallationId && input.githubAppInstallationTokenProvider
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
      githubTokenMode: input.control.githubTokenMode,
      ...(input.control.githubAppInstallationId ? { githubAppInstallationId: input.control.githubAppInstallationId } : {}),
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
    boardsTable: store.boardsTable,
    integrationSourcesTable: store.integrationSourcesTable,
    integrationLanesTable: store.integrationLanesTable,
    candidatesTable: tables.candidatesTable,
    revisionsTable: tables.revisionsTable,
    providerOperationsTable: tables.providerOperationsTable,
    requestsOutboxTable: tables.requestsOutboxTable,
    blockEpisodesTable: store.blockEpisodesTable,
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
      && (options.githubTokenMode === 'personal_access_token' || Number.isSafeInteger(options.githubAppInstallationId)),
    allowedWorktreeRoots: options.controlledMirrorRoot ? [options.controlledMirrorRoot] : [],
    githubAppInstallationId: options.githubAppInstallationId,
    capabilityService,
    resolveTarget: (input) => capabilityHost.resolveTarget(input),
    resolveExecutionTarget: (input) => capabilityHost.resolveExecutionTarget(input),
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
      return paths ? {
        worktreePath: paths.worktreePath,
        remoteUrl: canonicalGithubRepositoryUrl(parsed),
        repositoryOwner: parsed.owner,
        repositoryName: parsed.name,
      } : undefined;
    },
    resolveGithubToken: options.resolveGithubToken ?? (async () => undefined),
    operationService,
  });
  const withRepositoryCredential = async <T>(
    context: Pick<IntegrationV3ComposeContext, 'tenantId' | 'credentialOwnerId' | 'repository'>,
    action: (env: Readonly<Record<string, string>>) => Promise<T>,
  ): Promise<T> => {
    if (!options.resolveGithubToken) return action({});
    const credential = await options.resolveGithubToken({
      tenantId: context.tenantId,
      ownerUserId: context.credentialOwnerId,
      repositoryId: context.repository.repositoryId,
      repositoryOwner: context.repository.owner,
      repositoryName: context.repository.name,
    });
    if (!credential || !credentialMatchesRepository(credential, {
      repositoryId: context.repository.repositoryId,
      repositoryOwner: context.repository.owner,
      repositoryName: context.repository.name,
    }, options.githubAppInstallationId)) {
      throw new Error('Integration repository credential is unavailable');
    }
    return withIntegrationGitAskpass(credential.token, action);
  };
  let composeHost: PostgresIntegrationV3ComposeHost;
  const workerHost: PostgresIntegrationV3WorkerHost = new PostgresIntegrationV3WorkerHost({
    ...pgOptions,
    releaseIdentity: options.releaseIdentity ?? 'unknown-release',
    sourceSnapshotsTable: tables.sourceSnapshotsTable,
    boardsTable: store.boardsTable,
    executionsTable: store.executionsTable,
    dispatchAgent: async ({ identity, taskId, expectedVersion, purpose, executionId, candidateId, candidateRevision, assertCurrent }) => {
      const current = await workerHost.loadCurrent(candidateId);
      if (!current.revision || !current.revision.treeOid || current.candidate.currentRevision !== candidateRevision
        || current.revision.revision !== candidateRevision || !current.candidate.providerPullRequestId) {
        throw new Error('Candidate execution workspace binding is stale');
      }
      const revision = current.revision;
      const treeOid = current.revision.treeOid;
      const providerPullRequestId = current.candidate.providerPullRequestId;
      const context = await composeHost.resolveContext({ candidate: current.candidate, revision });
      const objects = await composeHost.withRepositoryFetchCredential(context, (fetchEnvironment) => (
        syncCandidateRevisionObjects(composeHost, {
          repositoryPath: context.repositoryPath,
          integrationBranch: current.candidate.branch,
          baseBranch: current.candidate.baseBranch,
          controlledRemoteUrl: canonicalGithubRepositoryUrl(context.repository),
          fetchEnvironment,
          candidateId,
          candidateRevision,
          providerPullRequestId,
          expectedBaseOid: revision.baseOid,
          expectedHeadOid: revision.headOid,
          expectedTreeOid: treeOid,
        })
      ));
      await materializeCandidateObjects({
        sourceRepositoryPath: objects.repositoryPath,
        workspaceRoot: resolveUserCwd(agentCwd, {
          id: identity.ownerUserId,
          username: identity.username,
          role: 'user',
          tenantId: identity.tenantId,
        }),
        repositoryName: context.repository.name,
        baseOid: objects.baseOid,
        headOid: objects.headOid,
        treeOid: objects.treeOid,
      });
      await assertCurrent();
      // Work admission is enforced inside rawRuntimeRunDispatch against evidence returned
      // by provisioning the exact ACS SandboxRef. A standalone capability probe here would
      // attest a different boundary and is therefore intentionally forbidden.
      const started = await executionCoordinator.startIntegrationV3Execution(
        identity, taskId, { expectedVersion, purpose }, executionId,
      );
      return { executionId: started.execution.id };
    },
    syncWorkspace: async (request) => {
      const current = await workerHost.loadCurrent(request.candidateId);
      if (!current.revision) throw new Error('Workspace sync requires a current candidate revision');
      const context = await composeHost.resolveContext({ candidate: current.candidate, revision: current.revision });
      await composeHost.withRepositoryFetchCredential(context, (fetchEnvironment) => (
        syncRepositoryWorkspace(composeHost, {
          repositoryPath: context.repositoryPath,
          worktreePath: context.worktreePath,
          baseBranch: current.candidate.baseBranch,
          integrationBranch: current.candidate.branch,
          controlledRemoteUrl: canonicalGithubRepositoryUrl(context.repository),
          fetchEnvironment,
          integrationWorktreeMode: 'reset_to_base',
        })
      ));
    },
    cleanup: createRuntimeIntegrationV3CleanupHost({
      controlledMirrorRoot: options.controlledMirrorRoot,
      loadCurrent: (candidateId) => workerHost.loadCurrent(candidateId),
      resolveContext: (current) => resolveRuntimeIntegrationV3CleanupContext({
        pool: store.pool,
        candidatesTable: tables.candidatesTable,
        tasksTable: store.tasksTable,
        boardsTable: store.boardsTable,
        sourceSnapshotsTable: tables.sourceSnapshotsTable,
        controlledMirrorRoot: options.controlledMirrorRoot!,
      }, current),
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
    resolutionsTable: store.resolutionsTable,
    requestsOutboxTable: tables.requestsOutboxTable,
    providerOperationsTable: tables.providerOperationsTable,
    resolvePaths: async (repository, candidateId, identity) => {
      const roots = { processCwd, agentCwd, ...(options.controlledMirrorRoot ? { controlledMirrorRoot: options.controlledMirrorRoot } : {}) };
      const existing = await resolveIntegrationV3RepositoryPaths(repository, candidateId, roots);
      if (existing || !options.controlledMirrorRoot) return existing;
      const client = await store.pool.connect();
      const lock = ['integration-v3-mirror-provision', repository.repositoryId];
      try {
        await client.query('SELECT pg_advisory_lock(hashtext($1),hashtext($2))', lock);
        const winner = await resolveIntegrationV3RepositoryPaths(repository, candidateId, roots);
        if (winner) return winner;
        await withRepositoryCredential({
          tenantId: identity.tenantId,
          credentialOwnerId: identity.ownerUserId,
          repository,
        }, (fetchEnvironment) => provisionIntegrationV3RepositoryMirror({
          controlledMirrorRoot: options.controlledMirrorRoot!,
          repository,
          fetchEnvironment,
          runGit,
        }));
        return resolveIntegrationV3RepositoryPaths(repository, candidateId, roots);
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))', lock).catch(() => undefined);
        client.release();
      }
    },
    runGit,
    validateServerOwnedRepository: createServerOwnedRepositoryValidator(options.controlledMirrorRoot),
    withRepositoryFetchCredential: withRepositoryCredential,
    pushIntegrationHead: async (input) => pushGateway.pushExact({
      tenantId: input.context.tenantId, ownerUserId: input.context.credentialOwnerId,
      repositoryId: input.context.repository.repositoryId, integrationTaskId: input.integrationTaskId,
      candidateId: input.candidateId, revision: input.revision,
      exactRef: `refs/heads/${input.branch}`, expectedOldOid: input.expectedOldOid, newOid: input.headOid,
      rebaseParentOid: input.headParentOid,
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
  const runtimeHealth = async () => {
    const gateway = await pushGateway.health();
    const workerTick = worker.health();
    const healthy = gateway.healthy && workerActive && !stopped && workerTick.healthy;
    return {
      healthy,
      ...(!healthy ? { reason: activationReason ?? gateway.reason ?? workerTick.reason ?? 'worker_inactive' } : {}),
    };
  };
  const activationHeartbeat = createIntegrationV3ActivationHeartbeat({
    store: new PostgresIntegrationV3ActivationStore(store.pool, tables.activationHeartbeatsTable),
    releaseIdentity: options.releaseIdentity ?? 'unknown-release',
    processRole: options.processRole ?? 'runtime-worker',
    getHealth: runtimeHealth,
  });
  const activation = startIntegrationV3ActivationRetry({
    check: async () => {
      const [health, attestation] = await Promise.all([
        pushGateway.health(),
        options.runtimeIsolationAttestationProvider?.attest({ admission: 'integration_v3_worker' }),
      ]);
      if (!health.healthy) return { healthy: false, reason: health.reason ?? 'gateway_unhealthy' };
      if (!validAttestation(attestation)) return { healthy: false, reason: 'runtime_isolation_attestation_unavailable' };
      return { healthy: true };
    },
    start: () => { worker.start(); workerActive = true; },
    setReason: (reason) => {
      activationReason = reason;
      if (reason && reason !== 'stopped') serverLogger.warn(`Integration v3 worker disabled: ${reason}`);
    },
    onError: (error) => serverLogger.warn(
      `Integration v3 worker activation failed: ${error instanceof Error ? error.message : String(error)}`,
    ),
  });
  const heartbeatReady = activationHeartbeat.start().catch((error) => {
    serverLogger.warn(`Integration v3 activation heartbeat unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });
  return {
    integrationPush: new ControlledTaskboardIntegrationPushService(pushGateway),
    async health() {
      await heartbeatReady;
      const health = await runtimeHealth();
      return { enabled: true as const, ...health, workerActive };
    },
    async stop() {
      stopped = true;
      await activation.stop();
      await heartbeatReady;
      try {
        await worker.stop();
      } finally {
        workerActive = false;
        await activationHeartbeat.stop();
      }
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
