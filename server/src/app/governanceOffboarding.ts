import type { AppRuntime } from './runtime.js';
import type { UserInfo } from '../data/users/types.js';
import { GovernanceChangeJobWorker } from '../data/changeJobs/index.js';
import { GovernanceOffboardingCoordinator } from '../data/offboarding/index.js';
import { runtimeRunController } from '../runtime/runController.js';

export type ExecuteUserOffboarding = (input: {
  tenantId: string;
  userId: string;
  handoffTargetUserId: string;
  idempotencyKey: string;
  requestedBy: string;
  reasonCode: string;
}) => Promise<unknown>;

type GovernanceOffboardingDependencies = {
  runtime: AppRuntime;
  userStore: NonNullable<AppRuntime['userStore']>;
  terminateAndRevokeUserConnectors: (target: UserInfo) => Promise<void>;
  disconnectWebUser?: (userId: string) => void;
  removeCronByOwners?: (ownerIds: string[]) => Promise<unknown>;
};

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
        const durableCancelled = await runs.cancelActiveByUser!(context.userId, 'user offboarding');
        const localCancelled = runtimeRunController.abortByUser(context.userId, 'user offboarding');
        dependencies.disconnectWebUser?.(context.userId);
        const count = Math.max(durableCancelled, localCancelled);
        return { affectedCount: count, completedCount: count, unresolvedItems: [] };
      } },
      assignmentsPreferences: { offboard: async context => {
        const result = await assignments.offboardUser(context.tenantId, context.userId);
        const count = result.assignmentsDeleted + result.preferencesDeleted;
        return { affectedCount: count, completedCount: count, unresolvedItems: [] };
      } },
      credentialsConnectors: { offboard: async context => {
        const ownedCredentials = await credentials.listForOwner(context.tenantId, context.userId);
        let completed = 0;
        for (const credential of ownedCredentials) {
          if (credential.status !== 'revoked') {
            await vault.revokeSecret(credential.secretRef, {
              actor: 'connector_proxy', userId: context.userId, tenantId: context.tenantId,
              scopes: ['secret:connector:revoke'],
            });
            await credentials.updateStatus(credential.credentialId, {
              status: 'revoked', expectedVersion: credential.version,
              updatedBy: context.requestedBy, updateReason: 'user_offboarding',
            });
          }
          completed += 1;
        }
        const target = dependencies.userStore.findById(context.userId);
        if (target) await dependencies.terminateAndRevokeUserConnectors(target);
        return { affectedCount: ownedCredentials.length, completedCount: completed, unresolvedItems: [] };
      } },
      cronOwnership: { offboard: async context => {
        await dependencies.removeCronByOwners?.([context.userId]);
        return { affectedCount: 1, completedCount: 1, unresolvedItems: [] };
      } },
      personalResources: { offboard: async context => {
        const [ownedAgents, ownedSkills] = await Promise.all([
          agents.listPersonalByOwner(context.tenantId, context.userId),
          skills.listPersonalByOwner(context.tenantId, context.userId),
        ]);
        for (const agent of ownedAgents) {
          if (agent.status !== 'archived') {
            await agents.archive(context.tenantId, agent.agentId, agent.revision, context.requestedBy);
          }
        }
        for (const skill of ownedSkills) {
          if (skill.status !== 'retired') {
            await skills.retire(context.tenantId, skill.skillId, skill.revision, context.requestedBy);
          }
        }
        const count = ownedAgents.length + ownedSkills.length;
        return { affectedCount: count, completedCount: count, unresolvedItems: [] };
      } },
      membership: { offboard: async context => {
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
  return async input => {
    const plan = await offboarding.createOrReuse(input);
    const status = plan.job.status;
    const job = status === 'succeeded' || status === 'failed'
      ? plan.job
      : await worker.execute({
          tenantId: input.tenantId,
          jobId: plan.job.jobId,
          handlers: plan.domainHandlers,
        });
    return { created: plan.created, job };
  };
}
