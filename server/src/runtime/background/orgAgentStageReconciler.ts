import type { RawRuntimeRunDispatchConfig } from '../rawRuntimeRunDispatch.js';
import { parseBackgroundTaskMetadata } from './backgroundTaskMetadata.js';
import type { OrgAgentBackgroundWorkCoordinator } from './orgAgentBackgroundWork.js';

const STAGE_STALE_MS = 120_000;
const STAGE_BATCH_SIZE = 50;

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
        const work = await store.getWorkOrder(run.tenantId!, metadata.workOrderId);
        if (!work) throw new Error('ORG_AGENT_STAGED_WORK_ORDER_MISSING');
        let attempt = (await store.listWorkAttempts(run.tenantId!, work.workOrderId)).find(
          (item) => item.runtimeRunId === run.runId,
        );
        if (!attempt)
          attempt = await store.createWorkAttempt({
            tenantId: run.tenantId!,
            workOrderId: work.workOrderId,
            runtimeRunId: run.runId,
            attemptId: metadata.attemptId,
            taskWorkspaceId: metadata.workspaceId,
            sandboxScopeId: metadata.sandboxScopeId,
            mountSubPath: metadata.mountSubPath,
            sharedReadOnlySubPath: metadata.sharedReadOnlySubPath,
          });
        if (attempt.attemptNo !== metadata.attemptNo)
          throw new Error('ORG_AGENT_STAGED_ATTEMPT_FENCE_MISMATCH');
        const activated = await runStore.markStatus(
          run.runId,
          'pending',
          'org_agent_stage_recovered',
          {
            backgroundTaskReady: true,
            backgroundStageRecoveredAt: new Date().toISOString(),
          },
        );
        if (!activated) throw new Error('ORG_AGENT_STAGED_ACTIVATION_FAILED');
      } catch (error) {
        await runStore
          .markStatus(run.runId, 'failed', 'org_agent_stage_recovery_failed', {
            backgroundTaskReady: false,
            backgroundStageFailure: (error instanceof Error ? error.message : String(error)).slice(
              0,
              500,
            ),
          })
          .catch(() => undefined);
        if (metadata?.workOrderId && run.tenantId) {
          await orgWork
            .failSetup(run.tenantId, metadata.workOrderId, run.runId, metadata.cwd, error)
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
    await orgWork
      .failSetup(
        work.tenantId,
        work.workOrderId,
        `orphaned-stage:${work.workOrderId}`,
        work.workOrderId,
        new Error('ORG_AGENT_STAGED_RUN_MISSING'),
      )
      .catch(() => undefined);
  }
}
