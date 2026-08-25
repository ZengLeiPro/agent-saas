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
import { contextTableNames } from '../../context/store/migration.js';
import { contextRetentionTableNames } from '../../context/lifecycle/migration.js';
import { tableNames as contextPhase4TableNames } from '../../context/phase4/migration.js';
import {
  GovernanceChangeJobWorker,
  TENANT_DELETE_DOMAINS,
  type GovernanceChangeJob,
  type GovernanceChangeJobDomain,
  type GovernanceTenantCleanup,
  type PgGovernanceChangeJobStore,
} from '../changeJobs/index.js';

export interface TenantDeletionResiduals {
  /** Every Context table deleted by ContextStore.hardDeleteTenant, checked after commit. */
  context: Record<Exclude<keyof ContextTenantDeletionReport, 'totalDeleted'>, number>;
  /** Read after deleteByTenant; this is never a deletion count. */
  users: number;
  /** Read-only final checks over the tenant-keyed durable runtime tables. */
  runtime: { events: number; cursors: number; runs: number; sessions: number; tools: number };
  files: number;
  workspaces: number;
  sandboxes: number;
  trafficPolicies: number;
  snat: number;
}

export interface TenantExternalRuntimeResiduals {
  sandboxes: number;
  trafficPolicies: number;
  snat: number;
  authority: string;
}

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
  /** Point-in-time residual checks made immediately after legacy deletion. */
  residuals: TenantDeletionResiduals;
  externalRuntimeAuthority?: string;
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
  /** ACS owns Sandbox, TrafficPolicy and SNAT as one lifecycle unit. */
  cleanupExternalRuntime?: (tenantId: string) => Promise<TenantExternalRuntimeResiduals>;
  /** Durable deletion jobs retain the tenant row until their final phase. */
  preserveTenantRecord?: boolean;
}

export interface TenantDeletionAuditProof {
  /** Present for v30+ jobs; v29 active jobs are verified without inventing a legacy report. */
  report?: TenantDeletionReport;
  /** Final point-in-time verifier result after every cleanup domain has completed. */
  residuals: TenantDeletionResiduals & { credentials: number; governance: Record<string, number> };
  verifiedAt: string;
  externalRuntimeAuthority: string;
}

