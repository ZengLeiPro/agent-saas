import { readdir, rm, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';

import type { AgentStore } from '../agents/store.js';
import type { AgentDwsAccountStore } from '../agentDwsAccounts/index.js';
import type { BillingService } from '../billing/service.js';
import type { GroupStore } from '../groups/store.js';
import type { ConnectorConnectionStore } from '../../connectors/connectionStore.js';
import type { McpConfigStore } from '../mcpConfig.js';
import type { SkillConfigStore } from '../skills/store.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT, isValidSessionId } from '../transcripts/projectKey.js';
import type { TokenUsageStore } from '../usage/store.js';
import type { UserStore } from '../users/store.js';
import type { UserInfo } from '../users/types.js';
import type { CronService } from '../../cron/service.js';
import type { ArtifactService } from '../../runtime/artifactService.js';
import type { PgEventStore } from '../../runtime/pgEventStore.js';
import type { PgHandStore } from '../../runtime/handStore.js';
import type { PgRunStore } from '../../runtime/runStore.js';
import type { PgSessionProjectionStore } from '../../runtime/sessionProjectionStore.js';
import type { PgToolInvocationStore } from '../../runtime/toolInvocationStore.js';
import { deriveStableWorkspaceId } from '../../runtime/workspaceIdentity.js';
import { resolveTenantCwd } from '../../workspace/resolver.js';
import { DEFAULT_TENANT_ID, TENANT_SLUG_PATTERN, type TenantRecord } from './types.js';
import type { TenantStore } from './store.js';
import type { McpOAuthService } from '../../mcp/oauthService.js';
import { ContextStore, type ContextTenantDeletionReport } from '../../context/store/store.js';
import {
  GovernanceChangeJobWorker,
  TENANT_DELETE_DOMAINS,
  type GovernanceChangeJob,
  type GovernanceChangeJobDomain,
  type GovernanceTenantCleanup,
  type PgGovernanceChangeJobStore,
} from '../changeJobs/index.js';

export interface TenantDeletionReport {
  tenantId: string;
  tenant: TenantRecord;
  usersDeleted: number;
  agentProfilesDeleted: number;
  groupsDeleted: number;
  cronJobsDeleted: number;
  skills: {
    usersRemoved: number;
    tenantConfigRemoved: boolean;
    platformRefsRemoved: number;
  };
  mcp: {
    serversRemoved: number;
    usersRemoved: number;
  };
  tokenUsageRowsDeleted: number;
  billing: {
    usageEvents: number;
    creditLedger: number;
    creditAccounts: number;
    tenantPolicies: number;
  };
  context: {
    enabled: boolean;
    deletion: ContextTenantDeletionReport;
  };
  runtime: {
    sessionIds: number;
    eventsDeleted: number;
    eventCursorsDeleted: number;
    runsDeleted: number;
    sessionsDeleted: number;
    toolInvocationsDeleted: number;
    handsDeleted: number;
    artifactsDeleted: number;
  };
  files: {
    workspaceDirDeleted: boolean;
    transcriptsDirDeleted: boolean;
    sharedTenantDirDeleted: boolean;
    tenantSkillsDirDeleted: boolean;
    avatarsDeleted: number;
  };
}

export interface DeleteTenantResourcesOptions {
  tenantId: string;
  tenantStore: TenantStore;
  userStore: UserStore;
  agentStore?: AgentStore;
  agentDwsAccountStore?: AgentDwsAccountStore;
  skillConfigStore?: SkillConfigStore;
  mcpConfigStore?: McpConfigStore;
  connectorConnectionStore?: ConnectorConnectionStore;
  onUserDeleting?: (user: UserInfo) => Promise<void>;
  mcpOAuthService?: McpOAuthService;
  groupStore?: GroupStore;
  cronService?: CronService | null;
  tokenUsageStore?: TokenUsageStore;
  billingService?: BillingService;
  runtimePgEventStore?: PgEventStore;
  runtimeRunStore?: PgRunStore;
  runtimeSessionProjectionStore?: PgSessionProjectionStore;
  runtimeToolInvocationStore?: PgToolInvocationStore;
  runtimeHandStore?: PgHandStore;
  artifactService?: ArtifactService;
  agentCwd: string;
  sharedDir: string;
  tenantSkillsRootDir?: string;
  avatarsDir: string;
  /** Durable deletion jobs retain the tenant row until their final phase. */
  preserveTenantRecord?: boolean;
}

export interface TenantDeletionJobReceipt {
  created: boolean;
  job: GovernanceChangeJob;
  domains: GovernanceChangeJobDomain[];
}

export interface DurableTenantDeletionExecutor {
  execute(input: {
    tenantId: string;
    idempotencyKey: string;
    requestedBy: string;
    reasonCode: string;
  }): Promise<TenantDeletionJobReceipt>;
  get(tenantId: string, jobId: string): Promise<TenantDeletionJobReceipt | null>;
  findByIdempotency(tenantId: string, idempotencyKey: string): Promise<TenantDeletionJobReceipt | null>;
  /** CAS-fenced replay of retryable or terminal work; grants a bounded fresh attempt budget. */
  replay(input: {
    tenantId: string;
    jobId: string;
    expectedRevision: number;
    requestedBy: string;
    additionalAttempts?: number;
  }): Promise<TenantDeletionJobReceipt>;
  /** Starts with an immediate recovery scan, then continuously consumes due retries. */
  start(): void;
  /** Stops future scans and waits for the active scan to settle. */
  stop(): Promise<void>;
  /** Visible test/operations hook for one isolated due-job scan. */
  runDue(): Promise<void>;
}

function emptyContextDeletionReport(): ContextTenantDeletionReport {
  return {
    relationCandidatesDeleted: 0,
    entityLinksDeleted: 0,
    itemEvidenceDeleted: 0,
    profileFacetEvidenceDeleted: 0,
    reviewsDeleted: 0,
    derivedItemsDeleted: 0,
    profileFacetsDeleted: 0,
    entitiesDeleted: 0,
    consumersDeleted: 0,
    derivedOutboxDeleted: 0,
    outboxDeleted: 0,
    evidenceDeleted: 0,
    revisionsDeleted: 0,
    recordsDeleted: 0,
    partitionsDeleted: 0,
    collectionsDeleted: 0,
    sourcesDeleted: 0,
    totalDeleted: 0,
  };
}

function isInside(baseDir: string, candidate: string): boolean {
  const base = resolve(baseDir);
  const target = resolve(candidate);
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function removeDirInside(baseDir: string, targetDir: string): Promise<boolean> {
  const base = resolve(baseDir);
  const target = resolve(targetDir);
  if (target === base || !isInside(base, target)) {
    throw new Error(`Refuse to delete unsafe directory: ${target}`);
  }
  if (!existsSync(target)) return false;
  await rm(target, { recursive: true, force: true });
  return true;
}

async function deleteAvatars(avatarsDir: string, users: UserInfo[]): Promise<number> {
  const ids = new Set(users.map(user => user.id));
  if (ids.size === 0 || !existsSync(avatarsDir)) return 0;
  let deleted = 0;
  const entries = await readdir(avatarsDir).catch(() => []);
  for (const name of entries) {
    const ext = extname(name);
    const base = basename(name, ext);
    if (!ids.has(base)) continue;
    await unlink(join(avatarsDir, name)).catch(() => undefined);
    deleted++;
  }
  return deleted;
}

async function collectSessionIds(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const sessionId = entry.name.endsWith('.meta.json')
        ? entry.name.slice(0, -'.meta.json'.length)
        : entry.name.endsWith('.jsonl')
          ? entry.name.slice(0, -'.jsonl'.length)
          : null;
      if (sessionId && isValidSessionId(sessionId)) out.add(sessionId);
    }
  }
  await walk(root);
  return out;
}

