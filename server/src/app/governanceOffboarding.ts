import type { AppRuntime } from './runtime.js';
import type { UserInfo } from '../data/users/types.js';
import { GovernanceChangeJobWorker } from '../data/changeJobs/index.js';
import { GovernanceOffboardingCoordinator, type GovernanceOffboardingDomainContext } from '../data/offboarding/index.js';
import { runtimeRunController } from '../runtime/runController.js';

export type ExecuteUserOffboarding = ((input: {
  tenantId: string;
  userId: string;
  handoffTargetUserId: string;
  idempotencyKey: string;
  requestedBy: string;
  reasonCode: string;
  manifest: { baselineDigest: string; baseline: Record<string, unknown> };
}) => Promise<unknown>) & {
  retry(input: { tenantId: string; jobId: string; expectedRevision: number; requestedBy: string }): Promise<unknown>;
};

export interface CronOffboardingItem {
  id: string;
  ownerUserId?: string;
  enabled: boolean;
  running: boolean;
  systemManaged?: boolean;
}

export function createSafeCronOffboardingExecutor(dependencies: {
  get: (cronId: string) => Promise<CronOffboardingItem | null>;
  disable: (cronId: string, operationId: string) => Promise<void>;
  stop: (cronId: string, operationId: string) => Promise<void>;
  transfer: (cronId: string, targetUserId: string, operationId: string) => Promise<void>;
}): (input: {
  cronIds: readonly string[];
  departingUserId: string;
  handoffTargetUserId: string;
  operationIdempotencyKey: string;
}) => Promise<{ affectedCount: number; completedCount: number; unresolvedItems: Array<{
  itemType: string; itemId: string; reasonCode: string; retryable: boolean;
}> }> {
  return async input => {
    let completedCount = 0;
    const unresolvedItems: Array<{ itemType: string; itemId: string; reasonCode: string; retryable: boolean }> = [];
    for (const cronId of [...new Set(input.cronIds)].sort()) {
      const operationId = `${input.operationIdempotencyKey}:${cronId}`;
      try {
        const current = await dependencies.get(cronId);
        if (!current || current.ownerUserId === input.handoffTargetUserId) {
          completedCount += 1;
          continue;
        }
        if (current.ownerUserId && current.ownerUserId !== input.departingUserId) {
          unresolvedItems.push({
            itemType: 'cron', itemId: cronId, reasonCode: 'CRON_OWNER_DRIFT', retryable: false,
          });
          continue;
        }
        // Fence future starts before waiting for an in-flight execution to stop.
        if (current.enabled && !current.systemManaged) await dependencies.disable(cronId, `${operationId}:disable`);
        if (current.running) await dependencies.stop(cronId, `${operationId}:stop`);
        await dependencies.transfer(cronId, input.handoffTargetUserId, `${operationId}:transfer`);
        completedCount += 1;
      } catch {
        unresolvedItems.push({
          itemType: 'cron', itemId: cronId, reasonCode: 'CRON_OFFBOARDING_RETRYABLE', retryable: true,
        });
      }
    }
    return { affectedCount: input.cronIds.length, completedCount, unresolvedItems };
  };
}

type GovernanceOffboardingDependencies = {
  runtime: AppRuntime;
  userStore: NonNullable<AppRuntime['userStore']>;
  terminateAndRevokeUserConnectors: (target: UserInfo) => Promise<void>;
  disconnectWebUser?: (userId: string) => void;
  listCronIdsByOwner?: (userId: string) => Promise<string[]>;
  listActiveSessionIdsByUser?: (tenantId: string, userId: string) => Promise<string[]>;
  listExternalConnectionIdsByUser?: (tenantId: string, userId: string) => Promise<string[]>;
  executeCronOffboarding?: ReturnType<typeof createSafeCronOffboardingExecutor>;
  retainSessions?: (tenantId: string, userId: string, jobId: string) => Promise<number>;
  archivePersonalWorkspace?: (
    tenantId: string, userId: string, jobId: string, manifestPaths?: readonly string[],
  ) => Promise<{ affectedCount: number; completedCount: number }>;
};

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(item => item !== null && typeof item === 'object') as Record<string, unknown>[]
    : [];
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => typeof item === 'string'
    ? [item]
    : item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
      ? [(item as { id: string }).id]
      : []);
}

function baseline(context: GovernanceOffboardingDomainContext): Record<string, unknown> {
  return context.manifest.baseline;
}

