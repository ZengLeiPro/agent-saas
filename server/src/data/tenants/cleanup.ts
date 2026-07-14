import { readdir, rm, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';

import type { AgentStore } from '../agents/store.js';
import type { BillingService } from '../billing/service.js';
import type { GroupStore } from '../groups/store.js';
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
  skillConfigStore?: SkillConfigStore;
  mcpConfigStore?: McpConfigStore;
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
  const skills = options.skillConfigStore
    ? await options.skillConfigStore.removeTenant(tenantId, usernames)
    : { usersRemoved: 0, tenantConfigRemoved: false, platformRefsRemoved: 0 };
  if (options.mcpOAuthService) {
    for (const username of usernames) {
      await options.mcpOAuthService.revokeUserConnections(username, tenantId);
    }
  }
  const mcp = options.mcpConfigStore
    ? await options.mcpConfigStore.removeTenantData(tenantId, usernames)
    : { serversRemoved: 0, usersRemoved: 0 };
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
  const deletedTenant = await options.tenantStore.delete(tenantId);

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
