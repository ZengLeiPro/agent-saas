import type { RawRuntimeRunDispatchConfig } from '../rawRuntimeRunDispatch.js';
import { parseBackgroundTaskMetadata } from './backgroundTaskMetadata.js';
import type { OrgAgentBackgroundWorkCoordinator } from './orgAgentBackgroundWork.js';

const STAGE_STALE_MS = 120_000;
const STAGE_BATCH_SIZE = 50;
const STAGE_RECOVERY_POLICY_TOOL = 'BackgroundTask';

export async function reconcileStagedOrgWork(
  config: RawRuntimeRunDispatchConfig,
  orgWork: OrgAgentBackgroundWorkCoordinator,
): Promise<void> {
  const runStore = config.runStore;
  const store = config.orgGroupAgentStore;
  if (!runStore?.listStagedOrgAgentBackgroundTasks || !store) return;
  const staleBefore = new Date(Date.now() - STAGE_STALE_MS);
  let fullyDrained = false;
  for (let batch = 0; batch < 20; batch += 1) {
    const stagedRuns = await runStore.listStagedOrgAgentBackgroundTasks(
      staleBefore,
      STAGE_BATCH_SIZE,
    );
    for (const run of stagedRuns) {
      const metadata = parseBackgroundTaskMetadata(run);
      try {
        if (
          !metadata?.workOrderId ||
          !metadata.attemptId ||
          !metadata.attemptNo ||
          !metadata.sandboxScopeId ||
          !metadata.mountSubPath ||
          !metadata.sharedReadOnlySubPath ||
          !metadata.orgAgentChannel
        )
          throw new Error('ORG_AGENT_STAGED_METADATA_INVALID');
        let work = await store.getWorkOrder(run.tenantId!, metadata.workOrderId);
        if (
          !work
          || work.bindingId !== metadata.orgAgentChannel.bindingId
          || work.agentId !== metadata.orgAgentChannel.agentId
          || work.workConversationId !== metadata.orgAgentChannel.workConversationId
        ) throw new Error('ORG_AGENT_STAGED_WORK_ORDER_PRINCIPAL_MISMATCH');
        const evaluateChannel = config.orgAgentChannelPolicyEvaluator;
        if (!evaluateChannel) throw new Error('ORG_AGENT_STAGED_CHANNEL_POLICY_UNAVAILABLE');
        const livePolicy = await evaluateChannel({
          tenantId: run.tenantId!,
          bindingId: metadata.orgAgentChannel.bindingId,
          accountId: metadata.orgAgentChannel.accountId,
          agentId: metadata.orgAgentChannel.agentId,
          conversationId: metadata.orgAgentChannel.channelPrincipal.conversationId,
          toolName: STAGE_RECOVERY_POLICY_TOOL,
        });
        if (!livePolicy.allowed) throw new Error('ORG_AGENT_STAGED_CHANNEL_PRINCIPAL_STALE');
        let attempt = (await store.listWorkAttempts(run.tenantId!, work.workOrderId)).find(
          (item) => item.runtimeRunId === run.runId,
        );
        if (!attempt)
          attempt = await store.createWorkAttempt({
            tenantId: run.tenantId!,
            workOrderId: work.workOrderId,
            runtimeRunId: run.runId,
            attemptId: metadata.attemptId,
            ...(metadata.parentAttemptId ? { parentAttemptId: metadata.parentAttemptId } : {}),
            taskWorkspaceId: metadata.workspaceId,
            sandboxScopeId: metadata.sandboxScopeId,
            mountSubPath: metadata.mountSubPath,
            sharedReadOnlySubPath: metadata.sharedReadOnlySubPath,
          });
        if (attempt.attemptNo !== metadata.attemptNo)
          throw new Error('ORG_AGENT_STAGED_ATTEMPT_FENCE_MISMATCH');
        work = await store.getWorkOrder(run.tenantId!, metadata.workOrderId);
        if (
          !work ||
          !['queued', 'running'].includes(work.state) ||
          work.currentAttemptNo !== attempt.attemptNo ||
          attempt.status !== 'queued'
        )
          throw new Error('ORG_AGENT_STAGED_ATTEMPT_NOT_CURRENT');
        const activate = runStore.activateStagedOrgAgentBackgroundTask;
        if (!activate) throw new Error('ORG_AGENT_STAGED_ACTIVATION_UNAVAILABLE');
        const activated = await activate.call(
          runStore,
          run.runId,
          'org_agent_stage_recovered',
          {
            backgroundTaskReady: true,
            backgroundStageRecoveredAt: new Date().toISOString(),
          },
        );
        if (!activated) {
          const current = await runStore.get(run.runId);
          if (
            current?.metadata.backgroundTaskReady === true ||
            (current && current.status !== 'pending')
          ) continue;
          throw new Error('ORG_AGENT_STAGED_ACTIVATION_FAILED');
        }
      } catch (error) {
        const failedRun = runStore.markStatusIfCurrent
          ? await runStore.markStatusIfCurrent(
              run.runId,
              ['pending'],
              'failed',
              'org_agent_stage_recovery_failed',
              {
            backgroundTaskReady: false,
            backgroundStageFailure: (error instanceof Error ? error.message : String(error)).slice(
              0,
              500,
            ),
              },
            ).catch(() => null)
          : null;
        if (failedRun && metadata?.workOrderId && run.tenantId) {
          await orgWork
            .failSetup(
              run.tenantId,
              metadata.workOrderId,
              run.runId,
              metadata.cwd,
              error,
              metadata.attemptNo,
            )
            .catch(() => undefined);
        }
      }
    }
    if (stagedRuns.length < STAGE_BATCH_SIZE) {
      fullyDrained = true;
      break;
    }
  }
  if (!fullyDrained) return;
  const orphanedWork = await store.listStagedWorkOrders(staleBefore, STAGE_BATCH_SIZE);
  for (const work of orphanedWork) {
    const currentAttempt = (await store.listWorkAttempts(work.tenantId, work.workOrderId))
      .find(attempt => attempt.attemptNo === work.currentAttemptNo);
    if (currentAttempt && await runStore.get(currentAttempt.runtimeRunId)) continue;
    await orgWork
      .failSetup(
        work.tenantId,
        work.workOrderId,
        currentAttempt?.runtimeRunId ?? `orphaned-stage:${work.workOrderId}`,
        currentAttempt?.mountSubPath ?? work.workOrderId,
        new Error('ORG_AGENT_STAGED_RUN_MISSING'),
        currentAttempt?.attemptNo ?? work.currentAttemptNo + 1,
      )
      .catch(() => undefined);
  }
}