function summaryIds(context: GovernanceOffboardingDomainContext, key: string): string[] {
  const value = baseline(context)[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return ids((value as Record<string, unknown>).ids);
}

function recordIds(context: GovernanceOffboardingDomainContext, key: string): string[] {
  return records(baseline(context)[key]).map(item => String(item.id));
}

export function createGovernanceOffboardingExecutor(
  dependencies: GovernanceOffboardingDependencies,
): ExecuteUserOffboarding | undefined {
  const { runtime } = dependencies;
  const {
    governanceChangeJobStore: jobs,
    assignmentStore: assignments,
    credentialStore: credentials,
    membershipStore: memberships,
    agentResourceStore: agents,
    skillGovernanceStore: skills,
    secretVault: vault,
    runtimeRunStore: runs,
  } = runtime;
  if (!jobs || !assignments || !credentials || !memberships || !agents || !skills || !vault
    || !runs?.cancelActiveByUser) return undefined;

  const offboarding = new GovernanceOffboardingCoordinator({
    jobs,
    domains: {
      runsSessions: { offboard: async context => {
        const runIds = summaryIds(context, 'activeRuns');
        const sessionIds = summaryIds(context, 'activeSessions');
        await runs.cancelActiveByUser!(context.userId, 'user offboarding');
        runtimeRunController.abortByUser(context.userId, 'user offboarding');
        dependencies.disconnectWebUser?.(context.userId);
        const retainedSessions = dependencies.retainSessions
          ? await dependencies.retainSessions(context.tenantId, context.userId, context.jobId)
          : 0;
        return {
          affectedCount: runIds.length + sessionIds.length,
          completedCount: runIds.length + Math.min(retainedSessions, sessionIds.length),
          unresolvedItems: dependencies.retainSessions
            ? sessionIds.slice(retainedSessions).map(id => ({
                itemType: 'session', itemId: id,
                reasonCode: 'SESSION_RETENTION_INCOMPLETE', retryable: true,
              }))
            : sessionIds.map(id => ({
                itemType: 'session', itemId: id,
                reasonCode: 'SESSION_RETENTION_EXECUTOR_UNAVAILABLE', retryable: true,
              })),
        };
      } },
      assignmentsPreferences: { offboard: async context => {
        const result = await assignments.offboardUser(context.tenantId, context.userId);
        const count = result.assignmentsDeleted + result.preferencesDeleted;
        return { affectedCount: count, completedCount: count, unresolvedItems: [] };
      } },
      credentialsConnectors: { offboard: async context => {
        const ownedCredentialIds = recordIds(context, 'ownedCredentials');
        const custodialCredentialIds = recordIds(context, 'custodialCredentials');
        const oauthGrantIds = summaryIds(context, 'oauthGrants');
        const externalConnectionIds = summaryIds(context, 'externalConnections');
        let completed = 0;
        for (const credentialId of custodialCredentialIds) {
          const credential = await credentials.get(credentialId);
          if (!credential || credential.tenantId !== context.tenantId
            || credential.status === 'revoked' || credential.custodianUserId === context.handoffTargetUserId) {
            completed += 1;
            continue;
          }
          await credentials.transferCustodian(
            context.tenantId, credential.credentialId, credential.version,
            context.handoffTargetUserId, context.requestedBy,
          );
          completed += 1;
        }
        for (const credentialId of ownedCredentialIds) {
          const credential = await credentials.get(credentialId);
          if (!credential || credential.tenantId !== context.tenantId || credential.status === 'revoked') {
            completed += 1;
            continue;
          }
          await vault.revokeSecret(credential.secretRef, {
            actor: 'connector_proxy', userId: context.userId, tenantId: context.tenantId,
            scopes: ['secret:connector:revoke'],
          });
          await credentials.updateStatus(credential.credentialId, {
            status: 'revoked', expectedVersion: credential.version,
            updatedBy: context.requestedBy, updateReason: 'user_offboarding',
          });
          completed += 1;
        }
        if (oauthGrantIds.length > 0 && !runtime.oauthGrantStore) {
          return {
            affectedCount: ownedCredentialIds.length + custodialCredentialIds.length
              + oauthGrantIds.length + externalConnectionIds.length,
            completedCount: completed,
            unresolvedItems: oauthGrantIds.map(grantId => ({
              itemType: 'oauth_grant', itemId: grantId,
              reasonCode: 'OAUTH_GRANT_REVOCATION_AUTHORITY_UNAVAILABLE', retryable: true,
            })),
          };
        }
        const grants = runtime.oauthGrantStore
          ? await runtime.oauthGrantStore.listForSubject(context.tenantId, context.userId)
          : [];
        for (const grantId of oauthGrantIds) {
          const grant = grants.find(item => item.grantId === grantId);
          if (!grant || grant.status === 'revoked') {
            completed += 1;
            continue;
          }
          await runtime.oauthGrantStore!.markRevocationPending({
            grantId, tenantId: context.tenantId, subjectUserId: context.userId,
            purpose: 'user_offboarding', actorUserId: context.requestedBy,
          });
          await runtime.oauthGrantStore!.markProviderRevoking({
            grantId, tenantId: context.tenantId, subjectUserId: context.userId,
          });
        }
        const target = dependencies.userStore.findById(context.userId);
        if (!target || target.tenantId !== context.tenantId) {
          return {
            affectedCount: ownedCredentialIds.length + custodialCredentialIds.length
              + oauthGrantIds.length + externalConnectionIds.length,
            completedCount: completed,
            unresolvedItems: [{
              itemType: 'external_connection', itemId: context.userId,
              reasonCode: 'OFFBOARDING_CONNECTOR_SUBJECT_UNAVAILABLE', retryable: true,
            }],
          };
        }
        await dependencies.terminateAndRevokeUserConnectors(target);
        if (runtime.oauthGrantStore) {
          for (const grantId of oauthGrantIds) {
            const grant = grants.find(item => item.grantId === grantId);
            if (grant && grant.status !== 'revoked') {
              await runtime.oauthGrantStore.markProviderRevoked({
                grantId, tenantId: context.tenantId, subjectUserId: context.userId,
              });
              await runtime.oauthGrantStore.recordRevocation({
                grantId, tenantId: context.tenantId, subjectUserId: context.userId,
                purpose: 'user_offboarding', actorUserId: context.requestedBy,
              });
              completed += 1;
            }
          }
        }
        completed += externalConnectionIds.length;
        return {
          affectedCount: ownedCredentialIds.length + custodialCredentialIds.length
            + oauthGrantIds.length + externalConnectionIds.length,
          completedCount: completed,
          unresolvedItems: [],
        };
      } },
      cronOwnership: { offboard: async context => {
        const cronIds = ids(baseline(context).cronIds);
        if (cronIds.length === 0) return { affectedCount: 0, completedCount: 0, unresolvedItems: [] };
        if (!dependencies.executeCronOffboarding) {
          return {
            affectedCount: cronIds.length, completedCount: 0,
            unresolvedItems: [{
              itemType: 'cron_authority', itemId: context.userId,
              reasonCode: 'CRON_OFFBOARDING_EXECUTOR_UNAVAILABLE', retryable: true,
            }],
          };
        }
        return dependencies.executeCronOffboarding({
          cronIds,
          departingUserId: context.userId,
          handoffTargetUserId: context.handoffTargetUserId,
          operationIdempotencyKey: context.operationIdempotencyKey,
        });
      } },
      personalResources: { offboard: async context => {
        const agentIds = recordIds(context, 'agents');
        const skillIds = recordIds(context, 'skills');
        let completed = 0;
        for (const agentId of agentIds) {
          const agent = await agents.get(agentId);
          if (!agent || agent.tenantId !== context.tenantId || agent.status === 'archived'
            || agent.ownerUserId === context.handoffTargetUserId) {
            completed += 1;
            continue;
          }
          if (agent.kind === 'org_agent') {
            await agents.transferOwnership(
              context.tenantId, agent.agentId, agent.revision,
              context.handoffTargetUserId, context.requestedBy,
            );
          } else {
            await agents.archive(context.tenantId, agent.agentId, agent.revision, context.requestedBy);
          }
          completed += 1;
        }
        for (const skillId of skillIds) {
          const skill = await skills.getResource(skillId);
          if (!skill || skill.tenantId !== context.tenantId || skill.status === 'retired') {
            completed += 1;
            continue;
          }
          await skills.retire(context.tenantId, skill.skillId, skill.revision, context.requestedBy);
          completed += 1;
        }
        const personalMemoryIds = ids(baseline(context).personalMemoryIds);
        const fileOwnership = baseline(context).fileOwnership as Record<string, unknown> | undefined;
        const personalFileIds = ids(fileOwnership?.personalFileIds);
        const workspacePaths = [...personalMemoryIds, ...personalFileIds];
        const workspace = dependencies.archivePersonalWorkspace
          ? await dependencies.archivePersonalWorkspace(
              context.tenantId, context.userId, context.jobId, workspacePaths,
            )
          : { affectedCount: Math.max(workspacePaths.length, 1), completedCount: 0 };
        const unresolvedItems = !dependencies.archivePersonalWorkspace ? [{
          itemType: 'personal_data', itemId: context.userId,
          reasonCode: 'PERSONAL_DATA_RETENTION_EXECUTOR_UNAVAILABLE', retryable: true,
        }] : workspace.completedCount < workspace.affectedCount ? [{
          itemType: 'personal_data', itemId: context.userId,
          reasonCode: 'PERSONAL_DATA_RETENTION_INCOMPLETE', retryable: true,
        }] : [];
        return {
          affectedCount: agentIds.length + skillIds.length + workspace.affectedCount,
          completedCount: completed + workspace.completedCount,
          unresolvedItems,
        };
      } },
      membership: { offboard: async context => {
        await runs.cancelActiveByUser!(context.userId, 'user offboarding final fence');
        runtimeRunController.abortByUser(context.userId, 'user offboarding final fence');
        await assignments.offboardUser(context.tenantId, context.userId);
        const target = dependencies.userStore.findById(context.userId);
        if (!target || target.tenantId !== context.tenantId) throw new Error('OFFBOARDING_MEMBERSHIP_SUBJECT_MISMATCH');
        await dependencies.terminateAndRevokeUserConnectors(target);
        const currentGrants = runtime.oauthGrantStore
          ? await runtime.oauthGrantStore.listForSubject(context.tenantId, context.userId)
          : [];
        for (const grant of currentGrants.filter(item => item.status !== 'revoked')) {
          await runtime.oauthGrantStore!.markProviderRevoked({
            grantId: grant.grantId, tenantId: context.tenantId, subjectUserId: context.userId,
          });
          await runtime.oauthGrantStore!.recordRevocation({
            grantId: grant.grantId, tenantId: context.tenantId, subjectUserId: context.userId,
            purpose: 'user_offboarding_final_fence', actorUserId: context.requestedBy,
          });
        }
        const currentCronIds = await dependencies.listCronIdsByOwner?.(context.userId) ?? [];
        if (currentCronIds.length > 0 && dependencies.executeCronOffboarding) {
          await dependencies.executeCronOffboarding({
            cronIds: currentCronIds, departingUserId: context.userId,
            handoffTargetUserId: context.handoffTargetUserId,
            operationIdempotencyKey: `${context.operationIdempotencyKey}:final`,
          });
        }
        await dependencies.retainSessions?.(context.tenantId, context.userId, context.jobId);
        await dependencies.archivePersonalWorkspace?.(context.tenantId, context.userId, context.jobId);
        const [remainingAgents, remainingSkills, remainingOwnedCredentials, remainingCustodialCredentials, remainingRuns, remainingGrants, remainingCrons, remainingSessions, remainingConnections] = await Promise.all([
          agents.listByOwner(context.tenantId, context.userId),
          skills.listPersonalByOwner(context.tenantId, context.userId),
          credentials.listForOwner(context.tenantId, context.userId),
          credentials.listForCustodian(context.tenantId, context.userId),
          runs.listActiveByUser ? runs.listActiveByUser(context.userId) : Promise.resolve([]),
          runtime.oauthGrantStore ? runtime.oauthGrantStore.listForSubject(context.tenantId, context.userId) : Promise.resolve([]),
          dependencies.listCronIdsByOwner?.(context.userId) ?? Promise.resolve([]),
          dependencies.listActiveSessionIdsByUser?.(context.tenantId, context.userId) ?? Promise.resolve([]),
          dependencies.listExternalConnectionIdsByUser?.(context.tenantId, context.userId) ?? Promise.resolve([]),
        ]);
        const unresolvedItems = [
          ...remainingAgents.filter(item => item.status !== 'archived' && item.ownerUserId === context.userId)
            .map(item => ({ itemType: 'agent', itemId: item.agentId, reasonCode: 'OFFBOARDING_FINAL_INVENTORY_DRIFT', retryable: true })),
          ...remainingSkills.filter(item => item.status !== 'retired')
            .map(item => ({ itemType: 'skill', itemId: item.skillId, reasonCode: 'OFFBOARDING_FINAL_INVENTORY_DRIFT', retryable: true })),
          ...remainingOwnedCredentials.filter(item => item.status !== 'revoked')
            .map(item => ({ itemType: 'credential', itemId: item.credentialId, reasonCode: 'OFFBOARDING_FINAL_INVENTORY_DRIFT', retryable: true })),
          ...remainingCustodialCredentials.filter(item => item.status !== 'revoked' && item.custodianUserId === context.userId)
            .map(item => ({ itemType: 'credential_custodian', itemId: item.credentialId, reasonCode: 'OFFBOARDING_FINAL_INVENTORY_DRIFT', retryable: true })),
          ...remainingRuns.filter(item => item.tenantId === context.tenantId)
            .map(item => ({ itemType: 'run', itemId: item.runId, reasonCode: 'OFFBOARDING_FINAL_INVENTORY_DRIFT', retryable: true })),
          ...remainingGrants.filter(item => item.status !== 'revoked')
            .map(item => ({ itemType: 'oauth_grant', itemId: item.grantId, reasonCode: 'OFFBOARDING_FINAL_INVENTORY_DRIFT', retryable: true })),
          ...remainingCrons.map(itemId => ({ itemType: 'cron', itemId, reasonCode: 'OFFBOARDING_FINAL_INVENTORY_DRIFT', retryable: true })),
          ...remainingSessions.map(itemId => ({ itemType: 'session', itemId, reasonCode: 'OFFBOARDING_FINAL_INVENTORY_DRIFT', retryable: true })),
          ...remainingConnections.map(itemId => ({ itemType: 'external_connection', itemId, reasonCode: 'OFFBOARDING_FINAL_INVENTORY_DRIFT', retryable: true })),
        ];
        if (unresolvedItems.length > 0) {
          return { affectedCount: unresolvedItems.length + 2, completedCount: 0, unresolvedItems };
        }
        const result = await memberships.offboardMembership({
          tenantId: context.tenantId,
          userId: context.userId,
          handoffTargetUserId: context.handoffTargetUserId,
          updatedBy: context.requestedBy,
        });
        const legacyUser = dependencies.userStore.findById(context.userId);
        if (!legacyUser || legacyUser.tenantId !== context.tenantId) {
          throw new Error('OFFBOARDING_MEMBERSHIP_SUBJECT_MISMATCH');
        }
        if (!legacyUser.disabled) {
          await dependencies.userStore.setDisabled(
            context.userId, true, 'system:governance-offboarding',
          );
        }
        if (runtime.governanceProjectionOutboxStore) {
          await runtime.governanceProjectionOutboxStore.enqueue({
            tenantId: context.tenantId,
            projector: 'membership',
            idempotencyKey: `${result.offboarded.userId}:${result.offboarded.version}`,
            payload: {
              tenantId: context.tenantId, userId: result.offboarded.userId,
              persona: result.offboarded.persona, status: result.offboarded.status,
              version: result.offboarded.version,
            },
          });
        }
        return { affectedCount: 2, completedCount: 2, unresolvedItems: [] };
      } },
    },
  });
  const worker = new GovernanceChangeJobWorker({
    store: jobs,
    workerId: 'governance-offboarding-route',
  });

  const execute = async (input: Parameters<ExecuteUserOffboarding>[0]) => {
    const plan = await offboarding.createOrReuse(input);
    const status = plan.job.status;
    const job = status === 'succeeded' || status === 'partial' || status === 'failed'
      ? plan.job
      : await worker.execute({
          tenantId: input.tenantId,
          jobId: plan.job.jobId,
          handlers: plan.domainHandlers,
        });
    return { created: plan.created, job, domains: await jobs.listDomains(input.tenantId, job.jobId) };
  };
  return Object.assign(execute, {
    retry: async (input: { tenantId: string; jobId: string; expectedRevision: number; requestedBy: string }) => {
      const current = await jobs.get(input.tenantId, input.jobId);
      if (!current || current.revision !== input.expectedRevision) throw new Error('CHANGE_JOB_VERSION_CONFLICT');
      const ready = current.status === 'pending'
        ? current
        : await jobs.retryNow(input.tenantId, input.jobId, input.expectedRevision, input.requestedBy);
      const plan = offboarding.resume(ready, input.requestedBy);
      const job = await worker.execute({
        tenantId: input.tenantId, jobId: input.jobId, handlers: plan.domainHandlers,
      });
      return { created: false, job, domains: await jobs.listDomains(input.tenantId, job.jobId) };
    },
  });
}