export async function deleteTenantResources(options: DeleteTenantResourcesOptions): Promise<TenantDeletionReport> {
  const { tenantId } = options;
  if (!TENANT_SLUG_PATTERN.test(tenantId)) throw new Error(`Invalid tenant id "${tenantId}"`);
  if (tenantId === DEFAULT_TENANT_ID) {
    throw new Error(`Cannot delete the default tenant "${DEFAULT_TENANT_ID}"`);
  }

  const tenant = options.tenantStore.findById(tenantId);
  if (!tenant) throw new Error('Tenant not found');

  // Context uses the same pool/prefix as the durable runtime event store. Clear
  // it before non-transactional resource deletion so a failed Context transaction
  // leaves the tenant available for an auditable retry.
  const context = options.runtimePgEventStore
    ? {
        enabled: true,
        deletion: await new ContextStore({
          pool: options.runtimePgEventStore.pool,
          tablePrefix: options.runtimePgEventStore.eventsTable.replace(/_events$/, ''),
        }).hardDeleteTenant(tenantId),
      }
    : { enabled: false, deletion: emptyContextDeletionReport() };

  const users = options.userStore.listAll().filter(user => user.tenantId === tenantId);
  const usernames = users.map(user => user.username);
  const userIds = users.map(user => user.id);
  const workspaceIds = users.map(user => deriveStableWorkspaceId(
    { id: user.id, tenantId },
    `ws_${tenantId}__${user.id}`,
  ));

  const transcriptTenantDir = join(AGENT_LEGACY_TRANSCRIPTS_ROOT, tenantId);
  const sessionIds = new Set<string>();
  for (const id of await collectSessionIds(transcriptTenantDir)) sessionIds.add(id);
  if (options.runtimePgEventStore) {
    for (const id of await options.runtimePgEventStore.listSessionIdsByTenant(tenantId)) sessionIds.add(id);
  }
  if (options.runtimeRunStore) {
    for (const id of await options.runtimeRunStore.listSessionIdsByTenant(tenantId)) sessionIds.add(id);
  }

  const artifacts = options.artifactService
    ? await options.artifactService.deleteArtifactsForSessions([...sessionIds])
    : { scanned: 0, deleted: 0 };

  const cronJobsDeleted = options.cronService
    ? await options.cronService.removeByOwners(userIds)
    : 0;
  const groupsDeleted = options.groupStore
    ? await options.groupStore.deleteByUserIds(userIds)
    : 0;
  const agentProfilesDeleted = options.agentStore
    ? await options.agentStore.removeMany(usernames)
    : 0;
  await options.agentDwsAccountStore?.deleteForTenant(tenantId);
  const skills = options.skillConfigStore
    ? await options.skillConfigStore.removeTenant(tenantId, usernames)
    : { usersRemoved: 0, tenantConfigRemoved: false, platformRefsRemoved: 0 };
  if (options.onUserDeleting) {
    for (const user of users) {
      await options.onUserDeleting(user);
    }
  }
  if (options.mcpOAuthService) {
    for (const username of usernames) {
      await options.mcpOAuthService.revokeUserConnections(username, tenantId);
    }
  }
  const mcp = options.mcpConfigStore
    ? await options.mcpConfigStore.removeTenantData(tenantId, usernames)
    : { serversRemoved: 0, usersRemoved: 0 };
  if (options.connectorConnectionStore) {
    await Promise.all(usernames.map(username => options.connectorConnectionStore!.removeUserData(username)));
  }
  const tokenUsageRowsDeleted = options.tokenUsageStore?.deleteTenant(tenantId) ?? 0;
  const billing = options.billingService
    ? await options.billingService.deleteTenantData(tenantId)
    : { usageEvents: 0, creditLedger: 0, creditAccounts: 0, tenantPolicies: 0 };
  const toolInvocationsDeleted = options.runtimeToolInvocationStore
    ? await options.runtimeToolInvocationStore.deleteByTenant(tenantId)
    : 0;
  const runtimeEvents = options.runtimePgEventStore
    ? await options.runtimePgEventStore.deleteByTenant(tenantId)
    : { events: 0, cursors: 0 };
  const runsDeleted = options.runtimeRunStore
    ? await options.runtimeRunStore.deleteByTenant(tenantId)
    : 0;
  const sessionsDeleted = options.runtimeSessionProjectionStore
    ? await options.runtimeSessionProjectionStore.deleteByTenant(tenantId)
    : 0;
  const handsDeleted = options.runtimeHandStore
    ? await options.runtimeHandStore.deleteByWorkspaceIds(workspaceIds)
    : 0;

  const avatarsDeleted = await deleteAvatars(options.avatarsDir, users);
  const workspaceDirDeleted = await removeDirInside(options.agentCwd, resolveTenantCwd(options.agentCwd, tenantId));
  const transcriptsDirDeleted = await removeDirInside(AGENT_LEGACY_TRANSCRIPTS_ROOT, transcriptTenantDir);
  const sharedTenantDirDeleted = await removeDirInside(resolve(options.sharedDir, 'tenants'), resolve(options.sharedDir, 'tenants', tenantId));
  const tenantSkillsDirDeleted = options.tenantSkillsRootDir
    ? await removeDirInside(options.tenantSkillsRootDir, resolve(options.tenantSkillsRootDir, tenantId))
    : false;

  const usersDeleted = await options.userStore.deleteByTenant(tenantId);
  const deletedTenant = options.preserveTenantRecord
    ? options.tenantStore.findById(tenantId) ?? tenant
    : await options.tenantStore.delete(tenantId);

  return {
    tenantId,
    tenant: deletedTenant,
    usersDeleted,
    agentProfilesDeleted,
    groupsDeleted,
    cronJobsDeleted,
    skills,
    mcp,
    tokenUsageRowsDeleted,
    billing,
    context,
    runtime: {
      sessionIds: sessionIds.size,
      eventsDeleted: runtimeEvents.events,
      eventCursorsDeleted: runtimeEvents.cursors,
      runsDeleted,
      sessionsDeleted,
      toolInvocationsDeleted,
      handsDeleted,
      artifactsDeleted: artifacts.deleted,
    },
    files: {
      workspaceDirDeleted,
      transcriptsDirDeleted,
      sharedTenantDirDeleted,
      tenantSkillsDirDeleted,
      avatarsDeleted,
    },
  };
}