export interface TenantDeletionJobReceipt {
  created: boolean;
  job: GovernanceChangeJob;
  domains: GovernanceChangeJobDomain[];
  /** Stable, persisted evidence; returned by GET and idempotent/replay receipts. */
  proof?: TenantDeletionAuditProof;
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
    retentionReceiptsDeleted: 0,
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

async function verifyContextResiduals(
  runtimePgEventStore: PgEventStore | undefined,
  tenantId: string,
): Promise<TenantDeletionResiduals['context']> {
  const zero = emptyContextDeletionReport();
  const residuals = Object.fromEntries(
    Object.keys(zero).filter(key => key !== 'totalDeleted').map(key => [key, 0]),
  ) as TenantDeletionResiduals['context'];
  if (!runtimePgEventStore || typeof runtimePgEventStore.pool.query !== 'function') return residuals;
  const prefix = runtimePgEventStore.eventsTable.replace(/_events$/, '');
  const base = contextTableNames(prefix);
  const retention = contextRetentionTableNames(prefix);
  const phase4 = contextPhase4TableNames(prefix);
  const tables: Record<keyof TenantDeletionResiduals['context'], string> = {
    retentionReceiptsDeleted: retention.receipts,
    relationCandidatesDeleted: phase4.relationCandidates,
    entityLinksDeleted: phase4.entityLinks,
    itemEvidenceDeleted: phase4.itemEvidence,
    profileFacetEvidenceDeleted: phase4.profileFacetEvidence,
    reviewsDeleted: phase4.reviews,
    derivedItemsDeleted: phase4.derivedItems,
    profileFacetsDeleted: phase4.profileFacets,
    entitiesDeleted: phase4.entities,
    consumersDeleted: phase4.consumers,
    derivedOutboxDeleted: phase4.derivedOutbox,
    outboxDeleted: base.outbox,
    evidenceDeleted: base.evidence,
    revisionsDeleted: base.revisions,
    recordsDeleted: base.records,
    partitionsDeleted: base.partitions,
    collectionsDeleted: base.collections,
    sourcesDeleted: base.sources,
  };
  await Promise.all(Object.entries(tables).map(async ([key, table]) => {
    const result = await runtimePgEventStore.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${table} WHERE tenant_id=$1`, [tenantId],
    );
    residuals[key as keyof TenantDeletionResiduals['context']] = Number(result.rows[0]?.count ?? 0);
  }));
  return residuals;
}

async function verifyRuntimeResiduals(options: Pick<DeleteTenantResourcesOptions,
  'runtimePgEventStore' | 'runtimeRunStore' | 'runtimeSessionProjectionStore' | 'runtimeToolInvocationStore'
>, tenantId: string): Promise<TenantDeletionResiduals['runtime']> {
  type ReadonlyPool = { query: <T>(sql: string, values: unknown[]) => Promise<{ rows: T[] }> };
  const readable = (pool: unknown): pool is ReadonlyPool => (
    Boolean(pool) && typeof (pool as { query?: unknown }).query === 'function'
  );
  const count = async (pool: ReadonlyPool, table: string) => {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${table} WHERE tenant_id=$1`, [tenantId],
    );
    return Number(result.rows[0]?.count ?? 0);
  };
  const events = options.runtimePgEventStore;
  const runs = options.runtimeRunStore;
  const sessions = options.runtimeSessionProjectionStore;
  const tools = options.runtimeToolInvocationStore;
  const [eventCount, cursorCount, runCount, sessionCount, toolCount] = await Promise.all([
    events && readable(events.pool) ? count(events.pool, events.eventsTable) : 0,
    events && readable(events.pool) ? count(events.pool, `${events.eventsTable.replace(/_events$/, '')}_event_cursors`) : 0,
    runs && readable(runs.pool) ? count(runs.pool, runs.runsTable) : 0,
    sessions && readable(sessions.pool) ? count(sessions.pool, sessions.sessionsTable) : 0,
    tools && typeof tools.countByTenant === 'function' ? tools.countByTenant(tenantId) : 0,
  ]);
  return { events: eventCount, cursors: cursorCount, runs: runCount, sessions: sessionCount, tools: toolCount };
}

export interface TenantDeletionVerificationOptions {
  userStore: UserStore;
  runtimePgEventStore?: PgEventStore;
  runtimeRunStore?: PgRunStore;
  runtimeSessionProjectionStore?: PgSessionProjectionStore;
  runtimeToolInvocationStore?: PgToolInvocationStore;
  agentCwd: string;
  sharedDir: string;
  tenantSkillsRootDir?: string;
  verifyExternalRuntime?: (tenantId: string) => Promise<TenantExternalRuntimeResiduals>;
}

/** Full read-only, final-point-in-time verification; safe for pre-v30 resumed jobs. */
export async function verifyTenantDeletionResiduals(
  options: TenantDeletionVerificationOptions,
  tenantId: string,
): Promise<{ residuals: TenantDeletionResiduals; externalRuntimeAuthority: string }> {
  const transcriptTenantDir = join(AGENT_LEGACY_TRANSCRIPTS_ROOT, tenantId);
  const paths = [
    resolveTenantCwd(options.agentCwd, tenantId),
    transcriptTenantDir,
    resolve(options.sharedDir, 'tenants', tenantId),
    ...(options.tenantSkillsRootDir ? [resolve(options.tenantSkillsRootDir, tenantId)] : []),
  ];
  const external = options.verifyExternalRuntime
    ? await options.verifyExternalRuntime(tenantId)
    : { sandboxes: 0, trafficPolicies: 0, snat: 0, authority: 'acs-runtime-not-configured' };
  return {
    residuals: {
      context: await verifyContextResiduals(options.runtimePgEventStore, tenantId),
      users: options.userStore.listAll().filter(user => user.tenantId === tenantId).length,
      runtime: await verifyRuntimeResiduals(options, tenantId),
      files: paths.filter(path => existsSync(path)).length,
      workspaces: existsSync(resolveTenantCwd(options.agentCwd, tenantId)) ? 1 : 0,
      sandboxes: external.sandboxes,
      trafficPolicies: external.trafficPolicies,
      snat: external.snat,
    },
    externalRuntimeAuthority: external.authority,
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
  const filesResidual = [
    resolveTenantCwd(options.agentCwd, tenantId),
    transcriptTenantDir,
    resolve(options.sharedDir, 'tenants', tenantId),
    ...(options.tenantSkillsRootDir ? [resolve(options.tenantSkillsRootDir, tenantId)] : []),
  ].filter(path => existsSync(path)).length;
  const externalRuntime = options.cleanupExternalRuntime
    ? await options.cleanupExternalRuntime(tenantId)
    : { sandboxes: 0, trafficPolicies: 0, snat: 0, authority: 'acs-runtime-not-configured' };
  const usersDeleted = await options.userStore.deleteByTenant(tenantId);
  // The proof is intentionally read only and runs after all legacy deletes. Do
  // not substitute deletion row counts: a successful DELETE does not prove zero residue.
  const residuals: TenantDeletionResiduals = {
    context: await verifyContextResiduals(options.runtimePgEventStore, tenantId),
    users: options.userStore.listAll().filter(user => user.tenantId === tenantId).length,
    runtime: await verifyRuntimeResiduals(options, tenantId),
    files: filesResidual,
    workspaces: existsSync(resolveTenantCwd(options.agentCwd, tenantId)) ? 1 : 0,
    sandboxes: externalRuntime.sandboxes,
    trafficPolicies: externalRuntime.trafficPolicies,
    snat: externalRuntime.snat,
  };

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
    residuals,
    externalRuntimeAuthority: externalRuntime.authority,
  };
}

/** Builds a resumable tenant deletion state machine on governance change jobs. */
export function createDurableTenantDeletionExecutor(options: {
  jobs: PgGovernanceChangeJobStore;
  tenantStore: TenantStore;
  deleteResources: (tenantId: string) => Promise<TenantDeletionReport>;
  governanceCleanup: GovernanceTenantCleanup;
  verifyResources?: (tenantId: string) => Promise<{
    residuals: TenantDeletionResiduals;
    externalRuntimeAuthority: string;
  }>;
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
  const receipt = async (job: GovernanceChangeJob, created: boolean): Promise<TenantDeletionJobReceipt> => {
    const domains = await options.jobs.listDomains(job.tenantId, job.jobId);
    const verification = domains.find(domain => domain.domain === 'deletion_verification')?.receipt;
    return {
      created,
      job,
      domains,
      ...(verification?.proof ? { proof: verification.proof as TenantDeletionAuditProof } : {}),
    };
  };
  const handlers = (tenantId: string, jobId: string) => ({
    tenant_freeze: async () => {
      const tenant = options.tenantStore.findById(tenantId);
      if (!tenant) return;
      if (!tenant.disabled) await options.tenantStore.setDisabled(tenantId, true, 'system:tenant-deletion');
      options.onFrozen?.(tenantId);
    },
    legacy_resources: async () => {
      const report = await options.deleteResources(tenantId);
      const affectedCount = report.usersDeleted + report.agentProfilesDeleted + report.groupsDeleted
        + report.cronJobsDeleted + report.tokenUsageRowsDeleted + report.context.deletion.totalDeleted
        + report.runtime.eventsDeleted + report.runtime.eventCursorsDeleted + report.runtime.runsDeleted
        + report.runtime.sessionsDeleted + report.runtime.toolInvocationsDeleted + report.runtime.handsDeleted
        + report.runtime.artifactsDeleted + report.files.avatarsDeleted
        + Number(report.files.workspaceDirDeleted) + Number(report.files.transcriptsDirDeleted)
        + Number(report.files.sharedTenantDirDeleted) + Number(report.files.tenantSkillsDirDeleted);
      return {
        affectedCount,
        completedCount: affectedCount,
        unresolvedItems: [],
        receipt: { report },
      };
    },
    assignments: async () => options.governanceCleanup.execute(tenantId, 'assignments'),
    agents_skills: async () => options.governanceCleanup.execute(tenantId, 'agents_skills'),
    credentials: async () => options.governanceCleanup.execute(tenantId, 'credentials'),
    memberships: async () => options.governanceCleanup.execute(tenantId, 'memberships'),
    tenant_configuration: async () => options.governanceCleanup.execute(tenantId, 'tenant_configuration'),
    audit_retention: async () => options.governanceCleanup.execute(tenantId, 'audit_retention'),
    deletion_verification: async () => {
      const domains = await options.jobs.listDomains(tenantId, jobId);
      const legacyReceipt = domains.find(domain => domain.domain === 'legacy_resources')?.receipt;
      const report = legacyReceipt?.report as TenantDeletionReport | undefined;
      if (report && report.tenantId !== tenantId) throw new Error('TENANT_DELETE_REPORT_TENANT_MISMATCH');
      const governance = await options.governanceCleanup.verifyTenantDeletion?.(tenantId)
        ?? { credentials: 0, governance: {} };
      const final = options.verifyResources
        ? await options.verifyResources(tenantId)
        : {
            residuals: report?.residuals ?? {
              context: emptyContextDeletionReport(), users: 0,
              runtime: { events: 0, cursors: 0, runs: 0, sessions: 0, tools: 0 },
              files: 0, workspaces: 0, sandboxes: 0, trafficPolicies: 0, snat: 0,
            },
            externalRuntimeAuthority: report?.externalRuntimeAuthority ?? 'acs-runtime-not-configured',
          };
      const proof: TenantDeletionAuditProof = {
        ...(report ? { report } : {}),
        residuals: { ...final.residuals, credentials: governance.credentials, governance: governance.governance },
        verifiedAt: new Date().toISOString(),
        externalRuntimeAuthority: final.externalRuntimeAuthority,
      };
      const entries = [
        ...Object.entries(proof.residuals.context),
        ...Object.entries(proof.residuals.governance),
        ['users', proof.residuals.users],
        ...Object.entries(proof.residuals.runtime),
        ['files', proof.residuals.files],
        ['workspaces', proof.residuals.workspaces],
        ['sandboxes', proof.residuals.sandboxes],
        ['trafficPolicies', proof.residuals.trafficPolicies],
        ['snat', proof.residuals.snat],
      ];
      const unresolvedItems = entries.filter(([, count]) => Number(count) > 0).map(([itemId]) => ({
        itemType: 'tenant_residual', itemId: String(itemId), reasonCode: 'TENANT_DELETE_RESIDUAL', retryable: true,
      }));
      return {
        affectedCount: entries.length,
        completedCount: entries.length - unresolvedItems.length,
        unresolvedItems,
        receipt: { proof },
      };
    },
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
    const result = await worker.execute({ tenantId: job.tenantId, jobId: job.jobId, handlers: handlers(job.tenantId, job.jobId) });
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