/** Builds a resumable tenant deletion state machine on governance change jobs. */
export function createDurableTenantDeletionExecutor(options: {
  jobs: PgGovernanceChangeJobStore;
  tenantStore: TenantStore;
  deleteResources: (tenantId: string) => Promise<TenantDeletionReport>;
  governanceCleanup: GovernanceTenantCleanup;
  onFrozen?: (tenantId: string) => void;
  workerId?: string;
  retryDelayMs?: number;
  maxAttempts?: number;
  leaseMs?: number;
  pollIntervalMs?: number;
  batchSize?: number;
  onJobError?: (error: unknown, job: Pick<GovernanceChangeJob, 'tenantId' | 'jobId' | 'status'>) => void;
}): DurableTenantDeletionExecutor {
  const leaseMs = options.leaseMs ?? 5 * 60_000;
  const worker = new GovernanceChangeJobWorker({
    store: options.jobs,
    workerId: options.workerId ?? 'tenant-deletion',
    ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
  });
  const receipt = async (job: GovernanceChangeJob, created: boolean): Promise<TenantDeletionJobReceipt> => ({
    created, job, domains: await options.jobs.listDomains(job.tenantId, job.jobId),
  });
  const handlers = (tenantId: string) => ({
    tenant_freeze: async () => {
      const tenant = options.tenantStore.findById(tenantId);
      if (!tenant) return;
      if (!tenant.disabled) await options.tenantStore.setDisabled(tenantId, true, 'system:tenant-deletion');
      options.onFrozen?.(tenantId);
    },
    legacy_resources: async () => { await options.deleteResources(tenantId); },
    assignments: async () => options.governanceCleanup.execute(tenantId, 'assignments'),
    agents_skills: async () => options.governanceCleanup.execute(tenantId, 'agents_skills'),
    credentials: async () => options.governanceCleanup.execute(tenantId, 'credentials'),
    memberships: async () => options.governanceCleanup.execute(tenantId, 'memberships'),
    tenant_configuration: async () => options.governanceCleanup.execute(tenantId, 'tenant_configuration'),
    audit_retention: async () => options.governanceCleanup.execute(tenantId, 'audit_retention'),
    tenant_record: async () => {
      const tenant = options.tenantStore.findById(tenantId);
      // Replay after a crash between row deletion and progress acknowledgement.
      if (!tenant) return;
      if (!tenant.disabled) throw new Error('TENANT_DELETE_NOT_FROZEN');
      await options.tenantStore.delete(tenantId);
    },
  });
  const executeJob = async (job: GovernanceChangeJob, created: boolean): Promise<TenantDeletionJobReceipt> => {
    if (['succeeded', 'partial', 'failed', 'dead_letter'].includes(job.status)) return receipt(job, created);
    if (job.status === 'retry_wait' && job.nextRetryAt && Date.parse(job.nextRetryAt) > Date.now()) {
      return receipt(job, created);
    }
    const result = await worker.execute({ tenantId: job.tenantId, jobId: job.jobId, handlers: handlers(job.tenantId) });
    return receipt(result, created);
  };
  const tenantExecutions = new Map<string, Promise<unknown>>();
  const perTenant = async <T>(tenantId: string, operation: () => Promise<T>): Promise<T> => {
    const prior = tenantExecutions.get(tenantId) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    tenantExecutions.set(tenantId, current);
    try {
      return await current;
    } finally {
      if (tenantExecutions.get(tenantId) === current) tenantExecutions.delete(tenantId);
    }
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeScan: Promise<void> | undefined;
  let stopped = true;
  const runDue = async (): Promise<void> => {
    if (activeScan) return activeScan;
    const scan = (async () => {
      const due = await options.jobs.listDue('tenant_delete', options.batchSize ?? 25, leaseMs);
      await Promise.all(due.map(job => perTenant(job.tenantId, async () => {
        try {
          await executeJob(job, false);
        } catch (error) {
          options.onJobError?.(error, job);
        }
      })));
    })();
    activeScan = scan;
    try {
      await scan;
    } finally {
      if (activeScan === scan) activeScan = undefined;
    }
  };
  const executor: DurableTenantDeletionExecutor = {
    async execute(input) {
      return perTenant(input.tenantId, async () => {
        const existing = await options.jobs.findByIdempotency(input.tenantId, 'tenant_delete', input.idempotencyKey);
        if (existing) return executeJob(existing, false);
        const created = await options.jobs.create({
          tenantId: input.tenantId, jobType: 'tenant_delete', targetType: 'tenant', targetId: input.tenantId,
          idempotencyKey: input.idempotencyKey, request: { reasonCode: input.reasonCode },
          domains: [...TENANT_DELETE_DOMAINS],
          ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
          createdBy: input.requestedBy,
        });
        return executeJob(created.job, created.created);
      });
    },
    async get(tenantId, jobId) {
      const job = await options.jobs.get(tenantId, jobId);
      return job?.jobType === 'tenant_delete' ? receipt(job, false) : null;
    },
    async findByIdempotency(tenantId, idempotencyKey) {
      const job = await options.jobs.findByIdempotency(tenantId, 'tenant_delete', idempotencyKey);
      return job ? receipt(job, false) : null;
    },
    async replay(input) {
      return perTenant(input.tenantId, async () => {
        const current = await options.jobs.get(input.tenantId, input.jobId);
        if (!current || current.jobType !== 'tenant_delete') throw new Error('CHANGE_JOB_NOT_FOUND');
        const replayed = await options.jobs.retryNow(
          input.tenantId,
          input.jobId,
          input.expectedRevision,
          input.requestedBy,
          input.additionalAttempts ?? options.maxAttempts ?? 5,
        );
        if (replayed.jobType !== 'tenant_delete') throw new Error('CHANGE_JOB_NOT_FOUND');
        return executeJob(replayed, false);
      });
    },
    start() {
      if (!stopped) return;
      stopped = false;
      void runDue().catch(error => options.onJobError?.(error, {
        tenantId: '*', jobId: 'tenant-delete-scan', status: 'pending',
      }));
      timer = setInterval(() => {
        void runDue().catch(error => options.onJobError?.(error, {
          tenantId: '*', jobId: 'tenant-delete-scan', status: 'pending',
        }));
      }, Math.max(10, options.pollIntervalMs ?? 5_000));
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await activeScan?.catch(() => undefined);
      await Promise.allSettled(tenantExecutions.values());
    },
    runDue,
  };
  return executor;
}
